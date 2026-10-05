// The graduation service, as a long-running process. One instance per ledger (a lock enforces it).
//   RPC_URL=… RPC_RPS=5 PLATFORM_KEY=keys/platform.json TREASURY=… node server/graduator.mjs
import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { env, connect, loadKeypair } from "../lib/env.mjs";
import { openDb, takeLock, releaseLock } from "../lib/db.mjs";
import { Graduator } from "../lib/graduate.mjs";
import { ensureConfigs, loadConfigState, configEntries } from "../lib/configs.mjs";
import { createFlywheel } from "../lib/flywheel.mjs";
import { existsSync } from "node:fs";

process.on("uncaughtException", (e) => console.error(new Date().toISOString(), "graduator uncaught:", String(e?.stack ?? e).replace(/api-key=[^&\s"']+/g, "api-key=…")));
process.on("unhandledRejection", (e) => console.error(new Date().toISOString(), "graduator unhandled:", String(e?.stack ?? e).replace(/api-key=[^&\s"']+/g, "api-key=…")));
const db = openDb(`${env.dataDir}/hooker.db`);
const me = randomUUID();
if (!takeLock(db, me)) { console.error("another graduator holds the ledger lock; exiting"); process.exit(1); }
const platform = loadKeypair(env.platformKeyPath);
// refuse to run as any wallet but the one this deployment is for, or to pay fees into itself
if (env.expectedPlatform && !platform.publicKey.equals(env.expectedPlatform)) { console.error(`platform key is ${platform.publicKey.toBase58()}, expected ${env.expectedPlatform.toBase58()}`); process.exit(1); }
if (!env.treasury || env.treasury.equals(platform.publicKey)) { console.error("TREASURY must be set and must not be the hot wallet"); process.exit(1); }
const conn = connect();
// the configs: made here if missing, re-made when pump.fun changes its curve (checked every CONFIGS_MS)
const log = (...a) => console.log(new Date().toISOString(), ...a);
const refreshConfigs = async (g) => {
  const st = await ensureConfigs({ conn, platform, hookProgram: env.hookProgram, dataDir: env.dataDir, log });
  if (g) { g.setConfigs(configEntries(st)); if (st.changed) { g.lut = null; await g.ensureLut(); } } // new configs → the lookup table gains them
  return st;
};
const first = await refreshConfigs();
const g = new Graduator({ conn, db, platform, treasury: env.treasury, hookProgram: env.hookProgram, configs: {}, dataDir: env.dataDir, burnWallet: env.burnWallet, log });
// the burn (lib/flywheel.mjs): on when BURN_WALLET is set; live only when its key is here and FLYWHEEL_DRY is not set
let flywheel = null;
if (env.burnWallet) {
  const burnKey = existsSync(env.burnKeyPath) ? loadKeypair(env.burnKeyPath) : null;
  if (burnKey && !burnKey.publicKey.equals(env.burnWallet)) { console.error(`keys/burn.json is ${burnKey.publicKey.toBase58()}, BURN_WALLET is ${env.burnWallet.toBase58()}`); process.exit(1); }
  flywheel = createFlywheel({ conn, db, burn: env.flywheelDry ? null : burnKey, burnPubkey: env.burnWallet, hookerMint: env.hookerMint, platform: platform.publicKey, log });
  log(`burn: wallet ${env.burnWallet.toBase58()} → $HOOKER ${env.hookerMint.toBase58()} ${flywheel.dry ? "(DRY: simulated, nothing sent)" : "(live)"}`);
} else log("burn: off (BURN_WALLET not set): graduated coins keep their creator as fee recipient");
await refreshConfigs(g);
await g.ensureLut(); // pump.fun's fixed accounts, so a create+buy with a long URI still fits one transaction
const CONFIGS_MS = Number(process.env.CONFIGS_MS ?? 600_000);
let lastConfigs = Date.now();
log(`configs: ${Object.keys(first.configs).join("/")} SOL, pump.fun start cap ${first.pump.capAt(0).toFixed(1)} SOL, graduates at ${first.pump.completionSol.toFixed(1)} SOL`);
// RPC budget while idle (per hour): a tick is free when nothing trades; discovery is 2 heavy
// getProgramAccounts per config; the sweep's balance read runs after a graduation or every SWEEP_MS
const TICK_MS = Number(process.env.TICK_MS ?? 8_000), DISCOVER_MS = Number(process.env.DISCOVER_MS ?? 900_000), SWEEP_MS = Number(process.env.SWEEP_MS ?? 900_000), FLYWHEEL_MS = Number(process.env.FLYWHEEL_MS ?? 600_000);
let lastDiscover = 0, lastSweep = 0, lastFlywheel = 0, stopping = false;
// a tick can take a while: on SIGTERM hand the lock back right away, finish the tick, then exit
process.on("SIGTERM", () => { stopping = true; releaseLock(db, me); });
process.on("SIGINT", () => { stopping = true; releaseLock(db, me); });
g.log(`graduator up: platform ${g.platform.publicKey.toBase58()}, treasury ${env.treasury?.toBase58()}`);
while (!stopping) {
  if (!takeLock(db, me)) { console.error("lost the ledger lock; exiting"); process.exit(1); }
  try {
    if (Date.now() - lastConfigs > CONFIGS_MS) { await refreshConfigs(g); lastConfigs = Date.now(); }
    if (Date.now() - lastDiscover > DISCOVER_MS) { await g.discover(); lastDiscover = Date.now(); }
    const finished = await g.tick();
    if (finished > 0 || Date.now() - lastSweep > SWEEP_MS) { await g.sweep(); lastSweep = Date.now(); }
    if (flywheel && Date.now() - lastFlywheel > FLYWHEEL_MS) { await flywheel.tick(); lastFlywheel = Date.now(); }
  } catch (e) { g.log(`⚠ pass failed: ${e.message}`); }
  await new Promise((r) => setTimeout(r, TICK_MS));
}
releaseLock(db, me);
g.log("graduator stopped");
