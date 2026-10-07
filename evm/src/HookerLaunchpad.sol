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
    /// Named as creator-fee recipient of every coin that graduates into Pons (unless its creator chose "creator fees to
    /// holders"): the burn side. Its fees buy and burn $HOOKER on Solana. Owner-settable; existing coins keep theirs.
    address public feeRecipient;
    IPonsV2Factory public immutable pons;
    IPonsDistributorFactory public immutable distributors;
    HookerTokenFactory public immutable tokenFactory;

    /// Pons V2's own curve for ETH (read on chain 5 Oct 2026: phantom 1.68 ETH, whole supply on the curve, graduation
    /// after 4.2 ETH of real buys). A launch paired with one of Pons's pair assets (USDG, the xStocks, …) takes that
    /// asset's own numbers from `pairTokenEconomics` instead. Every "Eth" below means "units of the launch's asset".
    uint256 public virtualEth = 1.68 ether;
    uint256 public supply = 1e27;
    uint256 public ponsGraduationEth = 4.2 ether;
    /// The dynamic fee's "per 1 ETH" for ETH launches; a pair-asset launch uses the same share of its graduation.
    uint256 public feeUnit = 1 ether;
    /// ETH held for Pons's launch fee of pair-asset launches (each creator pays it at launch).
    uint256 public ethReserve;
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

    /// Refunding: the curve is full but Pons refused the launch (or the owner called it off); holders sell back
    /// along the frozen curve, with no fee, until it is empty. Added after the first states, so their numbers hold.
    enum State { None, Trading, Complete, Graduated, Paid, Refunding }

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
        uint256 potEth;     // holder share that did not fit under Pons's graduation: paid out in the quote asset, by weight
        uint64 lastTrade;   // when it last traded: a curve nobody touches for a long time can be swept by the owner
        uint256 launchFeeEth; // pair-asset launches: the ETH the creator paid for Pons's launch fee
        address quote;      // the asset the curve is priced in: address(0) for ETH, else a Pons pair asset
        uint256 feeUnit;    // the dynamic fee's "per 1 ETH" in this asset
        uint256 ponsGrad;   // where Pons's own curve graduates for this asset
    }
    /// Pons caps each social at 256 bytes; a longer one would make the graduation revert forever.
    uint256 public constant SOCIAL_MAX = 256;
    /// After this long without a trade, a curve that never filled can have its holder-share pot swept.
    uint256 public constant POT_SWEEP_AFTER = 180 days;

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
        uint256 quoteIn;       // pair-asset launches: the creator's first buy, pulled from the creator (approve first)
        address quote;         // address(0) for ETH, else one of Pons's approved pair assets
        HookerToken.Ext ext;   // the v3 rules (all off = none)
    }

    mapping(address => Launch) public launches;
    mapping(address => Meta) internal _meta;
    address[] public tokens;
    /// Fees are kept per asset: creator → asset → amount, and asset → amount for the platform.
    mapping(address => mapping(address => uint256)) public creatorFees;
    mapping(address => uint256) public platformFees;
    /// King of the Hill: the King earns KING_BPS of every trade's value while they reign, out of the platform's part
    /// of the fee (as on Solana, where it comes out of Hooker's half). Kept per King and asset; anyone may push it.
    uint256 public constant KING_BPS = 30;
    mapping(address => bool) public kingRule;
    mapping(address => mapping(address => uint256)) public kingOwed;

    event Launched(address indexed token, address indexed creator, string name, string symbol, string image, uint8 size, uint8 tier, bool antiSnipe, uint256 gradEth, address quote);
    event Trade(address indexed token, address indexed trader, bool isBuy, uint256 eth, uint256 tokens, uint256 fee, uint256 vEth, uint256 vTokens, uint256 realEth);
    event Complete(address indexed token);
    event Graduated(address indexed token, address indexed ponsToken, uint256 ethSpent, uint256 ponsBought, uint256 ponsPot, address feeRecipient);
    event Paid(address indexed token, uint256 holdersPaid, bool done);
    event CreatorFeesClaimed(address indexed creator, address quote, uint256 amount);
    event Aborted(address indexed token, string why);
    event KingCredited(address indexed token, address indexed king, address quote, uint256 amount);
    event KingPaid(address indexed king, address quote, uint256 amount);

    error Refused(string why);

    /// `tokenImpl` is a deployed HookerToken: every launch is a clone of it (deployed apart, because its code inside
    /// this contract's would pass the size limits).
    constructor(address owner_, address treasury_, address feeRecipient_, IPonsV2Factory pons_, IPonsDistributorFactory distributors_, address tokenImpl) {
        owner = owner_;
        treasury = treasury_;
        feeRecipient = feeRecipient_;
        pons = pons_;
        distributors = distributors_;
        tokenFactory = new HookerTokenFactory(tokenImpl);
    }

    /// ETH sent straight here (nothing of ours does) is not stranded: it counts as platform fees and can be swept.
    receive() external payable { platformFees[address(0)] += msg.value; }
    /// ETH for Pons's launch fees of pair-asset launches, should Pons raise the fee after a launch paid it.
    function topUpReserve() external payable { ethReserve += msg.value; }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Refused("only the owner");
        _;
    }

    function setOwner(address o) external onlyOwner { owner = o; }
    function setTreasury(address t) external onlyOwner { treasury = t; }
    function setFeeRecipient(address r) external onlyOwner { if (r == address(0)) revert Refused("zero"); feeRecipient = r; }
    /// Pons may change its curve; new launches then follow it (existing ones keep theirs).
    function setCurve(uint256 virtualEth_, uint256 supply_, uint256 ponsGraduationEth_) external onlyOwner {
        virtualEth = virtualEth_;
        supply = supply_;
        ponsGraduationEth = ponsGraduationEth_;
        feeUnit = ponsGraduationEth_ * 10 / 42;
    }
    /// Spare ETH in the reserve (launch fees that were never needed) goes to the treasury.
    function sweepEthReserve() external onlyOwner nonReentrant {
        uint256 a = ethReserve;
        ethReserve = 0;
        (bool ok,) = treasury.call{value: a}("");
        if (!ok) revert Refused("ETH transfer failed");
    }

    function tokenCount() external view returns (uint256) { return tokens.length; }
    function meta(address token) external view returns (Meta memory) { return _meta[token]; }

    // ─── launch ───

    /// Creates the token and its curve. For an ETH launch msg.value is the creator's first buy (at the step's own fee,
    /// never the anti-snipe fee, the way the Solana launch's first swap pays the minimum). For a launch paired with a
    /// Pons pair asset the first buy is `a.quoteIn` of the asset (approved to this contract beforehand) and msg.value
    /// must be Pons's launch fee in ETH, kept for the graduation.
    function launch(LaunchInput calldata a) external payable nonReentrant returns (address token) {
        if (a.size >= 4 || a.tier >= 4) revert Refused("size or fee step");
        if (bytes(a.name).length == 0 || bytes(a.name).length > 32 || bytes(a.symbol).length == 0 || bytes(a.symbol).length > 10) revert Refused("name or ticker length");
        if (bytes(a.image).length > 512 || bytes(a.description).length > 2048) revert Refused("image or description too long");
        if (bytes(a.socials.twitter).length > SOCIAL_MAX || bytes(a.socials.telegram).length > SOCIAL_MAX || bytes(a.socials.discord).length > SOCIAL_MAX
            || bytes(a.socials.website).length > SOCIAL_MAX || bytes(a.socials.farcaster).length > SOCIAL_MAX) revert Refused("a social link is too long");
        tokenFactory.validateRules(a.rules);
        tokenFactory.validateExt(a.rules, a.ext);
        uint256 phantom = virtualEth;
        uint256 grad = ponsGraduationEth;
        if (a.quote != address(0)) {
            if (!pons.approvedPairTokens(a.quote)) revert Refused("not a Pons pair asset");
            (phantom, grad,) = pons.pairTokenEconomics(a.quote);
            if (phantom == 0 || grad == 0) revert Refused("not a Pons pair asset");
        }

        // the crown's minimum is in the launch's asset: between 1/4200 of a full Pons graduation (0.001 ETH) and all of it
        if (a.ext.kingOn && (a.ext.kingMin < grad / 4_200 || a.ext.kingMin > grad)) revert Refused("King of the Hill minimum");
        token = tokenFactory.create(a.name, a.symbol, a.image, supply, msg.sender, treasury, a.rules, a.ext);
        if (a.ext.kingOn) kingRule[token] = true;
        Launch storage l = launches[token];
        l.state = State.Trading;
        l.creator = msg.sender;
        l.createdAt = uint64(block.timestamp);
        l.tier = a.tier;
        l.antiSnipe = a.antiSnipe;
        l.vEth = phantom;
        l.vTokens = supply;
        l.gradEth = grad * sizeBps[a.size] / 10_000;
        l.quote = a.quote;
        l.ponsGrad = grad;
        l.feeUnit = a.quote == address(0) ? feeUnit : grad * 10 / 42;
        l.lastTrade = uint64(block.timestamp);
        _meta[token] = Meta(a.description, a.socials);
        tokens.push(token);
        emit Launched(token, msg.sender, a.name, a.symbol, a.image, a.size, a.tier, a.antiSnipe, l.gradEth, a.quote);

        if (a.quote == address(0)) {
            if (msg.value > 0) _buy(token, l, msg.value, a.minTokensOut, msg.sender, feeBps[a.tier]);
        } else {
            uint256 fee = pons.launchFee();
            if (msg.value != fee) revert Refused("send Pons's launch fee in ETH");
            l.launchFeeEth = fee;
            ethReserve += fee;
            if (a.quoteIn > 0) { IERC20(a.quote).safeTransferFrom(msg.sender, address(this), a.quoteIn); _buy(token, l, a.quoteIn, a.minTokensOut, msg.sender, feeBps[a.tier]); }
        }
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

    /// A buy: msg.value for an ETH launch; `quoteIn` of the asset (approved beforehand) for a pair-asset launch.
    function buy(address token, uint256 quoteIn, uint256 minTokensOut) external payable nonReentrant returns (uint256) {
        Launch storage l = launches[token];
        if (l.quote == address(0)) { if (quoteIn != msg.value) revert Refused("quoteIn must equal the ETH sent"); }
        else { if (msg.value != 0) revert Refused("this launch trades in its pair asset"); IERC20(l.quote).safeTransferFrom(msg.sender, address(this), quoteIn); }
        return _buy(token, l, quoteIn, minTokensOut, msg.sender, currentFeeBps(token));
    }

    function sell(address token, uint256 amount, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        Launch storage l = launches[token];
        if (l.state != State.Trading && l.state != State.Refunding) revert Refused("not trading");
        if (amount == 0) revert Refused("nothing to sell");
        uint256 gross = l.vEth - Math.mulDiv(l.vEth, l.vTokens, l.vTokens + amount, Math.Rounding.Ceil);
        if (gross > l.realEth) gross = l.realEth;
        uint256 fee = l.state == State.Refunding ? 0 : gross * currentFeeBps(token) / 10_000;
        ethOut = gross - fee;
        if (ethOut < minEthOut) revert Refused("slippage");
        address k = _king(token, gross);
        HookerToken(token).pull(msg.sender, amount);
        l.vEth -= gross;
        l.vTokens += amount;
        l.realEth -= gross;
        l.lastTrade = uint64(block.timestamp);
        _takeFee(token, l, fee, gross, k);
        emit Trade(token, msg.sender, false, ethOut, amount, fee, l.vEth, l.vTokens, l.realEth);
        _send(l.quote, msg.sender, ethOut);
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
        l.lastTrade = uint64(block.timestamp);
        _takeFee(token, l, fee, net + fee, _king(token, net + fee));

        // dynamic fee and auto burn, in tokens, on every buy (the Solana side settles these at graduation)
        HookerToken.Rules memory r = HookerToken(token).rules();
        uint256 feeTok;
        if (r.feeCapBps > 0) {
            uint256 fbps = r.feeBaseBps + uint256(r.feePerEthBps) * net / l.feeUnit;
            if (fbps > r.feeCapBps) fbps = r.feeCapBps;
            feeTok = out * fbps / 10_000;
        }
        uint256 burnTok = out * r.burnBps / 10_000;
        received = out - feeTok - burnTok;
        if (received < minTokensOut) revert Refused("slippage");
        IERC20(token).safeTransfer(buyer, received);
        if (feeTok > 0) IERC20(token).safeTransfer(HookerToken(token).treasury(), feeTok);
        if (burnTok > 0) IERC20(token).safeTransfer(DEAD, burnTok);
        emit Trade(token, buyer, true, net + fee, out, fee, l.vEth, l.vTokens, l.realEth);

        if (l.realEth >= l.gradEth) {
            l.state = State.Complete;
            emit Complete(token);
        }
        if (refund > 0) _send(l.quote, buyer, refund);
    }

    /// King of the Hill: tells the token this trade's value (it crowns by it) and returns the King reigning as the
    /// trade starts, who earns on it. Nothing for a token without the rule.
    function _king(address token, uint256 value) internal returns (address) {
        if (!kingRule[token]) return address(0);
        HookerToken(token).noteTrade(value);
        return HookerToken(token).king();
    }

    /// The step's split: the creator's share of the fee, then holder share and the King's share out of the platform's part.
    function _takeFee(address token, Launch storage l, uint256 fee, uint256 value, address k) internal {
        if (fee == 0) return;
        uint256 c = fee * creatorBps[l.tier] / feeBps[l.tier];
        creatorFees[l.creator][l.quote] += c;
        uint256 p = fee - c;
        uint256 toPot = p * HookerToken(token).rules().holderShareBps / 10_000;
        l.pot += toPot;
        p -= toPot;
        if (k != address(0)) {
            uint256 cut = value * KING_BPS / 10_000;
            if (cut > p) cut = p;
            kingOwed[k][l.quote] += cut;
            p -= cut;
            emit KingCredited(token, k, l.quote, cut);
        }
        platformFees[l.quote] += p;
    }

    /// Sends a King what they earned in one asset. Anyone may push it (the graduation service does, about every
    /// minute); a wallet that refuses it keeps it owed.
    function payKing(address k, address quote) external nonReentrant {
        uint256 a = kingOwed[k][quote];
        if (a == 0) return;
        kingOwed[k][quote] = 0;
        if (!_tryPay(quote, k, a)) { kingOwed[k][quote] = a; return; }
        emit KingPaid(k, quote, a);
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
        address quote = l.quote;
        uint256 base;
        if (quote == address(0)) {
            if (launchFee >= l.realEth) revert Refused("Pons launch fee above the raise");
            base = l.realEth - launchFee;
        } else {
            // the creator paid Pons's fee at launch; if Pons raised it since, the reserve covers the difference
            if (launchFee > l.launchFeeEth) { if (ethReserve < launchFee - l.launchFeeEth) revert Refused("top up ethReserve"); ethReserve -= launchFee - l.launchFeeEth; }
            else ethReserve += l.launchFeeEth - launchFee;
            base = l.realEth;
        }
        uint256 pot = l.pot;
        // stay under Pons's own graduation: a buy that crossed it would leave the coin between phases. Base ETH that
        // does not fit goes to the platform (it only happens if Pons shrinks its curve); holder share that does not
        // fit is paid to holders as ETH at payout.
        uint256 maxIn = Math.mulDiv(l.ponsGrad, 10_000, 10_000 - 100) - 1;
        if (base > maxIn) { platformFees[quote] += base - maxIn; base = maxIn; }
        if (base + pot > maxIn) { l.potEth = base + pot - maxIn; pot = maxIn - base; }
        uint256 quoteIn = base + pot;

        bool toHolders = t.rules().holderRewards;
        address forwarder = pons.launchForwarder();
        if (quote != address(0)) IERC20(quote).forceApprove(forwarder, quoteIn); // the periphery pulls the asset from us
        (address coin, address curve, uint256 bought) = IPonsV2LaunchAndBuy(forwarder).launchAndBuy{value: quote == address(0) ? launchFee + quoteIn : launchFee}(
            _ponsParams(token, toHolders ? address(this) : feeRecipient), 0, quote, quoteIn, 0, address(this), new address[](0)
        );
        if (quote != address(0)) IERC20(quote).forceApprove(forwarder, 0);
        uint256 baseBought = pot > 0 ? _baseShare(curve, quoteIn, base, bought) : bought;

        address recipient = feeRecipient;
        if (toHolders) {
            // Pons's own holder fee sharing: a distributor for the coin takes its creator fees for good
            address d = distributors.distributorOf(coin);
            if (d == address(0)) d = distributors.createFor(coin);
            IPonsCreatorFees(address(pons)).transferCreatorFeeRecipient(coin, d);
            recipient = d;
        }

        l.ponsToken = coin;
        l.ponsBase = baseBought;
        l.ponsPot = bought - baseBought;
        l.circulating = t.totalSupply() - t.balanceOf(address(this));
        l.state = State.Graduated;
        emit Graduated(token, coin, launchFee + quoteIn, bought, l.ponsPot, recipient);
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

    /// Calls a full curve off: holders sell back, fee-free, along the frozen curve. The owner may do it any time
    /// (a launch Pons would refuse, say a social link it rejects); anyone may once Pons has stopped taking launches,
    /// so nobody's ETH depends on the owner being around.
    function abort(address token) external nonReentrant {
        Launch storage l = launches[token];
        if (l.state != State.Complete) revert Refused("not full");
        string memory why = "called off by the owner";
        if (msg.sender != owner) {
            if (pons.launchEnabled()) revert Refused("only the owner, while Pons takes launches");
            why = "Pons stopped taking launches";
        }
        l.state = State.Refunding;
        emit Aborted(token, why);
    }

    /// A curve that never filled and has not traded for POT_SWEEP_AFTER: its holder-share pot goes to the treasury.
    function sweepPot(address token) external onlyOwner nonReentrant {
        Launch storage l = launches[token];
        if (l.state != State.Trading || block.timestamp < l.lastTrade + POT_SWEEP_AFTER) revert Refused("still live");
        uint256 p = l.pot;
        l.pot = 0;
        _send(l.quote, treasury, p);
    }

    /// The holder's Pons coins: snapshot balance share of the base, plus balance × time share of the pot.
    function allocationOf(address token, address holder) public view returns (uint256) {
        Launch storage l = launches[token];
        HookerToken t = HookerToken(token);
        return Math.mulDiv(l.ponsBase, t.balanceOf(holder), l.circulating) + _potShare(l, t, holder, l.ponsPot);
    }

    /// A holder's part of a pot: by balance × time held, or by balance alone when no time has passed at all
    /// (a curve that filled in the second it launched), so a pot is never left without an owner.
    function _potShare(Launch storage l, HookerToken t, address holder, uint256 pot) internal view returns (uint256) {
        if (pot == 0) return 0;
        uint256 w = t.totalWeight();
        return w > 0 ? Math.mulDiv(pot, t.weightOf(holder), w) : Math.mulDiv(pot, t.balanceOf(holder), l.circulating);
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
            // the holder share that did not fit under Pons's graduation, in the quote asset; a wallet that refuses it forfeits it
            uint256 e = _potShare(l, t, h, l.potEth);
            if (e > 0 && !_tryPay(l.quote, h, e)) platformFees[l.quote] += e;
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

    /// A creator's fees in one asset (address(0) = ETH).
    function claimCreatorFees(address quote) external nonReentrant returns (uint256 amount) {
        amount = creatorFees[msg.sender][quote];
        if (amount == 0) revert Refused("nothing to claim");
        creatorFees[msg.sender][quote] = 0;
        emit CreatorFeesClaimed(msg.sender, quote, amount);
        _send(quote, msg.sender, amount);
    }

    /// The platform's fees in one asset go to the treasury; anyone may trigger it.
    function sweepPlatformFees(address quote) external nonReentrant {
        uint256 a = platformFees[quote];
        platformFees[quote] = 0;
        _send(quote, treasury, a);
    }

    /// Pays in an asset: ETH (address(0)), or a pair asset.
    function _send(address quote, address to, uint256 amount) internal {
        if (!_tryPay(quote, to, amount)) revert Refused("transfer failed");
    }

    function _tryPay(address quote, address to, uint256 amount) internal returns (bool ok) {
        if (quote == address(0)) { (ok,) = to.call{value: amount, gas: 50_000}(""); }
        else { try IERC20(quote).transfer(to, amount) returns (bool r) { ok = r; } catch { ok = false; } }
    }
}
