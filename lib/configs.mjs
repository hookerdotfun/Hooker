// The Meteora DBC configs new launches use: one per graduation size, shaped from pump.fun's LIVE
// curve (lib/curve.mjs), owned by the platform wallet, recorded in <dataDir>/configs.json.
//
// pump.fun changes its curve parameters now and then. `ensureConfigs` re-reads them from pump.fun's
// Global account every time it runs (the graduator calls it every ten minutes): when they have moved,
// the current configs are RETIRED (the tokens trading on them keep their curve to the end) and a fresh
// set is created, so a new launch always starts where a pump.fun coin starts today and can graduate at
// most where pump.fun's own curve fills today.
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { dbcClient, getConfig, sendRemembered } from "./chain.mjs";
import { graduationSizes, pumpShapedCurve, pumpParams, pumpParamsKey, pumpParamsFromKey, ECONOMICS, configRest, FEE_TIERS } from "./curve.mjs";
const { OnlinePumpSdk } = createRequire(import.meta.url)("@pump-fun/pump-sdk");

const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function ensureConfigs({ conn, platform, hookProgram, dataDir, log = console.log }) {
  const dbc = dbcClient(conn);
  const p = pumpParams(await new OnlinePumpSdk(conn).fetchGlobal());
  const key = pumpParamsKey(p);
  const out = `${dataDir}/configs.json`;
  mkdirSync(dataDir, { recursive: true });
  const state = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { hookProgram: hookProgram.toBase58(), pump: key, economics: { ...ECONOMICS }, configs: {}, retired: [] };
  if (state.hookProgram !== hookProgram.toBase58()) throw new Error(`${out} is for hook ${state.hookProgram}, not ${hookProgram.toBase58()}`);
  let changed = false;
  // ⭐ our own fee economics are part of a config too (Meteora fixes them per config): a change to
  // ECONOMICS retires the current configs exactly like a pump.fun curve change. A configs.json made
  // before economics were recorded used the original 25% creator share.
  const economics = state.economics ?? { ...ECONOMICS, creatorTradingFeePct: 25 };
  if (!sameKey(state.pump, key) || !sameKey(economics, { ...ECONOMICS })) {
    const why = !sameKey(state.pump, key) ? `pump.fun changed its curve: ${JSON.stringify(state.pump)} → ${JSON.stringify(key)}` : `our fee economics changed: ${JSON.stringify(economics)} → ${JSON.stringify(ECONOMICS)}`;
    log(`${why}. Making new configs; the ${Object.keys(state.configs).length + Object.keys(state.flatConfigs ?? {}).length} current ones keep serving their tokens.`);
    state.retired = [...(state.retired ?? []), { pump: state.pump, economics, configs: state.configs, flatConfigs: state.flatConfigs ?? {}, tierConfigs: state.tierConfigs ?? {}, retiredAt: new Date().toISOString() }];
    state.pump = key;
    state.economics = { ...ECONOMICS };
    state.configs = {};
    state.flatConfigs = {};
    state.tierConfigs = {};
    changed = true;
  }
  // the creator's fee steps (curve.mjs FEE_TIERS), each a set of its own: { feeBps, creatorPct, configs, flatConfigs }.
  // A step whose numbers changed is retired on its own (its tokens keep their curves).
  state.tierConfigs ??= {};
  for (const [t, def] of Object.entries(FEE_TIERS)) {
    if (t === "0") continue;
    const cur = state.tierConfigs[t];
    if (cur && (cur.feeBps !== def.feeBps || cur.creatorPct !== def.creatorPct)) {
      log(`fee step ${t} changed (${cur.feeBps}/${cur.creatorPct} → ${def.feeBps}/${def.creatorPct}): new configs for it; the old ones keep serving their tokens.`);
      state.retired = [...(state.retired ?? []), { pump: state.pump, economics: state.economics, tierConfigs: { [t]: cur }, retiredAt: new Date().toISOString() }];
      delete state.tierConfigs[t];
    }
    state.tierConfigs[t] ??= { feeBps: def.feeBps, creatorPct: def.creatorPct, configs: {}, flatConfigs: {} };
  }
  // two sets per size: `configs` carry the anti-snipe fee (25% → 1% over two minutes), `flatConfigs` a
  // flat 1%. The creator picks; the anti-snipe fee is off by default (4 Oct 2026). Sets made before then
  // are all anti-snipe, which is what a missing `flatConfigs` means.
  state.flatConfigs ??= {};
  const sets = [[state.configs, true, 0], [state.flatConfigs, false, 0]];
  for (const [t, ts] of Object.entries(state.tierConfigs)) sets.push([ts.configs, true, Number(t)], [ts.flatConfigs, false, Number(t)]);
  for (const [set, antiSnipe, tier] of sets) for (const g of graduationSizes(p)) {
    if (set[g] && (await getConfig(dbc, set[g]))) continue;
    const { params, endCap } = pumpShapedCurve(g, p, configRest({ antiSnipe, tier }));
    const wantPct = tier === 0 ? ECONOMICS.creatorTradingFeePct : FEE_TIERS[tier].creatorPct;
    const kp = Keypair.generate();
    const tx = await dbc.partner.createConfigWithTransferHook({
      ...params, config: kp.publicKey, feeClaimer: platform.publicKey, leftoverReceiver: platform.publicKey,
      quoteMint: NATIVE_MINT, payer: platform.publicKey, transferHookProgram: hookProgram,
    });
    await sendRemembered(conn, tx, [platform, kp], () => {});
    // ⛔ 4 Oct 2026 (mainnet): a read right after confirmation can still come back empty from the RPC; that
    // crashed the service mid-set and orphaned a config that had cost SOL. Wait for the read to catch up.
    let c = null;
    for (let i = 0; i < 20 && !c; i++) { c = await getConfig(dbc, kp.publicKey).catch(() => null); if (!c) await new Promise((r) => setTimeout(r, 1_500)); }
    if (!c) throw new Error(`config ${kp.publicKey.toBase58()} was sent but cannot be read back yet; it will be recreated on the next pass`);
    if (c.migrationFeePercentage !== ECONOMICS.migrationFeePct || c.creatorTradingFeePercentage !== wantPct || !c.feeClaimer.equals(platform.publicKey) || !c.leftoverReceiver.equals(platform.publicKey))
      throw new Error("config read back wrong");
    if (feeIsFlat(c) === antiSnipe) throw new Error(`config read back wrong: anti-snipe ${antiSnipe ? "missing" : "present"}`);
    set[g] = kp.publicKey.toBase58();
    changed = true;
    // written after EVERY config so a crash mid-way never loses one that cost SOL
    writeFileSync(`${out}.tmp`, JSON.stringify(state, null, 2)); renameSync(`${out}.tmp`, out);
    log(`${g} SOL ${antiSnipe ? "anti-snipe" : "flat-fee"}${tier ? ` fee-step-${FEE_TIERS[tier].label}` : ""} config ${kp.publicKey.toBase58()} (start cap ${p.capAt(0).toFixed(1)} SOL, graduates at ${endCap.toFixed(1)} SOL cap)`);
  }
  if (changed) { writeFileSync(`${out}.tmp`, JSON.stringify(state, null, 2)); renameSync(`${out}.tmp`, out); }
  return { ...loadConfigState(dataDir), changed };
}

