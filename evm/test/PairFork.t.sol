// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {HookerLaunchpad, IPonsDistributorFactory} from "../src/HookerLaunchpad.sol";
import {HookerToken} from "../src/HookerToken.sol";
import {IPonsV2Factory} from "../src/IPonsV2.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

interface IPonsCurveU {
    function getReserves() external view returns (uint256, uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
}

/// A launchpad priced in one of Pons's pair assets (USDG), on a fork of live RHC against the real Pons V2:
/// the curve takes USDG, fills, graduates into a USDG-paired Pons coin with no swap, and every holder is paid.
contract PairForkTest is Test {
    IPonsV2Factory constant PONS = IPonsV2Factory(0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e);
    IPonsDistributorFactory constant DIST = IPonsDistributorFactory(0x70e95CC5f03DB2906081E7a8D16e4C4209291507);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant QUOTE = USDG;

    HookerLaunchpad pad;
    address owner = makeAddr("u-owner");
    address treasury = makeAddr("u-treasury");
    address burnSide = makeAddr("u-burnside");
    address creator = makeAddr("u-creator");
    address[3] buyers;

    function setUp() public {
        string memory url = vm.envOr("RHC_RPC_URL", string(""));
        if (bytes(url).length == 0) { vm.skip(true); return; }
        vm.createSelectFork(url);
        pad = new HookerLaunchpad(owner, treasury, burnSide, PONS, DIST);
        vm.deal(creator, 1 ether);
        deal(USDG, creator, 20_000e6);
        for (uint256 i; i < buyers.length; i++) {
            buyers[i] = makeAddr(string(abi.encodePacked("u-buyer", vm.toString(i))));
            vm.deal(buyers[i], 1 ether);
            deal(USDG, buyers[i], 20_000e6);
        }
    }

    function test_usdg_curve_graduates_into_a_usdg_pons_coin() public {

        HookerLaunchpad.LaunchInput memory a;
        a.name = "Dollar Hook"; a.symbol = "DHOOK"; a.image = "https://hooker.fun/x.png"; a.size = 0; a.tier = 1;
        a.rules.maxWalletBps = 5_000;
        a.quoteIn = 100e6; // the creator's first buy: 100 USDG
        a.quote = USDG;
        uint256 launchFee = PONS.launchFee();
        vm.startPrank(creator);
        IERC20(USDG).approve(address(pad), a.quoteIn);
        vm.expectRevert(abi.encodeWithSelector(HookerLaunchpad.Refused.selector, "send Pons's launch fee in ETH"));
        pad.launch(a);
        address token = pad.launch{value: launchFee}(a);
        vm.stopPrank();
        (, , , , , , , uint256 realQ, uint256 gradQ, , , , , , , , , uint256 feeEth, , , ) = pad.launches(token);
        assertGt(realQ, 0, "the first buy landed in USDG");
        assertEq(gradQ, 8_090e6 * 3_500 / 10_000, "35% of Pons's USDG graduation");
        assertEq(feeEth, launchFee, "Pons's launch fee is held for the graduation");

        // ETH must not be sent to a USDG launchpad's buy
        vm.prank(buyers[0]);
        vm.expectRevert(abi.encodeWithSelector(HookerLaunchpad.Refused.selector, "this launch trades in its pair asset"));
        pad.buy{value: 1}(token, 1, 0);

        // buys in USDG until it fills; the last one is refunded its excess in USDG
        for (uint256 i; i < buyers.length; i++) {
            vm.startPrank(buyers[i]);
            IERC20(USDG).approve(address(pad), 700e6);
            pad.buy(token, 700e6, 0);
            vm.stopPrank();
        }
        uint256 before = IERC20(USDG).balanceOf(buyers[0]);
        vm.startPrank(buyers[0]);
        IERC20(USDG).approve(address(pad), 10_000e6);
        pad.buy(token, 10_000e6, 0);
        vm.stopPrank();
        (HookerLaunchpad.State st, , , , , , , uint256 realQ2, , , , , , , , , , , , , ) = pad.launches(token);
        assertEq(uint8(st), uint8(HookerLaunchpad.State.Complete), "full");
        assertEq(realQ2, gradQ);
        assertLt(before - IERC20(USDG).balanceOf(buyers[0]), 10_000e6, "the excess USDG came back");

        // a sell pays USDG
        uint256 held = HookerToken(token).balanceOf(buyers[1]);
        vm.prank(buyers[1]);
        vm.expectRevert(abi.encodeWithSelector(HookerLaunchpad.Refused.selector, "not trading"));
        pad.sell(token, held, 0);

        // graduation: the curve's USDG buys the Pons coin, paired with USDG, in one transaction
        address coin = pad.graduate(token);
        IPonsV2Factory.LaunchedToken memory lt = PONS.getLaunchedToken(coin);
        assertTrue(lt.exists && lt.pairToken == USDG, "a real Pons V2 coin paired with USDG");
        assertEq(lt.phase, 0, "on Pons's curve, under its graduation");
        assertEq(lt.creatorFeeRecipient, burnSide, "its creator fees go to the burn side");
        assertEq(IERC20(USDG).balanceOf(address(pad)), pad.platformFees(QUOTE) + _creatorFeesOf(creator), "only the fees stayed behind, in USDG");
        (uint256 q, uint256 t) = IPonsCurveU(lt.curve).getReserves();
        (, , , , , uint256 vQ, uint256 vT, , , , , , , , , , , , , , ) = pad.launches(token);
        assertApproxEqRel(q * 1e18 / t, vQ * 1e18 / vT, 0.06e18, "the price carries over within 6%");

        // every holder gets Pons coins; the creator claims USDG fees
        while (!pad.payout(token, 50)) {}
        for (uint256 i; i < buyers.length; i++) assertGt(IERC20(coin).balanceOf(buyers[i]), 0, "paid in Pons coins");
        assertEq(IERC20(coin).balanceOf(address(pad)), 0);
        uint256 cBefore = IERC20(USDG).balanceOf(creator);
        vm.prank(creator);
        pad.claimCreatorFees(QUOTE);
        assertGt(IERC20(USDG).balanceOf(creator), cBefore, "creator fees paid in USDG");
        pad.sweepPlatformFees(QUOTE);
        assertGt(IERC20(USDG).balanceOf(treasury), 0, "platform fees swept in USDG");
        // a holder sells some of the coin on Pons's curve, for USDG
        uint256 h = IERC20(coin).balanceOf(buyers[0]);
        vm.warp(block.timestamp + 10);
        vm.startPrank(buyers[0]);
        IERC20(coin).approve(lt.curve, h / 2);
        uint256 got = IPonsCurveU(lt.curve).sell(h / 2, 0, buyers[0]);
        vm.stopPrank();
        assertGt(got, 0, "sold on Pons for USDG");
    }

    function _creatorFeesOf(address c) internal view returns (uint256) { return pad.creatorFees(c, QUOTE); }
}
