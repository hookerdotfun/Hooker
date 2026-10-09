// The Meteora DBC configs Hooker launches on, shaped from pump.fun's LIVE curve parameters.
//
// ⭐ The window curve IS pump.fun's curve, so the window token and the pump.fun coin it becomes show
// the same market cap and about the same token count per holder (measured: cap −2..3% across
// graduation, ~0.99 pump.fun token per window token).
//
// pump.fun's numbers come from its on-chain `Global` account (never hardcoded here): the virtual
// reserves fix the start cap, and the real token reserves fix where its own curve fills. After q SOL:
//   tokens sold = virtualTokens − k/(virtualSol+q),   market cap = (virtualSol+q)² / k × supply.
// A DBC segment between two prices has the same shape, so giving it pump.fun's start and end caps and
// putting only as many tokens on the curve as pump.fun would have sold by then reproduces it. The
// tokens pump.fun would not have sold yet are `leftover`: they never circulate and are burned after
// migration. pump.fun changes these numbers now and then: lib/configs.mjs re-reads Global and makes a
// fresh set of configs when they move, so a new launch always matches the pump.fun of today.
import { buildCurveWithMarketCap, getDeltaAmountBaseUnsigned, getInitialLiquidityFromDeltaBase, getTotalSupplyFromCurve, MAX_SQRT_PRICE } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";

/** pump.fun's curve, from its Global account (BN fields; tokens have 6 decimals, SOL 9). */
export function pumpParams(global) {
  const n = (v, d) => Number(v.toString()) / 10 ** d;
  return pumpParamsFromKey({
    virtualSol: n(global.initialVirtualSolReserves, 9),
    virtualTokens: n(global.initialVirtualTokenReserves, 6),
    supply: n(global.tokenTotalSupply, 6),
    realTokens: n(global.initialRealTokenReserves, 6),
  });
}

/** The same, rebuilt from the four numbers configs.json records. */
export function pumpParamsFromKey(key) {
  const { virtualSol, virtualTokens, supply, realTokens } = key;
  const k = virtualSol * virtualTokens;
  return {
    virtualSol, virtualTokens, supply, realTokens,
    /** SOL in pump.fun's curve when it fills (its real token reserves are sold): its graduation */
    completionSol: k / (virtualTokens - realTokens) - virtualSol,
    capAt: (sol) => ((virtualSol + sol) ** 2 / k) * supply,
    soldAt: (sol) => virtualTokens - k / (virtualSol + sol),
  };
}
export const pumpParamsKey = (p) => ({ virtualSol: p.virtualSol, virtualTokens: p.virtualTokens, supply: p.supply, realTokens: p.realTokens });

/** Graduation sizes offered, as shares of pump.fun's own graduation; the last IS pump.fun's. */
export const SIZE_FRACTIONS = [0.35, 0.5, 0.7, 1];
/** Extra sizes for our own tests (TEST_SIZES=1,2): shown while set, kept recognised after. */
export const testSizes = () => String(process.env.TEST_SIZES ?? "").split(",").map(Number).filter((n) => n > 0);
export const graduationSizes = (p) => [...new Set([...testSizes(), ...SIZE_FRACTIONS.map((f) => Math.floor(p.completionSol * f * 10) / 10)])].sort((a, b) => a - b);

/** Platform economics shared by every config. Changing these means new configs. */
export const ECONOMICS = Object.freeze({
  tradingFeeBps: 100,            // 1% per trade on the curve; Meteora keeps 20% of it
  creatorTradingFeePct: 50,      // of the rest: half to the creator, half to the platform (was 25 until 4 Oct 2026)
  antiSnipeStartBps: 5_000,      // the fee starts at 50% (25% until 4 Oct 2026) ...
  antiSnipeSecs: 120,            // ... and falls linearly to 1% over two minutes
  antiSnipePeriods: 12,
  migrationFeePct: 99,           // 99% of the curve's SOL is withdrawn at graduation for the pump.fun buy
});

/**
 * The creator's fee steps (4 Oct 2026, operator: "1%, 2%, 3% plus the default"). Meteora fixes a pool's
 * fee per CONFIG, so each step is its own set of configs. The platform keeps what it keeps on the default
 * (100 bps × 80% × 50% = 0.40% of volume); the total fee T is raised so the creator gets the step:
 *   T × 0.8 = creator + 0.40%   (Meteora keeps 20% of every fee)
 * `creatorPct` is Meteora's integer split, so the creator lands within 0.01% of the step.
 * ⚠ Kept OUT of ECONOMICS on purpose: ECONOMICS is the default set's key, and a change to it retires them.
 */
