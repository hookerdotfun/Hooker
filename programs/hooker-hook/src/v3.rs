//! v3 rules: the 88 config bytes v2 kept reserved (168..256) plus, for the rules that remember
//! something, one writable account per token ["state", mint]. A v2 token has zeros there, so none of
//! this runs for it: live tokens keep exactly the behaviour they launched with.
//!
//! Sell side (checked for everyone, the dev included, before the "sells always pass" exit):
//!  * ANTI-DUMP CAPS — max per sell (and, after the dev exit, max per buy), as a share of supply.
//!  * GRADUATED SELL CAPS — the bigger the seller's bag, the smaller one sell can be, down to a floor.
//!  * DEX-ONLY — no wallet-to-wallet sends: every move is a trade with the curve.
//!  * P2P-ONLY — nobody sells to the curve and only the dev buys from it; tokens move wallet to wallet.
//!  * TRADING HOURS (v3 options) — close sells too; follow US or EU daylight saving; skip US market
//!    holidays (NYSE full-day closures, computed on chain).
//!  * HOT POTATO — the last qualifying buyer cannot sell or send until a different wallet buys after
//!    them, or the potato goes cold.
//!  * PING PONG — buys and sells take turns. A trade under the minimum goes through on its own turn
//!    without handing it over; nobody takes both turns in one transaction (the turn remembers the
//!    slot and a fingerprint of the transaction that took it). ⛔ Not "one turn per slot": a wallet's
//!    preflight simulation runs on the last CONFIRMED bank, whose clock still shows the slot of the
//!    previous turn, so a per-slot rule refuses honest trades in simulation for a second after each turn.
//!  * KING OF THE HILL — the biggest qualifying buy (valued in SOL at the pool's price) holds the
//!    crown; selling or sending any tokens gives it up; the bar to beat decays by halving. The hook
//!    records the value traded during each reign in a ring of the last 32 reigns; the keeper pays the
//!    King their share from it (a hook cannot move SOL).
//!
//! Buy / receive side (after the dev exit):
//!  * PLAGUE — a wallet can only buy once it already holds the infection dose.
//!  * CHAPTERS — a max per wallet that doubles every time total traded volume crosses a chapter.
//!  * OSCILLATORS — the per-buy cap is base × (1 + x), floored, where x is
//!      breathing: a sine of the launch clock;
//!      momentum / resonance: a damped oscillator every buy kicks;
//!      coupled: two such oscillators coupled (two normal modes, so the cap beats).
//!    The oscillator's exact 1-second step is computed once at init (Taylor series of the matrix
//!    exponential, fixed point) and raised to the elapsed seconds by squaring on each buy.
//!
//! ⛔ Every state write needs Token-2022's `transferring` flag on the source: only a real transfer
//! moves the state, never a direct `execute` call.

use solana_program::{account_info::AccountInfo, msg, program_error::ProgramError, pubkey, pubkey::Pubkey};

pub const EXT_AT: usize = 168;
pub const EXT_LEN: usize = 88;

// flags3 (byte 168)
pub const F3_SIDE_CAPS: u8 = 1;
pub const F3_SELL_SCALE: u8 = 2;
pub const F3_PLAGUE: u8 = 4;
pub const F3_DEX_ONLY: u8 = 8;
pub const F3_P2P: u8 = 16;
pub const F3_POTATO: u8 = 32;
pub const F3_PING: u8 = 64;
pub const F3_CHAPTERS: u8 = 128;
// flags4 (byte 169)
pub const F4_KING: u8 = 1;
pub const F4_HOURS_SELLS: u8 = 2;
pub const F4_HOLIDAYS: u8 = 4;
/// bits 3..4: daylight saving (0 none, 1 US, 2 EU)
pub const F4_DST_SHIFT: u8 = 3;
pub const F4_DST_MASK: u8 = 3 << F4_DST_SHIFT;
const KNOWN_F4: u8 = F4_KING | F4_HOURS_SELLS | F4_HOLIDAYS | F4_DST_MASK;
// oscillator kind (byte 170)
pub const OSC_BREATH: u8 = 1;
pub const OSC_MOMENTUM: u8 = 2;
pub const OSC_RESONANCE: u8 = 3;
pub const OSC_COUPLED: u8 = 4;

pub const E_BUY_CAP: u32 = 15;
pub const E_SELL_CAP: u32 = 16;
pub const E_PLAGUE: u32 = 17;
pub const E_DEX_ONLY: u32 = 18;
pub const E_P2P: u32 = 19;
pub const E_HOURS_SELL: u32 = 20;
pub const E_POTATO: u32 = 21;
pub const E_PING: u32 = 22;
pub const E_OSC: u32 = 23;
pub const E_CHAPTER: u32 = 24;

pub const DBC_PROGRAM: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
/// Meteora's `TransferHookPool` account (a hooked token's pool; same layout as `VirtualPool`, other discriminator).
const POOL_DISC: [u8; 8] = [237, 219, 184, 23, 42, 189, 169, 35];
const POOL_BASE_MINT: usize = 136;
const POOL_SQRT_PRICE: usize = 280;

