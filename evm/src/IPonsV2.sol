// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Pons V2, from the outside — only the parts SHARE actually calls.
 *
 * Live factory on Robinhood Chain: `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`.
 *
 * ⭐⭐ `creatorFeeRecipient` IS A LAUNCH PARAMETER, and that single fact is why this launchpad can
 * promise anything at all. The splitter that pays the recipients is named at the moment the token is
 * created, so there is no later `transferCreatorFeeRecipient` step and therefore no window in which
 * a live token wearing somebody's handle is earning into the launcher's own wallet.
 *
 * ⛔⛔ THE CREATOR TAX IS FIXED FOREVER. Pons ships no `setCreatorTaxBps`. Whatever a launch is
 * created with is what it charges for the rest of its life, so the launch form has to be right the
 * first time.
 */
interface IPonsV2Factory {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct LaunchParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        bytes32 expectedEconomics;
        bytes32 salt;
    }

    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function launchToken(LaunchParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        returns (address token, address curve);

    /**
     * ⭐⭐ The overload that DECLARES SNIPE TAX EXEMPTIONS, and the only way to exempt anyone on a
     * launch with no atomic developer buy.
     *
     * ⛔ It is a second entrypoint, not a variant. An empty array is NOT the same calldata as no
     * array, so the three-argument call is still the one sent when there is nothing to declare.
     */
    function launchToken(
        IPonsV2Factory.LaunchParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve);

    /**
     * ⚠ Rotatable, so it is read live and never pinned. Only the address this returns may drive the
     * atomic developer buy; a pinned one turns the day Pons replaces its periphery into an opaque
     * revert for every launcher.
     */
    function launchForwarder() external view returns (address);

    function launchEnabled() external view returns (bool);
    function launchFee() external view returns (uint256);
    function maxCreatorTaxBps() external view returns (uint256);
    function approvedPairTokens(address pairToken) external view returns (bool);
    function previewLaunchEconomics(uint256 launchConfigId, address pairToken) external view returns (bytes32);
    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
    /**
     * ⛔⛔ THE SNIPE TAX, and the pair of numbers LONG's launch warning is built on. A buy in the
     * launch's own second pays `snipeTaxStartBps` (9,900 = 99%), decaying to zero across
     * `snipeTaxSeconds` (3) of WALL CLOCK — not blocks. RHC has two block clocks and the block one
     * runs 120x slow, so anything counting blocks here is wrong by two orders of magnitude.
     *
     * ⚠ The failure mode is not a rejected transaction. The buy SUCCEEDS and the buyer silently
     * loses 99% of their money.
     */
    function snipeTaxStartBps() external view returns (uint16);
    function snipeTaxSeconds() external view returns (uint256);

    /**
     * ⭐⭐ THE NUMBER THAT SHAPES THE PRODUCT. `graduationThreshold` for NVDA is 41.6 NVDA — about
     * $7.5k. Launches here graduate FAST, so the hook is the main fee-collection path and the curve
     * is a short opening act. Read per pair asset; never assume one threshold fits all of them.
     */
    function pairTokenEconomics(address pairToken)
        external
        view
        returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals);

    /**
     * ⭐⭐ THE ONLY THING THAT MOVES A PHASE-1 LAUNCH ALONG, and it is PERMISSIONLESS.
     *
     * ⛔⛔ Graduation is not one step. `phase` goes 0 (on the curve) → 1 (swept, POOL NOT SEEDED) →
     * 2 (trading in the pool). At phase 1 the curve sweep reverts `AlreadyGraduated()` AND the hook
     * sweep reverts `UnknownPool()`, because the pool does not exist yet. Neither failure names the
     * fix, and a front end built on a graduated/not-graduated boolean shows a button that can only
     * ever revert.
     *
     * ➤ Anybody may call this. Selector `0x2f53ef2f`.
     */
    function createGraduatedPool(address token) external;

    function feeEscrow() external view returns (address);
    function memeHook() external view returns (address);
}

/**
 * Pons's periphery: the launch and the developer's first buy settled in ONE transaction.
 *
 * ⛔⛔ THE ONLY WAY TO BUY AT LAUNCH WITHOUT BEING SNIPED. A buy sent as a follow-up transaction is
 * a separate block for a bot to get in front of, and it pays the snipe tax as well.
 *
 * ⚠⚠ Its native value check is EXACT: `launchFee + quoteIn` for a native pair, `launchFee` alone
 * otherwise. Anything else reverts `NativeValueMismatch`. There is no slack and no tip.
 */
