//! Hooker's Token-2022 transfer hook. Solana runs it on every transfer of a window token while the
//! token trades on its Meteora DBC curve; Meteora revokes it in the buy that fills the curve.
//!
//! A hook can only ALLOW or REFUSE a transfer. Every rule here does exactly that:
//!
//!  * VENUE LOCK — tokens may only land in a real wallet (an on-curve key) or in the curve itself,
//!    so no other pool or escrow program can hold window tokens at graduation.
//!  * MAX PER WALLET — after the transfer the receiving token account holds at most `max_wallet_bps`
//!    of supply. During the first `early_secs` after launch the cap is `early_max_wallet_bps`
//!    (anti-snipe). With a RAMP (v2) the cap rises linearly from `ramp_start_bps` to the max over
//!    `ramp_secs`. Like every wallet cap it is per account: one person can use many wallets.
//!  * FOMO-ONLY BUYS — a buy (tokens leaving the curve) must sit in a transaction that `cosigner`
//!    signed. FOMO signs a top-level ATA create, not the swap, so every top-level instruction is
//!    scanned (observed on 208 of 208 FOMO buys of Hooked's live cosign hook).
//!  * APP-ONLY BUYS — a buy must run inside `app_program`: the top-level instruction currently
//!    executing must belong to it. A hook cannot see its CPI caller, only the outermost program.
//!
//! v2 (256-byte config) adds:
//!
//!  * ALLOWLIST / BLOCKLIST — one sorted list of wallets per token, in a PDA ["list", mint] that the
//!    creator fills (and seals) after launch. Allowlist: only listed wallets may receive. Blocklist:
//!    listed wallets may not. ⭐ The list is ONE account derived from the mint alone, never one per
//!    wallet: Meteora's SDK (and so FOMO, terminals and bots) resolves a hook's extra accounts with
//!    placeholder source/destination/owner keys, so any account derived from the buyer would make the
//!    token untradeable everywhere but our own site, sells included.
//!  * TRADE GUARD — no single transfer may move more than `trade_guard_bps` of supply.
//!  * TRADING HOURS — buys only on the chosen weekdays between two local times (fixed UTC offset).
//!  * SNIPER-FEE CAP — for `snipe_secs` after launch a buy is refused if its transaction sets a
//!    compute-unit price above `snipe_max_cu_price` or, in a top-level instruction of the same
//!    transaction, tips one of Jito's 8 tip accounts more than `snipe_max_tip`. A hook sees nothing
//!    else: a tip in another transaction of a bundle, by CPI, or to another relay is not caught.
//!  * ANTI-BUNDLE — at most `bundle_max` buys per slot, counted in a PDA ["slot", mint]. The counter
//!    is only ever moved by a REAL transfer: source and destination must be Token-2022 accounts of
//!    this mint, and Token-2022's `transferring` flag must be set on the source (it is only while
//!    Token-2022 itself runs the hook), so nobody can jam it by calling `execute` directly.
//!
//! Sells into the curve always pass (holders can always exit). The dev wallet is exempt from every
//! rule so the launch's dev buy works through any route. Fees, burns and holder rewards are NOT
//! enforced here (a hook cannot move value): their parameters live in the same config so they are
//! public and immutable, and the graduation settlement applies them.

use solana_curve25519::edwards::{validate_edwards, PodEdwardsPoint};
use solana_program::{
    account_info::AccountInfo, clock::Clock, entrypoint, entrypoint::ProgramResult, msg,
    program::{invoke, invoke_signed}, program_error::ProgramError, pubkey, pubkey::Pubkey,
    rent::Rent, system_instruction, system_program, sysvar::instructions as ix_sysvar,
    sysvar::Sysvar,
};

mod v3;

entrypoint!(process);

/// sha256("spl-transfer-hook-interface:execute")[..8]
const EXECUTE: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];
/// sha256("spl-transfer-hook-interface:initialize-extra-account-metas")[..8]
const INIT: [u8; 8] = [43, 34, 13, 49, 167, 88, 235, 235];
/// The creator adds wallets to the token's list / seals it. Our own discriminators.
const LIST_ADD: [u8; 8] = *b"hkLstAdd";
const LIST_SEAL: [u8; 8] = *b"hkLstSel";
/// Meteora DBC pool authority — owns every curve vault.
const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
const COMPUTE_BUDGET: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");
const TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/// Jito's eight tip accounts.
const JITO_TIPS: [Pubkey; 8] = [
    pubkey!("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"),
    pubkey!("HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe"),
    pubkey!("Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY"),
    pubkey!("ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49"),
    pubkey!("DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh"),
    pubkey!("ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt"),
    pubkey!("DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"),
    pubkey!("3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"),
];

pub const CFG_VERSION: u8 = 1;
pub const CFG_V2: u8 = 2;
pub const CFG_LEN: usize = 128;
pub const CFG2_LEN: usize = 256;
/// init data tag for the compact v2 form (see `init`).
pub const CFG_V2_COMPACT: u8 = 0x82;
/// init data tag for the compact form with v3 rules (see `init`).
pub const CFG_V3_COMPACT: u8 = 0x83;
pub const FLAG_COSIGN: u8 = 1;
pub const FLAG_APP: u8 = 2;
pub const FLAG_VENUE_LOCK: u8 = 4;
/// Not enforced by the hook: tells the graduation to launch the pump.fun coin with holder rewards
/// (its creator fees go to holders forever). On chain so the promise is fixed at launch and public.
pub const FLAG_HOLDER_REWARDS: u8 = 8;
const KNOWN_FLAGS: u8 = FLAG_COSIGN | FLAG_APP | FLAG_VENUE_LOCK | FLAG_HOLDER_REWARDS;
// v2 flags (byte 128)
pub const F2_ALLOW: u8 = 1;
pub const F2_BLOCK: u8 = 2;
pub const F2_BUNDLE: u8 = 4;
pub const F2_HOURS: u8 = 8;
pub const F2_SNIPE: u8 = 16;
const KNOWN_F2: u8 = F2_ALLOW | F2_BLOCK | F2_BUNDLE | F2_HOURS | F2_SNIPE;