/// Config bytes 168..256.
///
/// | off | len | field                                               |
/// |-----|-----|-----------------------------------------------------|
/// | 168 |   1 | flags3                                              |
/// | 169 |   1 | flags4                                              |
/// | 170 |   1 | oscillator kind                                     |
/// | 171 |   1 | reserved (zero)                                     |
/// | 172 |   2 | max_buy_bps (anti-dump, 0 = no buy cap)             |
/// | 174 |   2 | max_sell_bps (anti-dump, 0 = no sell cap)           |
/// | 176 |   2 | sell_small_bps (graduated: cap for small holders)   |
/// | 178 |   2 | sell_floor_bps (graduated: cap for the biggest bags)|
/// | 180 |   2 | sell_bag_bps (graduated: bag that gets the floor)   |
/// | 182 |   8 | plague_dose (base units)                            |
/// | 190 |   2 | potato_min_bps                                      |
/// | 192 |   4 | potato_cold_secs (0 = never)                        |
/// | 196 |   2 | ping_min_bps                                        |
/// | 198 |   4 | ping_free_secs (0 = never)                          |
/// | 202 |   2 | chapter_start_bps                                   |
/// | 204 |   8 | chapter_volume (base units)                         |
/// | 212 |   2 | osc_period_secs                                     |
/// | 214 |   2 | osc_base_bps                                        |
/// | 216 |   2 | osc_floor_bps                                       |
/// | 218 |   2 | osc_amp_pct (breathing: swing; others: buy energy)  |
/// | 220 |   2 | osc_damp_permille (per second)                      |
/// | 222 |   2 | osc_coupling_pct                                    |
/// | 224 |   8 | king_min_lamports                                   |
/// | 232 |   1 | king_beat_pct                                       |
/// | 233 |   1 | king_decay_unit (0 never, 1 min, 2 hour, 3 day)     |
/// | 234 |   2 | king_decay_n                                        |
/// | 236 |   1 | king_dev_can (0/1)                                  |
/// | 237 |  19 | reserved (zero)                                     |
#[derive(Default, Clone, Copy)]
pub struct Ext {
    pub f3: u8,
    pub f4: u8,
    pub osc: u8,
    pub max_buy_bps: u16,
    pub max_sell_bps: u16,
    pub sell_small_bps: u16,
    pub sell_floor_bps: u16,
    pub sell_bag_bps: u16,
    pub plague_dose: u64,
    pub potato_min_bps: u16,
    pub potato_cold_secs: u32,
    pub ping_min_bps: u16,
    pub ping_free_secs: u32,
    pub chapter_start_bps: u16,
    pub chapter_volume: u64,
    pub osc_period: u16,
    pub osc_base_bps: u16,
    pub osc_floor_bps: u16,
    pub osc_amp_pct: u16,
    pub osc_damp: u16,
    pub osc_coupling: u16,
    pub king_min: u64,
    pub king_beat_pct: u8,
    pub king_decay_unit: u8,
    pub king_decay_n: u16,
    pub king_dev_can: u8,
}

fn u16_at(d: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([d[at], d[at + 1]])
}
fn u32_at(d: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(d[at..at + 4].try_into().unwrap())
}
fn u64_at(d: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(d[at..at + 8].try_into().unwrap())
}
fn i64_at(d: &[u8], at: usize) -> i64 {
    i64::from_le_bytes(d[at..at + 8].try_into().unwrap())
}
fn put_i64(d: &mut [u8], at: usize, v: i64) {
    d[at..at + 8].copy_from_slice(&v.to_le_bytes());
}
fn put_u64(d: &mut [u8], at: usize, v: u64) {
    d[at..at + 8].copy_from_slice(&v.to_le_bytes());
}

impl Ext {
    /// `c` is a whole 256-byte v2 config.
    pub fn read(c: &[u8]) -> Ext {
        Ext {
            f3: c[168],
            f4: c[169],
            osc: c[170],
            max_buy_bps: u16_at(c, 172),
            max_sell_bps: u16_at(c, 174),
            sell_small_bps: u16_at(c, 176),
            sell_floor_bps: u16_at(c, 178),
            sell_bag_bps: u16_at(c, 180),
            plague_dose: u64_at(c, 182),
            potato_min_bps: u16_at(c, 190),
            potato_cold_secs: u32_at(c, 192),
            ping_min_bps: u16_at(c, 196),
            ping_free_secs: u32_at(c, 198),
            chapter_start_bps: u16_at(c, 202),
            chapter_volume: u64_at(c, 204),
            osc_period: u16_at(c, 212),
            osc_base_bps: u16_at(c, 214),
            osc_floor_bps: u16_at(c, 216),
            osc_amp_pct: u16_at(c, 218),
            osc_damp: u16_at(c, 220),
            osc_coupling: u16_at(c, 222),
            king_min: u64_at(c, 224),
            king_beat_pct: c[232],
            king_decay_unit: c[233],
            king_decay_n: u16_at(c, 234),
            king_dev_can: c[236],
        }
    }
    pub fn any(&self) -> bool {
        self.f3 != 0 || self.f4 != 0 || self.osc != 0
    }
    pub fn king(&self) -> bool {
        self.f4 & F4_KING != 0
    }
    pub fn dst(&self) -> u8 {
        (self.f4 & F4_DST_MASK) >> F4_DST_SHIFT
    }
    /// Rules that keep state in ["state", mint].
    pub fn needs_state(&self) -> bool {
        self.f3 & (F3_POTATO | F3_PING | F3_CHAPTERS) != 0 || self.king() || matches!(self.osc, OSC_MOMENTUM | OSC_RESONANCE | OSC_COUPLED)
    }
    pub fn state_len(&self) -> usize {
        if self.king() { STATE_LEN + RING_N * RING_ENTRY } else { STATE_LEN }
    }
}

// ── state account ["state", mint] ────────────────────────────────────────────────────────────────
//   0  32 potato holder          32   8 potato since (i64)
//  40   1 ping next (0 any, 1 buy, 2 sell)   44 4 fingerprint of the transaction that took the last turn
//  48   8 ping last turn ts                 56 8 ping last turn slot
//  64  16 volume traded (u128, base units)
//  80   8 oscillator last ts     88..120 mode 1 x, v, mode 2 x, v (i64 Q32)
// 120  32 step matrix mode 1 (4 × i64 Q32)                     152 32 step matrix mode 2
// 184   8 kick mode 1 (Q32)      192   8 kick mode 2 (Q32)
// 200  32 King                   232   8 King's winning buy (lamports)   240 8 crowned at (i64)
// 248   4 reign (u32, 0 = never had a King)                    252 4 zero
// 256  RING_N × RING_ENTRY: King 32, reign u32, ended u32, value traded during the reign u64 (lamports)
pub const STATE_LEN: usize = 256;
pub const RING_N: usize = 32;
pub const RING_ENTRY: usize = 48;

const Q: i128 = 1 << 32;
const TWO_PI_Q: i128 = 26_986_075_409;
const TWO_PI_SQ_Q: i128 = 169_558_512_509;
const PI_Q: i128 = 13_493_037_705;
const HALF_PI_Q: i128 = 6_746_518_852;
/// |x| and |v| stay within this, so the cap stays sane and nothing overflows.
const OSC_LIMIT: i128 = 16 * Q;

type M2 = [i128; 4];
const ID: M2 = [Q, 0, 0, Q];
fn mmul(a: &M2, b: &M2) -> M2 {
    [
        (a[0] * b[0] + a[1] * b[2]) >> 32,
        (a[0] * b[1] + a[1] * b[3]) >> 32,
        (a[2] * b[0] + a[3] * b[2]) >> 32,
        (a[2] * b[1] + a[3] * b[3]) >> 32,
    ]
}

