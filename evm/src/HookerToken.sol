// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {HookerMath as M} from "./HookerMath.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";

/// The Robinhood Chain version of a Hooker window token: an ERC-20 whose rules run on every transfer, the
/// way the Solana transfer hook (programs/hooker-hook) runs them on every Token-2022 transfer. The rules
/// and their refusal codes mirror the hook; lib/rules.mjs is the shared description.
///
/// The whole supply is minted to the launchpad, which is the curve: a transfer FROM it is a buy, a transfer
/// TO it is a sell. Sells and transfers to the creator always pass, as on Solana.
///
/// At graduation the launchpad freezes the token for good: its balances are the snapshot each holder's
/// Pons coins are paid from, so nothing may move after it.
///
/// Holder share needs each wallet's balance × time held up to graduation; the token keeps that running
/// sum (`weightOf`) so the payout can be computed on chain, with no off-chain replay.
///
/// v3 rules (`Ext`): the same 14 rules as the Solana hook's v3 (programs/hooker-hook/src/v3.rs), checked in the
/// same order: sell-side rules and the state every trade moves first (the creator included), then, after the
/// "sells and the creator always pass" exit, the receive-side rules. FOMO-only and the sniper-fee cap have no
/// Robinhood Chain counterpart (no FOMO app there; the sequencer ignores priority fees and has no tips).
///
/// Each launch is a minimal proxy (EIP-1167) of one implementation, set up by `initialize` in the same transaction
/// that creates it: the token's code is too big to sit inside the factory, and a clone costs a fraction of the gas.
contract HookerToken is ERC20 {
    // refusal codes, the same numbers as the Solana hook (lib/rules.mjs HOOK_ERRORS)
    error HookRefused(uint8 code);
    uint8 internal constant E_MAX_WALLET = 1;
    uint8 internal constant E_VENUE = 4;
    uint8 internal constant E_NOT_LISTED = 6;
    uint8 internal constant E_BLOCKED = 7;
    uint8 internal constant E_TRADE_GUARD = 8;
    uint8 internal constant E_HOURS = 9;
    uint8 internal constant E_BUNDLE = 11;
    uint8 internal constant E_LIST_CLOSED = 12;
    uint8 internal constant E_NOT_DEV = 14;
    uint8 internal constant E_FROZEN = 15;
    // v3: the Solana hook's numbers, except the buy cap (15 is "frozen" here)
    uint8 internal constant E_SELL_CAP = 16;
    uint8 internal constant E_PLAGUE = 17;
    uint8 internal constant E_DEX_ONLY = 18;
    uint8 internal constant E_P2P = 19;
    uint8 internal constant E_HOURS_SELL = 20;
    uint8 internal constant E_POTATO = 21;
    uint8 internal constant E_PING = 22;
    uint8 internal constant E_OSC = 23;
    uint8 internal constant E_CHAPTER = 24;
    uint8 internal constant E_BUY_CAP = 25;

    /// The rules a creator picks at launch. Zero means off throughout. Validated by the launchpad.
    struct Rules {
        uint16 maxWalletBps;      // max per wallet, of supply
        uint32 earlySecs;         // launch window: a tighter cap for this long
        uint16 earlyMaxWalletBps;
        uint16 rampStartBps;      // rising max per wallet: from this ...
        uint32 rampSecs;          // ... to maxWalletBps over this long
        uint16 tradeGuardBps;     // no single transfer moves more than this share of supply
        bool allowlist;           // only listed wallets may receive
        bool blocklist;           // listed wallets may never receive
        bool venueLock;           // only wallets (no contracts) may receive
        bool hoursOn;             // buys only inside weekly trading hours
        uint8 hoursDays;          // bit 0 Sunday … bit 6 Saturday
        uint16 hoursOpenMin;      // local minute of the day
        uint16 hoursCloseMin;
        int16 tzOffsetMin;        // local = UTC + this
        uint16 bundleMax;         // buys per block (0 = off)
        // settled at graduation (the launchpad reads these): dynamic fee, burn, holder share
        uint16 feeBaseBps;
        uint16 feePerEthBps;
        uint16 feeCapBps;
        uint16 burnBps;
        uint16 holderShareBps;
        bool holderRewards;       // Pons creator fees go to holders after graduation
    }

    /// The v3 rules (lib/rules.mjs V3_OFF, the same names). Zero/false means off throughout. Validated by the
    /// token factory (and the King's minimum by the launchpad, which knows the asset).
    struct Ext {
        uint16 maxBuyBps;         // anti-dump: max per buy, of supply (0 = no buy cap)
        uint16 maxSellBps;        // anti-dump: max per sell (0 = no sell cap)
        uint16 sellSmallBps;      // graduated sell caps: what a small holder may sell at once ...
        uint16 sellFloorBps;      // ... down to this for the biggest bags ...
        uint16 sellBagBps;        // ... a bag of this share of supply or more (0 = off)
        uint256 plagueDose;       // plague: tokens (wei) a wallet must hold before it may buy (0 = off)
        bool dexOnly;             // no wallet-to-wallet sends
        bool p2pOnly;             // nobody sells to the curve; only the creator buys from it
        bool potatoOn;            // hot potato
        uint16 potatoMinBps;      // a buy at least this big takes the potato
        uint32 potatoColdSecs;    // the potato goes cold after this long (0 = never)
        bool pingOn;              // ping pong: buys and sells take turns
        uint16 pingMinBps;        // a trade at least this big takes a turn
        uint32 pingFreeSecs;      // after this long without a turn, both sides may go (0 = never)
        uint16 chapterStartBps;   // chapters: max per wallet in chapter 1, doubling each chapter (0 = off)
        uint256 chapterVolume;    // tokens (wei) traded per chapter
        uint8 oscKind;            // 0 off, 1 breathing, 2 momentum, 3 resonance, 4 coupled
        uint16 oscPeriod;         // seconds
        uint16 oscBaseBps;        // the per-buy cap at rest
        uint16 oscFloorBps;       // never below this
        uint16 oscAmpPct;         // breathing: swing; others: the energy a base-sized buy adds
        uint16 oscDampPermille;   // per second
        uint16 oscCouplingPct;    // coupled resonator only
        bool kingOn;              // King of the Hill
        uint256 kingMin;          // the smallest buy (in the launch's asset) that takes an empty throne
        uint8 kingBeatPct;        // a challenger must beat the King's buy by this much
        uint8 kingDecayUnit;      // the bar halves every kingDecayN of: 0 never, 1 minutes, 2 hours, 3 days
        uint16 kingDecayN;
        bool kingDevCan;          // the creator may take the crown too
        bool hoursSells;          // trading hours close sells too
        bool hoursHolidays;       // trading hours skip US market holidays
        uint8 hoursDst;           // trading hours follow daylight saving: 0 no, 1 US, 2 EU
    }

    /// One King's reign: who, since when, whether it ended, and the value traded during it (the launchpad
    /// pays the King a share of that value as it trades).
    struct Reign {
        address king;
        uint64 since;
        bool ended;
        uint256 value;
    }

    uint256 public constant LIST_OPEN_SECS = 1 days;
    uint256 public constant LIST_MAX = 5_000;

    /// where the dynamic fee's tokens go, and where burned tokens go: both are paid out at graduation
    /// (the treasury its share, the dead address's share burned) and neither counts as a holder
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address public treasury;
    address public launchpad;
    address public dev;
    uint64 public launchTs;
    string public image;
    string internal _n;
    string internal _s;
    bool internal _initialized;
    Rules internal _rules;
    Ext internal _ext;
    /// any v3 rule at all: a token without one never reads `_ext`
    bool internal _v3;

    bool public frozen;
    mapping(address => bool) public listed;
    uint256 public listCount;
    bool public listSealed;

    /// anti-bundle: buys counted per L2 block (ArbSys on Robinhood Chain; block.number elsewhere)
    uint256 public bundleBlock;
    uint256 public bundleCount;

    // holder share: balance × seconds, per wallet and in total, up to graduation
    mapping(address => uint256) internal _weight;
    mapping(address => uint64) internal _since;
    uint256 internal _totalWeight;
    uint64 internal _totalSince;
    uint256 internal _held; // what holders hold (not the launchpad, the treasury or the dead address)

    // every wallet that ever held it, so the payout can walk them on chain
    address[] public holders;
    mapping(address => bool) public isHolder;

    // ── v3 state ──
    address public potatoHolder;
    uint64 public potatoSince;
    uint8 public pingNext;          // 0 either side, 1 buyers, 2 sellers
    uint64 public pingLastTs;
    uint256 public volume;          // tokens traded with the curve (chapters)
    // the oscillator: last update, and position/velocity of its one or two modes (Q32)
    uint64 public oscLastTs;
    int256 public oscX1;
    int256 public oscV1;
    int256 public oscX2;
    int256 public oscV2;
    // its step matrices and kicks, fixed at launch
    int256[4] internal _m1;
    int256[4] internal _m2;
    int256 internal _k1;
    int256 internal _k2;
    // King of the Hill
    address public king;
    uint256 public kingBid;         // the King's winning buy, in the launch's asset
    uint64 public kingSince;        // crowned (or the throne emptied) at
    uint32 public reign;            // 0 = never had a King
    mapping(uint256 => Reign) public reigns;

    // transient: the value of the trade the launchpad is making right now (King of the Hill), and whether a
    // trade in this transaction already took a ping-pong turn
    bytes32 internal constant T_VALUE = keccak256("hooker.trade.value");
    bytes32 internal constant T_PING = keccak256("hooker.ping.turn");

    event Listed(uint256 added, uint256 count);
    event ListSealed();

    /// The implementation itself can never be set up: only its clones are tokens.
    constructor() ERC20("", "") {
        _initialized = true;
    }

    function name() public view override returns (string memory) { return _n; }
    function symbol() public view override returns (string memory) { return _s; }

    /// Sets a fresh clone up; the factory calls it in the transaction that creates the clone.
    function initialize(string memory name_, string memory symbol_, string memory image_, uint256 supply, address dev_, address treasury_, address launchpad_, Rules memory r, Ext memory e)
        external
    {
        require(!_initialized, "already set up");
        _initialized = true;
        _n = name_;
        _s = symbol_;
        launchpad = launchpad_;
        dev = dev_;
        treasury = treasury_;
        launchTs = uint64(block.timestamp);
        image = image_;
        _rules = r;
        _ext = e;
        _v3 = e.maxBuyBps != 0 || e.maxSellBps != 0 || e.sellBagBps != 0 || e.plagueDose != 0 || e.dexOnly || e.p2pOnly || e.potatoOn
            || e.pingOn || e.chapterStartBps != 0 || e.oscKind != 0 || e.kingOn || e.hoursSells || e.hoursHolidays || e.hoursDst != 0;
        if (e.oscKind >= M.OSC_MOMENTUM) (_m1, _m2, _k1, _k2) = M.oscConstants(e.oscKind, e.oscPeriod, e.oscDampPermille, e.oscAmpPct, e.oscCouplingPct);
        _totalSince = uint64(block.timestamp);
        _mint(launchpad_, supply);
    }

    function rules() external view returns (Rules memory) { return _rules; }
    function ext() external view returns (Ext memory) { return _ext; }

    /// The launchpad names the value of the trade it is about to make (King of the Hill values buys in the asset).
    function noteTrade(uint256 value) external {
        require(msg.sender == launchpad, "only the launchpad");
        bytes32 k = T_VALUE;
        assembly { tstore(k, value) }
    }
    function holderCount() external view returns (uint256) { return holders.length; }

    // ─── the creator's list (first day only, up to LIST_MAX, until sealed) ───
    function addToList(address[] calldata wallets) external {
        if (msg.sender != dev) revert HookRefused(E_NOT_DEV);
        if (listSealed || block.timestamp >= launchTs + LIST_OPEN_SECS) revert HookRefused(E_LIST_CLOSED);
        uint256 added;
        for (uint256 i; i < wallets.length; i++) {
            if (!listed[wallets[i]]) { listed[wallets[i]] = true; added++; }
        }
        listCount += added;
        if (listCount > LIST_MAX) revert HookRefused(E_LIST_CLOSED);
        emit Listed(added, listCount);
    }

    function sealList() external {
        if (msg.sender != dev) revert HookRefused(E_NOT_DEV);
        listSealed = true;
        emit ListSealed();
    }

    /// A sell: the launchpad takes the tokens straight from the seller (no approval step).
    function pull(address from, uint256 amount) external {
        require(msg.sender == launchpad, "only the launchpad");
        _transfer(from, launchpad, amount);
    }

    // ─── graduation ───
    function freeze() external {
        require(msg.sender == launchpad, "only the launchpad");
        _accrueTotal();
        frozen = true;
    }

    /// balance × seconds held up to graduation (or now, before it)
    function weightOf(address a) public view returns (uint256) {
        uint64 t = frozen ? _totalSince : uint64(block.timestamp);
        return _weight[a] + balanceOf(a) * (t - (_since[a] == 0 ? t : _since[a]));
    }

    function totalWeight() public view returns (uint256) {
        uint64 t = frozen ? _totalSince : uint64(block.timestamp);
        return _totalWeight + _held * (t - _totalSince);
    }

    /// a wallet whose balance earns holder share and is paid like a holder's
    function _counts(address a) internal view returns (bool) {
        return a != launchpad && a != address(0) && a != treasury && a != DEAD;
    }

    function _accrue(address a) internal {
        if (!_counts(a)) return;
        uint64 t = uint64(block.timestamp);
        if (_since[a] != 0) _weight[a] += balanceOf(a) * (t - _since[a]);
        _since[a] = t;
    }

    function _accrueTotal() internal {
        uint64 t = uint64(block.timestamp);
        _totalWeight += _held * (t - _totalSince);
        _totalSince = t;
    }

    /// The L2 block on Robinhood Chain: `block.number` there is the L1 block, which only moves every
    /// ~12 s, so anti-bundle would count a whole stretch of blocks as one. ArbSys is absent on a plain
    /// chain (tests), where `block.number` is already right.
    function _l2Block() internal view returns (uint256) {
        (bool ok, bytes memory out) = address(100).staticcall(abi.encodeWithSignature("arbBlockNumber()"));
        return ok && out.length == 32 ? abi.decode(out, (uint256)) : block.number;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0)) {
            if (frozen) revert HookRefused(E_FROZEN);
            _accrueTotal();
            _accrue(from);
            _accrue(to);
        }
        super._update(from, to, amount);
        if (from == address(0)) return; // the mint at launch

        if (_counts(from)) _held -= amount;
        if (_counts(to)) {
            _held += amount;
            if (!isHolder[to]) { isHolder[to] = true; holders.push(to); }
        }

        _check(from, to, amount);
    }

    function _check(address from, address to, uint256 amount) internal {
        // the fee and burn tokens the launchpad takes on a buy are part of that buy, not trades of their own
        if (from == launchpad && (to == treasury || to == DEAD)) return;
        Ext memory e;
        if (_v3) {
            e = _ext;
            _pre(e, from, to, amount);
        }
        // sells into the curve, the creator's wallet, and the treasury and dead address, always pass
        if (to == launchpad || to == dev || to == treasury || to == DEAD) return;
        Rules memory r = _rules;

        if (r.venueLock && to.code.length > 0) revert HookRefused(E_VENUE);
        if (r.allowlist && !listed[to]) revert HookRefused(E_NOT_LISTED);
        if (r.blocklist && listed[to]) revert HookRefused(E_BLOCKED);

        uint256 supply = totalSupply();
        if (r.tradeGuardBps > 0 && amount * 10_000 > supply * r.tradeGuardBps) revert HookRefused(E_TRADE_GUARD);

        bool isBuy = from == launchpad;
        if (isBuy && r.hoursOn && !_inHours(r, e, block.timestamp)) revert HookRefused(E_HOURS);
        if (isBuy && r.bundleMax > 0) {
            uint256 b = _l2Block();
            uint256 count = b == bundleBlock ? bundleCount : 0;
            if (count >= r.bundleMax) revert HookRefused(E_BUNDLE);
            bundleBlock = b;
            bundleCount = count + 1;
        }

        // max per wallet: a ramp raises it over time, the launch window tightens it at first
        uint256 capBps = r.maxWalletBps;
        if (r.rampSecs > 0 && capBps > 0) {
            uint256 elapsed = block.timestamp - launchTs;
            if (elapsed > r.rampSecs) elapsed = r.rampSecs;
            capBps = r.rampStartBps + (capBps - r.rampStartBps) * elapsed / r.rampSecs;
        }
        if (r.earlySecs > 0 && block.timestamp < launchTs + r.earlySecs) {
            capBps = capBps == 0 ? r.earlyMaxWalletBps : (capBps < r.earlyMaxWalletBps ? capBps : r.earlyMaxWalletBps);
        }
        if (capBps > 0 && balanceOf(to) * 10_000 > supply * capBps) revert HookRefused(E_MAX_WALLET);
        if (_v3) _post(e, to, amount, isBuy);
    }

    /// Whether `ts` is inside the weekly trading hours (the same arithmetic as the Solana hook): daylight saving
    /// moves the offset by an hour, and US market holidays close the whole local day.
    function _inHours(Rules memory r, Ext memory e, uint256 ts) internal pure returns (bool) {
        int256 tz = int256(r.tzOffsetMin);
        if (M.dstOn(e.hoursDst, int256(ts), tz)) tz += 60;
        int256 local = int256(ts) + tz * 60;
        int256 day = local >= 0 ? local / 86_400 : (local - 86_399) / 86_400;
        if (e.hoursHolidays && M.usMarketHoliday(day)) return false;
        uint256 minute = uint256(local - day * 86_400) / 60;
        uint8 weekday = uint8(uint256(((day + 4) % 7 + 7) % 7)); // 1970-01-01 was a Thursday; 0 = Sunday
        uint16 open = r.hoursOpenMin;
        uint16 close = r.hoursCloseMin;
        if (open < close) return (r.hoursDays & (1 << weekday)) != 0 && minute >= open && minute < close;
        // overnight: the evening belongs to today, the early morning to yesterday
        return ((r.hoursDays & (1 << weekday)) != 0 && minute >= open)
            || ((r.hoursDays & (1 << ((weekday + 6) % 7))) != 0 && minute < close);
    }

    // ─── v3 ───

    function _over(uint256 amount, uint256 supply, uint256 bps) internal pure returns (bool) {
        return amount * 10_000 > supply * bps;
    }

    /// Everything before the "sells and the creator always pass" exit: sell-side rules, sends, and the state every
    /// trade moves. The creator is NOT exempt here (v3::pre).
    function _pre(Ext memory e, address from, address to, uint256 amount) internal {
        bool isBuy = from == launchpad;
        bool isSell = to == launchpad;
        bool isSend = !isBuy && !isSell;
        uint256 supply = totalSupply();
        uint256 nowTs = block.timestamp;

        if (e.dexOnly && isSend) revert HookRefused(E_DEX_ONLY);
        if (e.p2pOnly && (isSell || (isBuy && to != dev))) revert HookRefused(E_P2P);
        if (isSell && e.hoursSells && !_inHours(_rules, e, nowTs)) revert HookRefused(E_HOURS_SELL);
        if (isSell && e.maxSellBps > 0 && _over(amount, supply, e.maxSellBps)) revert HookRefused(E_SELL_CAP);
        if (isSell && e.sellBagBps > 0) {
            uint256 bag = balanceOf(from) + amount; // the seller's balance before this sell
            uint256 bagBps = bag * 10_000 / supply;
            if (bagBps > e.sellBagBps) bagBps = e.sellBagBps;
            uint256 cap = e.sellSmallBps - uint256(e.sellSmallBps - e.sellFloorBps) * bagBps / e.sellBagBps;
            if (_over(amount, supply, cap)) revert HookRefused(E_SELL_CAP);
        }

        if (e.potatoOn) {
            address h = potatoHolder;
            if (!isBuy && from == h && h != address(0)) {
                bool cold = e.potatoColdSecs > 0 && nowTs >= uint256(potatoSince) + e.potatoColdSecs;
                if (!cold) revert HookRefused(E_POTATO);
            }
            if (isBuy && amount * 10_000 >= supply * e.potatoMinBps) {
                potatoHolder = to;
                potatoSince = uint64(nowTs);
            }
        }

        if (e.pingOn && (isBuy || isSell)) {
            uint8 side = isBuy ? 1 : 2;
            uint8 next = pingNext;
            uint64 last = pingLastTs;
            bool free = e.pingFreeSecs > 0 && last > 0 && nowTs >= uint256(last) + e.pingFreeSecs;
            if (next != 0 && next != side && !free) revert HookRefused(E_PING);
            if (amount * 10_000 >= supply * e.pingMinBps) {
                bytes32 k = T_PING;
                uint256 taken;
                assembly { taken := tload(k) }
                // one transaction cannot take both turns
                if (next != 0 && taken == 1) revert HookRefused(E_PING);
                assembly { tstore(k, 1) }
                pingNext = 3 - side;
                pingLastTs = uint64(nowTs);
            }
        }

        if (e.chapterStartBps > 0 && (isBuy || isSell)) volume += amount;

        if (e.kingOn) _kingPre(e, from, to, isBuy, isSell, nowTs);
    }

    function _kingPre(Ext memory e, address from, address to, bool isBuy, bool isSell, uint256 nowTs) internal {
        uint256 value;
        if (isBuy || isSell) {
            bytes32 k = T_VALUE;
            assembly { value := tload(k) }
        }
        address k0 = king;
        uint32 rn = reign;
        if (k0 != address(0) && (isBuy || isSell)) reigns[rn].value += value;
        if (k0 != address(0) && !isBuy && from == k0) {
            // the King sold or sent: the crown is given up
            king = address(0);
            kingBid = 0;
            kingSince = uint64(nowTs);
            reigns[rn].ended = true;
            k0 = address(0);
        }
        if (isBuy && (e.kingDevCan || to != dev) && value >= kingBar()) {
            if (k0 == to) {
                kingBid = value;
                kingSince = uint64(nowTs);
            } else {
                if (k0 != address(0)) reigns[rn].ended = true;
                rn += 1;
                reign = rn;
                king = to;
                kingBid = value;
                kingSince = uint64(nowTs);
                reigns[rn] = Reign(to, uint64(nowTs), false, 0);
            }
        }
    }

    /// What a buy has to reach right now to take the crown: the King's buy plus the beat, halving over time.
    function kingBar() public view returns (uint256) {
        Ext memory e = _ext;
        if (king == address(0)) return e.kingMin;
        uint256 bar = kingBid * (100 + e.kingBeatPct) / 100;
        uint256 unit = e.kingDecayUnit == 1 ? 60 : e.kingDecayUnit == 2 ? 3_600 : e.kingDecayUnit == 3 ? 86_400 : 0;
        uint256 hl = unit * e.kingDecayN;
        if (hl > 0) {
            uint256 elapsed = block.timestamp > kingSince ? block.timestamp - kingSince : 0;
            uint256 halvings = elapsed / hl;
            if (halvings >= 64) bar = 0;
            else bar = ((bar >> halvings) * uint256(M.exp2NegFrac(int256((elapsed % hl) << 32) / int256(hl)))) >> 32;
        }
        return bar > e.kingMin ? bar : e.kingMin;
    }

    /// Receive-side rules, after the exit (the creator and sells into the curve never get here). `held` is the
    /// receiving wallet's balance after the transfer (v3::post).
    function _post(Ext memory e, address to, uint256 amount, bool isBuy) internal {
        uint256 supply = totalSupply();
        uint256 held = balanceOf(to);
        if (isBuy && e.maxBuyBps > 0 && _over(amount, supply, e.maxBuyBps)) revert HookRefused(E_BUY_CAP);
        if (isBuy && e.plagueDose > 0 && held - amount < e.plagueDose) revert HookRefused(E_PLAGUE);
        if (e.chapterStartBps > 0) {
            // the chapter as it stood BEFORE this trade: a buy must not lift itself into the next chapter
            uint256 v = volume - (isBuy ? amount : 0);
            uint256 chapter = v / (e.chapterVolume == 0 ? 1 : e.chapterVolume);
            if (chapter > 20) chapter = 20;
            uint256 cap = uint256(e.chapterStartBps) << chapter;
            if (cap < 10_000 && held * 10_000 > supply * cap) revert HookRefused(E_CHAPTER);
        }
        if (isBuy && e.oscKind != 0) {
            uint256 cap;
            if (e.oscKind == M.OSC_BREATH) {
                uint256 p = e.oscPeriod;
                int256 phase = int256(((block.timestamp - launchTs) % p) << 32) / int256(p);
                cap = M.oscCapBps(e.oscBaseBps, e.oscFloorBps, M.sinTurn(phase) * int256(uint256(e.oscAmpPct)) / 100);
            } else {
                cap = M.oscCapBps(e.oscBaseBps, e.oscFloorBps, _oscAdvance(e));
                if (!_over(amount, supply, cap)) {
                    // the kick: a buy the size of the base cap adds energy% of amplitude
                    int256 baseAmt = int256(supply * e.oscBaseBps / 10_000);
                    if (baseAmt == 0) baseAmt = 1;
                    int256 a = int256(amount) < baseAmt * 16 ? int256(amount) : baseAmt * 16;
                    oscV1 = M.clamp(oscV1 + _k1 * a / baseAmt);
                    if (e.oscKind == M.OSC_COUPLED) oscV2 = M.clamp(oscV2 + _k2 * a / baseAmt);
                }
            }
            if (_over(amount, supply, cap)) revert HookRefused(E_OSC);
        }
    }

    /// Brings the oscillator to now and returns its displacement (Q32).
    function _oscAdvance(Ext memory e) internal returns (int256 x) {
        uint256 last = oscLastTs;
        uint256 nowTs = block.timestamp;
        bool reset = last == 0 || nowTs - last > M.oscQuietAfter(e.oscDampPermille, e.oscPeriod);
        uint256 dt = nowTs - last;
        (int256 x1, int256 v1) = _mode(oscX1, oscV1, _m1, dt, reset);
        (oscX1, oscV1) = (x1, v1);
        x = x1;
        if (e.oscKind == M.OSC_COUPLED) {
            (int256 x2, int256 v2) = _mode(oscX2, oscV2, _m2, dt, reset);
            (oscX2, oscV2) = (x2, v2);
            x += x2;
        }
        oscLastTs = uint64(nowTs);
    }

    function _mode(int256 px, int256 pv, int256[4] memory m, uint256 dt, bool reset) internal pure returns (int256, int256) {
        if (reset) return (0, 0);
        if (dt == 0) return (px, pv);
        int256[4] memory p = M.mpow(m, dt);
        return (M.clamp((p[0] * px + p[1] * pv) >> 32), M.clamp((p[2] * px + p[3] * pv) >> 32));
    }

    /// The oscillating per-buy cap right now, bps of supply (for the token page; a view, so nothing moves).
    function oscCapNow() external view returns (uint256) {
        Ext memory e = _ext;
        if (e.oscKind == 0) return 0;
        if (e.oscKind == M.OSC_BREATH) {
            uint256 p = e.oscPeriod;
            int256 phase = int256(((block.timestamp - launchTs) % p) << 32) / int256(p);
            return M.oscCapBps(e.oscBaseBps, e.oscFloorBps, M.sinTurn(phase) * int256(uint256(e.oscAmpPct)) / 100);
        }
        uint256 last = oscLastTs;
        bool reset = last == 0 || block.timestamp - last > M.oscQuietAfter(e.oscDampPermille, e.oscPeriod);
        uint256 dt = block.timestamp - last;
        (int256 x,) = _mode(oscX1, oscV1, _m1, dt, reset);
        if (e.oscKind == M.OSC_COUPLED) { (int256 x2,) = _mode(oscX2, oscV2, _m2, dt, reset); x += x2; }
        return M.oscCapBps(e.oscBaseBps, e.oscFloorBps, x);
    }
}