/**
 * What configs.json says: the active sizes → config address, pump.fun's curve they were made for,
 * and EVERY config ever made (active + retired) → size, which the graduator and the token pages need.
 */
/** Every config ever made, active and retired, as { sizeSol, address, retired }: what discovery must scan. */
export const configEntries = (state) => Object.entries(state.all).map(([addr, v]) => ({ sizeSol: v.sizeSol, address: new PublicKey(addr), retired: v.retired, antiSnipe: v.antiSnipe, tier: v.tier }));

/** The live config for a launch: size × anti-snipe × fee step. null when that combination is not made yet. */
export const configFor = (state, { gradSol, antiSnipe = false, tier = 0 }) => {
  const set = tier === 0 ? (antiSnipe ? state.configs : state.flatConfigs) : (antiSnipe ? state.tierConfigs?.[tier]?.anti : state.tierConfigs?.[tier]?.flat);
  return set?.[gradSol] ?? null;
};

/** A config's base fee does not change over time (no anti-snipe schedule). Read from the config itself. */
export function feeIsFlat(c) {
  const b = c.poolFees.baseFee;
  return Number(b.firstFactor.toString()) === 0; // the scheduler's number of periods
}

/** The fee a config's pools START at, in percent (cliff fee numerator: 1e9 = 100%). 1 on a flat config. */
export const startFeePct = (c) => Number(c.poolFees.baseFee.cliffFeeNumerator.toString()) / 1e7;

export function loadConfigState(dataDir) {
  const out = `${dataDir}/configs.json`;
  if (!existsSync(out)) return null;
  const s = JSON.parse(readFileSync(out, "utf8"));
  // offered now = the sizes derived from pump.fun's curve plus any TEST_SIZES; a size no longer offered
  // (a test size switched off) stays recognised through `all` but is not offered to new launches
  const offered = s.pump ? new Set(graduationSizes(pumpParamsFromKey(s.pump)).map(String)) : null;
  const live = (m) => Object.fromEntries(Object.entries(m ?? {}).filter(([g]) => !offered || offered.has(g)).map(([g, c]) => [g, new PublicKey(c)]));
  const configs = live(s.configs), flatConfigs = live(s.flatConfigs);
  const tierConfigs = Object.fromEntries(Object.entries(s.tierConfigs ?? {}).map(([t, ts]) => [t, { anti: live(ts.configs), flat: live(ts.flatConfigs) }]));
  const all = {};
  for (const set of [s, ...(s.retired ?? [])]) {
    const retired = set !== s;
    for (const [g, c] of Object.entries(set.configs ?? {})) all[c] = { sizeSol: Number(g), retired, antiSnipe: true, tier: 0 };
    for (const [g, c] of Object.entries(set.flatConfigs ?? {})) all[c] = { sizeSol: Number(g), retired, antiSnipe: false, tier: 0 };
    for (const [t, ts] of Object.entries(set.tierConfigs ?? {})) {
      for (const [g, c] of Object.entries(ts.configs ?? {})) all[c] = { sizeSol: Number(g), retired, antiSnipe: true, tier: Number(t) };
      for (const [g, c] of Object.entries(ts.flatConfigs ?? {})) all[c] = { sizeSol: Number(g), retired, antiSnipe: false, tier: Number(t) };
    }
  }
  return { hookProgram: s.hookProgram, pump: s.pump ? pumpParamsFromKey(s.pump) : null, configs, flatConfigs, tierConfigs, all, retired: s.retired ?? [] };
}
