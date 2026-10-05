// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {HookerToken, HookerTokenFactory} from "./HookerToken.sol";
import {IPonsV2Factory, IPonsV2LaunchAndBuy} from "./IPonsV2.sol";

interface IPonsCurve {
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve);
}

interface IPonsCreatorFees {
    function transferCreatorFeeRecipient(address token, address newRecipient) external;
}

interface IPonsDistributorFactory {
    function distributorOf(address token) external view returns (address);
    function createFor(address token) external returns (address);
}

/// hooker.fun on Robinhood Chain: the curve every Hooker token trades on, and its graduation into Pons V2.
///
/// The Solana side runs a Meteora curve shaped exactly like Pumpfun's and graduates into Pumpfun. This is
/// the same product for Pons: a constant-product curve shaped exactly like Pons V2's own (1.68 ETH of
/// virtual liquidity over the whole supply), filled to a share of Pons's own graduation (4.2 ETH). When it
/// fills, `graduate` launches the Pons V2 coin and buys it with the curve's ETH in ONE transaction (the
/// atomic first buy pays Pons's normal fee, never its snipe tax), and `payout` hands every holder their
/// share of the coins, computed on chain from the frozen balances. Nobody has to claim anything.
///
/// The rules (hooks) live in each token (HookerToken). Three of them are applied here, on each buy:
/// dynamic fee (tokens to the treasury), auto burn (tokens to the dead address), holder share (a part of
/// the platform's trading fees, spent on Pons coins at graduation and split by balance × time held).
contract HookerLaunchpad is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── platform settings ───
    address public owner;
    address public treasury;
    IPonsV2Factory public immutable pons;
    IPonsDistributorFactory public immutable distributors;
    HookerTokenFactory public immutable tokenFactory;

    /// Pons V2's own curve for a native launch (read on chain 5 Oct 2026: phantom 1.68 ETH, whole supply
    /// on the curve, graduation after 4.2 ETH of real buys). New launches use the values set here.
    uint256 public virtualEth = 1.68 ether;
    uint256 public supply = 1e27;
    uint256 public ponsGraduationEth = 4.2 ether;
    /// Graduation sizes, in bps of Pons's own graduation; the last IS Pons's.
    uint16[4] public sizeBps = [3_500, 5_000, 7_000, 10_000];
    /// Fee steps (the same as the Solana side): total bps per trade and the creator's bps of it.
    uint16[4] public feeBps = [100, 175, 300, 425];
    uint16[4] public creatorBps = [40, 99, 199, 299];
    /// Anti-snipe: the fee starts at 50% and falls to the step's fee in 12 steps over two minutes.
    uint16 public constant ANTI_SNIPE_START_BPS = 5_000;
    uint32 public constant ANTI_SNIPE_SECS = 120;
    uint32 public constant ANTI_SNIPE_PERIODS = 12;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    enum State { None, Trading, Complete, Graduated, Paid }

    struct Launch {
        State state;
        address creator;
        uint64 createdAt;
        uint8 tier;
        bool antiSnipe;
        uint256 vEth;       // virtual + real ETH in the curve
        uint256 vTokens;    // tokens in the curve, virtual
        uint256 realEth;    // ETH bought in (net of fees)
        uint256 gradEth;    // fills at this much real ETH
        uint256 pot;        // holder share: ETH for Pons coins at graduation
        address ponsToken;
        uint256 ponsBase;   // Pons coins for the snapshot balances
        uint256 ponsPot;    // Pons coins for holder share (by balance × time)
        uint256 circulating;// the snapshot: tokens outside the curve (holders, treasury, dead)
        uint256 paidUpTo;   // payout cursor into the token's holder list
    }

    struct Meta {
        string description;
        IPonsV2Factory.Socials socials;
    }

    struct LaunchInput {
        string name;
        string symbol;
        string image;          // https or ipfs link (Pons allows 512 bytes)
        string description;
        IPonsV2Factory.Socials socials;
        uint8 size;            // index into sizeBps
        uint8 tier;            // index into feeBps
        bool antiSnipe;
        HookerToken.Rules rules;
        uint256 minTokensOut;  // the dev buy's slippage guard
    }

    mapping(address => Launch) public launches;
    mapping(address => Meta) internal _meta;
    address[] public tokens;
    mapping(address => uint256) public creatorFees;
    uint256 public platformFees;

    event Launched(address indexed token, address indexed creator, string name, string symbol, string image, uint8 size, uint8 tier, bool antiSnipe, uint256 gradEth);
    event Trade(address indexed token, address indexed trader, bool isBuy, uint256 eth, uint256 tokens, uint256 fee, uint256 vEth, uint256 vTokens, uint256 realEth);
    event Complete(address indexed token);
    event Graduated(address indexed token, address indexed ponsToken, uint256 ethSpent, uint256 ponsBought, uint256 ponsPot, address feeRecipient);
    event Paid(address indexed token, uint256 holdersPaid, bool done);
    event CreatorFeesClaimed(address indexed creator, uint256 amount);

    error Refused(string why);

    constructor(address owner_, address treasury_, IPonsV2Factory pons_, IPonsDistributorFactory distributors_) {
        owner = owner_;
        treasury = treasury_;
        pons = pons_;
        distributors = distributors_;
        tokenFactory = new HookerTokenFactory();
    }

    receive() external payable {}

    modifier onlyOwner() {
        if (msg.sender != owner) revert Refused("only the owner");
        _;
    }

    function setOwner(address o) external onlyOwner { owner = o; }
    function setTreasury(address t) external onlyOwner { treasury = t; }
    /// Pons may change its curve; new launches then follow it (existing ones keep theirs).
    function setCurve(uint256 virtualEth_, uint256 supply_, uint256 ponsGraduationEth_) external onlyOwner {
        virtualEth = virtualEth_;
        supply = supply_;
        ponsGraduationEth = ponsGraduationEth_;
    }

    function tokenCount() external view returns (uint256) { return tokens.length; }
    function meta(address token) external view returns (Meta memory) { return _meta[token]; }

    // ─── launch ───

    /// Creates the token and its curve; msg.value is the creator's first buy (at the step's own fee,
    /// never the anti-snipe fee, the way the Solana launch's first swap pays the minimum).
    function launch(LaunchInput calldata a) external payable nonReentrant returns (address token) {
        if (a.size >= 4 || a.tier >= 4) revert Refused("size or fee step");
        if (bytes(a.name).length == 0 || bytes(a.name).length > 32 || bytes(a.symbol).length == 0 || bytes(a.symbol).length > 10) revert Refused("name or ticker length");
        if (bytes(a.image).length > 512 || bytes(a.description).length > 2048) revert Refused("image or description too long");
        validateRules(a.rules);

        token = tokenFactory.create(a.name, a.symbol, a.image, supply, msg.sender, treasury, a.rules);
        Launch storage l = launches[token];
        l.state = State.Trading;
        l.creator = msg.sender;
        l.createdAt = uint64(block.timestamp);
        l.tier = a.tier;
        l.antiSnipe = a.antiSnipe;
        l.vEth = virtualEth;
        l.vTokens = supply;
        l.gradEth = ponsGraduationEth * sizeBps[a.size] / 10_000;
        _meta[token] = Meta(a.description, a.socials);
        tokens.push(token);
        emit Launched(token, msg.sender, a.name, a.symbol, a.image, a.size, a.tier, a.antiSnipe, l.gradEth);

        if (msg.value > 0) _buy(token, l, msg.value, a.minTokensOut, msg.sender, feeBps[a.tier]);
    }

    /// Mirrors validateRules in lib/rules.mjs (the Solana hook's `validate`), minus the Solana-only rules.
    function validateRules(HookerToken.Rules calldata r) public pure {
        if (r.maxWalletBps != 0 && (r.maxWalletBps < 10 || r.maxWalletBps > 10_000)) revert Refused("max per wallet");
        if (r.earlySecs > 86_400) revert Refused("launch window");
        if (r.earlySecs > 0 && (r.earlyMaxWalletBps < 10 || r.earlyMaxWalletBps > 10_000)) revert Refused("launch-window cap");
        if (r.earlySecs == 0 && r.earlyMaxWalletBps != 0) revert Refused("launch-window cap without a window");
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
        } else if (r.hoursDays != 0 || r.hoursOpenMin != 0 || r.hoursCloseMin != 0 || r.tzOffsetMin != 0) revert Refused("trading hours set without the rule");
        if (r.bundleMax > 20) revert Refused("anti-bundle");
    }

    // ─── trading ───

    /// The fee a trade pays right now, in bps.
    function currentFeeBps(address token) public view returns (uint256) {
        Launch storage l = launches[token];
        uint256 base = feeBps[l.tier];
        if (!l.antiSnipe) return base;
        uint256 start = ANTI_SNIPE_START_BPS > base ? ANTI_SNIPE_START_BPS : base;
        uint256 elapsed = block.timestamp - l.createdAt;
        uint256 period = elapsed / (ANTI_SNIPE_SECS / ANTI_SNIPE_PERIODS);
        if (period >= ANTI_SNIPE_PERIODS) return base;
        return start - (start - base) * period / ANTI_SNIPE_PERIODS;
    }

    function buy(address token, uint256 minTokensOut) external payable nonReentrant returns (uint256) {
        Launch storage l = launches[token];
        return _buy(token, l, msg.value, minTokensOut, msg.sender, currentFeeBps(token));
    }

    function sell(address token, uint256 amount, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        Launch storage l = launches[token];
        if (l.state != State.Trading) revert Refused("not trading");
        if (amount == 0) revert Refused("nothing to sell");
        uint256 gross = l.vEth - Math.mulDiv(l.vEth, l.vTokens, l.vTokens + amount, Math.Rounding.Ceil);
        if (gross > l.realEth) gross = l.realEth;
        uint256 fee = gross * currentFeeBps(token) / 10_000;
        ethOut = gross - fee;
        if (ethOut < minEthOut) revert Refused("slippage");
        HookerToken(token).pull(msg.sender, amount);
        l.vEth -= gross;
        l.vTokens += amount;
        l.realEth -= gross;
        _takeFee(token, l, fee);
        emit Trade(token, msg.sender, false, ethOut, amount, fee, l.vEth, l.vTokens, l.realEth);
        _send(msg.sender, ethOut);
    }

    function _buy(address token, Launch storage l, uint256 value, uint256 minTokensOut, address buyer, uint256 bps) internal returns (uint256 received) {
        if (l.state != State.Trading) revert Refused("not trading");
        if (value == 0) revert Refused("nothing to buy with");
        uint256 fee = value * bps / 10_000;
        uint256 net = value - fee;
        uint256 refund;
        // the buy that fills the curve takes only what it needs and gets the rest back
        if (l.realEth + net >= l.gradEth) {
            net = l.gradEth - l.realEth;
            uint256 gross = Math.mulDiv(net, 10_000, 10_000 - bps, Math.Rounding.Ceil);
            if (gross > value) gross = value;
            fee = gross - net;
            refund = value - gross;
        }
        uint256 out = l.vTokens - Math.mulDiv(l.vEth, l.vTokens, l.vEth + net, Math.Rounding.Ceil);
        l.vEth += net;
        l.vTokens -= out;
        l.realEth += net;
        _takeFee(token, l, fee);

        // dynamic fee and auto burn, in tokens, on every buy (the Solana side settles these at graduation)
        HookerToken.Rules memory r = HookerToken(token).rules();
        uint256 feeTok;
        if (r.feeCapBps > 0) {
            uint256 fbps = r.feeBaseBps + uint256(r.feePerEthBps) * net / 1 ether;
            if (fbps > r.feeCapBps) fbps = r.feeCapBps;
            feeTok = out * fbps / 10_000;
        }
        uint256 burnTok = out * r.burnBps / 10_000;
        received = out - feeTok - burnTok;
        if (received < minTokensOut) revert Refused("slippage");
        IERC20(token).safeTransfer(buyer, received);
        if (feeTok > 0) IERC20(token).safeTransfer(treasury, feeTok);
        if (burnTok > 0) IERC20(token).safeTransfer(DEAD, burnTok);
        emit Trade(token, buyer, true, net + fee, out, fee, l.vEth, l.vTokens, l.realEth);

        if (l.realEth >= l.gradEth) {
            l.state = State.Complete;
            emit Complete(token);
        }
        if (refund > 0) _send(buyer, refund);
    }

    /// The step's split: the creator's share of the fee, then holder share out of the platform's part.
    function _takeFee(address token, Launch storage l, uint256 fee) internal {
        if (fee == 0) return;
        uint256 c = fee * creatorBps[l.tier] / feeBps[l.tier];
        creatorFees[l.creator] += c;
        uint256 p = fee - c;
        uint256 toPot = p * HookerToken(token).rules().holderShareBps / 10_000;
        l.pot += toPot;
        platformFees += p - toPot;
    }

    // ─── graduation ───

    /// Launches the Pons V2 coin and buys it with everything the curve raised (plus the holder-share pot),
    /// in one transaction. Anyone may call it once the curve is full; every input is fixed on chain.
    function graduate(address token) external nonReentrant returns (address ponsToken) {
        Launch storage l = launches[token];
        if (l.state != State.Complete) revert Refused("not full");
        HookerToken t = HookerToken(token);
        t.freeze();

        uint256 launchFee = pons.launchFee();
        uint256 base = l.realEth - launchFee;
        uint256 pot = l.pot;
        // stay under Pons's own graduation: a buy that crossed it would leave the coin between phases
        uint256 maxIn = Math.mulDiv(ponsGraduationEth, 10_000, 10_000 - 100) - 1;
        if (base > maxIn) { platformFees += base - maxIn; base = maxIn; }
        if (base + pot > maxIn) { platformFees += base + pot - maxIn; pot = maxIn - base; }
        uint256 quoteIn = base + pot;

        bool toHolders = t.rules().holderRewards;
        (address coin, address curve, uint256 bought) = IPonsV2LaunchAndBuy(pons.launchForwarder()).launchAndBuy{value: launchFee + quoteIn}(
            _ponsParams(token, toHolders ? address(this) : l.creator), 0, address(0), quoteIn, 0, address(this), new address[](0)
        );
        uint256 baseBought = pot > 0 ? _baseShare(curve, quoteIn, base, bought) : bought;

        address feeRecipient = l.creator;
        if (toHolders) {
            // Pons's own holder fee sharing: a distributor for the coin takes its creator fees for good
            address d = distributors.distributorOf(coin);
            if (d == address(0)) d = distributors.createFor(coin);
            IPonsCreatorFees(address(pons)).transferCreatorFeeRecipient(coin, d);
            feeRecipient = d;
        }

        l.ponsToken = coin;
        l.ponsBase = baseBought;
        l.ponsPot = bought - baseBought;
        l.circulating = t.totalSupply() - t.balanceOf(address(this));
        l.state = State.Graduated;
        emit Graduated(token, coin, launchFee + quoteIn, bought, l.ponsPot, feeRecipient);
        return coin;
    }

    function _ponsParams(address token, address feeRecipient) internal view returns (IPonsV2Factory.LaunchParams memory p) {
        HookerToken t = HookerToken(token);
        p.name = t.name();
        p.symbol = t.symbol();
        p.logo = t.image();
        p.description = _meta[token].description;
        p.socials = _meta[token].socials;
        p.creatorFeeRecipient = feeRecipient;
        // a salt nobody can know ahead: a stranger launching the same metadata first cannot block this
        p.salt = keccak256(abi.encode(token, block.timestamp, block.number, blockhash(block.number - 1)));
    }

    /// What the base ETH alone bought on Pons's curve (constant product, Pons's 1% fee), the pot the rest.
    function _baseShare(address curve, uint256 quoteIn, uint256 base, uint256 bought) internal view returns (uint256 b) {
        (uint256 q1, uint256 t1) = IPonsCurve(curve).getReserves();
        uint256 q0 = q1 - quoteIn * 99 / 100;
        uint256 t0 = t1 + bought;
        b = t0 - Math.mulDiv(q0, t0, q0 + base * 99 / 100, Math.Rounding.Ceil);
        if (b > bought) b = bought;
    }

    /// The holder's Pons coins: snapshot balance share of the base, plus balance × time share of the pot.
    function allocationOf(address token, address holder) public view returns (uint256) {
        Launch storage l = launches[token];
        HookerToken t = HookerToken(token);
        uint256 a = Math.mulDiv(l.ponsBase, t.balanceOf(holder), l.circulating);
        uint256 w = t.totalWeight();
        if (l.ponsPot > 0 && w > 0) a += Math.mulDiv(l.ponsPot, t.weightOf(holder), w);
        return a;
    }

    /// Sends every holder their coins, `max` holders per call (anyone may call it). The last call sends the
    /// dead address's share to the dead address (burned) and the treasury's share and the rounding dust to
    /// the treasury.
    function payout(address token, uint256 max) external nonReentrant returns (bool done) {
        Launch storage l = launches[token];
        if (l.state != State.Graduated) revert Refused("not graduated");
        HookerToken t = HookerToken(token);
        IERC20 coin = IERC20(l.ponsToken);
        uint256 n = t.holderCount();
        uint256 i = l.paidUpTo;
        uint256 end = i + max > n ? n : i + max;
        for (; i < end; i++) {
            address h = t.holders(i);
            uint256 a = allocationOf(token, h);
            if (a > 0) coin.safeTransfer(h, a);
        }
        l.paidUpTo = end;
        done = end == n;
        if (done) {
            uint256 burn = Math.mulDiv(l.ponsBase, t.balanceOf(DEAD), l.circulating);
            if (burn > 0) coin.safeTransfer(DEAD, burn);
            uint256 rest = coin.balanceOf(address(this));
            if (rest > 0) coin.safeTransfer(treasury, rest);
            l.state = State.Paid;
        }
        emit Paid(token, end, done);
    }

    // ─── fees ───

    function claimCreatorFees() external nonReentrant returns (uint256 amount) {
        amount = creatorFees[msg.sender];
        if (amount == 0) revert Refused("nothing to claim");
        creatorFees[msg.sender] = 0;
        emit CreatorFeesClaimed(msg.sender, amount);
        _send(msg.sender, amount);
    }

    /// The platform's fees go to the treasury; anyone may trigger it.
    function sweepPlatformFees() external nonReentrant {
        uint256 a = platformFees;
        platformFees = 0;
        _send(treasury, a);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert Refused("ETH transfer failed");
    }
}