/// The list: 8-byte header (count u32, sealed u8, 3 zero) then `count` wallets, strictly ascending.
const LIST_HEADER: usize = 8;
pub const LIST_MAX: u32 = 5_000;
/// Wallets per LIST_ADD (a transaction holds about 30 keys).
const LIST_ADD_MAX: usize = 30;
/// After this long the list can no longer grow, sealed or not.
pub const LIST_OPEN_SECS: i64 = 86_400;
/// The anti-bundle counter: last slot u64, buys in it u32, 4 zero.
const SLOT_LEN: usize = 16;

// errors (custom codes, also in lib/rules.mjs)
const E_MAX_WALLET: u32 = 1;
const E_NOT_COSIGNED: u32 = 2;
const E_NOT_IN_APP: u32 = 3;
const E_VENUE: u32 = 4;
const E_BAD_CONFIG: u32 = 5;
const E_NOT_LISTED: u32 = 6;
const E_BLOCKED: u32 = 7;
const E_TRADE_GUARD: u32 = 8;
const E_HOURS: u32 = 9;
const E_SNIPE: u32 = 10;
const E_BUNDLE: u32 = 11;
const E_LIST_CLOSED: u32 = 12;
const E_LIST_ORDER: u32 = 13;
const E_NOT_DEV: u32 = 14;

/// The per-token config at PDA ["cfg", mint]. v1 is 128 bytes, v2 is 256 (the first 128 identical).
///
/// | off | len | field                                     |
/// |-----|-----|-------------------------------------------|
/// |   0 |   1 | version (1 or 2)                          |
/// |   1 |   1 | flags: 1 cosign, 2 app, 4 venue lock,     |
/// |     |     |        8 pump.fun holder rewards          |
/// |   2 |  32 | dev wallet                                |
/// |  34 |  32 | co-signer (FOMO-only)                     |
/// |  66 |  32 | app program (app-only)                    |
/// |  98 |   2 | max_wallet_bps (0 = no cap)               |
/// | 100 |   8 | launch_ts (written by init from the clock)|
/// | 108 |   4 | early_secs                                |
/// | 112 |   2 | early_max_wallet_bps                      |
/// | 114 |   2 | fee_base_bps        ┐                     |
/// | 116 |   2 | fee_per_sol_bps     │ settlement rules,   |
/// | 118 |   2 | fee_cap_bps         │ applied at          |
/// | 120 |   2 | burn_bps            │ graduation          |
/// | 122 |   2 | holder_share_bps    ┘                     |
/// | 124 |   4 | reserved (zero)                           |
/// |-----|-----|---------------- v2 -----------------------|
/// | 128 |   1 | flags2: 1 allow, 2 block, 4 bundle,       |
/// |     |     |         8 hours, 16 snipe                 |
/// | 129 |   1 | hours_days (bit 0 Sunday … bit 6 Saturday)|
/// | 130 |   2 | trade_guard_bps (0 = off)                 |
/// | 132 |   2 | ramp_start_bps                            |
/// | 134 |   4 | ramp_secs (0 = off)                       |
/// | 138 |   2 | hours_open_min (local minute of the day)  |
/// | 140 |   2 | hours_close_min                           |
/// | 142 |   2 | tz_offset_min (i16, local = UTC + this)   |
/// | 144 |   2 | bundle_max (buys per slot)                |
/// | 146 |   2 | reserved (zero)                           |
/// | 148 |   4 | snipe_secs                                |
/// | 152 |   8 | snipe_max_cu_price (micro-lamports / CU)  |
/// | 160 |   8 | snipe_max_tip (lamports)                  |
/// | 168 |  88 | v3 rules (src/v3.rs)                      |
struct Cfg {
    version: u8,
    flags: u8,
    dev: Pubkey,
    cosigner: Pubkey,
    app: Pubkey,
    max_wallet_bps: u16,
    launch_ts: i64,
    early_secs: u32,
    early_max_wallet_bps: u16,
    flags2: u8,
    hours_days: u8,
    trade_guard_bps: u16,
    ramp_start_bps: u16,
    ramp_secs: u32,
    hours_open_min: u16,
    hours_close_min: u16,
    tz_offset_min: i16,
    bundle_max: u16,
    snipe_secs: u32,
    snipe_max_cu_price: u64,
    snipe_max_tip: u64,
    /// v3 rules (config bytes 168..256; all zero on a token launched before them)
    ext: v3::Ext,
}

fn key_at(d: &[u8], at: usize) -> Result<Pubkey, ProgramError> {
    let b = d.get(at..at + 32).ok_or(ProgramError::InvalidAccountData)?;
    Ok(Pubkey::try_from(b).unwrap())
}
fn u16_at(d: &[u8], at: usize) -> Result<u16, ProgramError> {
    let b = d.get(at..at + 2).ok_or(ProgramError::InvalidAccountData)?;
    Ok(u16::from_le_bytes(b.try_into().unwrap()))
}
fn u32_at(d: &[u8], at: usize) -> Result<u32, ProgramError> {
    let b = d.get(at..at + 4).ok_or(ProgramError::InvalidAccountData)?;
    Ok(u32::from_le_bytes(b.try_into().unwrap()))
}
fn u64_at(d: &[u8], at: usize) -> Result<u64, ProgramError> {
    let b = d.get(at..at + 8).ok_or(ProgramError::InvalidAccountData)?;
    Ok(u64::from_le_bytes(b.try_into().unwrap()))
}

