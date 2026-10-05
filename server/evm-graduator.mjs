// The Robinhood Chain graduation service: every few seconds, each full curve is graduated into Pons V2
// (`graduate`: the Pons launch + buy, one transaction) and each graduated one is paid out to its holders
// (`payout`, 100 holders per transaction) until every holder has their coins.
//
// Both calls are permissionless and every input is fixed on chain, so this wallet only pays gas: it holds no
// one's money, and if it stops, anyone can finish a graduation with the same two calls.
//
//   EVM_LAUNCHPAD=0x… EVM_KEY_FILE=keys/evm-graduator.key node server/evm-graduator.mjs
//
// ⛔ Robinhood Chain: a transaction's gas is not what anvil says (Nitro adds L1 gas now and then), so every
// limit is the estimate plus a margin; its fee is the base fee whatever is offered, and the rest is refunded.
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { evmEnv, evmClient, rhc, LAUNCHPAD_ABI, STATES, revertText } from "../lib/evm.mjs";

const log = (...a) => console.log(new Date().toISOString(), ...a);
const PAYOUT_BATCH = BigInt(process.env.EVM_PAYOUT_BATCH || 100);
const HEARTBEAT = process.env.EVM_HEARTBEAT_FILE || null;

/** The key file: the private key on a line of its own; lines starting with # are notes. */
export function readEvmKey(file) {
  const line = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  const k = line && (line.startsWith("0x") ? line : `0x${line}`);
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`no private key in ${file} (a 64-character hex line)`);
  return k;
}

export function createEvmGraduator({ env = evmEnv(), key, timeout = 60_000, client = evmClient(env.rpcUrl, env.chainId, { timeout }), wallet, log: say = log } = {}) {
  if (!env.launchpad) throw new Error("EVM_LAUNCHPAD is not set");
  const account = privateKeyToAccount(key);
  wallet ??= createWalletClient({ account, chain: rhc(env.chainId, env.rpcUrl), transport: http(env.rpcUrl, { fetchOptions: { headers: { "User-Agent": "Mozilla/5.0 Chrome/140.0.0.0", Accept: "application/json" } }, retryCount: 3, timeout }) });
  const pad = env.launchpad;
  const read = (fn, args = []) => client.readContract({ address: pad, abi: LAUNCHPAD_ABI, functionName: fn, args });
  const failing = new Map(); // token → { n, next } back-off after a refusal

  async function send(fn, args) {
    const { request } = await client.simulateContract({ account, address: pad, abi: LAUNCHPAD_ABI, functionName: fn, args });
    const gas = await client.estimateContractGas({ account, address: pad, abi: LAUNCHPAD_ABI, functionName: fn, args });
    const hash = await wallet.writeContract({ ...request, gas: (gas * 13n) / 10n + 50_000n });
    const r = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`${fn} reverted on chain: ${hash}`);
    return hash;
  }

  async function tick() {
    const n = Number(await read("tokenCount"));
    const tokens = await Promise.all(Array.from({ length: n }, (_, i) => read("tokens", [BigInt(i)])));
    const states = await Promise.all(tokens.map((t) => read("launches", [t]).then((l) => STATES[l[0]])));
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i], s = states[i];
      if (s !== "complete" && s !== "graduated") continue;
      const f = failing.get(t);
      if (f && Date.now() < f.next) continue;
      try {
        if (s === "complete") {
          const hash = await send("graduate", [t]);
          const l = await read("launches", [t]);
          say(`graduated ${t} → Pons ${l[10]} (${hash})`);
        }
        // pay out right away, a batch per transaction, until every holder is paid
        for (let k = 0; k < 1_000; k++) {
          const l = await read("launches", [t]);
          if (STATES[l[0]] !== "graduated") break;
          const hash = await send("payout", [t, PAYOUT_BATCH]);
          say(`paid ${t} up to holder ${(await read("launches", [t]))[14]} (${hash})`);
        }
        failing.delete(t);
      } catch (e) {
        const n = (f?.n ?? 0) + 1;
        const why = revertText(e);
        failing.set(t, { n, why, step: s === "complete" ? "graduate" : "payout", next: Date.now() + Math.min(300_000, 5_000 * 2 ** n) });
        say(`⚠ ${s === "complete" ? "graduate" : "payout"} ${t} failed (try ${n}): ${why}`);
      }
    }
    // the watchdog (server/watchdog.mjs) reads this: when the last pass finished, and what keeps failing
    if (HEARTBEAT) {
      const out = { at: Math.floor(Date.now() / 1000), failing: [...failing].map(([token, f]) => ({ token, n: f.n, step: f.step, why: String(f.why).slice(0, 300) })) };
      writeFileSync(`${HEARTBEAT}.tmp`, JSON.stringify(out));
      renameSync(`${HEARTBEAT}.tmp`, HEARTBEAT);
    }
  }
  return { tick, account };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.env.EVM_KEY_FILE || new URL("../keys/evm-graduator.key", import.meta.url).pathname;
  const key = readEvmKey(file);
  const g = createEvmGraduator({ key });
  log(`evm graduator up: ${g.account.address} on ${evmEnv().launchpad}`);
  for (;;) {
    await g.tick().catch((e) => log("tick:", e.shortMessage ?? e.message));
    await new Promise((r) => setTimeout(r, 5_000));
  }
}