export const FEE_TIERS = Object.freeze({
  0: Object.freeze({ feeBps: 100, creatorPct: 50, label: "Default" }),   // creator ≈ 0.40% of volume
  1: Object.freeze({ feeBps: 175, creatorPct: 71, label: "1%" }),        // creator ≈ 0.99%
  2: Object.freeze({ feeBps: 300, creatorPct: 83, label: "2%" }),        // creator ≈ 1.99%
  3: Object.freeze({ feeBps: 425, creatorPct: 88, label: "3%" }),        // creator ≈ 2.99%
});
/** What a tier means for one trade, in percent of the trade: total, creator, platform, Meteora. */
export const tierSplit = (t) => { const f = FEE_TIERS[t]; const net = f.feeBps * 0.8; return { totalPct: f.feeBps / 100, creatorPct: (net * f.creatorPct) / 100 / 100, platformPct: (net * (100 - f.creatorPct)) / 100 / 100, meteoraPct: (f.feeBps * 0.2) / 100 }; };

/**
 * Builder settings, minus the token and the caps. Two kinds of config per size: with the anti-snipe
 * fee (25% falling to 1% over two minutes) and without it (a flat 1%). Since 4 Oct 2026 the anti-snipe
 * fee is a hook the creator picks, off by default; Meteora fixes a pool's fee schedule per config.
 */
