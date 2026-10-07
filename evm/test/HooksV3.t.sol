// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {HookerLaunchpad, IPonsDistributorFactory} from "../src/HookerLaunchpad.sol";
import {HookerToken, HookerTokenFactory} from "../src/HookerToken.sol";
import {HookerMath as M} from "../src/HookerMath.sol";
import {IPonsV2Factory} from "../src/IPonsV2.sol";

/// The library's internal functions, callable from a test.
contract MathHarness {
    function sinTurn(int256 p) external pure returns (int256) { return M.sinTurn(p); }
    function dayNum(int256 y, int256 m, int256 d) external pure returns (int256) { return M.dayNum(y, m, d); }
    function weekday(int256 z) external pure returns (int256) { return M.weekday(z); }
    function holiday(int256 z) external pure returns (bool) { return M.usMarketHoliday(z); }
    function dstOn(uint8 mode, int256 ts, int256 tz) external pure returns (bool) { return M.dstOn(mode, ts, tz); }
    function year(int256 z) external pure returns (int256) { return M.year(z); }

    /// The Solana tests' `sim`: one kick per time in `kicks`, then the displacement at `at`.
    function sim(uint8 kind, uint16 period, uint16 damp, uint16 amp, uint16 coupling, uint256[] calldata kicks, uint256 at) external pure returns (int256) {
        (int256[4] memory m1, int256[4] memory m2, int256 k1, int256 k2) = M.oscConstants(kind, period, damp, amp, coupling);
        int256[4] memory st; // x1 v1 x2 v2
        uint256 last;
        for (uint256 i; i < kicks.length; i++) {
            (st, last) = _adv(kind, period, damp, m1, m2, st, last, kicks[i]);
            st[1] += k1;
            if (kind == 4) st[3] += k2;
        }
        (st, last) = _adv(kind, period, damp, m1, m2, st, last, at);
        return kind == 4 ? st[0] + st[2] : st[0];
    }

    function _adv(uint8 kind, uint16 period, uint16 damp, int256[4] memory m1, int256[4] memory m2, int256[4] memory st, uint256 last, uint256 nowTs)
        internal
        pure
        returns (int256[4] memory, uint256)
    {
        bool reset = last == 0 || nowTs - last > M.oscQuietAfter(damp, period);
        uint256 dt = nowTs - last;
        if (reset) { st = [int256(0), 0, 0, 0]; }
        else if (dt > 0) {
            int256[4] memory p = M.mpow(m1, dt);
            (st[0], st[1]) = (M.clamp((p[0] * st[0] + p[1] * st[1]) >> 32), M.clamp((p[2] * st[0] + p[3] * st[1]) >> 32));
            if (kind == 4) {
                p = M.mpow(m2, dt);
                (st[2], st[3]) = (M.clamp((p[0] * st[2] + p[1] * st[3]) >> 32), M.clamp((p[2] * st[2] + p[3] * st[3]) >> 32));
            }
        }
        return (st, nowTs);
    }
}

/// Buys and sells in one transaction (ping pong: one transaction cannot take both turns).
contract BothTurns {
    function go(HookerLaunchpad pad, address token) external payable {
        uint256 got = pad.buy{value: msg.value}(token, msg.value, 0);
        pad.sell(token, got / 2, 0);
    }
    receive() external payable {}
}