fn read_cfg(d: &[u8]) -> Result<Cfg, ProgramError> {
    let version = *d.first().ok_or(ProgramError::InvalidAccountData)?;
    let len = match version {
        CFG_VERSION => CFG_LEN,
        CFG_V2 => CFG2_LEN,
        _ => return Err(ProgramError::InvalidAccountData),
    };
    if d.len() < len {
        return Err(ProgramError::InvalidAccountData);
    }
    let v2 = version == CFG_V2;
    Ok(Cfg {
        version,
        flags: d[1],
        dev: key_at(d, 2)?,
        cosigner: key_at(d, 34)?,
        app: key_at(d, 66)?,
        max_wallet_bps: u16_at(d, 98)?,
        launch_ts: u64_at(d, 100)? as i64,
        early_secs: u32_at(d, 108)?,
        early_max_wallet_bps: u16_at(d, 112)?,
        flags2: if v2 { d[128] } else { 0 },
        hours_days: if v2 { d[129] } else { 0 },
        trade_guard_bps: if v2 { u16_at(d, 130)? } else { 0 },
        ramp_start_bps: if v2 { u16_at(d, 132)? } else { 0 },
        ramp_secs: if v2 { u32_at(d, 134)? } else { 0 },
        hours_open_min: if v2 { u16_at(d, 138)? } else { 0 },
        hours_close_min: if v2 { u16_at(d, 140)? } else { 0 },
        tz_offset_min: if v2 { u16_at(d, 142)? as i16 } else { 0 },
        bundle_max: if v2 { u16_at(d, 144)? } else { 0 },
        snipe_secs: if v2 { u32_at(d, 148)? } else { 0 },
        snipe_max_cu_price: if v2 { u64_at(d, 152)? } else { 0 },
        snipe_max_tip: if v2 { u64_at(d, 160)? } else { 0 },
        ext: if v2 { v3::Ext::read(d) } else { v3::Ext::default() },
    })
}

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    match <[u8; 8]>::try_from(&data[..8]).unwrap() {
        EXECUTE => execute(program_id, accounts, &data[8..]),
        INIT => init(program_id, accounts, &data[8..]),
        LIST_ADD => list_add(program_id, accounts, &data[8..]),
        LIST_SEAL => list_seal(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn refuse(code: u32) -> ProgramResult {
    Err(ProgramError::Custom(code))
}

fn pda(seed: &[u8], mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[seed, mint.as_ref()], program_id)
}

/// Whether `who` is in a list account's sorted wallets (binary search). A missing list holds nobody.
fn listed(list: &AccountInfo, program_id: &Pubkey, who: &Pubkey) -> Result<bool, ProgramError> {
    if list.owner != program_id || list.data_is_empty() {
        return Ok(false);
    }
    let d = list.try_borrow_data()?;
    let n = u32_at(&d, 0)? as usize;
    if d.len() < LIST_HEADER + n * 32 {
        return Err(ProgramError::InvalidAccountData);
    }
    let (mut lo, mut hi) = (0usize, n);
    let target = who.as_ref();
    while lo < hi {
        let mid = (lo + hi) / 2;
        let at = LIST_HEADER + mid * 32;
        match d[at..at + 32].cmp(target) {
            core::cmp::Ordering::Equal => return Ok(true),
            core::cmp::Ordering::Less => lo = mid + 1,
            core::cmp::Ordering::Greater => hi = mid,
        }
    }
    Ok(false)
}

/// Token-2022 sets the `transferring` flag of the source and destination accounts' TransferHookAccount
/// extension (type 15) while it runs the hook, and clears it after. True only inside a real transfer.
fn transferring(acct: &AccountInfo) -> Result<bool, ProgramError> {
    let d = acct.try_borrow_data()?;
    // base account 165 bytes, then the account type byte, then TLV entries: type u16, len u16, value
    let mut at = 166usize;
    while at + 4 <= d.len() {
        let ty = u16::from_le_bytes([d[at], d[at + 1]]);
        let len = u16::from_le_bytes([d[at + 2], d[at + 3]]) as usize;
        if ty == 0 {
            break;
        }
        if ty == 15 {
            return Ok(len >= 1 && d.get(at + 4) == Some(&1));
        }
        at += 4 + len;
    }
    Ok(false)
}

/// Whether `ts` falls inside the weekly trading hours (local time = UTC + tz_offset_min, plus an hour
/// during daylight saving when the token follows it).
fn in_hours(c: &Cfg, ts: i64) -> bool {
    // v3: daylight saving moves the offset, and US market holidays close the whole local day
    let local = ts + v3::offset_min(&c.ext, ts, c.tz_offset_min) * 60;
    let day = local.div_euclid(86_400);
    if c.ext.f4 & v3::F4_HOLIDAYS != 0 && v3::us_market_holiday(day) {
        return false;
    }
    let minute = (local.rem_euclid(86_400) / 60) as u16;
    let weekday = (day + 4).rem_euclid(7) as u8; // 1970-01-01 was a Thursday; 0 = Sunday
    let open_on = |wd: u8| c.hours_days & (1 << wd) != 0;
    let (open, close) = (c.hours_open_min, c.hours_close_min);
    if open < close {
        open_on(weekday) && minute >= open && minute < close
    } else {
        // overnight: the evening part belongs to today, the early-morning part to yesterday
        (open_on(weekday) && minute >= open) || (open_on((weekday + 6) % 7) && minute < close)
    }
}

fn execute(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // 0 source, 1 mint, 2 destination, 3 owner, 4 extra-account-metas, 5 cfg, 6 instructions sysvar,
    // then (v2) the list if the token has one, then the slot counter if it has anti-bundle
    let [source, mint, dest, _owner, _eaml, cfg_ai, ixs, rest @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (cfg_pda, _) = pda(b"cfg", mint.key, program_id);
    if *cfg_ai.key != cfg_pda || cfg_ai.owner != program_id {
        return Err(ProgramError::InvalidSeeds);
    }
    if *ixs.key != ix_sysvar::ID {
        return Err(ProgramError::UnsupportedSysvar);
    }
    let cfg = read_cfg(&cfg_ai.try_borrow_data()?)?;
    let amount = u64_at(data, 0).unwrap_or(0) as u128;

    // ⛔ every rule below trusts the bytes of source, destination and mint (owners, amounts, the
    // `transferring` flag), so they must be real Token-2022 accounts of THIS mint. Without this a
    // direct `execute` call with a forged "vault mid-transfer" source could fill the anti-bundle
    // counter every block, or another token's hook could pass its own vault in.
    if *source.owner != TOKEN_2022 || *dest.owner != TOKEN_2022 || *mint.owner != TOKEN_2022 {
        return Err(ProgramError::IllegalOwner);
    }
    if key_at(&source.try_borrow_data()?, 0)? != *mint.key || key_at(&dest.try_borrow_data()?, 0)? != *mint.key {
        return Err(ProgramError::InvalidAccountData);
    }

    let mut rest = rest.iter();
    let list_ai = if cfg.flags2 & (F2_ALLOW | F2_BLOCK) != 0 {
        let a = rest.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        if *a.key != pda(b"list", mint.key, program_id).0 {
            return Err(ProgramError::InvalidSeeds);
        }
        Some(a)
    } else {
        None
    };
    let slot_ai = if cfg.flags2 & F2_BUNDLE != 0 {
        let a = rest.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        if *a.key != pda(b"slot", mint.key, program_id).0 || a.owner != program_id {
            return Err(ProgramError::InvalidSeeds);
        }
        Some(a)
    } else {
        None
    };
    let ext = cfg.ext;
    let state_ai = if ext.needs_state() {
        let a = rest.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        if *a.key != pda(b"state", mint.key, program_id).0 || a.owner != program_id || !a.is_writable {
            return Err(ProgramError::InvalidSeeds);
        }
        // ⛔ only a real transfer moves the state: a direct `execute` call cannot steer it
        if !transferring(source)? {
            msg!("state: not inside a transfer");
            return Err(ProgramError::InvalidAccountData);
        }
        Some(a)
    } else {
        None
    };
    let pool_ai = if ext.king() {
        let a = rest.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        v3::check_pool(a, mint.key)?;
        Some(a)
    } else {
        None
    };

    // token account layout: mint 0..32, owner 32..64, amount 64..72
    let dest_owner = key_at(&dest.try_borrow_data()?, 32)?;
    let src_owner = key_at(&source.try_borrow_data()?, 32)?;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let supply = u64_at(&mint.try_borrow_data()?, 36)? as u128;
    let trade = v3::Trade {
        src_owner,
        dest_owner,
        is_buy: src_owner == DBC_POOL_AUTHORITY,
        is_sell: dest_owner == DBC_POOL_AUTHORITY,
        amount,
        supply,
        src_balance: u64_at(&source.try_borrow_data()?, 64)? as u128,
        dev: cfg.dev,
        now,
        slot: clock.slot,
        in_hours: cfg.flags2 & F2_HOURS == 0 || in_hours(&cfg, now),
        tx_fp: if ext.f3 & v3::F3_PING != 0 { v3::tx_fingerprint(ixs)? } else { 0 },
        state: state_ai,
        pool: pool_ai,
    };
    if ext.any() {
        v3::pre(&ext, &trade)?; // v3 sell-side rules and state: the dev and sells are NOT exempt
    }

    if dest_owner == DBC_POOL_AUTHORITY || dest_owner == cfg.dev {
        return Ok(()); // sells into the curve, and the dev wallet, always pass
    }

    // Venue lock: only a real wallet may receive. Pools and escrows are owned by PDAs (off curve).
    if cfg.flags & FLAG_VENUE_LOCK != 0 && !validate_edwards(&PodEdwardsPoint(dest_owner.to_bytes())) {
        msg!("venue lock: {} is not a wallet; window tokens only trade on their curve", dest_owner);
        return refuse(E_VENUE);
    }

    if let Some(list) = list_ai {
        let on = listed(list, program_id, &dest_owner)?;
        if cfg.flags2 & F2_ALLOW != 0 && !on {
            msg!("allowlist: {} is not on this token's list", dest_owner);
            return refuse(E_NOT_LISTED);
        }
        if cfg.flags2 & F2_BLOCK != 0 && on {
            msg!("blocklist: {} may not receive this token", dest_owner);
            return refuse(E_BLOCKED);
        }
    }

    if cfg.trade_guard_bps > 0 && amount * 10_000 > supply * cfg.trade_guard_bps as u128 {
        msg!("trade guard: {} moves more than {} bps of supply", amount, cfg.trade_guard_bps);
        return refuse(E_TRADE_GUARD);
    }

    let is_buy = trade.is_buy;

    if is_buy && cfg.flags & FLAG_COSIGN != 0 {
        let n = {
            let d = ixs.try_borrow_data()?;
            u16::from_le_bytes([d[0], d[1]]) as usize
        };
        let mut cosigned = false;
        for i in 0..n {
            let ix = ix_sysvar::load_instruction_at_checked(i, ixs)?;
            if ix.accounts.iter().any(|m| m.pubkey == cfg.cosigner && m.is_signer) {
                cosigned = true;
                break;
            }
        }
        if !cosigned {
            msg!("FOMO-only: buys must be co-signed by {}", cfg.cosigner);
            return refuse(E_NOT_COSIGNED);
        }
    }

    if is_buy && cfg.flags & FLAG_APP != 0 {
        let current = ix_sysvar::load_current_index_checked(ixs)? as usize;
        let top = ix_sysvar::load_instruction_at_checked(current, ixs)?;
        if top.program_id != cfg.app {
            msg!("app-only: buys must run inside {} (this one runs in {})", cfg.app, top.program_id);
            return refuse(E_NOT_IN_APP);
        }
    }

    if is_buy && cfg.flags2 & F2_HOURS != 0 && !in_hours(&cfg, now) {
        msg!("trading hours: buys are closed right now");
        return refuse(E_HOURS);
    }

    if is_buy && cfg.flags2 & F2_SNIPE != 0 && now < cfg.launch_ts.saturating_add(cfg.snipe_secs as i64) {
        let n = {
            let d = ixs.try_borrow_data()?;
            u16::from_le_bytes([d[0], d[1]]) as usize
        };
        for i in 0..n {
            let ix = ix_sysvar::load_instruction_at_checked(i, ixs)?;
            if ix.program_id == COMPUTE_BUDGET && ix.data.first() == Some(&3) {
                let price = u64_at(&ix.data, 1).unwrap_or(0);
                if price > cfg.snipe_max_cu_price {
                    msg!("sniper-fee cap: priority fee {} µL/CU is above {}", price, cfg.snipe_max_cu_price);
                    return refuse(E_SNIPE);
                }
            }
            if ix.program_id == system_program::ID && ix.data.len() >= 12 && ix.data[..4] == [2, 0, 0, 0] {
                if let Some(to) = ix.accounts.get(1) {
                    if JITO_TIPS.contains(&to.pubkey) && u64_at(&ix.data, 4).unwrap_or(0) > cfg.snipe_max_tip {
                        msg!("sniper-fee cap: a tip above {} lamports", cfg.snipe_max_tip);
                        return refuse(E_SNIPE);
                    }
                }
            }
        }
    }

    if let (true, Some(slot_ai)) = (is_buy, slot_ai) {
        // ⛔ only a real transfer moves the counter: a direct `execute` call cannot jam the token
        if !transferring(source)? {
            msg!("anti-bundle: not inside a transfer");
            return Err(ProgramError::InvalidAccountData);
        }
        if !slot_ai.is_writable {
            return Err(ProgramError::InvalidAccountData);
        }
        let mut d = slot_ai.try_borrow_mut_data()?;
        if d.len() < SLOT_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let last = u64_at(&d, 0)?;
        let count = if last == clock.slot { u32_at(&d, 8)? } else { 0 };
        if count >= cfg.bundle_max as u32 {
            msg!("anti-bundle: {} buys already in slot {}", count, clock.slot);
            return refuse(E_BUNDLE);
        }
        d[0..8].copy_from_slice(&clock.slot.to_le_bytes());
        d[8..12].copy_from_slice(&(count + 1).to_le_bytes());
    }

    // Max per wallet (anti-snipe: a tighter cap during the first early_secs; a ramp raises it over
    // time). Token-2022 calls the hook after it has moved the tokens, so `held` includes this transfer.
    let early = cfg.early_secs > 0 && now < cfg.launch_ts.saturating_add(cfg.early_secs as i64);
    let mut cap_bps = cfg.max_wallet_bps as u128;
    if cfg.ramp_secs > 0 && cap_bps > 0 {
        let elapsed = (now - cfg.launch_ts).clamp(0, cfg.ramp_secs as i64) as u128;
        let start = cfg.ramp_start_bps as u128;
        cap_bps = start + (cap_bps - start) * elapsed / cfg.ramp_secs as u128;
    }
    if early {
        let e = cfg.early_max_wallet_bps as u128;
        cap_bps = if cap_bps == 0 { e } else { cap_bps.min(e) };
    }
    if cap_bps > 0 {
        let held = u64_at(&dest.try_borrow_data()?, 64)? as u128;
        if held * 10_000 > supply * cap_bps {
            msg!("max per wallet{}: {} would hold {} of {} (cap {} bps)", if early { " (launch window)" } else { "" }, dest_owner, held, supply, cap_bps);
            return refuse(E_MAX_WALLET);
        }
    }
    if ext.any() {
        let held = u64_at(&dest.try_borrow_data()?, 64)? as u128;
        v3::post(&ext, &trade, held, cfg.launch_ts)?;
    }
    Ok(())
}

/// Creates a program-owned PDA. ⚠ Anyone can send lamports to a PDA before it exists, which makes
/// `create_account` fail forever — so a pre-funded address is topped up, allocated and assigned.
/// An account that already has an owner or data is refused: a config is written exactly once.
fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    acct: &AccountInfo<'a>,
    sys: &AccountInfo<'a>,
    space: usize,
    program_id: &Pubkey,
    seeds: &[&[u8]],
) -> ProgramResult {
    if *acct.owner != system_program::ID || !acct.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    let need = Rent::get()?.minimum_balance(space);
    let have = acct.lamports();
    if have == 0 {
        return invoke_signed(
            &system_instruction::create_account(payer.key, acct.key, need, space as u64, program_id),
            &[payer.clone(), acct.clone(), sys.clone()],
            &[seeds],
        );
    }
    if have < need {
        invoke(&system_instruction::transfer(payer.key, acct.key, need - have), &[payer.clone(), acct.clone(), sys.clone()])?;
    }
    invoke_signed(&system_instruction::allocate(acct.key, space as u64), &[acct.clone(), sys.clone()], &[seeds])?;
    invoke_signed(&system_instruction::assign(acct.key, program_id), &[acct.clone(), sys.clone()], &[seeds])
}

/// One ExtraAccountMeta: a PDA of this program from a literal and the mint (account 1).
fn meta_pda(literal: &[u8], writable: bool) -> [u8; 35] {
    let mut e = [0u8; 35];
    e[0] = 1;
    e[1] = 1; // Literal
    e[2] = literal.len() as u8;
    e[3..3 + literal.len()].copy_from_slice(literal);
    e[3 + literal.len()] = 3; // AccountKey
    e[4 + literal.len()] = 1; // index 1 = the mint
    e[34] = writable as u8;
    e
}

/// data = the 128-byte (v1) or 256-byte (v2) config with launch_ts left zero (init writes it), or
/// the compact v2 form (tag 0x82) that leaves out the dev (= the payer) and every zero byte.
/// Accounts: 0 payer(s,w), 1 extra-account-metas(w), 2 mint(s), 3 cfg(w), 4 system program,
/// and for a v2 config with anti-bundle the slot counter (w), then with v3 rules that keep state the
/// state account (w), then for King of the Hill the token's Meteora pool.
///
/// ⛔ The MINT must sign. Meteora needs the mint's own key to create the pool, so its signature
/// proves the caller is the launcher; without it a stranger could set another token's rules first.
/// The mint need not exist yet, so init rides in the same transaction as the pool creation.
fn init(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [payer, eaml, mint, cfg, sys, rest @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !mint.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *sys.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let mut buf = [0u8; CFG2_LEN];
    let len = match data.first() {
        Some(&CFG_VERSION) => {
            buf[..CFG_LEN].copy_from_slice(data.get(..CFG_LEN).ok_or(ProgramError::InvalidInstructionData)?);
            CFG_LEN
        }
        Some(&CFG_V2) => {
            buf.copy_from_slice(data.get(..CFG2_LEN).ok_or(ProgramError::InvalidInstructionData)?);
            CFG2_LEN
        }
        // ⭐ compact v2, so a launch fits one transaction: [0x82, flags, cosigner if FOMO-only, app if
        // app-only, then config bytes 98..168]. The dev wallet is the payer, who signs; the rest is zero.
        // ⭐ compact v3: the same, then ext_len u8 and config bytes 168..168+ext_len (trailing zeros left out)
        Some(&tag @ (CFG_V2_COMPACT | CFG_V3_COMPACT)) => {
            let flags = *data.get(1).ok_or(ProgramError::InvalidInstructionData)?;
            buf[0] = CFG_V2;
            buf[1] = flags;
            buf[2..34].copy_from_slice(payer.key.as_ref());
            let mut at = 2usize;
            if flags & FLAG_COSIGN != 0 {
                buf[34..66].copy_from_slice(data.get(at..at + 32).ok_or(ProgramError::InvalidInstructionData)?);
                at += 32;
            }
            if flags & FLAG_APP != 0 {
                buf[66..98].copy_from_slice(data.get(at..at + 32).ok_or(ProgramError::InvalidInstructionData)?);
                at += 32;
            }
            buf[98..168].copy_from_slice(data.get(at..at + 70).ok_or(ProgramError::InvalidInstructionData)?);
            at += 70;
            if tag == CFG_V3_COMPACT {
                let n = *data.get(at).ok_or(ProgramError::InvalidInstructionData)? as usize;
                if n > v3::EXT_LEN {
                    return Err(ProgramError::InvalidInstructionData);
                }
                buf[v3::EXT_AT..v3::EXT_AT + n].copy_from_slice(data.get(at + 1..at + 1 + n).ok_or(ProgramError::InvalidInstructionData)?);
                at += 1 + n;
            }
            if data.len() != at {
                return Err(ProgramError::InvalidInstructionData);
            }
            CFG2_LEN
        }
        _ => return refuse(E_BAD_CONFIG),
    };
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    buf[100..108].copy_from_slice(&Clock::get()?.unix_timestamp.to_le_bytes());
    validate(&buf[..len])?;

    let (eaml_pda, eb) = pda(b"extra-account-metas", mint.key, program_id);
    let (cfg_pda, cb) = pda(b"cfg", mint.key, program_id);
    if eaml_pda != *eaml.key || cfg_pda != *cfg.key {
        return Err(ProgramError::InvalidSeeds);
    }
    create_pda(payer, cfg, sys, len, program_id, &[b"cfg", mint.key.as_ref(), &[cb]])?;
    cfg.try_borrow_mut_data()?[..len].copy_from_slice(&buf[..len]);

    // the extra accounts every transfer needs, in the order `execute` reads them
    let flags2 = if len == CFG2_LEN { buf[128] } else { 0 };
    let mut metas: Vec<[u8; 35]> = Vec::with_capacity(4);
    metas.push(meta_pda(b"cfg", false));
    let mut sysvar_meta = [0u8; 35];
    sysvar_meta[1..33].copy_from_slice(ix_sysvar::ID.as_ref()); // discriminator 0 = fixed address
    metas.push(sysvar_meta);
    if flags2 & (F2_ALLOW | F2_BLOCK) != 0 {
        metas.push(meta_pda(b"list", false));
    }
    if flags2 & F2_BUNDLE != 0 {
        let slot = rest.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let (slot_pda, sb) = pda(b"slot", mint.key, program_id);
        if *slot.key != slot_pda {
            return Err(ProgramError::InvalidSeeds);
        }
        create_pda(payer, slot, sys, SLOT_LEN, program_id, &[b"slot", mint.key.as_ref(), &[sb]])?;
        metas.push(meta_pda(b"slot", true));
    }
    let ext = if len == CFG2_LEN { v3::Ext::read(&buf) } else { v3::Ext::default() };
    let mut rest = rest.iter().skip(if flags2 & F2_BUNDLE != 0 { 1 } else { 0 });
    if ext.needs_state() {
        let state = rest.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        let (state_pda, sb) = pda(b"state", mint.key, program_id);
        if *state.key != state_pda {
            return Err(ProgramError::InvalidSeeds);
        }
        create_pda(payer, state, sys, ext.state_len(), program_id, &[b"state", mint.key.as_ref(), &[sb]])?;
        v3::init_state(&ext, &mut state.try_borrow_mut_data()?);
        metas.push(meta_pda(b"state", true));
    }
    if ext.king() {
        // the token's own Meteora pool (created earlier in the launch transaction), at a fixed address
        let pool = rest.next().ok_or(ProgramError::NotEnoughAccountKeys)?;
        v3::check_pool(pool, mint.key)?;
        let mut m = [0u8; 35]; // discriminator 0 = fixed address, read-only
        m[1..33].copy_from_slice(pool.key.as_ref());
        metas.push(m);
    }

    // TLV: EXECUTE disc (8) | len u32 (4 + n*35) | count u32 | n × ExtraAccountMeta (35 bytes)
    let n = metas.len();
    let size = 8 + 4 + 4 + n * 35;
    create_pda(payer, eaml, sys, size, program_id, &[b"extra-account-metas", mint.key.as_ref(), &[eb]])?;
    let mut d = eaml.try_borrow_mut_data()?;
    d[..8].copy_from_slice(&EXECUTE);
    d[8..12].copy_from_slice(&((4 + n * 35) as u32).to_le_bytes());
    d[12..16].copy_from_slice(&(n as u32).to_le_bytes());
    for (i, m) in metas.iter().enumerate() {
        d[16 + i * 35..16 + (i + 1) * 35].copy_from_slice(m);
    }
    Ok(())
}

/// The checks LIST_ADD and LIST_SEAL share: a v2 token with a list, signed by its dev.
/// Accounts: 0 dev(s,w), 1 mint, 2 cfg, 3 list(w), 4 system program.
fn list_accounts<'a, 'b>(program_id: &Pubkey, accounts: &'b [AccountInfo<'a>]) -> Result<(Cfg, u8, &'b [AccountInfo<'a>]), ProgramError> {
    let [dev, mint, cfg_ai, list, sys, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if *cfg_ai.key != pda(b"cfg", mint.key, program_id).0 || cfg_ai.owner != program_id {
        return Err(ProgramError::InvalidSeeds);
    }
    let cfg = read_cfg(&cfg_ai.try_borrow_data()?)?;
    if cfg.version != CFG_V2 || cfg.flags2 & (F2_ALLOW | F2_BLOCK) == 0 {
        msg!("this token has no list");
        return Err(ProgramError::Custom(E_BAD_CONFIG));
    }
    if !dev.is_signer || *dev.key != cfg.dev {
        msg!("only the token's dev wallet can change its list");
        return Err(ProgramError::Custom(E_NOT_DEV));
    }
    if *sys.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let (list_pda, lb) = pda(b"list", mint.key, program_id);
    if *list.key != list_pda {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok((cfg, lb, &accounts[..5]))
}

/// Appends up to 30 wallets (strictly ascending, all above the last one already listed) to the
/// token's list. Only the dev, only before the list is sealed, only in the first day after launch.
fn list_add(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (cfg, lb, a) = list_accounts(program_id, accounts)?;
    let (dev, mint, list, sys) = (&a[0], &a[1], &a[3], &a[4]);
    if Clock::get()?.unix_timestamp >= cfg.launch_ts.saturating_add(LIST_OPEN_SECS) {
        msg!("the list can only grow in the first day after launch");
        return refuse(E_LIST_CLOSED);
    }
    if data.is_empty() || data.len() % 32 != 0 || data.len() / 32 > LIST_ADD_MAX {
        return Err(ProgramError::InvalidInstructionData);
    }
    let add = data.len() / 32;
    if list.owner != program_id || list.data_is_empty() {
        create_pda(dev, list, sys, LIST_HEADER, program_id, &[b"list", mint.key.as_ref(), &[lb]])?;
    }
    let (count, sealed) = {
        let d = list.try_borrow_data()?;
        (u32_at(&d, 0)? as usize, d[4])
    };
    if sealed != 0 {
        msg!("the list is sealed");
        return refuse(E_LIST_CLOSED);
    }
    if count + add > LIST_MAX as usize {
        msg!("a list holds at most {} wallets", LIST_MAX);
        return refuse(E_LIST_CLOSED);
    }
    let new_len = LIST_HEADER + (count + add) * 32;
    let need = Rent::get()?.minimum_balance(new_len);
    if list.lamports() < need {
        invoke(&system_instruction::transfer(dev.key, list.key, need - list.lamports()), &[dev.clone(), list.clone(), sys.clone()])?;
    }
    #[allow(deprecated)]
    list.realloc(new_len, true)?;
    let mut d = list.try_borrow_mut_data()?;
    let mut prev: Option<[u8; 32]> = if count > 0 {
        let at = LIST_HEADER + (count - 1) * 32;
        Some(d[at..at + 32].try_into().unwrap())
    } else {
        None
    };
    for i in 0..add {
        let k: [u8; 32] = data[i * 32..(i + 1) * 32].try_into().unwrap();
        if prev.map_or(false, |p| k <= p) {
            msg!("wallets must be added in strictly ascending order");
            return refuse(E_LIST_ORDER);
        }
        let at = LIST_HEADER + (count + i) * 32;
        d[at..at + 32].copy_from_slice(&k);
        prev = Some(k);
    }
    d[0..4].copy_from_slice(&((count + add) as u32).to_le_bytes());
    Ok(())
}

/// Seals the list for good (creating it empty if it was never filled). Only the dev.
fn list_seal(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let (_cfg, lb, a) = list_accounts(program_id, accounts)?;
    let (dev, mint, list, sys) = (&a[0], &a[1], &a[3], &a[4]);
    if list.owner != program_id || list.data_is_empty() {
        create_pda(dev, list, sys, LIST_HEADER, program_id, &[b"list", mint.key.as_ref(), &[lb]])?;
    }
    list.try_borrow_mut_data()?[4] = 1;
    Ok(())
}

/// Rejects a config that would brick or mislead. Mirrors `validateRules` in lib/rules.mjs.
fn validate(c: &[u8]) -> ProgramResult {
    let bad = |why: &str| -> ProgramResult {
        msg!("bad config: {}", why);
        refuse(E_BAD_CONFIG)
    };
    let v2 = match (c.first(), c.len()) {
        (Some(&CFG_VERSION), CFG_LEN) => false,
        (Some(&CFG_V2), CFG2_LEN) => true,
        _ => return bad("version"),
    };
    let flags = c[1];
    if flags & !KNOWN_FLAGS != 0 {
        return bad("unknown flag");
    }
    if key_at(c, 2)? == Pubkey::default() {
        return bad("dev wallet");
    }
    if (flags & FLAG_COSIGN != 0) != (key_at(c, 34)? != Pubkey::default()) {
        return bad("co-signer must be set exactly when FOMO-only is on");
    }
    if (flags & FLAG_APP != 0) != (key_at(c, 66)? != Pubkey::default()) {
        return bad("app program must be set exactly when app-only is on");
    }
    let max_wallet = u16_at(c, 98)?;
    let early_secs = u32_at(c, 108)?;
    let early_cap = u16_at(c, 112)?;
    // 0.1%..100% when on; anything tighter leaves the curve unsellable to anyone
    if max_wallet != 0 && !(10..=10_000).contains(&max_wallet) {
        return bad("max per wallet");
    }
    if early_secs > 86_400 {
        return bad("launch window longer than a day");
    }
    if early_secs > 0 && !(10..=10_000).contains(&early_cap) {
        return bad("launch-window cap");
    }
    if early_secs == 0 && early_cap != 0 {
        return bad("launch-window cap without a window");
    }
    let (fee_base, fee_per_sol, fee_cap) = (u16_at(c, 114)?, u16_at(c, 116)?, u16_at(c, 118)?);
    let (burn, share) = (u16_at(c, 120)?, u16_at(c, 122)?);
    if fee_cap > 2_000 || fee_base > fee_cap || (fee_per_sol > 0 && fee_cap == 0) {
        return bad("dynamic fee (cap at most 20%, base at most the cap)");
    }
    if burn > 2_000 || fee_cap as u32 + burn as u32 > 3_000 {
        return bad("burn (at most 20%, fee + burn at most 30%)");
    }
    if share > 10_000 {
        return bad("holder share");
    }
    if c[124..128] != [0, 0, 0, 0] {
        return bad("reserved bytes");
    }
    if !v2 {
        return Ok(());
    }

    let f2 = c[128];
    if f2 & !KNOWN_F2 != 0 {
        return bad("unknown v2 flag");
    }
    if f2 & F2_ALLOW != 0 && f2 & F2_BLOCK != 0 {
        return bad("allowlist and blocklist together");
    }
    let guard = u16_at(c, 130)?;
    if guard != 0 && !(10..=10_000).contains(&guard) {
        return bad("trade guard (0.1%..100%)");
    }
    let (ramp_start, ramp_secs) = (u16_at(c, 132)?, u32_at(c, 134)?);
    if ramp_secs > 0 {
        if max_wallet == 0 || ramp_secs > 7 * 86_400 || !(10..max_wallet).contains(&ramp_start) {
            return bad("rising max per wallet (needs a max, starts below it, at most a week)");
        }
    } else if ramp_start != 0 {
        return bad("ramp start without a ramp");
    }
    let (days, open, close, tz) = (c[129], u16_at(c, 138)?, u16_at(c, 140)?, u16_at(c, 142)? as i16);
    if f2 & F2_HOURS != 0 {
        if days == 0 || days >= 128 || open >= 1_440 || close >= 1_440 || open == close || !(-720..=840).contains(&tz) {
            return bad("trading hours");
        }
    } else if days != 0 || open != 0 || close != 0 || tz != 0 {
        return bad("trading hours without the rule");
    }
    let bundle = u16_at(c, 144)?;
    if f2 & F2_BUNDLE != 0 {
        if !(1..=20).contains(&bundle) {
            return bad("anti-bundle (1..20 buys per slot)");
        }
    } else if bundle != 0 {
        return bad("anti-bundle without the rule");
    }
    let snipe_secs = u32_at(c, 148)?;
    let (cu, tip) = (u64_at(c, 152)?, u64_at(c, 160)?);
    if f2 & F2_SNIPE != 0 {
        if !(1..=86_400).contains(&snipe_secs) {
            return bad("sniper-fee cap window (1 second to a day)");
        }
    } else if snipe_secs != 0 || cu != 0 || tip != 0 {
        return bad("sniper-fee cap without the rule");
    }
    if c[146..148] != [0, 0] {
        return bad("reserved bytes");
    }
    v3::validate(c, &bad)
}