/// exp(A·1s) for x'' = -w2·x - 2γ·x', A = [[0, 1], [-w2, -2γ]], by its Taylor series (‖A‖ ≲ 1).
pub fn step_matrix(w2: i128, two_gamma: i128) -> M2 {
    let a: M2 = [0, Q, -w2, -two_gamma];
    let mut term = ID;
    let mut sum = ID;
    for k in 1..=24i128 {
        term = mmul(&term, &a);
        for t in term.iter_mut() {
            *t /= k;
        }
        for i in 0..4 {
            sum[i] += term[i];
        }
    }
    sum
}

fn mpow(m: &M2, mut e: u64) -> M2 {
    let (mut r, mut b) = (ID, *m);
    while e > 0 {
        if e & 1 == 1 {
            r = mmul(&r, &b);
        }
        e >>= 1;
        if e > 0 {
            b = mmul(&b, &b);
        }
    }
    r
}

/// sin(2π·p) for a phase p in [0, Q), Q32 in and out.
pub fn sin_turn(p: i128) -> i128 {
    let mut x = (p * TWO_PI_Q) >> 32; // [0, 2π)
    if x > PI_Q {
        x -= 2 * PI_Q; // (-π, π]
    }
    if x > HALF_PI_Q {
        x = PI_Q - x;
    } else if x < -HALF_PI_Q {
        x = -PI_Q - x;
    }
    // x − x³/3! + x⁵/5! − … to x¹³: error far below one Q32 step on [-π/2, π/2]
    let x2 = (x * x) >> 32;
    let mut term = x;
    let mut sum = x;
    let mut k = 1i128;
    for _ in 0..6 {
        term = -((term * x2) >> 32) / ((k + 1) * (k + 2));
        k += 2;
        sum += term;
    }
    sum
}

/// The oscillator constants init writes into the state (step matrices and kicks, Q32).
pub fn osc_constants(e: &Ext) -> (M2, M2, i128, i128) {
    let t = e.osc_period as i128;
    let w2 = TWO_PI_SQ_Q / (t * t);
    let w = TWO_PI_Q / t;
    let two_gamma = 2 * (e.osc_damp as i128) * Q / 1000;
    let kick = w * e.osc_amp_pct as i128 / 100;
    match e.osc {
        OSC_COUPLED => {
            // two identical oscillators, coupling κ: normal modes at w² and w²(1 + 2κ); a kick on
            // the first oscillator's velocity is half in each mode, and its position is their sum
            let w2a = w2 * (100 + 2 * e.osc_coupling as i128) / 100;
            (step_matrix(w2, two_gamma), step_matrix(w2a, two_gamma), kick / 2, kick / 2)
        }
        _ => (step_matrix(w2, two_gamma), [0; 4], kick, 0),
    }
}

pub fn init_state(e: &Ext, d: &mut [u8]) {
    if matches!(e.osc, OSC_MOMENTUM | OSC_RESONANCE | OSC_COUPLED) {
        let (m1, m2, k1, k2) = osc_constants(e);
        for i in 0..4 {
            put_i64(d, 120 + i * 8, m1[i] as i64);
            put_i64(d, 152 + i * 8, m2[i] as i64);
        }
        put_i64(d, 184, k1 as i64);
        put_i64(d, 192, k2 as i64);
    }
}

/// After this many seconds without a buy the oscillator has decayed below one Q32 step: e^{-rt} < 2^-34
/// for its slowest rate r, which is γ when underdamped and at least ω0²/2γ when overdamped.
fn osc_quiet_after(e: &Ext) -> i64 {
    let (d, t) = (e.osc_damp.max(1) as i64, e.osc_period as i64);
    (23_570 / d).max(2_357 * t * t * d / 1_973_900)
}

/// Brings the oscillator state to `now` and returns its displacement (Q32).
fn osc_advance(e: &Ext, s: &mut [u8], now: i64) -> i128 {
    let last = i64_at(s, 80);
    let dt = now - last;
    let modes = if e.osc == OSC_COUPLED { 2 } else { 1 };
    let mut x = 0i128;
    for m in 0..modes {
        let at = 88 + m * 16;
        let (mut px, mut pv) = (i64_at(s, at) as i128, i64_at(s, at + 8) as i128);
        if last == 0 || dt > osc_quiet_after(e) {
            px = 0;
            pv = 0;
        } else if dt > 0 {
            let mat_at = 120 + m * 32;
            let mm: M2 = [0, 1, 2, 3].map(|i| i64_at(s, mat_at + i * 8) as i128);
            let p = mpow(&mm, dt as u64);
            let nx = (p[0] * px + p[1] * pv) >> 32;
            let nv = (p[2] * px + p[3] * pv) >> 32;
            px = nx.clamp(-OSC_LIMIT, OSC_LIMIT);
            pv = nv.clamp(-OSC_LIMIT, OSC_LIMIT);
        }
        put_i64(s, at, px as i64);
        put_i64(s, at + 8, pv as i64);
        x += px;
    }
    put_i64(s, 80, now);
    x
}

/// The per-buy cap right now, bps of supply (breathing needs no state).
fn osc_cap_bps(e: &Ext, x: i128) -> u128 {
    let cap = (e.osc_base_bps as i128) * (Q + x) / Q;
    cap.clamp(e.osc_floor_bps as i128, 10_000) as u128
}

// ── trading hours: daylight saving and US market holidays ───────────────────────────────────────

