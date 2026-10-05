// One watchdog pass (run by hooker-watchdog.timer every 2 minutes; it exits when done).
// Lives OUTSIDE the graduator so a dead or hung graduator is still reported. See lib/alert.mjs.
//   node server/watchdog.mjs          one pass
//   node server/watchdog.mjs --test   send a test line to every configured channel
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { env, connect } from "../lib/env.mjs";
import { findProblems, plan, settle, deliver, channels, GRADUATING } from "../lib/alert.mjs";

const log = (...a) => console.log(new Date().toISOString(), ...a);
const root = new URL("../", import.meta.url).pathname;
const ch = channels();
if (!ch.webhook && !ch.telegram) log("no ALERT_WEBHOOK or TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID set: problems are logged only");

if (process.argv.includes("--test")) {
  const ok = await deliver("🔔 test alert from the watchdog. If you can read this, alerts reach you.", { ch, log });
  log(ok ? "test alert sent" : "test alert NOT delivered");
  process.exit(ok ? 0 : 1);
}

const nowMs = Date.now(), nowSec = Math.floor(nowMs / 1000);
const statePath = `${env.dataDir}/alerts.json`;
let state = {};
try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch {}

// the ledger, read-only: the graduator's heartbeat and every launch that is not finished
const db = new DatabaseSync(`${env.dataDir}/hooker.db`, { readOnly: true });
db.exec("PRAGMA busy_timeout = 10000");
const heartbeat = db.prepare("SELECT heartbeat FROM lock WHERE id = 1").get()?.heartbeat ?? null;
const launches = db.prepare(`SELECT * FROM launches WHERE status = 'stalled' OR status IN (${GRADUATING.map(() => "?").join(",")})`).all(...GRADUATING);
const counts = Object.fromEntries(db.prepare("SELECT status, COUNT(*) n FROM launches GROUP BY status").all().map((r) => [r.status, r.n]));
db.close();

const probe = async (url) => {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "manual" }); return { ok: r.status < 500, why: `HTTP ${r.status}` }; }
  catch (e) { return { ok: false, why: String(e.cause?.code ?? e.name ?? e).slice(0, 60) }; }
};
const api = await probe(`http://127.0.0.1:${env.apiPort}/api/health`);
const gateExpected = existsSync(`${root}gate.env`);
const gate = gateExpected ? await probe(`http://127.0.0.1:${process.env.GATE_PORT || 5312}/`) : { ok: true };

// the hot wallet's balance: one getBalance at most every 10 minutes (the RPC key is shared with Earn)
let hotLamports = state._hot?.lamports ?? null, hotWallet = null;
try { hotWallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(env.platformKeyPath, "utf8")))).publicKey; } catch {}
if (hotWallet && (!state._hot || nowMs - state._hot.at > 600_000)) {
  try { hotLamports = await connect().getBalance(hotWallet, "confirmed"); state._hot = { lamports: hotLamports, at: nowMs }; }
  catch (e) { log(`hot wallet balance unreadable: ${e.message}`); hotLamports = null; }
}

// Robinhood Chain (Pons), when it is set up: the graduation service's status file and its wallet's ETH (every 10 min)
let evm = null;
const evmKeyPath = `${root}keys/evm-graduator.key`;
if (process.env.EVM_LAUNCHPAD && existsSync(evmKeyPath)) {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { readEvmKey } = await import("./evm-graduator.mjs");
  const { evmClient } = await import("../lib/evm.mjs");
  let status = null;
  try { status = JSON.parse(readFileSync(`${env.dataDir}/evm-graduator.heartbeat`, "utf8")); } catch {}
  const wallet = privateKeyToAccount(readEvmKey(evmKeyPath)).address;
  let wei = state._evm?.wei != null ? BigInt(state._evm.wei) : null;
  if (!state._evm || nowMs - state._evm.at > 600_000) {
    try { wei = await evmClient(process.env.EVM_CALL_RPC_URL || process.env.EVM_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", 4663).getBalance({ address: wallet }); state._evm = { wei: wei.toString(), at: nowMs }; }
    catch (e) { log(`evm wallet balance unreadable: ${e.shortMessage ?? e.message}`); wei = null; }
  }
  evm = { status, wallet, wei, lowWei: BigInt(Math.round(Number(process.env.EVM_LOW_ETH ?? 0.002) * 1e18)) };
}

let newestBackupSec = null;
try {
  for (const f of readdirSync(`${root}backups`)) if (f.endsWith(".db")) newestBackupSec = Math.max(newestBackupSec ?? 0, Math.floor(statSync(`${root}backups/${f}`).mtimeMs / 1000));
} catch {}

const problems = findProblems({
  nowSec, heartbeat, apiOk: api.ok, apiWhy: api.why, gateExpected, gateOk: gate.ok, launches,
  hotLamports, hotLowLamports: Math.round(Number(process.env.HOT_LOW_SOL ?? 0.3) * 1e9),
  newestBackupSec, hotWallet: hotWallet?.toBase58(), evm,
});
for (const p of problems) log(p.text);

const { messages, next } = plan(problems, state, nowMs);
const results = new Map();
for (const m of messages) {
  const ok = await deliver(m.text, { ch, log });
  results.set(m.key, ok);
  log(`${ok ? "sent" : "NOT sent"}: ${m.text.slice(0, 100)}`);
}
settle(next, results, nowMs);

// once a day a line saying all is well: silence then means the watchdog itself is gone
const day = new Date(nowMs).toISOString().slice(0, 10), hour = new Date(nowMs).getUTCHours();
if (hour >= Number(process.env.ALERT_DAILY_HOUR ?? 8) && next._daily?.day !== day && (ch.webhook || ch.telegram)) {
  const line = `${problems.length ? `⚠ ${problems.length} open problem(s)` : "✅ all well"} · hot wallet ${hotLamports == null ? "?" : (hotLamports / 1e9).toFixed(3)} SOL${evm ? ` · Pons gas ${evm.wei == null ? "?" : (Number(evm.wei) / 1e18).toFixed(4)} ETH` : ""} · launches: ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(", ") || "none"}`;
  if (await deliver(`daily: ${line}`, { ch, log })) next._daily = { day };
}

writeFileSync(`${statePath}.tmp`, JSON.stringify(next, null, 1), { mode: 0o600 });
renameSync(`${statePath}.tmp`, statePath);
if (!problems.length) log("ok");