export function configRest({ antiSnipe = true, tier = 0 } = {}) {
  const e = ECONOMICS, t = FEE_TIERS[tier];
  if (!t) throw new Error(`no fee tier ${tier}`);
  const fee = tier === 0 ? e.tradingFeeBps : t.feeBps, creatorPct = tier === 0 ? e.creatorTradingFeePct : t.creatorPct;
  const schedule = antiSnipe
    ? { startingFeeBps: Math.max(e.antiSnipeStartBps, fee), endingFeeBps: fee, numberOfPeriod: e.antiSnipePeriods, totalDuration: e.antiSnipeSecs }
    : { startingFeeBps: fee, endingFeeBps: fee, numberOfPeriod: 0, totalDuration: 0 };
  return {
    token: { tokenType: 1, tokenBaseDecimal: 6, tokenQuoteDecimal: 9, tokenAuthorityOption: 1 },
    fee: {
      baseFeeParams: { baseFeeMode: 0, feeSchedulerParam: schedule },
      dynamicFeeEnabled: false, collectFeeMode: 0, creatorTradingFeePercentage: creatorPct,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: true, // the dev buy in the launch transaction pays 1%, not 25%
    },
    migration: { migrationOption: 1, migrationFeeOption: 0, migrationFee: { feePercentage: e.migrationFeePct, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 10, partnerLiquidityPercentage: 90, creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: 1, // timestamps, so the anti-snipe fee decays in seconds
  };
}

/**
 * Builder parameters for a pump-shaped curve that graduates with `graduationSol` in it.
 * @returns { params, leftover, startCap, endCap }  (caps in SOL)
 */
export function pumpShapedCurve(graduationSol, p, rest = configRest()) {
  if (!(graduationSol > 0 && graduationSol <= p.completionSol + 1e-9)) throw new Error(`graduation must be within 0..${p.completionSol.toFixed(1)} SOL (where pump.fun's own curve fills)`);
  const supply = Math.round(p.supply);
  const build = (leftover) => buildCurveWithMarketCap({
    ...rest,
    token: { ...rest.token, totalTokenSupply: supply, leftover },
    initialMarketCap: p.capAt(0),
    migrationMarketCap: p.capAt(graduationSol),
  });
  const thresholdOf = (leftover) => { try { return Number(build(leftover).migrationQuoteThreshold) / 1e9; } catch { return 0; } };
  // more leftover → fewer tokens on the curve → a smaller threshold: bisect to the target
  let lo = 0, hi = supply - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (thresholdOf(mid) > graduationSol) lo = mid; else hi = mid;
  }
  // at tiny sizes the builder's own rounding refuses the exact edge: walk a little past it
  let params = null, leftover = hi;
  for (let k = 0; k < 2000 && !params; k++) {
    try { const c = build(hi + k); if (Number(c.migrationQuoteThreshold) / 1e9 <= graduationSol * 1.001) { params = c; leftover = hi + k; } } catch {}
  }
  if (!params) throw new Error(`no curve builds for a ${graduationSol} SOL graduation`);
  return { params, leftover, startCap: p.capAt(0), endCap: p.capAt(graduationSol) };
}

// ── Custom graduation caps (10 Oct 2026) ─────────────────────────────────────────────────────────────
// The creator picks the market cap their token graduates at, any cap from CUSTOM_LIMITS.minCapSol up, or no
// migration at all. Each such launch gets its own config (lib/custom-configs.mjs), paid by the creator.
//
// Up to pump.fun's own graduation the curve is pump.fun's, exactly as for the fixed sizes. Past it, the same
// pump.fun shape continues while there are tokens left to put on it (the raise then fills pump.fun's curve at
// graduation and buys the rest of the coins on PumpSwap, lib/graduate.mjs); further out Meteora's own
// single-segment curve from pump.fun's start cap to the chosen cap.

/** Market cap (SOL) → SOL in the curve when it reaches it, on pump.fun's shape: capAt(q) = cap. */
export const raiseForCap = (capSol, p) => Math.sqrt((capSol / p.supply) * p.virtualSol * p.virtualTokens) - p.virtualSol;

/** The custom caps a creator may pick: the smallest raise we have graduated on mainnet (2 SOL) up to what
 *  Meteora's curve can hold with a 1B supply (found by search in test/curve-custom.test.mjs). */
export const CUSTOM_LIMITS = Object.freeze({ minRaiseSol: 2, maxCapSol: 100_000 });

/**
 * Builder parameters for a curve that graduates at market cap `capSol` (in SOL).
 * @returns { params, leftover, startCap, endCap, raiseSol, shape: "pump" | "single" }
 */
export function customCapCurve(capSol, p, rest = configRest()) {
  if (!(capSol > 0) || !Number.isFinite(capSol)) throw new Error("the graduation cap must be a positive number of SOL");
  const minCap = p.capAt(CUSTOM_LIMITS.minRaiseSol);
  if (capSol < minCap - 1e-9) throw new Error(`the graduation cap must be at least ${minCap.toFixed(1)} SOL`);
  if (capSol > CUSTOM_LIMITS.maxCapSol) throw new Error(`the graduation cap can be at most ${CUSTOM_LIMITS.maxCapSol} SOL`);
  const raise = raiseForCap(capSol, p);
  if (raise <= p.completionSol + 1e-9) { const c = pumpShapedCurve(raise, p, rest); return { ...c, raiseSol: Number(c.params.migrationQuoteThreshold) / 1e9, shape: "pump" }; }
  // past pump.fun's own graduation: pump.fun's shape while the supply allows it
  try { const c = pumpShapedCurve(raise, { ...p, completionSol: Infinity }, rest); return { ...c, raiseSol: Number(c.params.migrationQuoteThreshold) / 1e9, shape: "pump" }; } catch {}
  const params = buildCurveWithMarketCap({ ...rest, token: { ...rest.token, totalTokenSupply: Math.round(p.supply), leftover: 0 }, initialMarketCap: p.capAt(0), migrationMarketCap: capSol });
  return { params, leftover: 0, startCap: p.capAt(0), endCap: capSol, raiseSol: Number(params.migrationQuoteThreshold) / 1e9, shape: "single" };
}

/** The fill threshold of a no-migration curve: a billion SOL, more than will ever exist. Nobody can complete
 *  it, so Meteora never revokes the hook: the token trades on its curve with its rules for good. */
export const NO_MIGRATION_THRESHOLD = 10n ** 18n;

/**
 * A curve that never graduates. pump.fun's curve up to where pump.fun's own fills (the same caps a
 * pump.fun coin shows), then one last segment holding the rest of the supply out to Meteora's highest price.
 * The threshold sits deep inside that last segment, so the tokens add up the way Meteora checks them.
 */
export function noMigrationCurve(p, rest = configRest()) {
  const supply = BigInt(Math.round(p.supply)) * 10n ** 6n;
  const first = pumpShapedCurve(p.completionSol, p, rest).params;
  const seg1 = first.curve[0], start = first.sqrtStartPrice;
  const seg1Base = BigInt(getDeltaAmountBaseUnsigned(start, seg1.sqrtPrice, seg1.liquidity, 0).toString());
  // what the rest of the supply puts on the last segment, less a margin for Meteora's migration reserve
  let margin = supply / 1000n, curve = null;
  for (let i = 0; i < 40 && !curve; i++, margin *= 2n) {
    const l2 = getInitialLiquidityFromDeltaBase(new BN((supply - seg1Base - margin).toString()), MAX_SQRT_PRICE, seg1.sqrtPrice);
    const c = [{ sqrtPrice: seg1.sqrtPrice, liquidity: seg1.liquidity }, { sqrtPrice: MAX_SQRT_PRICE, liquidity: l2 }];
    const need = BigInt(getTotalSupplyFromCurve(new BN(NO_MIGRATION_THRESHOLD.toString()), start, c, first.lockedVesting, first.migrationOption, new BN(0), first.migrationFee.feePercentage).toString());
    if (need <= supply) curve = c;
  }
  if (!curve) throw new Error("no no-migration curve fits the supply");
  const params = { ...first, curve, migrationQuoteThreshold: new BN(NO_MIGRATION_THRESHOLD.toString()) };
  return { params, leftover: null, startCap: p.capAt(0), endCap: null, raiseSol: null, shape: "none" };
}
