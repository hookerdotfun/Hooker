// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {HookerLaunchpad, IPonsDistributorFactory} from "../src/HookerLaunchpad.sol";
import {HookerToken} from "../src/HookerToken.sol";
import {IPonsV2Factory} from "../src/IPonsV2.sol";

/// Every hook on the Robinhood Chain side, with no network: launch, trade, and the refusal codes (the same
/// numbers as the Solana hook). Graduation needs the real Pons contracts: test/LaunchpadFork.t.sol.
contract HooksTest is Test {
    HookerLaunchpad pad;
    address constant QUOTE = address(0);
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    uint256 constant T0 = 1_760_000_000;

    function setUp() public {
        vm.warp(T0); // Thu 9 Oct 2025 08:53 UTC
        pad = new HookerLaunchpad(address(this), treasury, makeAddr("burnside"), IPonsV2Factory(address(0xBEEF)), IPonsDistributorFactory(address(0xBEEF)));
        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    function _launch(HookerToken.Rules memory r) internal returns (HookerToken) {
        HookerLaunchpad.LaunchInput memory a;
        a.name = "Hook";
        a.symbol = "HOOK";
        a.image = "https://hooker.fun/x.png";
        a.size = 3;
        a.rules = r;
        vm.prank(creator);
        return HookerToken(pad.launch(a));
    }

    function _refused(uint8 code) internal {
        vm.expectRevert(abi.encodeWithSelector(HookerToken.HookRefused.selector, code));
    }

    /// Foundry's tests do not enforce the 24 KB contract size limit; a real chain does (it cost a deploy once).
    function test_contracts_fit_the_size_limit() public view {
        assertLt(address(pad).code.length, 24_576, "launchpad");
        assertLt(address(pad.tokenFactory()).code.length, 24_576, "token factory");
    }

    function test_noRules_tradeFreely_and_sellBack() public {
        HookerToken t = _launch(HookerToken.Rules({maxWalletBps: 0, earlySecs: 0, earlyMaxWalletBps: 0, rampStartBps: 0, rampSecs: 0, tradeGuardBps: 0, allowlist: false, blocklist: false, venueLock: false, hoursOn: false, hoursDays: 0, hoursOpenMin: 0, hoursCloseMin: 0, tzOffsetMin: 0, bundleMax: 0, feeBaseBps: 0, feePerEthBps: 0, feeCapBps: 0, burnBps: 0, holderShareBps: 0, holderRewards: false}));
        vm.prank(alice);
        uint256 got = pad.buy{value: 1 ether}(address(t), 1 ether, 0);
        assertEq(t.balanceOf(alice), got);
        uint256 before = alice.balance;
        vm.prank(alice);
        uint256 back = pad.sell(address(t), got, 0);
        assertEq(alice.balance - before, back);
        // 1% in, 1% out: about 98% back
        assertApproxEqRel(back, 0.98 ether, 0.001e18);
        assertEq(t.balanceOf(alice), 0);
    }

    function test_slippage_guard() public {
        HookerToken.Rules memory r;
        HookerToken t = _launch(r);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HookerLaunchpad.Refused.selector, "slippage"));
        pad.buy{value: 0.1 ether}(address(t), 0.1 ether, type(uint256).max);
    }

    function test_maxWallet_launchWindow_ramp() public {
        HookerToken.Rules memory r;
        r.maxWalletBps = 300;      // 3%
        r.rampStartBps = 100;      // rising from 1% ...
        r.rampSecs = 1_000;        // ... over 1,000 s
        r.earlySecs = 100;         // and 0.5% in the first 100 s
        r.earlyMaxWalletBps = 50;
        HookerToken t = _launch(r);
        // ~0.6% of supply costs ~0.01 ETH at the start of the curve
        vm.prank(alice);
        _refused(1);
        pad.buy{value: 0.015 ether}(address(t), 0.015 ether, 0);
        vm.prank(alice);
        pad.buy{value: 0.005 ether}(address(t), 0.005 ether, 0);
        // after the window: the ramp's cap (1% + 2% × 200/1000 = 1.4%)
        vm.warp(T0 + 200);
        vm.prank(bob);
        pad.buy{value: 0.02 ether}(address(t), 0.02 ether, 0);
        vm.prank(bob);
        _refused(1);
        pad.buy{value: 0.02 ether}(address(t), 0.02 ether, 0);
        // fully ramped: 3%
        vm.warp(T0 + 1_200);
        vm.prank(bob);
        pad.buy{value: 0.02 ether}(address(t), 0.02 ether, 0);
        // a transfer is held to the cap too, and sells always pass
        vm.prank(alice);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
        uint256 b = t.balanceOf(bob);
        uint256 a = t.balanceOf(alice);
        vm.prank(alice);
        _refused(1);
        t.transfer(bob, a);
        vm.prank(bob);
        pad.sell(address(t), b, 0);
    }

    function test_allowlist_blocklist() public {
        HookerToken.Rules memory r;
        r.allowlist = true;
        HookerToken t = _launch(r);
        vm.prank(alice);
        _refused(6);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
        address[] memory w = new address[](1);
        w[0] = alice;
        vm.prank(alice);
        _refused(14); // only the creator edits the list
        t.addToList(w);
        vm.prank(creator);
        t.addToList(w);
        vm.prank(alice);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
        // the list closes when sealed (or after a day)
        vm.prank(creator);
        t.sealList();
        w[0] = bob;
        vm.prank(creator);
        _refused(12);
        t.addToList(w);

        HookerToken.Rules memory r2;
        r2.blocklist = true;
        HookerToken t2 = _launch(r2);
        vm.prank(creator);
        t2.addToList(w); // bob
        vm.prank(bob);
        _refused(7);
        pad.buy{value: 0.01 ether}(address(t2), 0.01 ether, 0);
        vm.prank(alice);
        pad.buy{value: 0.01 ether}(address(t2), 0.01 ether, 0);
    }

    function test_tradeGuard() public {
        HookerToken.Rules memory r;
        r.tradeGuardBps = 100; // 1% of supply per transfer
        HookerToken t = _launch(r);
        vm.prank(alice);
        _refused(8);
        pad.buy{value: 0.05 ether}(address(t), 0.05 ether, 0);
        vm.prank(alice);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
    }

    function test_tradingHours() public {
        HookerToken.Rules memory r;
        r.hoursOn = true;
        r.hoursDays = 0x3E;        // Monday to Friday
        r.hoursOpenMin = 9 * 60;   // 09:00
        r.hoursCloseMin = 17 * 60; // 17:00
        r.tzOffsetMin = 120;       // UTC+2
        HookerToken t = _launch(r);
        // Thu 08:53 UTC = 10:53 local: open
        vm.prank(alice);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
        // Thu 15:30 UTC = 17:30 local: closed for buys, sells still pass
        vm.warp(T0 + 6 hours + 37 minutes);
        vm.prank(bob);
        _refused(9);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
        uint256 half = t.balanceOf(alice) / 2;
        vm.prank(alice);
        pad.sell(address(t), half, 0);
        // Sat 10:00 local: closed
        vm.warp(T0 + 2 days + 1 hours);
        vm.prank(bob);
        _refused(9);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
    }

    function test_antiBundle() public {
        HookerToken.Rules memory r;
        r.bundleMax = 2;
        HookerToken t = _launch(r);
        vm.prank(alice);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
        vm.prank(bob);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
        vm.prank(carol);
        _refused(11);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
        vm.roll(block.number + 1);
        vm.prank(carol);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
    }

    function test_venueLock() public {
        HookerToken.Rules memory r;
        r.venueLock = true;
        HookerToken t = _launch(r);
        vm.prank(alice);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
        uint256 half = t.balanceOf(alice) / 2;
        vm.prank(alice);
        _refused(4);
        t.transfer(address(this), half); // any contract
        vm.prank(alice);
        t.transfer(bob, half); // a wallet is fine
    }

    function test_antiSnipe_fee_and_creator_split() public {
        HookerLaunchpad.LaunchInput memory a;
        a.name = "Hook";
        a.symbol = "HOOK";
        a.size = 3;
        a.tier = 2; // 3%, the creator's 1.99%
        a.antiSnipe = true;
        vm.prank(creator);
        address t = pad.launch{value: 1 ether}(a);
        // the dev buy pays the step's fee, not the anti-snipe fee
        assertEq(pad.creatorFees(creator, QUOTE), 1 ether * 199 / 10_000);
        assertEq(pad.currentFeeBps(t), 5_000);
        vm.warp(T0 + 60);
        assertEq(pad.currentFeeBps(t), 5_000 - (5_000 - 300) * 6 / 12);
        vm.warp(T0 + 120);
        assertEq(pad.currentFeeBps(t), 300);
        uint256 c0 = pad.creatorFees(creator, QUOTE);
        vm.prank(alice);
        pad.buy{value: 1 ether}(t, 1 ether, 0);
        assertEq(pad.creatorFees(creator, QUOTE) - c0, 0.03 ether * 199 / 300);
        // the platform keeps the rest of both 3% fees (dev buy and alice's)
        assertEq(pad.platformFees(QUOTE), 2 * (0.03 ether - 0.03 ether * 199 / 300));
    }

    function test_social_links_are_bounded() public {
        HookerLaunchpad.LaunchInput memory a;
        a.name = "Hook"; a.symbol = "HOOK"; a.size = 3;
        a.socials.website = string(new bytes(257));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(HookerLaunchpad.Refused.selector, "a social link is too long"));
        pad.launch(a);
        a.socials.website = string(new bytes(256));
        vm.prank(creator);
        pad.launch(a);
    }

    function test_owner_can_call_off_a_full_curve_and_holders_sell_back_fee_free() public {
        HookerToken.Rules memory r;
        HookerToken t = _launch(r);
        vm.prank(alice);
        _refusedWith("not full");
        pad.abort(address(t)); // owner, but not full yet
        vm.prank(alice);
        pad.buy{value: 10 ether}(address(t), 10 ether, 0); // fills (4.2 ETH), refunds the rest
        pad.abort(address(t)); // the owner (this test contract); a stranger's abort is covered by the fork test (it asks Pons)
        vm.prank(alice);
        _refusedWith("not trading");
        pad.buy{value: 1 ether}(address(t), 1 ether, 0);
        uint256 held = t.balanceOf(alice);
        uint256 before = alice.balance;
        uint256 cf = pad.creatorFees(creator, QUOTE);
        vm.prank(alice);
        pad.sell(address(t), held, 0);
        // 1% was paid on the way in and nothing on the way out
        assertApproxEqRel(alice.balance - before, 4.2 ether, 0.001e18);
        assertEq(pad.creatorFees(creator, QUOTE), cf, "no fee on the refund sells");
    }

    function test_size_fee_goes_to_the_tokens_own_treasury_even_after_setTreasury() public {
        HookerToken.Rules memory r;
        r.allowlist = true;
        r.feeCapBps = 200; r.feeBaseBps = 100;
        HookerToken t = _launch(r);
        address[] memory w = new address[](1);
        w[0] = alice;
        vm.prank(creator);
        t.addToList(w);
        pad.setTreasury(makeAddr("treasury2"));
        vm.prank(alice);
        pad.buy{value: 0.1 ether}(address(t), 0.1 ether, 0); // the fee transfer to the old treasury passes the allowlist
        assertGt(t.balanceOf(treasury), 0);
        assertEq(t.balanceOf(makeAddr("treasury2")), 0);
    }

    function test_stray_eth_is_sweepable_and_a_dead_curves_pot_can_be_swept() public {
        (bool ok,) = address(pad).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(pad.platformFees(QUOTE), 1 ether);
        HookerToken.Rules memory r;
        r.holderShareBps = 10_000;
        HookerToken t = _launch(r);
        vm.prank(alice);
        pad.buy{value: 1 ether}(address(t), 1 ether, 0);
        (, , , , , , , , , uint256 pot, , , , , , , , , , , ) = pad.launches(address(t));
        assertGt(pot, 0);
        _refusedWith("still live");
        pad.sweepPot(address(t));
        vm.warp(block.timestamp + 181 days);
        uint256 before = treasury.balance;
        pad.sweepPot(address(t));
        assertEq(treasury.balance - before, pot);
    }

    function _refusedWith(string memory why) internal {
        vm.expectRevert(abi.encodeWithSelector(HookerLaunchpad.Refused.selector, why));
    }

    function test_rules_validation() public {
        HookerToken.Rules memory r;
        r.allowlist = true;
        r.blocklist = true;
        vm.expectRevert(abi.encodeWithSelector(HookerLaunchpad.Refused.selector, "allowlist and blocklist"));
        _launch(r);
        HookerToken.Rules memory r2;
        r2.maxWalletBps = 5;
        vm.expectRevert(abi.encodeWithSelector(HookerLaunchpad.Refused.selector, "max per wallet"));
        _launch(r2);
    }

    function test_holderShare_weights_time_held() public {
        HookerToken.Rules memory r;
        HookerToken t = _launch(r);
        vm.prank(alice);
        pad.buy{value: 0.1 ether}(address(t), 0.1 ether, 0);
        vm.warp(T0 + 100);
        vm.prank(bob);
        pad.buy{value: 0.1 ether}(address(t), 0.1 ether, 0);
        vm.warp(T0 + 200);
        // balance × seconds: alice 200 s, bob 100 s
        assertEq(t.weightOf(alice), t.balanceOf(alice) * 200);
        assertEq(t.weightOf(bob), t.balanceOf(bob) * 100);
        assertApproxEqRel(t.totalWeight(), t.weightOf(alice) + t.weightOf(bob), 1e9);
    }
}
