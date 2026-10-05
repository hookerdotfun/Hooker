// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

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

    uint256 public constant LIST_OPEN_SECS = 1 days;
    uint256 public constant LIST_MAX = 5_000;

    /// where the dynamic fee's tokens go, and where burned tokens go: both are paid out at graduation
    /// (the treasury its share, the dead address's share burned) and neither counts as a holder
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address public immutable treasury;
    address public immutable launchpad;
    address public immutable dev;
    uint64 public immutable launchTs;
    string public image;
    Rules internal _rules;

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

    event Listed(uint256 added, uint256 count);
    event ListSealed();

    constructor(string memory name_, string memory symbol_, string memory image_, uint256 supply, address dev_, address treasury_, address launchpad_, Rules memory r)
        ERC20(name_, symbol_)
    {
        launchpad = launchpad_;
        dev = dev_;
        treasury = treasury_;
        launchTs = uint64(block.timestamp);
        image = image_;
        _rules = r;
        _totalSince = uint64(block.timestamp);
        _mint(launchpad_, supply);
    }

    function rules() external view returns (Rules memory) { return _rules; }
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
        // sells into the curve, the creator's wallet, and the fee and burn the launchpad takes, always pass
        if (to == launchpad || to == dev || to == treasury || to == DEAD) return;
        Rules memory r = _rules;

        if (r.venueLock && to.code.length > 0) revert HookRefused(E_VENUE);
        if (r.allowlist && !listed[to]) revert HookRefused(E_NOT_LISTED);
        if (r.blocklist && listed[to]) revert HookRefused(E_BLOCKED);

        uint256 supply = totalSupply();
        if (r.tradeGuardBps > 0 && amount * 10_000 > supply * r.tradeGuardBps) revert HookRefused(E_TRADE_GUARD);

        bool isBuy = from == launchpad;
        if (isBuy && r.hoursOn && !_inHours(r, block.timestamp)) revert HookRefused(E_HOURS);
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
    }

    /// Whether `ts` is inside the weekly trading hours (the same arithmetic as the Solana hook).
    function _inHours(Rules memory r, uint256 ts) internal pure returns (bool) {
        int256 local = int256(ts) + int256(r.tzOffsetMin) * 60;
        int256 day = local >= 0 ? local / 86_400 : (local - 86_399) / 86_400;
        uint256 minute = uint256(local - day * 86_400) / 60;
        uint8 weekday = uint8(uint256(((day + 4) % 7 + 7) % 7)); // 1970-01-01 was a Thursday; 0 = Sunday
        uint16 open = r.hoursOpenMin;
        uint16 close = r.hoursCloseMin;
        if (open < close) return (r.hoursDays & (1 << weekday)) != 0 && minute >= open && minute < close;
        // overnight: the evening belongs to today, the early morning to yesterday
        return ((r.hoursDays & (1 << weekday)) != 0 && minute >= open)
            || ((r.hoursDays & (1 << ((weekday + 6) % 7))) != 0 && minute < close);
    }
}

/// Deploys tokens for the launchpad. Its own contract only because the token's code inside the launchpad
/// would push the launchpad past the 24 KB contract size limit. The launchpad creates it, so only the
/// launchpad can use it.
contract HookerTokenFactory {
    address public immutable launchpad = msg.sender;

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


    function create(string calldata name_, string calldata symbol_, string calldata image_, uint256 supply, address dev_, address treasury_, HookerToken.Rules calldata r)
        external
        returns (address)
    {
        require(msg.sender == launchpad, "only the launchpad");
        return address(new HookerToken(name_, symbol_, image_, supply, dev_, treasury_, launchpad, r));
    }
}