/// (year, month 1..12, day 1..31) of a day number (days since 1970-01-01). Howard Hinnant's algorithm.
pub fn civil(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
pub fn days(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
/// 0 = Sunday … 6 = Saturday.
pub fn weekday(z: i64) -> i64 {
    (z + 4).rem_euclid(7)
}
/// The n-th (1-based) `wd` of a month, or the last one when n = 0.
fn nth_weekday(y: i64, m: u32, wd: i64, n: i64) -> i64 {
    if n == 0 {
        let next = if m == 12 { days(y + 1, 1, 1) } else { days(y, m + 1, 1) };
        let last = next - 1;
        return last - (weekday(last) - wd).rem_euclid(7);
    }
    let first = days(y, m, 1);
    first + (wd - weekday(first)).rem_euclid(7) + 7 * (n - 1)
}
fn easter(y: i64) -> i64 {
    let a = y % 19;
    let b = y / 100;
    let c = y % 100;
    let d = b / 4;
    let e = b % 4;
    let f = (b + 8) / 25;
    let g = (b - f + 1) / 3;
    let h = (19 * a + b - d - g + 15) % 30;
    let i = c / 4;
    let k = c % 4;
    let l = (32 + 2 * e + 2 * i - h - k) % 7;
    let m = (a + 11 * h + 22 * l) / 451;
    let month = (h + l - 7 * m + 114) / 31;
    let day = (h + l - 7 * m + 114) % 31 + 1;
    days(y, month as u32, day as u32)
}
/// A fixed-date holiday moved off a weekend (Saturday → Friday, Sunday → Monday).
fn observed(z: i64) -> i64 {
    match weekday(z) {
        6 => z - 1,
        0 => z + 1,
        _ => z,
    }
}
/// NYSE full-day closures on day `z`.
pub fn us_market_holiday(z: i64) -> bool {
    let (y, _, _) = civil(z);
    // New Year's Day: a Saturday New Year is not made up on the Friday before (NYSE rule)
    let ny = days(y, 1, 1);
    if weekday(ny) != 6 && observed(ny) == z {
        return true;
    }
    let fixed = [days(y, 7, 4), days(y, 12, 25)];
    if fixed.iter().any(|&h| observed(h) == z) {
        return true;
    }
    if y >= 2022 && observed(days(y, 6, 19)) == z {
        return true;
    }
    z == nth_weekday(y, 1, 1, 3)        // Martin Luther King Jr. Day
        || z == nth_weekday(y, 2, 1, 3) // Washington's Birthday
        || z == easter(y) - 2           // Good Friday
        || z == nth_weekday(y, 5, 1, 0) // Memorial Day
        || z == nth_weekday(y, 9, 1, 1) // Labor Day
        || z == nth_weekday(y, 11, 4, 4) // Thanksgiving
}
/// Whether daylight saving is on at unix time `ts` for a zone at UTC + `tz` minutes standard time.
pub fn dst_on(mode: u8, ts: i64, tz: i16) -> bool {
    match mode {
        1 => {
            // US: from the second Sunday of March 02:00 local standard time to the first Sunday of
            // November 02:00 local daylight time (= 01:00 standard)
            let std = ts + tz as i64 * 60;
            let (y, _, _) = civil(std.div_euclid(86_400));
            let start = nth_weekday(y, 3, 0, 2) * 86_400 + 2 * 3_600;
            let end = nth_weekday(y, 11, 0, 1) * 86_400 + 3_600;
            std >= start && std < end
        }
        2 => {
            // EU: from the last Sunday of March 01:00 UTC to the last Sunday of October 01:00 UTC
            let (y, _, _) = civil(ts.div_euclid(86_400));
            ts >= nth_weekday(y, 3, 0, 0) * 86_400 + 3_600 && ts < nth_weekday(y, 10, 0, 0) * 86_400 + 3_600
        }
        _ => false,
    }
}
/// The token's UTC offset right now (standard + an hour while daylight saving is on).
pub fn offset_min(e: &Ext, ts: i64, tz: i16) -> i64 {
    tz as i64 + if dst_on(e.dst(), ts, tz) { 60 } else { 0 }
}

// ── King of the Hill ────────────────────────────────────────────────────────────────────────────

/// (a × b) >> 64 without overflow for any u128s whose result fits (saturates otherwise).
fn mul_shr64(a: u128, b: u128) -> u128 {
    let (a1, a0) = (a >> 64, a & u64::MAX as u128);
    let (b1, b0) = (b >> 64, b & u64::MAX as u128);
    let hi = (a1 * b1).checked_shl(64).unwrap_or(u128::MAX);
    hi.saturating_add(a1 * b0).saturating_add(a0 * b1).saturating_add((a0 * b0) >> 64)
}
/// Lamports `amount` base units are worth at the pool's price (sqrt_price is Q64.64 of quote per base).
pub fn value_lamports(amount: u64, sqrt_price: u128) -> u64 {
    let v = mul_shr64(mul_shr64(amount as u128, sqrt_price), sqrt_price);
    v.min(u64::MAX as u128) as u64
}
fn half_life_secs(e: &Ext) -> i64 {
    let unit = match e.king_decay_unit {
        1 => 60,
        2 => 3_600,
        3 => 86_400,
        _ => return 0,
    };
    unit * e.king_decay_n as i64
}
/// 2^(-f) for f in [0, 1), Q32 (polynomial, error < 0.01%).
fn exp2_neg_frac(f: i128) -> i128 {
    // 2^-f = e^{-f ln2}: Taylor to the 7th power
    let y = f * 2_977_044_472 >> 32; // f·ln2
    let mut term = Q;
    let mut sum = Q;
    for k in 1..=7i128 {
        term = -(term * y >> 32) / k;
        sum += term;
    }
    sum
}
/// What a buy has to reach right now to take the crown.
pub fn king_bar(e: &Ext, s: &[u8], now: i64) -> u64 {
    let king = &s[200..232];
    if king.iter().all(|&b| b == 0) {
        return e.king_min;
    }
    let bid = u64_at(s, 232) as u128;
    let mut bar = bid * (100 + e.king_beat_pct as u128) / 100;
    let hl = half_life_secs(e);
    if hl > 0 {
        let elapsed = (now - i64_at(s, 240)).max(0) as i128;
        let halvings = elapsed / hl as i128;
        if halvings >= 64 {
            bar = 0;
        } else {
            let frac = (elapsed % hl as i128) * Q / hl as i128;
            bar = ((bar >> halvings) as i128 * exp2_neg_frac(frac) >> 32) as u128;
        }
    }
    (bar as u64).max(e.king_min)
}

fn ring_at(reign: u32) -> usize {
    STATE_LEN + (reign as usize % RING_N) * RING_ENTRY
}

// ── the checks ──────────────────────────────────────────────────────────────────────────────────

pub struct Trade<'a, 'b> {
    pub src_owner: Pubkey,
    pub dest_owner: Pubkey,
    pub is_buy: bool,
    pub is_sell: bool,
    pub amount: u128,
    pub supply: u128,
    pub src_balance: u128,
    pub dev: Pubkey,
    pub now: i64,
    pub slot: u64,
    pub in_hours: bool,
    /// a fingerprint of this transaction's instructions (`tx_fingerprint`), for ping pong
    pub tx_fp: u32,
    pub state: Option<&'b AccountInfo<'a>>,
    pub pool: Option<&'b AccountInfo<'a>>,
}

/// The first 4 bytes of sha256 over the Instructions sysvar without its trailing current-index: the same
/// for every instruction of one transaction, different for any other transaction's instructions.
pub fn tx_fingerprint(ixs: &AccountInfo) -> Result<u32, ProgramError> {
    let d = ixs.try_borrow_data()?;
    let body = &d[..d.len().saturating_sub(2)];
    let h = solana_program::hash::hash(body);
    Ok(u32::from_le_bytes(h.to_bytes()[..4].try_into().unwrap()))
}

fn refuse(code: u32) -> Result<(), ProgramError> {
    Err(ProgramError::Custom(code))
}
fn over(amount: u128, supply: u128, bps: u16) -> bool {
    amount * 10_000 > supply * bps as u128
}

/// The pool account of a King of the Hill token: Meteora's, for this mint.
pub fn check_pool(pool: &AccountInfo, mint: &Pubkey) -> Result<(), ProgramError> {
    let d = pool.try_borrow_data()?;
    if *pool.owner != DBC_PROGRAM || d.len() < POOL_SQRT_PRICE + 16 || d[..8] != POOL_DISC || d[POOL_BASE_MINT..POOL_BASE_MINT + 32] != mint.to_bytes() {
        msg!("King of the Hill: not this token's Meteora pool");
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

/// Everything that applies before the "sells and the dev always pass" exit: sell-side rules,
/// sends, and the state every trade moves. The dev is NOT exempt here.
pub fn pre(e: &Ext, t: &Trade) -> Result<(), ProgramError> {
    let is_send = !t.is_buy && !t.is_sell;
    if e.f3 & F3_DEX_ONLY != 0 && is_send {
        msg!("DEX-only: this token only moves in trades with its curve");
        return refuse(E_DEX_ONLY);
    }
    if e.f3 & F3_P2P != 0 {
        if t.is_sell {
            msg!("P2P-only: nobody can sell this token to its curve; send it wallet to wallet");
            return refuse(E_P2P);
        }
        if t.is_buy && t.dest_owner != t.dev {
            msg!("P2P-only: only the creator buys from the curve");
            return refuse(E_P2P);
        }
    }
    if t.is_sell && e.f4 & F4_HOURS_SELLS != 0 && !t.in_hours {
        msg!("trading hours: sells are closed right now too");
        return refuse(E_HOURS_SELL);
    }
    if t.is_sell && e.f3 & F3_SIDE_CAPS != 0 && e.max_sell_bps > 0 && over(t.amount, t.supply, e.max_sell_bps) {
        msg!("anti-dump: one sell can move at most {} bps of supply", e.max_sell_bps);
        return refuse(E_SELL_CAP);
    }
    if t.is_sell && e.f3 & F3_SELL_SCALE != 0 {
        let bag = t.src_balance + t.amount; // the seller's balance before this sell
        let bag_bps = (bag * 10_000 / t.supply.max(1)).min(e.sell_bag_bps as u128);
        let span = (e.sell_small_bps - e.sell_floor_bps) as u128;
        let cap = e.sell_small_bps as u128 - span * bag_bps / e.sell_bag_bps as u128;
        if t.amount * 10_000 > t.supply * cap {
            msg!("graduated sell caps: with this bag one sell can move at most {} bps of supply", cap);
            return refuse(E_SELL_CAP);
        }
    }

    let Some(state) = t.state else { return Ok(()) };
    let mut s = state.try_borrow_mut_data()?;

    if e.f3 & F3_POTATO != 0 {
        let holder = Pubkey::try_from(&s[0..32]).unwrap();
        if !t.is_buy && t.src_owner == holder && holder != Pubkey::default() {
            let cold = e.potato_cold_secs > 0 && t.now >= i64_at(&s, 32).saturating_add(e.potato_cold_secs as i64);
            if !cold {
                msg!("hot potato: {} bought last and holds the potato until another wallet buys", holder);
                return refuse(E_POTATO);
            }
        }
        if t.is_buy && t.amount * 10_000 >= t.supply * e.potato_min_bps as u128 {
            s[0..32].copy_from_slice(t.dest_owner.as_ref());
            put_i64(&mut s, 32, t.now);
        }
    }

    if e.f3 & F3_PING != 0 && (t.is_buy || t.is_sell) {
        let side = if t.is_buy { 1u8 } else { 2 };
        let next = s[40];
        let last_ts = i64_at(&s, 48);
        let free = e.ping_free_secs > 0 && last_ts > 0 && t.now >= last_ts.saturating_add(e.ping_free_secs as i64);
        if next != 0 && next != side && !free {
            msg!("ping pong: it is the {}' turn", if next == 1 { "buyers" } else { "sellers" });
            return refuse(E_PING);
        }
        if t.amount * 10_000 >= t.supply * e.ping_min_bps as u128 {
            if next != 0 && u64_at(&s, 56) == t.slot && u32_at(&s, 44) == t.tx_fp {
                msg!("ping pong: one transaction cannot take both turns");
                return refuse(E_PING);
            }
            s[40] = 3 - side;
            s[44..48].copy_from_slice(&t.tx_fp.to_le_bytes());
            put_i64(&mut s, 48, t.now);
            put_u64(&mut s, 56, t.slot);
        }
    }

    if e.f3 & F3_CHAPTERS != 0 && (t.is_buy || t.is_sell) {
        let v = u128::from_le_bytes(s[64..80].try_into().unwrap()).saturating_add(t.amount);
        s[64..80].copy_from_slice(&v.to_le_bytes());
    }

    if e.king() {
        let pool = t.pool.ok_or(ProgramError::NotEnoughAccountKeys)?;
        let sqrt = u128::from_le_bytes(pool.try_borrow_data()?[POOL_SQRT_PRICE..POOL_SQRT_PRICE + 16].try_into().unwrap());
        let value = value_lamports(t.amount.min(u64::MAX as u128) as u64, sqrt);
        let king = Pubkey::try_from(&s[200..232]).unwrap();
        let reign = u32_at(&s, 248);
        let has_king = king != Pubkey::default();
        if has_king && (t.is_buy || t.is_sell) {
            let at = ring_at(reign) + 40;
            let acc = u64_at(&s, at).saturating_add(value);
            put_u64(&mut s, at, acc);
        }
        if has_king && !t.is_buy && t.src_owner == king {
            msg!("King of the Hill: {} sold or sent and gives up the crown", king);
            s[200..232].fill(0);
            put_u64(&mut s, 232, 0);
            put_i64(&mut s, 240, t.now);
            let at = ring_at(reign) + 36;
            s[at..at + 4].copy_from_slice(&1u32.to_le_bytes());
        }
        if t.is_buy && (e.king_dev_can != 0 || t.dest_owner != t.dev) && value >= king_bar(e, &s, t.now) {
            let king = Pubkey::try_from(&s[200..232]).unwrap();
            if king == t.dest_owner {
                put_u64(&mut s, 232, value);
                put_i64(&mut s, 240, t.now);
            } else {
                if king != Pubkey::default() {
                    let at = ring_at(reign) + 36;
                    s[at..at + 4].copy_from_slice(&1u32.to_le_bytes());
                }
                let next = reign + 1;
                s[200..232].copy_from_slice(t.dest_owner.as_ref());
                put_u64(&mut s, 232, value);
                put_i64(&mut s, 240, t.now);
                s[248..252].copy_from_slice(&next.to_le_bytes());
                let at = ring_at(next);
                s[at..at + 32].copy_from_slice(t.dest_owner.as_ref());
                s[at + 32..at + 36].copy_from_slice(&next.to_le_bytes());
                s[at + 36..at + 48].fill(0);
                msg!("King of the Hill: {} takes the crown with {} lamports", t.dest_owner, value);
            }
        }
    }
    Ok(())
}

/// Receive-side rules (after the dev exit: the dev and sells into the curve never get here).
/// `held` is the receiving account's balance after the transfer.
pub fn post(e: &Ext, t: &Trade, held: u128, launch_ts: i64) -> Result<(), ProgramError> {
    if t.is_buy && e.f3 & F3_SIDE_CAPS != 0 && e.max_buy_bps > 0 && over(t.amount, t.supply, e.max_buy_bps) {
        msg!("anti-dump: one buy can take at most {} bps of supply", e.max_buy_bps);
        return refuse(E_BUY_CAP);
    }
    if t.is_buy && e.f3 & F3_PLAGUE != 0 && held.saturating_sub(t.amount) < e.plague_dose as u128 {
        msg!("plague: a wallet must already hold {} to buy; get some sent by a holder", e.plague_dose);
        return refuse(E_PLAGUE);
    }
    if e.f3 & F3_CHAPTERS != 0 {
        let s = t.state.ok_or(ProgramError::NotEnoughAccountKeys)?.try_borrow_data()?;
        // the chapter as it stood BEFORE this trade: `pre` already counted this buy's volume, and a
        // buy must not lift itself into the next chapter
        let v = u128::from_le_bytes(s[64..80].try_into().unwrap()).saturating_sub(if t.is_buy { t.amount } else { 0 });
        let chapter = (v / e.chapter_volume.max(1) as u128).min(20) as u32;
        let cap = (e.chapter_start_bps as u128) << chapter;
        if cap < 10_000 && held * 10_000 > t.supply * cap {
            msg!("chapters: in chapter {} a wallet holds at most {} bps of supply", chapter + 1, cap);
            return refuse(E_CHAPTER);
        }
    }
    if t.is_buy && e.osc != 0 {
        let cap = if e.osc == OSC_BREATH {
            let p = e.osc_period as i64;
            let phase = ((t.now - launch_ts).rem_euclid(p) as i128) * Q / p as i128;
            let x = sin_turn(phase) * e.osc_amp_pct as i128 / 100;
            osc_cap_bps(e, x)
        } else {
            let mut s = t.state.ok_or(ProgramError::NotEnoughAccountKeys)?.try_borrow_mut_data()?;
            let x = osc_advance(e, &mut s, t.now);
            let cap = osc_cap_bps(e, x);
            if !over(t.amount, t.supply, cap as u16) {
                // the kick: a buy the size of the base cap adds energy% of amplitude
                let base_amt = (t.supply * e.osc_base_bps as u128 / 10_000).max(1) as i128;
                for m in 0..(if e.osc == OSC_COUPLED { 2 } else { 1 }) {
                    let k = i64_at(&s, 184 + m * 8) as i128;
                    let dv = k * (t.amount as i128).min(base_amt * 16) / base_amt;
                    let at = 96 + m * 16;
                    let v = (i64_at(&s, at) as i128 + dv).clamp(-OSC_LIMIT, OSC_LIMIT);
                    put_i64(&mut s, at, v as i64);
                }
            }
            cap
        };
        if over(t.amount, t.supply, cap as u16) {
            msg!("oscillating cap: one buy can take at most {} bps of supply right now", cap);
            return refuse(E_OSC);
        }
    }
    Ok(())
}

/// Rejects ext bytes that would brick or mislead. Mirrors `validateRules` in lib/rules.mjs.
/// `max_wallet` / `ramp` / `trade_guard` / f1 / f2 from the rest of the config, for the exclusions.
pub fn validate(c: &[u8], bad: &dyn Fn(&str) -> Result<(), ProgramError>) -> Result<(), ProgramError> {
    let e = Ext::read(c);
    let (flags, f2) = (c[1], c[128]);
    let max_wallet = u16_at(c, 98);
    let trade_guard = u16_at(c, 130);
    let ramp_secs = u32_at(c, 134);
    if c[171] != 0 || c[237..256].iter().any(|&b| b != 0) {
        return bad("reserved bytes");
    }
    if e.f4 & !KNOWN_F4 != 0 || e.dst() > 2 || e.osc > OSC_COUPLED {
        return bad("unknown v3 flag");
    }
    let bps = |v: u16, lo: u16, hi: u16| v >= lo && v <= hi;
    // anti-dump
    if e.f3 & F3_SIDE_CAPS != 0 {
        if (e.max_buy_bps == 0 && e.max_sell_bps == 0) || (e.max_buy_bps != 0 && !bps(e.max_buy_bps, 10, 10_000)) || (e.max_sell_bps != 0 && !bps(e.max_sell_bps, 10, 10_000)) {
            return bad("anti-dump caps (0.1%..100%, at least one side)");
        }
        if trade_guard != 0 {
            return bad("anti-dump caps and trade guard both cap a trade");
        }
    } else if e.max_buy_bps != 0 || e.max_sell_bps != 0 {
        return bad("anti-dump caps without the rule");
    }
    if e.f3 & F3_SELL_SCALE != 0 {
        if !bps(e.sell_small_bps, 2, 10_000) || !bps(e.sell_floor_bps, 1, e.sell_small_bps - 1) || !bps(e.sell_bag_bps, 10, 10_000) {
            return bad("graduated sell caps (floor below the small-holder cap)");
        }
        if e.f3 & F3_SIDE_CAPS != 0 && e.max_sell_bps != 0 {
            return bad("graduated sell caps and a max per sell both cap a sell");
        }
    } else if e.sell_small_bps != 0 || e.sell_floor_bps != 0 || e.sell_bag_bps != 0 {
        return bad("graduated sell caps without the rule");
    }
    if e.f3 & F3_PLAGUE != 0 {
        if e.plague_dose == 0 {
            return bad("plague dose");
        }
    } else if e.plague_dose != 0 {
        return bad("plague dose without the rule");
    }
    if e.f3 & F3_PLAGUE != 0 && e.f3 & (F3_DEX_ONLY | F3_P2P) != 0 {
        return bad("plague spreads by sends: not with DEX-only or P2P-only");
    }
    if e.f3 & F3_DEX_ONLY != 0 && e.f3 & F3_P2P != 0 {
        return bad("DEX-only and P2P-only");
    }
    if e.f3 & F3_P2P != 0 {
        // the creator is the only buyer: rules about other buyers or about selling make no sense
        if flags & 3 != 0 || f2 & (8 | 16 | 4) != 0 || e.f3 & (F3_POTATO | F3_PING | F3_SIDE_CAPS | F3_SELL_SCALE) != 0 || e.king() || e.osc != 0 {
            return bad("P2P-only cannot be combined with buy or sell rules");
        }
    }
    if e.f3 & F3_POTATO != 0 {
        if e.potato_min_bps > 100 || e.potato_cold_secs > 86_400 {
            return bad("hot potato (minimum at most 1%, cold after at most a day)");
        }
    } else if e.potato_min_bps != 0 || e.potato_cold_secs != 0 {
        return bad("hot potato without the rule");
    }
    if e.f3 & F3_PING != 0 {
        if e.ping_min_bps > 100 || e.ping_free_secs > 86_400 {
            return bad("ping pong (minimum at most 1%, free after at most a day)");
        }
    } else if e.ping_min_bps != 0 || e.ping_free_secs != 0 {
        return bad("ping pong without the rule");
    }
    if e.f3 & F3_CHAPTERS != 0 {
        if !bps(e.chapter_start_bps, 10, 10_000) || e.chapter_volume == 0 {
            return bad("chapters (start 0.1%..100%, a volume per chapter)");
        }
        if max_wallet != 0 || ramp_secs != 0 {
            return bad("chapters and max per wallet both cap a wallet");
        }
    } else if e.chapter_start_bps != 0 || e.chapter_volume != 0 {
        return bad("chapters without the rule");
    }
    match e.osc {
        0 => {
            if c[212..224].iter().any(|&b| b != 0) {
                return bad("oscillator settings without the rule");
            }
        }
        OSC_BREATH => {
            if !(30..=3_600).contains(&e.osc_period) || !bps(e.osc_amp_pct, 10, 100) || e.osc_damp != 0 || e.osc_coupling != 0 {
                return bad("breathing cap (30 s..1 h, swing 10..100%)");
            }
        }
        _ => {
            let coupled = e.osc == OSC_COUPLED;
            if !(20..=1_200).contains(&e.osc_period) || !bps(e.osc_amp_pct, 5, 100) || !bps(e.osc_damp, 10, 400) {
                return bad("oscillator (period 20 s..20 min, energy 5..100%, damping 1..40%/s)");
            }
            if coupled != (e.osc_coupling != 0) || (coupled && !bps(e.osc_coupling, 1, 60)) {
                return bad("coupling (1..60%) only on the coupled resonator");
            }
        }
    }
    if e.osc != 0 && (!bps(e.osc_base_bps, 10, 10_000) || !bps(e.osc_floor_bps, 1, e.osc_base_bps)) {
        return bad("oscillator base cap and floor (floor at most the base)");
    }
    if e.king() {
        if !(10_000_000..=10_000_000_000).contains(&e.king_min) || e.king_beat_pct > 50 || e.king_decay_unit > 3 || e.king_dev_can > 1 {
            return bad("King of the Hill (0.01..10 SOL, beat by at most 50%)");
        }
        if (e.king_decay_unit == 0) != (e.king_decay_n == 0) || e.king_decay_n > 60 {
            return bad("King of the Hill decay (1..60 units, or never)");
        }
    } else if c[224..237].iter().any(|&b| b != 0) {
        return bad("King of the Hill settings without the rule");
    }
    if e.f4 & (F4_HOURS_SELLS | F4_HOLIDAYS | F4_DST_MASK) != 0 && f2 & 8 == 0 {
        return bad("trading-hours options without trading hours");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ymd(y: i64, m: u32, d: u32) -> i64 {
        days(y, m, d)
    }

    #[test]
    fn calendar_round_trips() {
        for z in [-1000i64, 0, 19_000, 20_367, 60_000] {
            let (y, m, d) = civil(z);
            assert_eq!(days(y, m, d), z);
        }
        assert_eq!(weekday(ymd(2026, 10, 6)), 2); // a Tuesday
    }

    #[test]
    fn nyse_holidays_2026_2027() {
        let h26 = [(1, 1), (1, 19), (2, 16), (4, 3), (5, 25), (6, 19), (7, 3), (9, 7), (11, 26), (12, 25)];
        let h27 = [(1, 1), (1, 18), (2, 15), (3, 26), (5, 31), (6, 18), (7, 5), (9, 6), (11, 25), (12, 24)];
        for (y, list) in [(2026, &h26[..]), (2027, &h27[..])] {
            let mut found = vec![];
            for z in ymd(y, 1, 1)..ymd(y + 1, 1, 1) {
                if us_market_holiday(z) {
                    let (_, m, d) = civil(z);
                    found.push((m, d));
                }
            }
            assert_eq!(found, list.to_vec(), "{y}");
        }
        // 2022: New Year's Day was a Saturday and NYSE stayed open on Friday 31 Dec 2021
        assert!(!us_market_holiday(ymd(2021, 12, 31)));
    }

    #[test]
    fn daylight_saving() {
        let ny = -300i16;
        let t = |y, m, d, h: i64, min: i64| ymd(y, m, d) * 86_400 + h * 3_600 + min * 60; // UTC
        // US 2026: 8 March 07:00 UTC to 1 November 06:00 UTC
        assert!(!dst_on(1, t(2026, 3, 8, 6, 59), ny));
        assert!(dst_on(1, t(2026, 3, 8, 7, 0), ny));
        assert!(dst_on(1, t(2026, 11, 1, 5, 59), ny));
        assert!(!dst_on(1, t(2026, 11, 1, 6, 0), ny));
        // EU 2026: 29 March 01:00 UTC to 25 October 01:00 UTC
        assert!(!dst_on(2, t(2026, 3, 29, 0, 59), 60));
        assert!(dst_on(2, t(2026, 3, 29, 1, 0), 60));
        assert!(!dst_on(2, t(2026, 10, 25, 1, 0), 60));
    }

    #[test]
    fn sine() {
        for i in 0..64 {
            let p = (i as i128) * Q / 64;
            let want = (2.0 * std::f64::consts::PI * i as f64 / 64.0).sin();
            let got = sin_turn(p) as f64 / Q as f64;
            assert!((got - want).abs() < 1e-6, "{i}: {got} vs {want}");
        }
    }

    fn sim(e: &Ext, kicks: &[i64], at: i64) -> f64 {
        // the program's state machine, driven on a plain buffer
        let mut s = vec![0u8; STATE_LEN];
        init_state(e, &mut s);
        for &k in kicks {
            osc_advance(e, &mut s, k);
            for m in 0..(if e.osc == OSC_COUPLED { 2 } else { 1 }) {
                let v = i64_at(&s, 96 + m * 16) + i64_at(&s, 184 + m * 8);
                put_i64(&mut s, 96 + m * 16, v);
            }
        }
        osc_advance(e, &mut s, at) as f64 / Q as f64
    }

    #[test]
    fn momentum_matches_the_physics() {
        let e = Ext { osc: OSC_MOMENTUM, osc_period: 120, osc_damp: 80, osc_amp_pct: 40, osc_base_bps: 100, osc_floor_bps: 25, ..Default::default() };
        // one base-sized kick at t=1000: x(t) = A e^{-γt} sin(ωd t), A = 0.4 ω0/ωd
        let (w0, g) = (2.0 * std::f64::consts::PI / 120.0, 0.08f64);
        let wd = (w0 * w0 - g * g).sqrt();
        if w0 > g {
            for dt in [1i64, 5, 17, 30, 59] {
                let want = 0.4 * w0 / wd * (-g * dt as f64).exp() * (wd * dt as f64).sin();
                let got = sim(&e, &[1000], 1000 + dt);
                assert!((got - want).abs() < 1e-4, "dt {dt}: {got} vs {want}");
            }
        } else {
            // overdamped at these settings: it rises then settles, never negative
            let peak = (1..60).map(|dt| sim(&e, &[1000], 1000 + dt)).fold(0.0, f64::max);
            assert!(peak > 0.0 && sim(&e, &[1000], 1300).abs() < 1e-3);
        }
        assert_eq!(sim(&e, &[1000], 1000 + osc_quiet_after(&e) + 1), 0.0);
    }

    #[test]
    fn resonance_builds_on_the_beat() {
        // lowest damping (1%/s): 55% of a swing survives one 60 s beat, so on-beat buys pile up toward
        // 1/(1 - 0.55) ≈ 2.2× one kick, while buys half a beat apart cancel
        let e = Ext { osc: OSC_RESONANCE, osc_period: 60, osc_damp: 10, osc_amp_pct: 40, osc_base_bps: 100, osc_floor_bps: 25, ..Default::default() };
        let peak = |k: &[i64]| (0..60).map(|dt| sim(&e, k, k[k.len() - 1] + dt).abs()).fold(0.0, f64::max);
        let on_beat: Vec<i64> = (0..8).map(|i| 1000 + 61 * i).collect();
        let off_beat: Vec<i64> = (0..8).map(|i| 1000 + 31 * i).collect();
        let one = peak(&[1000]);
        assert!(peak(&on_beat) > 1.8 * one, "{} vs {}", peak(&on_beat), one);
        assert!(peak(&off_beat) < one, "{} vs {}", peak(&off_beat), one);
    }

    #[test]
    fn coupled_energy_moves_between_modes() {
        let e = Ext { osc: OSC_COUPLED, osc_period: 60, osc_damp: 10, osc_amp_pct: 40, osc_coupling: 20, osc_base_bps: 100, osc_floor_bps: 25, ..Default::default() };
        // oscillator 1 beats: half a beat (~165 s) after the kick its energy has moved to the second
        // oscillator, so it swings far less than one uncoupled oscillator with the same damping, and
        // a beat later (~330 s) it has the energy back
        let lone = Ext { osc: OSC_MOMENTUM, osc_coupling: 0, ..e };
        let swing = |e: &Ext, from: i64| (from..from + 40).map(|t| sim(e, &[1000], t).abs()).fold(0.0, f64::max);
        let (half_c, half_l) = (swing(&e, 1145), swing(&lone, 1145));
        assert!(half_c < 0.3 * half_l, "half a beat: {half_c} vs {half_l}");
        let (full_c, full_l) = (swing(&e, 1310), swing(&lone, 1310));
        assert!(full_c > 0.7 * full_l, "a beat: {full_c} vs {full_l}");
    }

    #[test]
    fn king_value_and_bar() {
        // price 1e-4 lamports per base unit → sqrt = 0.01 → Q64
        let sqrt = (0.01f64 * 18446744073709551616.0) as u128;
        let v = value_lamports(1_000_000_000_000, sqrt);
        assert!((v as i64 - 100_000_000).abs() < 10, "{v}");
        let e = Ext { f4: F4_KING, king_min: 100_000_000, king_beat_pct: 5, king_decay_unit: 2, king_decay_n: 6, ..Default::default() };
        let mut s = vec![0u8; STATE_LEN + RING_N * RING_ENTRY];
        assert_eq!(king_bar(&e, &s, 0), 100_000_000);
        s[200] = 1;
        put_u64(&mut s, 232, 1_000_000_000);
        put_i64(&mut s, 240, 1_000);
        assert_eq!(king_bar(&e, &s, 1_000), 1_050_000_000);
        let half = king_bar(&e, &s, 1_000 + 6 * 3_600);
        assert!((half as i64 - 525_000_000).abs() < 100_000, "{half}");
        let quarter = king_bar(&e, &s, 1_000 + 9 * 3_600); // 1.5 half-lives: 1.05 / 2^1.5
        assert!((quarter as i64 - 371_231_060).abs() < 100_000, "{quarter}");
        assert_eq!(king_bar(&e, &s, 1_000 + 400 * 86_400), 100_000_000);
    }
}