/// Deploys tokens for the launchpad. Its own contract only because the token's code inside the launchpad
/// would push the launchpad past the 24 KB contract size limit. The launchpad creates it, so only the
/// launchpad can use it.
contract HookerTokenFactory {
    address public immutable launchpad = msg.sender;
    /// the token code every launch is a clone of
    address public immutable implementation;

    constructor(address implementation_) {
        implementation = implementation_;
    }

    /// Mirrors validateRules in lib/rules.mjs (the Solana hook's `validate`), minus the Solana-only rules.
    error Refused(string why);
    function validateRules(HookerToken.Rules calldata r) external pure {
        if (r.maxWalletBps != 0 && (r.maxWalletBps < 10 || r.maxWalletBps > 10_000)) revert Refused("max per wallet");
        if (r.earlySecs > 86_400) revert Refused("launch window");
        if (r.earlySecs > 0 && (r.earlyMaxWalletBps < 10 || r.earlyMaxWalletBps > 10_000)) revert Refused("launch-window cap");
        if (r.earlySecs == 0 && r.earlyMaxWalletBps != 0) revert Refused("cap without a window");
        if (r.feeCapBps > 2_000 || r.feeBaseBps > r.feeCapBps || (r.feePerEthBps > 0 && r.feeCapBps == 0)) revert Refused("dynamic fee");
        if (r.burnBps > 2_000 || uint256(r.feeCapBps) + r.burnBps > 3_000) revert Refused("burn");
        if (r.holderShareBps > 10_000) revert Refused("holder share");
        if (r.allowlist && r.blocklist) revert Refused("allowlist and blocklist");
        if (r.tradeGuardBps != 0 && (r.tradeGuardBps < 10 || r.tradeGuardBps > 10_000)) revert Refused("trade guard");
        if (r.rampSecs > 0) {
            if (r.rampSecs > 7 days || r.maxWalletBps == 0 || r.rampStartBps < 10 || r.rampStartBps >= r.maxWalletBps) revert Refused("rising max per wallet");
        } else if (r.rampStartBps != 0) revert Refused("ramp start without a ramp");
        if (r.hoursOn) {
            if (r.hoursDays == 0 || r.hoursDays > 127 || r.hoursOpenMin > 1_439 || r.hoursCloseMin > 1_439 || r.hoursOpenMin == r.hoursCloseMin || r.tzOffsetMin < -720 || r.tzOffsetMin > 840) revert Refused("trading hours");
        } else if (r.hoursDays != 0 || r.hoursOpenMin != 0 || r.hoursCloseMin != 0 || r.tzOffsetMin != 0) revert Refused("hours without the rule");
        if (r.bundleMax > 20) revert Refused("anti-bundle");
    }


    /// Mirrors v3::validate in the Solana hook (and validateV3 in lib/rules.mjs), minus the Solana-only rules.
    function validateExt(HookerToken.Rules calldata r, HookerToken.Ext calldata e) external pure {
        bool sideCaps = e.maxBuyBps != 0 || e.maxSellBps != 0;
        if ((e.maxBuyBps != 0 && (e.maxBuyBps < 10 || e.maxBuyBps > 10_000)) || (e.maxSellBps != 0 && (e.maxSellBps < 10 || e.maxSellBps > 10_000))) revert Refused("anti-dump caps");
        if (sideCaps && r.tradeGuardBps != 0) revert Refused("anti-dump caps and trade guard both cap a trade");
        if (e.sellBagBps != 0) {
            if (e.sellSmallBps < 2 || e.sellSmallBps > 10_000 || e.sellFloorBps < 1 || e.sellFloorBps >= e.sellSmallBps || e.sellBagBps < 10 || e.sellBagBps > 10_000) revert Refused("graduated sell caps");
            if (e.maxSellBps != 0) revert Refused("graduated sell caps and a max per sell both cap a sell");
        } else if (e.sellSmallBps != 0 || e.sellFloorBps != 0) revert Refused("graduated sell caps without the rule");
        if (e.plagueDose != 0 && (e.dexOnly || e.p2pOnly)) revert Refused("plague spreads by sends");
        if (e.dexOnly && e.p2pOnly) revert Refused("DEX-only and P2P-only");
        if (e.p2pOnly && (r.hoursOn || r.bundleMax != 0 || e.potatoOn || e.pingOn || sideCaps || e.sellBagBps != 0 || e.kingOn || e.oscKind != 0)) revert Refused("P2P-only with buy or sell rules");
        if (e.potatoOn) { if (e.potatoMinBps > 100 || e.potatoColdSecs > 86_400) revert Refused("hot potato"); }
        else if (e.potatoMinBps != 0 || e.potatoColdSecs != 0) revert Refused("hot potato without the rule");
        if (e.pingOn) { if (e.pingMinBps > 100 || e.pingFreeSecs > 86_400) revert Refused("ping pong"); }
        else if (e.pingMinBps != 0 || e.pingFreeSecs != 0) revert Refused("ping pong without the rule");
        if (e.chapterStartBps != 0 || e.chapterVolume != 0) {
            if (e.chapterStartBps < 10 || e.chapterStartBps > 10_000 || e.chapterVolume == 0) revert Refused("chapters");
            if (r.maxWalletBps != 0 || r.rampSecs != 0) revert Refused("chapters and max per wallet both cap a wallet");
        }
        if (e.oscKind > 4) revert Refused("unknown oscillator");
        if (e.oscKind == 0) {
            if (e.oscPeriod != 0 || e.oscBaseBps != 0 || e.oscFloorBps != 0 || e.oscAmpPct != 0 || e.oscDampPermille != 0 || e.oscCouplingPct != 0) revert Refused("oscillator settings without the rule");
        } else {
            if (e.oscKind == 1) {
                if (e.oscPeriod < 30 || e.oscPeriod > 3_600 || e.oscAmpPct < 10 || e.oscAmpPct > 100 || e.oscDampPermille != 0 || e.oscCouplingPct != 0) revert Refused("breathing cap");
            } else {
                if (e.oscPeriod < 20 || e.oscPeriod > 1_200 || e.oscAmpPct < 5 || e.oscAmpPct > 100 || e.oscDampPermille < 10 || e.oscDampPermille > 400) revert Refused("oscillator");
                if ((e.oscKind == 4) != (e.oscCouplingPct != 0) || e.oscCouplingPct > 60) revert Refused("coupling");
            }
            if (e.oscBaseBps < 10 || e.oscBaseBps > 10_000 || e.oscFloorBps < 1 || e.oscFloorBps > e.oscBaseBps) revert Refused("oscillator base cap and floor");
        }
        if (e.kingOn) {
            if (e.kingBeatPct > 50 || e.kingDecayUnit > 3 || (e.kingDecayUnit == 0) != (e.kingDecayN == 0) || e.kingDecayN > 60) revert Refused("King of the Hill");
        } else if (e.kingMin != 0 || e.kingBeatPct != 0 || e.kingDecayUnit != 0 || e.kingDecayN != 0 || e.kingDevCan) revert Refused("King of the Hill settings without the rule");
        if (!r.hoursOn && (e.hoursSells || e.hoursHolidays || e.hoursDst != 0)) revert Refused("trading-hours options without trading hours");
        if (e.hoursDst > 2) revert Refused("daylight saving");
    }

    function create(string calldata name_, string calldata symbol_, string calldata image_, uint256 supply, address dev_, address treasury_, HookerToken.Rules calldata r, HookerToken.Ext calldata e)
        external
        returns (address)
    {
        require(msg.sender == launchpad, "only the launchpad");
        address t = Clones.clone(implementation);
        HookerToken(t).initialize(name_, symbol_, image_, supply, dev_, treasury_, launchpad, r, e);
        return t;
    }
}