interface IPonsV2LaunchAndBuy {
    function launchAndBuy(
        IPonsV2Factory.LaunchParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        uint256 quoteIn,
        uint256 minTokensOut,
        address recipient,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve, uint256 tokensOut);
}

/**
 * Pons V2's fee escrow.
 *
 * ⚠⚠ TWO LEDGERS, AND A LAUNCH ONLY EVER LANDS IN ONE. `balanceOf` is native ETH;
 * `balanceOfToken` is everything else. A launch paired against USDG credits ONLY the token ledger
 * and its native balance reads a truthful, useless zero forever. Anything that harvests must do
 * both sides and must never infer one from the other — reading only the native ledger is how a live
 * earner gets reported as having made nothing.
 *
 * ⚠ Both claims pay `msg.sender` and take no recipient. There is no claiming on behalf of anybody,
 * which is why the splitter is a contract rather than a script: to be paid it must BE the fee
 * recipient, so it must be able to call `claim` itself.
 *
 * ⚠ Pons REVERTS rather than returning zero when there is nothing to claim, so every call is
 * wrapped. Unguarded, a harvest reverts for the entire window between two trades.
 */
interface IPonsFeeEscrow {
    function balanceOf(address recipient) external view returns (uint256);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
    function claim() external returns (uint256);
    function claimToken(address token) external returns (uint256);
}

/**
 * The bonding curve, for the one call a fee recipient has to be able to make on it.
 *
 * ⛔⛔ `sweepFees` REVERTS `NotFeeSweepOperator()` for everyone but Pons's own operator and the
 * launch's fee recipient. The fee recipient here is the splitter, so without a passthrough on the
 * splitter there is no way for anybody on this side to move a launch's fees into the escrow:
 * `harvest` is permissionless but the step BEFORE it is not.
 */
interface IPonsCurveSweep {
    function sweepFees(uint256 minBuybackTokensOut) external;
}

/**
 * The meme hook, which is where a GRADUATED launch's fees accrue.
 *
 * ⛔⛔ GRADUATING MOVES THE MONEY. The curve stops earning, `sweepFees` starts reverting, and the
 * fees begin piling up in the hook instead. A launchpad that only knows how to sweep the curve
 * cannot move a graduated launch's fees and — because the escrow is what the sweep FILLS — cannot
 * even see them, so its biggest earner reports "nothing to collect" while real money accumulates.
 * That exact failure has already happened on this stack once.
 */
interface IPonsHookSweep {
    /**
     * ⛔⛔ `minConversionQuoteOut` MUST NOT BE ZERO, and the obvious reasoning is backwards. A zero
     * looks like "no floor, so it cannot revert"; the hook REJECTS it whenever a conversion actually
     * runs — `MinimumOutputRequired()` `0x3672d25f`. With every bucket empty a zero also succeeds, so
     * the bug is LATENT and passes every quiet test. Pass 1. `minBuybackTokensOut` may be 0.
     */
    function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut) external;

    /**
     * ⛔⛔ THE POOL-ID CHECK. Uniswap V4 has no registry, so a pool id is REPRODUCED from its key —
     * and a wrong one answers a confident ZERO rather than reverting, indistinguishable from "no
     * fees". Worse, `sweepPoolFees` does not check its caller, so a wrong id sweeps a STRANGER'S
     * pool.
     *
     * ➤ Believe a derived id only when this says `registered` AND `memecoin` is the exact token you
     *   derived it for. Both conditions, every time.
     *
     * ⚠ Declared as a struct return. The live getter is a public mapping and returns its members
     * flattened, but every member is a STATIC type, so the ABI encoding is byte-identical.
     */
    function launches(bytes32 poolId) external view returns (HookLaunch memory);
}

/// The hook's per-pool record. ⚠ All members static — see the note on `launches`.
struct HookLaunch {
    bool registered;
    bool memecoinIsCurrency0;
    address memecoin;
    address quoteToken;
    address creator;
    address buybackCreatorRecipient;
    address protocolFeeRecipient;
    uint16 creatorTaxBps;
    uint16 protocolFeeShareBps;
    uint16 buybackBurnBps;
    uint16 hookFeeBps;
    uint16 maxInternalPriceImpactBps;
    bool buybackEnabled;
}
