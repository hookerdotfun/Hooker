// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// The parts of Pons V2 (Robinhood Chain) that Hooker's launchpad talks to. Field order in the structs is
/// the factory's ABI and must not change. Factory 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e.
interface IPonsV2Factory {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    /// Everything here, name to salt, feeds the CREATE2 address of the coin: the salt must differ per launch.
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

    /// phase: 0 on Pons's curve, 1 swept (between curve and pool), 2 trading in the Uniswap V4 pool.
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

    /// The periphery that launches and buys in one transaction. Pons can replace it: read it per launch.
    function launchForwarder() external view returns (address);
    /// Paid on every launch, in native ETH, on top of the buy.
    function launchFee() external view returns (uint256);
    function launchEnabled() external view returns (bool);
    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
    /// For a pair asset (address(0) = native ETH): the curve's phantom quote, where it graduates, decimals.
    function pairTokenEconomics(address pairToken) external view returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals);
    /// Hands a coin's creator fees to another address for good. Only the current recipient may call it.
    function transferCreatorFeeRecipient(address token, address newRecipient) external;
}

/// Pons's launch-and-buy periphery (`IPonsV2Factory.launchForwarder()`). The native value must be exactly
/// `launchFee + quoteIn` for an ETH pair. The bought coins go to `recipient`, which the periphery itself exempts
/// from the snipe tax, so an empty `snipeTaxExemptions` is right.
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
