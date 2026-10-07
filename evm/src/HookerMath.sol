// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// The arithmetic behind the v3 rules, ported one to one from the Solana hook (programs/hooker-hook/src/v3.rs):
/// Q32 fixed point (1.0 = 2^32), a 2×2 oscillator step matrix, a sine, 2^-f, and the calendar for daylight saving
/// and US market holidays. Rust's `>>` on i128 and Solidity's `>>` on int256 are both arithmetic shifts, and both
/// `/` truncate toward zero, so the same inputs give the same numbers.
library HookerMath {
    int256 internal constant Q = 1 << 32;
    int256 internal constant TWO_PI_Q = 26_986_075_409;
    int256 internal constant TWO_PI_SQ_Q = 169_558_512_509;
    int256 internal constant PI_Q = 13_493_037_705;
    int256 internal constant HALF_PI_Q = 6_746_518_852;
    /// |x| and |v| stay within this, so the cap stays sane and nothing overflows.
    int256 internal constant OSC_LIMIT = 16 * Q;

    uint8 internal constant OSC_BREATH = 1;
    uint8 internal constant OSC_MOMENTUM = 2;
    uint8 internal constant OSC_RESONANCE = 3;
    uint8 internal constant OSC_COUPLED = 4;

    // ── 2×2 matrices, Q32 ──
    function mmul(int256[4] memory a, int256[4] memory b) internal pure returns (int256[4] memory r) {
        r[0] = (a[0] * b[0] + a[1] * b[2]) >> 32;
        r[1] = (a[0] * b[1] + a[1] * b[3]) >> 32;
        r[2] = (a[2] * b[0] + a[3] * b[2]) >> 32;
        r[3] = (a[2] * b[1] + a[3] * b[3]) >> 32;
    }

    /// exp(A·1s) for x'' = -w2·x - 2γ·x', A = [[0, 1], [-w2, -2γ]], by its Taylor series.
    function stepMatrix(int256 w2, int256 twoGamma) internal pure returns (int256[4] memory sum) {
        int256[4] memory a = [int256(0), Q, -w2, -twoGamma];
        int256[4] memory term = [Q, int256(0), int256(0), Q];
        sum = [Q, int256(0), int256(0), Q];
        for (int256 k = 1; k <= 24; k++) {
            term = mmul(term, a);
            for (uint256 i; i < 4; i++) {
                term[i] /= k;
                sum[i] += term[i];
            }
        }
    }

    function mpow(int256[4] memory m, uint256 e) internal pure returns (int256[4] memory r) {
        r = [Q, int256(0), int256(0), Q];
        int256[4] memory b = m;
        while (e > 0) {
            if (e & 1 == 1) r = mmul(r, b);
            e >>= 1;
            if (e > 0) b = mmul(b, b);
        }
    }

    /// The oscillator's constants: the step matrices of its one or two modes, and the kick each buy adds per mode.
    function oscConstants(uint8 kind, uint16 period, uint16 dampPermille, uint16 ampPct, uint16 couplingPct)
        internal
        pure
        returns (int256[4] memory m1, int256[4] memory m2, int256 k1, int256 k2)
    {
        int256 t = int256(uint256(period));
        int256 w2 = TWO_PI_SQ_Q / (t * t);
        int256 w = TWO_PI_Q / t;
        int256 twoGamma = 2 * int256(uint256(dampPermille)) * Q / 1000;
        int256 kick = w * int256(uint256(ampPct)) / 100;
        m1 = stepMatrix(w2, twoGamma);
        if (kind == OSC_COUPLED) {
            // two identical oscillators, coupling κ: normal modes at w² and w²(1 + 2κ); a kick on the first
            // oscillator's velocity is half in each mode, and its position is their sum
            int256 w2a = w2 * (100 + 2 * int256(uint256(couplingPct))) / 100;
            m2 = stepMatrix(w2a, twoGamma);
            k1 = kick / 2;
            k2 = kick / 2;
        } else {
            k1 = kick;
        }
    }

    /// After this many seconds without a buy the oscillator has decayed below one Q32 step.
    function oscQuietAfter(uint16 dampPermille, uint16 period) internal pure returns (uint256) {
        uint256 d = dampPermille == 0 ? 1 : dampPermille;
        uint256 t = period;
        uint256 a = 23_570 / d;
        uint256 b = 2_357 * t * t * d / 1_973_900;
        return a > b ? a : b;
    }

    /// The per-buy cap for a displacement x, bps of supply.
    function oscCapBps(uint16 baseBps, uint16 floorBps, int256 x) internal pure returns (uint256) {
        int256 cap = int256(uint256(baseBps)) * (Q + x) / Q;
        if (cap < int256(uint256(floorBps))) cap = int256(uint256(floorBps));
        if (cap > 10_000) cap = 10_000;
        return uint256(cap);
    }

    function clamp(int256 v) internal pure returns (int256) {
        return v > OSC_LIMIT ? OSC_LIMIT : (v < -OSC_LIMIT ? -OSC_LIMIT : v);
    }

    /// sin(2π·p) for a phase p in [0, Q), Q32 in and out.
    function sinTurn(int256 p) internal pure returns (int256 sum) {
        int256 x = (p * TWO_PI_Q) >> 32;
        if (x > PI_Q) x -= 2 * PI_Q;
        if (x > HALF_PI_Q) x = PI_Q - x;
        else if (x < -HALF_PI_Q) x = -PI_Q - x;
        int256 x2 = (x * x) >> 32;
        int256 term = x;
        sum = x;
        int256 k = 1;
        for (uint256 i; i < 6; i++) {
            term = -((term * x2) >> 32) / ((k + 1) * (k + 2));
            k += 2;
            sum += term;
        }
    }

    /// 2^(-f) for f in [0, Q), Q32.
    function exp2NegFrac(int256 f) internal pure returns (int256 sum) {
        int256 y = (f * 2_977_044_472) >> 32; // f·ln2
        int256 term = Q;
        sum = Q;
        for (int256 k = 1; k <= 7; k++) {
            term = -((term * y) >> 32) / k;
            sum += term;
        }
    }

    // ── the calendar (Howard Hinnant's algorithms), days since 1970-01-01 ──
    function divE(int256 a, int256 b) internal pure returns (int256) {
        int256 q = a / b;
        if (a % b < 0) q -= 1; // b > 0 everywhere here
        return q;
    }

    function modE(int256 a, int256 b) internal pure returns (int256) {
        int256 r = a % b;
        return r < 0 ? r + b : r;
    }

    function year(int256 z) internal pure returns (int256) {
        z += 719_468;
        int256 era = divE(z, 146_097);
        int256 doe = z - era * 146_097;
        int256 yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        int256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        int256 mp = (5 * doy + 2) / 153;
        int256 m = mp < 10 ? mp + 3 : mp - 9;
        int256 y = yoe + era * 400;
        return m <= 2 ? y + 1 : y;
    }

    function dayNum(int256 y, int256 m, int256 d) internal pure returns (int256) {
        if (m <= 2) y -= 1;
        int256 era = divE(y, 400);
        int256 yoe = y - era * 400;
        int256 doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
        int256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146_097 + doe - 719_468;
    }

    /// 0 = Sunday … 6 = Saturday.
    function weekday(int256 z) internal pure returns (int256) {
        return modE(z + 4, 7);
    }

    /// The n-th (1-based) `wd` of a month, or the last one when n = 0.
    function nthWeekday(int256 y, int256 m, int256 wd, int256 n) internal pure returns (int256) {
        if (n == 0) {
            int256 last = (m == 12 ? dayNum(y + 1, 1, 1) : dayNum(y, m + 1, 1)) - 1;
            return last - modE(weekday(last) - wd, 7);
        }
        int256 first = dayNum(y, m, 1);
        return first + modE(wd - weekday(first), 7) + 7 * (n - 1);
    }

    function easter(int256 y) internal pure returns (int256) {
        int256 a = y % 19;
        int256 b = y / 100;
        int256 c = y % 100;
        int256 d = b / 4;
        int256 e = b % 4;
        int256 f = (b + 8) / 25;
        int256 g = (b - f + 1) / 3;
        int256 h = (19 * a + b - d - g + 15) % 30;
        int256 i = c / 4;
        int256 k = c % 4;
        int256 l = (32 + 2 * e + 2 * i - h - k) % 7;
        int256 mm = (a + 11 * h + 22 * l) / 451;
        return dayNum(y, (h + l - 7 * mm + 114) / 31, (h + l - 7 * mm + 114) % 31 + 1);
    }

    /// A fixed-date holiday moved off a weekend (Saturday → Friday, Sunday → Monday).
    function observed(int256 z) internal pure returns (int256) {
        int256 w = weekday(z);
        return w == 6 ? z - 1 : (w == 0 ? z + 1 : z);
    }

    /// NYSE full-day closures on day `z`.
    function usMarketHoliday(int256 z) internal pure returns (bool) {
        int256 y = year(z);
        int256 ny = dayNum(y, 1, 1);
        if (weekday(ny) != 6 && observed(ny) == z) return true; // a Saturday New Year is not made up
        if (observed(dayNum(y, 7, 4)) == z || observed(dayNum(y, 12, 25)) == z) return true;
        if (y >= 2022 && observed(dayNum(y, 6, 19)) == z) return true;
        return z == nthWeekday(y, 1, 1, 3) // Martin Luther King Jr. Day
            || z == nthWeekday(y, 2, 1, 3) // Washington's Birthday
            || z == easter(y) - 2 // Good Friday
            || z == nthWeekday(y, 5, 1, 0) // Memorial Day
            || z == nthWeekday(y, 9, 1, 1) // Labor Day
            || z == nthWeekday(y, 11, 4, 4); // Thanksgiving
    }

    /// Whether daylight saving is on at unix time `ts` for a zone at UTC + `tz` minutes standard time.
    /// mode 1: US (second Sunday of March 02:00 standard → first Sunday of November 02:00 daylight);
    /// mode 2: EU (last Sunday of March 01:00 UTC → last Sunday of October 01:00 UTC).
    function dstOn(uint8 mode, int256 ts, int256 tz) internal pure returns (bool) {
        if (mode == 1) {
            int256 std = ts + tz * 60;
            int256 y = year(divE(std, 86_400));
            return std >= nthWeekday(y, 3, 0, 2) * 86_400 + 2 * 3_600 && std < nthWeekday(y, 11, 0, 1) * 86_400 + 3_600;
        }
        if (mode == 2) {
            int256 y = year(divE(ts, 86_400));
            return ts >= nthWeekday(y, 3, 0, 0) * 86_400 + 3_600 && ts < nthWeekday(y, 10, 0, 0) * 86_400 + 3_600;
        }
        return false;
    }
}