/// The 14 v3 rules on the Robinhood Chain side, with no network: each one's pass and refusal, the state they keep,
/// the math ported from the Solana hook (against the Solana tests' own numbers), and their validation.
contract HooksV3Test is Test {
    HookerLaunchpad pad;
    MathHarness mh = new MathHarness();
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    uint256 constant T0 = 1_760_000_000; // Thu 9 Oct 2025 08:53 UTC
    int256 constant Q = 1 << 32;

    function setUp() public {
        vm.warp(T0);
        pad = new HookerLaunchpad(address(this), treasury, makeAddr("burnside"), IPonsV2Factory(address(0xBEEF)), IPonsDistributorFactory(address(0xBEEF)), address(new HookerToken()));
        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    function _launch(HookerToken.Rules memory r, HookerToken.Ext memory e) internal returns (HookerToken) {
        HookerLaunchpad.LaunchInput memory a;
        a.name = "Hook";
        a.symbol = "HOOK";
        a.image = "https://hooker.fun/x.png";
        a.size = 3;
        a.rules = r;
        a.ext = e;
        vm.prank(creator);
        return HookerToken(pad.launch(a));
    }

    function _ext(HookerToken.Ext memory e) internal returns (HookerToken) {
        HookerToken.Rules memory r;
        return _launch(r, e);
    }

    function _refused(uint8 code) internal {
        vm.expectRevert(abi.encodeWithSelector(HookerToken.HookRefused.selector, code));
    }

    function _buy(address who, HookerToken t, uint256 eth) internal returns (uint256) {
        vm.prank(who);
        return pad.buy{value: eth}(address(t), eth, 0);
    }

    function _sell(address who, HookerToken t, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return pad.sell(address(t), amount, 0);
    }

    // ─── the plumbing ───

    function test_token_code_fits_and_clones_are_set_up_once() public {
        HookerToken.Ext memory e;
        HookerToken t = _ext(e);
        address impl = pad.tokenFactory().implementation();
        assertLt(impl.code.length, 24_576, "token implementation");
        assertLt(address(t).code.length, 100, "a launch is a minimal proxy");
        assertEq(t.name(), "Hook");
        assertEq(t.symbol(), "HOOK");
        HookerToken.Rules memory r;
        vm.expectRevert(bytes("already set up"));
        t.initialize("x", "x", "", 1, alice, alice, alice, r, e);
        vm.expectRevert(bytes("already set up"));
        HookerToken(impl).initialize("x", "x", "", 1, alice, alice, alice, r, e);
        vm.expectRevert(bytes("only the launchpad"));
        t.noteTrade(1 ether);
    }

    // ─── math, against the Solana hook's own tests ───

    function test_math_sine() public view {
        for (uint256 i; i < 64; i++) {
            int256 got = mh.sinTurn(int256(i) * Q / 64);
            int256 want = _sin64(i);
            assertApproxEqAbs(got, want, uint256(Q) / 1_000_000, "sin");
        }
    }

    /// sin(2π i / 64) in Q32, from a table (Foundry has no floating point).
    function _sin64(uint256 i) internal pure returns (int256) {
        int256[17] memory quarter = [int256(0), 420_980_412, 837_906_553, 1_246_763_195, 1_643_612_827, 2_024_633_568, 2_386_155_981, 2_724_698_408, 3_037_000_500, 3_320_054_617, 3_571_134_792, 3_787_822_988, 3_968_032_378, 4_110_027_446, 4_212_440_704, 4_274_285_855, 4_294_967_296];
        // the table above is sin over the first quarter; fold the rest onto it
        uint256 k = i % 64;
        if (k <= 16) return _q(quarter, k);
        if (k <= 32) return _q(quarter, 32 - k);
        if (k <= 48) return -_q(quarter, k - 32);
        return -_q(quarter, 64 - k);
    }

    function _q(int256[17] memory quarter, uint256 k) internal pure returns (int256) {
        return quarter[k] * Q / 4_294_967_296;
    }

    function test_math_nyse_holidays_2026_2027() public view {
        uint8[2][10] memory h26 = [[1, 1], [1, 19], [2, 16], [4, 3], [5, 25], [6, 19], [7, 3], [9, 7], [11, 26], [12, 25]];
        uint8[2][10] memory h27 = [[1, 1], [1, 18], [2, 15], [3, 26], [5, 31], [6, 18], [7, 5], [9, 6], [11, 25], [12, 24]];
        _holidays(2026, h26);
        _holidays(2027, h27);
        // 2022: New Year's Day was a Saturday and NYSE stayed open on Friday 31 Dec 2021
        assertFalse(mh.holiday(mh.dayNum(2021, 12, 31)));
        assertEq(mh.weekday(mh.dayNum(2026, 10, 6)), 2, "a Tuesday");
    }

    function _holidays(int256 y, uint8[2][10] memory want) internal view {
        uint256 n;
        for (int256 z = mh.dayNum(y, 1, 1); z < mh.dayNum(y + 1, 1, 1); z++) {
            if (mh.holiday(z)) {
                assertLt(n, 10, "too many holidays");
                assertEq(z, mh.dayNum(y, int256(uint256(want[n][0])), int256(uint256(want[n][1]))), "holiday");
                n++;
            }
        }
        assertEq(n, 10, "holiday count");
    }

    function test_math_daylight_saving() public view {
        int256 ny = -300;
        // US 2026: 8 March 07:00 UTC to 1 November 06:00 UTC
        assertFalse(mh.dstOn(1, _t(2026, 3, 8, 6, 59), ny));
        assertTrue(mh.dstOn(1, _t(2026, 3, 8, 7, 0), ny));
        assertTrue(mh.dstOn(1, _t(2026, 11, 1, 5, 59), ny));
        assertFalse(mh.dstOn(1, _t(2026, 11, 1, 6, 0), ny));
        // EU 2026: 29 March 01:00 UTC to 25 October 01:00 UTC
        assertFalse(mh.dstOn(2, _t(2026, 3, 29, 0, 59), 60));
        assertTrue(mh.dstOn(2, _t(2026, 3, 29, 1, 0), 60));
        assertFalse(mh.dstOn(2, _t(2026, 10, 25, 1, 0), 60));
    }

    function _t(int256 y, int256 m, int256 d, int256 h, int256 mi) internal view returns (int256) {
        return mh.dayNum(y, m, d) * 86_400 + h * 3_600 + mi * 60;
    }

    function test_math_momentum_matches_the_physics() public view {
        // the Solana test's settings: period 120 s, damping 8%/s, energy 40%. ω0 = 2π/120 ≈ 0.0524 < γ = 0.08, so it
        // is overdamped: one kick rises, then settles, and never goes negative
        uint256[] memory k = new uint256[](1);
        k[0] = 1000;
        int256 peak;
        for (uint256 dt = 1; dt < 60; dt++) {
            int256 x = mh.sim(2, 120, 80, 40, 0, k, 1000 + dt);
            assertGe(x, 0, "overdamped: never negative");
            if (x > peak) peak = x;
        }
        assertGt(peak, 0);
        assertLt(_abs(mh.sim(2, 120, 80, 40, 0, k, 1300)), Q / 1000);
        assertEq(mh.sim(2, 120, 80, 40, 0, k, 1000 + M.oscQuietAfter(80, 120) + 1), 0, "quiet after");
    }

    function test_math_momentum_underdamped_against_closed_form() public view {
        // period 120 s, damping 1%/s: x(t) = 0.4 ω0/ωd e^{-γt} sin(ωd t) with ω0 = 2π/120, γ = 0.01, at dt = 5, 17, 30 s
        uint256[] memory k = new uint256[](1);
        k[0] = 1000;
        // closed form, Q32 (computed with floating point outside the test)
        int256[3] memory want = [int256(423_139_075), 1_132_143_378, 1_296_040_553];
        uint256[3] memory dts = [uint256(5), 17, 30];
        for (uint256 i; i < 3; i++) {
            int256 got = mh.sim(2, 120, 10, 40, 0, k, 1000 + dts[i]);
            assertApproxEqRel(uint256(got), uint256(want[i]), 0.002e18, "closed form");
        }
    }

    function test_math_resonance_builds_on_the_beat() public view {
        // lowest damping (1%/s), 60 s period: on-beat buys pile up, buys half a beat apart cancel
        uint256[] memory one = new uint256[](1);
        one[0] = 1000;
        uint256[] memory on = new uint256[](8);
        uint256[] memory off = new uint256[](8);
        for (uint256 i; i < 8; i++) { on[i] = 1000 + 61 * i; off[i] = 1000 + 31 * i; }
        int256 p1 = _peak(one);
        assertGt(_peak(on) * 10, p1 * 18, "on the beat: > 1.8x one kick");
        assertLt(_peak(off), p1, "off the beat: less than one kick");
    }

    function _peak(uint256[] memory k) internal view returns (int256 best) {
        for (uint256 dt; dt < 60; dt++) {
            int256 x = _abs(mh.sim(3, 60, 10, 40, 0, k, k[k.length - 1] + dt));
            if (x > best) best = x;
        }
    }

    function test_math_coupled_energy_moves_between_modes() public view {
        uint256[] memory k = new uint256[](1);
        k[0] = 1000;
        int256 halfC = _swing(4, 20, k, 1145);
        int256 halfL = _swing(2, 0, k, 1145);
        assertLt(halfC * 10, halfL * 3, "half a beat: the energy is in the other oscillator");
        int256 fullC = _swing(4, 20, k, 1310);
        int256 fullL = _swing(2, 0, k, 1310);
        assertGt(fullC * 10, fullL * 7, "a beat: it is back");
    }

    function _swing(uint8 kind, uint16 coupling, uint256[] memory k, uint256 from) internal view returns (int256 best) {
        for (uint256 t = from; t < from + 40; t++) {
            int256 x = _abs(mh.sim(kind, 60, 10, 40, coupling, k, t));
            if (x > best) best = x;
        }
    }

    function _abs(int256 x) internal pure returns (int256) { return x < 0 ? -x : x; }

    // ─── the rules ───

    function test_antiDump_caps_buys_and_sells_creator_included() public {
        HookerToken.Ext memory e;
        e.maxBuyBps = 100;  // 1% per buy
        e.maxSellBps = 50;  // 0.5% per sell
        HookerToken t = _ext(e);
        // 0.1 ETH is ~5.6% of supply: too big for one buy
        vm.prank(alice);
        _refused(25);
        pad.buy{value: 0.1 ether}(address(t), 0.1 ether, 0);
        uint256 got = _buy(alice, t, 0.01 ether); // ~0.59%
        // a sell of all of it (0.59%) is over 0.5%: refused, for the creator as much as anyone
        vm.prank(alice);
        _refused(16);
        pad.sell(address(t), got, 0);
        _sell(alice, t, got / 2);
        // the creator buys big (exempt from buy rules) but sells under the cap like everyone
        uint256 dev = _buy(creator, t, 0.2 ether);
        vm.prank(creator);
        _refused(16);
        pad.sell(address(t), dev, 0);
        _sell(creator, t, t.totalSupply() * 40 / 10_000);
    }

    function test_graduated_sell_caps_shrink_with_the_bag() public {
        HookerToken.Ext memory e;
        e.sellSmallBps = 200;  // a small holder may sell 2% at once ...
        e.sellFloorBps = 20;   // ... a bag of 5% or more only 0.2%
        e.sellBagBps = 500;
        HookerToken t = _ext(e);
        uint256 supply = t.totalSupply();
        uint256 small = _buy(alice, t, 0.01 ether); // ~0.59%: cap ≈ 2% - 1.8%·0.59/5 ≈ 1.79%
        _sell(alice, t, small);                       // all of it: fine
        _buy(bob, t, 0.12 ether);                     // ~6.6%: the floor
        uint256 bag = t.balanceOf(bob);
        assertGt(bag * 10_000, supply * 500);
        vm.prank(bob);
        _refused(16);
        pad.sell(address(t), supply * 30 / 10_000, 0); // 0.3% > 0.2%
        _sell(bob, t, supply * 20 / 10_000);
    }

    function test_plague_spreads_by_sends() public {
        HookerToken.Ext memory e;
        e.plagueDose = 1_000 ether; // 1,000 tokens
        HookerToken t = _ext(e);
        vm.prank(alice);
        _refused(17);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
        // the creator buys (exempt) and infects alice
        _buy(creator, t, 0.01 ether);
        vm.prank(creator);
        t.transfer(alice, 1_000 ether);
        _buy(alice, t, 0.01 ether);
        // alice infects bob with less than a dose: still refused
        vm.prank(alice);
        t.transfer(bob, 999 ether);
        vm.prank(bob);
        _refused(17);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
    }

    function test_dexOnly_refuses_sends() public {
        HookerToken.Ext memory e;
        e.dexOnly = true;
        HookerToken t = _ext(e);
        uint256 got = _buy(alice, t, 0.01 ether);
        vm.prank(alice);
        _refused(18);
        t.transfer(bob, 1);
        // even to the creator: every move is a trade with the curve
        vm.prank(alice);
        _refused(18);
        t.transfer(creator, 1);
        _sell(alice, t, got);
    }

    function test_p2pOnly_only_the_creator_buys_and_nobody_sells() public {
        HookerToken.Ext memory e;
        e.p2pOnly = true;
        HookerToken t = _ext(e);
        vm.prank(alice);
        _refused(19);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
        uint256 dev = _buy(creator, t, 0.05 ether);
        vm.prank(creator);
        t.transfer(alice, dev / 2);
        vm.prank(alice);
        t.transfer(bob, dev / 4);
        vm.prank(bob);
        _refused(19);
        pad.sell(address(t), dev / 4, 0);
        vm.prank(creator);
        _refused(19);
        pad.sell(address(t), 1, 0);
    }

    function test_hours_options_sells_holidays_daylight_saving() public {
        HookerToken.Rules memory r;
        r.hoursOn = true;
        r.hoursDays = 0x3E;          // Monday to Friday
        r.hoursOpenMin = 9 * 60 + 30;
        r.hoursCloseMin = 16 * 60;
        r.tzOffsetMin = -300;        // New York, standard time
        HookerToken.Ext memory e;
        e.hoursSells = true;
        e.hoursHolidays = true;
        e.hoursDst = 1;              // US daylight saving
        HookerToken t = _launch(r, e);
        HookerToken.Ext memory plain;
        plain.hoursSells = true;     // no daylight saving: New York standard time all year
        HookerToken s = _launch(r, plain);
        // Thu 9 Oct 2025 13:45 UTC = 09:45 EDT: open with daylight saving, 08:45 without
        vm.warp(uint256(_t(2025, 10, 9, 13, 45)));
        uint256 got = _buy(alice, t, 0.01 ether);
        vm.prank(alice);
        _refused(9);
        pad.buy{value: 0.01 ether}(address(s), 0.01 ether, 0);
        // 20:30 UTC = 16:30 EDT: closed, and sells are closed too
        vm.warp(uint256(_t(2025, 10, 9, 20, 30)));
        vm.prank(alice);
        _refused(20);
        pad.sell(address(t), got, 0);
        // Thanksgiving, Thu 27 Nov 2025, 15:00 UTC = 10:00 EST: a holiday, closed all day
        vm.warp(uint256(_t(2025, 11, 27, 15, 0)));
        vm.prank(bob);
        _refused(9);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
        // the Friday after: open
        vm.warp(uint256(_t(2025, 11, 28, 15, 0)));
        _buy(bob, t, 0.01 ether);
        _sell(alice, t, got);
    }

    function test_hot_potato() public {
        HookerToken.Ext memory e;
        e.potatoOn = true;
        e.potatoMinBps = 10;        // a buy of 0.1% or more takes it
        e.potatoColdSecs = 600;
        HookerToken t = _ext(e);
        uint256 got = _buy(alice, t, 0.01 ether);
        assertEq(t.potatoHolder(), alice);
        vm.prank(alice);
        _refused(21);
        pad.sell(address(t), got, 0);
        vm.prank(alice);
        _refused(21);
        t.transfer(carol, 1);
        // a tiny buy (under 0.1%) does not take it
        _buy(bob, t, 0.0001 ether);
        assertEq(t.potatoHolder(), alice);
        _buy(bob, t, 0.01 ether);
        assertEq(t.potatoHolder(), bob);
        _sell(alice, t, got);
        // bob holds it until it goes cold
        uint256 b = t.balanceOf(bob);
        vm.prank(bob);
        _refused(21);
        pad.sell(address(t), b, 0);
        vm.warp(block.timestamp + 600);
        _sell(bob, t, b);
    }

    function test_ping_pong() public {
        HookerToken.Ext memory e;
        e.pingOn = true;
        e.pingMinBps = 10;           // 0.1% takes a turn
        e.pingFreeSecs = 300;
        HookerToken t = _ext(e);
        uint256 got = _buy(alice, t, 0.01 ether);
        assertEq(t.pingNext(), 2, "sellers' turn");
        vm.prank(bob);
        _refused(22);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0);
        // a buy under the minimum goes through on its own turn ... no: it is the sellers' turn, so it is refused too
        vm.prank(bob);
        _refused(22);
        pad.buy{value: 0.0001 ether}(address(t), 0.0001 ether, 0);
        _sell(alice, t, got / 2);
        assertEq(t.pingNext(), 1, "buyers' turn");
        // a small sell on the buyers' turn: refused; free for both after 300 s
        vm.prank(alice);
        _refused(22);
        pad.sell(address(t), 1, 0);
        vm.warp(block.timestamp + 300);
        _sell(alice, t, 1 ether);
        assertEq(t.pingNext(), 1, "a trade under the minimum does not hand the turn over");
        // one transaction cannot take both turns
        BothTurns both = new BothTurns();
        vm.deal(address(both), 1 ether);
        _refused(22);
        both.go{value: 0.01 ether}(pad, address(t));
    }

    function test_chapters_double_the_cap_as_volume_trades() public {
        HookerToken.Ext memory e;
        e.chapterStartBps = 100;          // 1% per wallet in chapter 1
        e.chapterVolume = 30_000_000 ether; // 3% of supply traded per chapter
        HookerToken t = _ext(e);
        uint256 supply = t.totalSupply();
        _buy(alice, t, 0.015 ether);        // ~0.88%
        vm.prank(alice);
        _refused(24);
        pad.buy{value: 0.01 ether}(address(t), 0.01 ether, 0); // would be ~1.5%
        // a send that puts bob over 1% is refused too
        uint256 a = t.balanceOf(alice);
        _buy(bob, t, 0.015 ether);
        vm.prank(alice);
        _refused(24);
        t.transfer(bob, a);
        // trade volume through chapter 1 (3%): carol trades in and out
        for (uint256 i; i < 4; i++) {
            uint256 c = _buy(carol, t, 0.015 ether);
            _sell(carol, t, c);
        }
        assertGt(t.volume(), 30_000_000 ether);
        _buy(alice, t, 0.01 ether);         // chapter 2: 2%
        assertGt(t.balanceOf(alice) * 10_000, supply * 100);
    }

    function test_breathing_cap_follows_the_sine() public {
        HookerToken.Ext memory e;
        e.oscKind = 1;
        e.oscPeriod = 60;
        e.oscBaseBps = 100;   // 1% at rest
        e.oscFloorBps = 10;
        e.oscAmpPct = 50;     // swings ±50%
        HookerToken t = _ext(e);
        // a quarter cycle in: 1.5%; three quarters: 0.5%
        vm.warp(T0 + 15);
        assertApproxEqAbs(t.oscCapNow(), 150, 1);
        _buy(alice, t, 0.02 ether); // ~1.2%: fits under 1.5%
        vm.warp(T0 + 45);
        assertApproxEqAbs(t.oscCapNow(), 50, 1);
        vm.prank(bob);
        _refused(23);
        pad.buy{value: 0.02 ether}(address(t), 0.02 ether, 0);
        _buy(bob, t, 0.005 ether); // ~0.29%
    }

    function test_momentum_buys_kick_the_cap() public {
        HookerToken.Ext memory e;
        e.oscKind = 2;
        e.oscPeriod = 120;
        e.oscBaseBps = 100;
        e.oscFloorBps = 25;
        e.oscAmpPct = 40;
        e.oscDampPermille = 10;
        HookerToken t = _ext(e);
        assertEq(t.oscCapNow(), 100, "at rest");
        _buy(alice, t, 0.017 ether); // ~1%: a base-sized kick
        vm.warp(block.timestamp + 30);
        uint256 up = t.oscCapNow();
        assertGt(up, 120, "a quarter period after a kick the cap is up (~1.29%)");
        vm.warp(block.timestamp + 60);
        uint256 down = t.oscCapNow();
        assertLt(down, 100, "and half a period later it is below rest");
        // a buy over the low cap is refused
        vm.prank(bob);
        _refused(23);
        pad.buy{value: 0.02 ether}(address(t), 0.02 ether, 0);
    }

    function test_coupled_resonator_runs() public {
        HookerToken.Ext memory e;
        e.oscKind = 4;
        e.oscPeriod = 60;
        e.oscBaseBps = 100;
        e.oscFloorBps = 25;
        e.oscAmpPct = 40;
        e.oscDampPermille = 10;
        e.oscCouplingPct = 20;
        HookerToken t = _ext(e);
        _buy(alice, t, 0.017 ether);
        vm.warp(block.timestamp + 15);
        assertGt(t.oscCapNow(), 100);
        assertTrue(t.oscX1() == 0 && t.oscV1() != 0 && t.oscV2() != 0, "both modes kicked");
    }

    function test_king_of_the_hill_crown_bar_decay_and_pay() public {
        HookerToken.Ext memory e;
        e.kingOn = true;
        e.kingMin = 0.01 ether;
        e.kingBeatPct = 10;
        e.kingDecayUnit = 2;  // hours
        e.kingDecayN = 6;     // halves every 6 hours
        HookerToken t = _ext(e);
        assertTrue(pad.kingRule(address(t)));
        // the creator's buy never crowns (kingDevCan off)
        _buy(creator, t, 0.05 ether);
        assertEq(t.king(), address(0));
        _buy(alice, t, 0.02 ether);
        assertEq(t.king(), alice);
        assertEq(t.kingBid(), 0.02 ether);
        assertEq(t.kingBar(), 0.022 ether);
        _buy(bob, t, 0.021 ether);             // not 10% more
        assertEq(t.king(), alice);
        // alice earns 0.3% of the trades during her reign (bob's 0.021): out of the platform's part
        assertEq(pad.kingOwed(alice, address(0)), 0.021 ether * 30 / 10_000);
        // six hours later the bar has halved: 0.011
        vm.warp(block.timestamp + 6 hours);
        assertApproxEqAbs(t.kingBar(), 0.011 ether, 0.000001 ether);
        _buy(bob, t, 0.0115 ether);
        assertEq(t.king(), bob);
        assertEq(t.reign(), 2);
        (address k1,, bool ended1,) = t.reigns(1);
        assertEq(k1, alice);
        assertTrue(ended1);
        // pay alice what she earned (bob's crowning buy was still her reign)
        uint256 owed = pad.kingOwed(alice, address(0));
        assertEq(owed, (0.021 ether + 0.0115 ether) * 30 / 10_000);
        uint256 before = alice.balance;
        pad.payKing(alice, address(0));
        assertEq(alice.balance - before, owed);
        assertEq(pad.kingOwed(alice, address(0)), 0);
        // bob sends a token away: the crown is given up, and the bar falls back to the minimum
        vm.prank(bob);
        t.transfer(carol, 1);
        assertEq(t.king(), address(0));
        assertEq(t.kingBar(), 0.01 ether);
    }

    function test_king_cut_comes_out_of_the_platforms_part_only() public {
        HookerToken.Ext memory e;
        e.kingOn = true;
        e.kingMin = 0.01 ether;
        HookerToken t = _ext(e);
        _buy(alice, t, 0.02 ether);
        uint256 creatorBefore = pad.creatorFees(creator, address(0));
        uint256 platformBefore = pad.platformFees(address(0));
        _buy(bob, t, 1 ether);
        // the 1% fee: 0.4% creator (untouched), 0.6% platform, of which the King takes 0.3%
        assertEq(pad.creatorFees(creator, address(0)) - creatorBefore, 1 ether * 40 / 10_000);
        assertEq(pad.platformFees(address(0)) - platformBefore, 1 ether * 30 / 10_000);
        assertEq(pad.kingOwed(alice, address(0)), 1 ether * 30 / 10_000);
    }

    // ─── validation ───

    function test_v3_validation() public {
        HookerTokenFactory f = pad.tokenFactory();
        HookerToken.Rules memory r;
        HookerToken.Ext memory e;
        f.validateExt(r, e); // all off is fine

        e.plagueDose = 1;
        e.dexOnly = true;
        vm.expectRevert(abi.encodeWithSelector(HookerTokenFactory.Refused.selector, "plague spreads by sends"));
        f.validateExt(r, e);

        e = _off();
        e.p2pOnly = true;
        e.potatoOn = true;
        vm.expectRevert(abi.encodeWithSelector(HookerTokenFactory.Refused.selector, "P2P-only with buy or sell rules"));
        f.validateExt(r, e);

        e = _off();
        e.chapterStartBps = 100;
        e.chapterVolume = 1 ether;
        r.maxWalletBps = 300;
        vm.expectRevert(abi.encodeWithSelector(HookerTokenFactory.Refused.selector, "chapters and max per wallet both cap a wallet"));
        f.validateExt(r, e);
        r.maxWalletBps = 0;

        e = _off();
        e.maxBuyBps = 100;
        r.tradeGuardBps = 100;
        vm.expectRevert(abi.encodeWithSelector(HookerTokenFactory.Refused.selector, "anti-dump caps and trade guard both cap a trade"));
        f.validateExt(r, e);
        r.tradeGuardBps = 0;

        e = _off();
        e.oscKind = 2;
        e.oscPeriod = 120;
        e.oscBaseBps = 100;
        e.oscFloorBps = 25;
        e.oscAmpPct = 40;
        e.oscDampPermille = 5; // below 1%/s
        vm.expectRevert(abi.encodeWithSelector(HookerTokenFactory.Refused.selector, "oscillator"));
        f.validateExt(r, e);

        e = _off();
        e.hoursSells = true;
        vm.expectRevert(abi.encodeWithSelector(HookerTokenFactory.Refused.selector, "trading-hours options without trading hours"));
        f.validateExt(r, e);

        // the King's minimum is checked by the launchpad, in the launch's asset (4.2 ETH graduation: 0.001..4.2 ETH)
        e = _off();
        e.kingOn = true;
        e.kingMin = 0.0001 ether;
        HookerLaunchpad.LaunchInput memory a;
        a.name = "Hook";
        a.symbol = "HOOK";
        a.size = 3;
        a.ext = e;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(HookerLaunchpad.Refused.selector, "King of the Hill minimum"));
        pad.launch(a);
    }

    function _off() internal pure returns (HookerToken.Ext memory e) {}
}
