// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {HookerLaunchpad, IPonsDistributorFactory} from "../src/HookerLaunchpad.sol";
import {HookerToken} from "../src/HookerToken.sol";
import {IPonsV2Factory} from "../src/IPonsV2.sol";

interface IPonsCurveT {
    function getReserves() external view returns (uint256, uint256);
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
}

interface IOwnable { function owner() external view returns (address); }
interface ISetLaunch { function setLaunchEnabled(bool) external; }

interface IERC20T {
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// The whole Robinhood Chain flow against the REAL Pons V2 contracts, on a fork of live RHC:
/// launch with hooks → trade (and be refused) → fill → graduate into Pons → every holder paid.
///   node scripts/rpc-proxy.mjs &  RHC_RPC_URL=http://127.0.0.1:8899 forge test --match-path test/LaunchpadFork.t.sol -vv
contract LaunchpadForkTest is Test {
    IPonsV2Factory constant PONS = IPonsV2Factory(0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e);
    IPonsDistributorFactory constant DIST = IPonsDistributorFactory(0x70e95CC5f03DB2906081E7a8D16e4C4209291507);
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    HookerLaunchpad pad;
    address owner = makeAddr("hk-owner");
    address treasury = makeAddr("hk-treasury");
    address creator = makeAddr("hk-creator");
    address[6] buyers;

    function setUp() public {
        string memory url = vm.envOr("RHC_RPC_URL", string(""));
        if (bytes(url).length == 0) { vm.skip(true); return; }
        vm.createSelectFork(url);
        pad = new HookerLaunchpad(owner, treasury, PONS, DIST);
        vm.deal(creator, 10 ether);
        for (uint256 i; i < buyers.length; i++) {
            buyers[i] = makeAddr(string(abi.encodePacked("hk-buyer", vm.toString(i))));
            vm.deal(buyers[i], 10 ether);
        }
    }

    function _input(uint8 size, bool antiSnipe, HookerToken.Rules memory r) internal pure returns (HookerLaunchpad.LaunchInput memory a) {
        a.name = "Hook Fork";
        a.symbol = "HFORK";
        a.image = "https://hooker.fun/api/img/bafkreitest";
        a.description = "A Hooker token, graduated into Pons.";
        a.socials.website = "https://hooker.fun";
        a.size = size;
        a.tier = 1;
        a.antiSnipe = antiSnipe;
        a.rules = r;
    }

    function test_fullFlow_hooks_graduate_payout() public {
        HookerToken.Rules memory r;
        r.maxWalletBps = 2_000;      // 20% of supply
        r.holderShareBps = 5_000;    // half the platform's fees buy coins for holders
        r.burnBps = 100;             // 1% of every buy burned
        r.feeCapBps = 200; r.feeBaseBps = 50; r.feePerEthBps = 100; // dynamic fee 0.5%..2%
        vm.prank(creator);
        address token = pad.launch{value: 0.05 ether}(_input(0, true, r));
        HookerToken t = HookerToken(token);
        assertGt(t.balanceOf(creator), 0, "dev buy landed");
        (, , , , , , , , uint256 gradEth, , , , , , , , ) = pad.launches(token);
        assertEq(gradEth, 1.47 ether, "35% of Pons's 4.2 ETH");

        // the anti-snipe fee: 50% at launch, the step's 1.75% after two minutes
        assertEq(pad.currentFeeBps(token), 5_000);
        vm.warp(block.timestamp + 121);
        assertEq(pad.currentFeeBps(token), 175);

        // max per wallet refuses a buy that would hold more than 20% (code 1)
        vm.prank(buyers[0]);
        vm.expectRevert(abi.encodeWithSelector(HookerToken.HookRefused.selector, uint8(1)));
        pad.buy{value: 1.2 ether}(token, 0);

        // trades: buys, a sell, a wallet-to-wallet transfer, time passing (holder share weights)
        for (uint256 i; i < 5; i++) {
            vm.prank(buyers[i]);
            pad.buy{value: 0.2 ether}(token, 0);
            vm.warp(block.timestamp + 60);
        }
        uint256 b1 = t.balanceOf(buyers[1]);
        vm.prank(buyers[1]);
        pad.sell(token, b1 / 2, 0);
        uint256 third = t.balanceOf(buyers[2]) / 3;
        vm.prank(buyers[2]);
        t.transfer(buyers[5], third);
        assertGt(t.balanceOf(treasury), 0, "dynamic fee tokens to the treasury");
        assertGt(t.balanceOf(DEAD), 0, "burn tokens to the dead address");

        // fill it: the last buy takes only what it needs and is refunded the rest
        uint256 before = buyers[3].balance;
        vm.prank(buyers[3]);
        pad.buy{value: 2 ether}(token, 0);
        (HookerLaunchpad.State st, , , , , , , uint256 realEth, , uint256 pot, , , , , , , ) = pad.launches(token);
        assertEq(uint8(st), uint8(HookerLaunchpad.State.Complete), "full");
        assertEq(realEth, 1.47 ether);
        assertLt(before - buyers[3].balance, 2 ether, "refunded the excess");
        assertGt(pot, 0, "holder share pot");
        vm.prank(buyers[4]);
        vm.expectRevert(abi.encodeWithSelector(HookerLaunchpad.Refused.selector, "not trading"));
        pad.buy{value: 0.1 ether}(token, 0);

        // our price at the end, to compare with Pons's after graduation
        (, , , , , uint256 vEth, uint256 vTok, , , , , , , , , , ) = pad.launches(token);
        uint256 ourPrice = vEth * 1e18 / vTok;

        // graduate: the real Pons V2 launch + buy, one transaction
        address coin = pad.graduate(token);
        IPonsV2Factory.LaunchedToken memory lt = PONS.getLaunchedToken(coin);
        assertTrue(lt.exists, "a real Pons V2 launch");
        assertEq(lt.phase, 0, "trading on Pons's curve");
        assertEq(lt.creatorFeeRecipient, creator, "creator fees to the creator");
        assertEq(lt.deployer, address(pad));
        (uint256 q, uint256 tk) = IPonsCurveT(lt.curve).getReserves();
        uint256 ponsPrice = q * 1e18 / tk;
        emit log_named_decimal_uint("our last price (ETH per 1e18 tokens)", ourPrice, 18);
        emit log_named_decimal_uint("Pons price after the buy", ponsPrice, 18);
        assertApproxEqRel(ponsPrice, ourPrice, 0.06e18, "market cap carries over within 6%");

        // the token is frozen: its balances are the snapshot
        vm.prank(buyers[0]);
        vm.expectRevert(abi.encodeWithSelector(HookerToken.HookRefused.selector, uint8(15)));
        t.transfer(buyers[1], 1);

        // payout, two holders per call, and every holder gets exactly their allocation
        uint256 n = t.holderCount();
        uint256[] memory want = new uint256[](n);
        for (uint256 i; i < n; i++) want[i] = pad.allocationOf(token, t.holders(i));
        uint256 bought = IERC20T(coin).balanceOf(address(pad));
        uint256 calls;
        while (!pad.payout(token, 2)) calls++;
        uint256 sum;
        for (uint256 i; i < n; i++) {
            assertEq(IERC20T(coin).balanceOf(t.holders(i)), want[i], "holder paid its allocation");
            sum += want[i];
        }
        assertEq(IERC20T(coin).balanceOf(address(pad)), 0, "nothing left behind");
        assertGt(IERC20T(coin).balanceOf(DEAD), 0, "burned share");
        assertGt(IERC20T(coin).balanceOf(treasury), 0, "treasury share");
        emit log_named_uint("holders", n);
        emit log_named_decimal_uint("coins to holders %", sum * 1e18 / bought * 100, 18);
        // a holder that sold half and kept half still holds about what the curve sold it, in Pons coins
        emit log_named_decimal_uint("buyer0 window tokens", t.balanceOf(buyers[0]), 18);
        emit log_named_decimal_uint("buyer0 Pons coins", IERC20T(coin).balanceOf(buyers[0]), 18);

        // the Pons coin trades: a holder sells some on Pons's curve
        vm.warp(block.timestamp + 10);
        uint256 hold = IERC20T(coin).balanceOf(buyers[0]);
        vm.startPrank(buyers[0]);
        IERC20T(coin).approve(lt.curve, hold / 2);
        uint256 ethBack = IPonsCurveT(lt.curve).sell(hold / 2, 0, buyers[0]);
        vm.stopPrank();
        assertGt(ethBack, 0, "sold on Pons");

        // fees: the creator claims ETH, the platform sweeps
        uint256 cf = pad.creatorFees(creator);
        assertGt(cf, 0);
        vm.prank(creator);
        pad.claimCreatorFees();
        pad.sweepPlatformFees();
        assertGt(treasury.balance, 0);
        emit log_named_uint("payout calls", calls + 1);
    }

    function test_holderRewards_full_size_distributor() public {
        HookerToken.Rules memory r;
        r.holderRewards = true;
        r.holderShareBps = 10_000;
        HookerLaunchpad.LaunchInput memory a = _input(3, false, r);
        a.tier = 3; // the platform's part of a 4.25% fee: more holder share than fits under Pons's cap
        vm.prank(creator);
        address token = pad.launch{value: 0.1 ether}(a);
        // fill the full 4.2 ETH size
        for (uint256 i; i < 6; i++) {
            (HookerLaunchpad.State st, , , , , , , , , , , , , , , , ) = pad.launches(token);
            if (st != HookerLaunchpad.State.Trading) break;
            vm.prank(buyers[i]);
            pad.buy{value: 1 ether}(token, 0);
        }
        uint256 ethBefore = buyers[0].balance;
        address coin = pad.graduate(token);
        IPonsV2Factory.LaunchedToken memory lt = PONS.getLaunchedToken(coin);
        assertEq(lt.phase, 0, "the full size stays under Pons's own graduation");
        (, , , , , , , , , , , , , , , uint256 potEth, ) = pad.launches(token);
        assertGt(potEth, 0, "a full-size curve's holder share does not all fit under Pons's cap");
        address d = DIST.distributorOf(coin);
        assertTrue(d != address(0), "a Pons distributor");
        assertEq(lt.creatorFeeRecipient, d, "creator fees go to holders");
        while (!pad.payout(token, 50)) {}
        assertEq(IERC20T(coin).balanceOf(address(pad)), 0);
        assertGt(buyers[0].balance, ethBefore, "the holder got its ETH share of the pot that did not fit");
    }

    /// Pons stops taking launches: a full curve can be called off by ANYONE and every holder sells back, fee-free.
    function test_refund_when_pons_refuses() public {
        HookerToken.Rules memory r;
        vm.prank(creator);
        address token = pad.launch{value: 0.1 ether}(_input(0, false, r));
        vm.prank(buyers[0]);
        pad.buy{value: 2 ether}(token, 0);
        vm.prank(buyers[1]);
        vm.expectRevert(abi.encodeWithSelector(HookerLaunchpad.Refused.selector, "Pons still takes launches: only the owner can call it off"));
        pad.abort(token);
        // Pons's owner disables launches (as it did to V1)
        address ponsOwner = IOwnable(address(PONS)).owner();
        vm.prank(ponsOwner);
        ISetLaunch(address(PONS)).setLaunchEnabled(false);
        vm.expectRevert();
        pad.graduate(token);
        vm.prank(buyers[1]);
        pad.abort(token);
        uint256 before = buyers[0].balance;
        uint256 held = HookerToken(token).balanceOf(buyers[0]);
        vm.prank(buyers[0]);
        uint256 back = pad.sell(token, held, 0);
        assertEq(buyers[0].balance - before, back);
        assertGt(back, 1.37 ether, "the whole raise but the creator's own buy comes back, with no fee");
        uint256 cheld = HookerToken(token).balanceOf(creator);
        vm.prank(creator);
        pad.sell(token, cheld, 0);
        (, , , , , , , uint256 realEth, , , , , , , , , ) = pad.launches(token);
        assertLt(realEth, 10, "the curve is empty to the wei");
    }

    function test_graduate_only_when_full_and_only_once() public {
        HookerToken.Rules memory r;
        vm.prank(creator);
        address token = pad.launch{value: 0.1 ether}(_input(0, false, r));
        vm.expectRevert(abi.encodeWithSelector(HookerLaunchpad.Refused.selector, "not full"));
        pad.graduate(token);
        vm.prank(buyers[0]);
        pad.buy{value: 2 ether}(token, 0);
        pad.graduate(token);
        vm.expectRevert(abi.encodeWithSelector(HookerLaunchpad.Refused.selector, "not full"));
        pad.graduate(token);
    }
}
