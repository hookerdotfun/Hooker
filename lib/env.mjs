// Every setting the services read, in one place. Defaults are for the local validator.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync, existsSync } from "node:fs";
import { pacedOptions, rpsFromEnv } from "./rpc-pace.mjs";

const pk = (v, fallback) => new PublicKey(v || fallback);

export const env = {
  rpcUrl: process.env.RPC_URL || "http://127.0.0.1:8997",
  /** requests per second this process may send (0 = unpaced, for the local validator) */
  rpcRps: rpsFromEnv(0),
  hookProgram: pk(process.env.HOOK_PROGRAM, "GE5TW1AFehhNFLYiSiaAkmbTjnHTB3hdhw6ZZFBP5sLV"),
  /** FOMO's server key: it pays for and co-signs every FOMO trade (AgmLJ…zN51) */
  fomoCosigner: pk(process.env.FOMO_COSIGNER, "AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51"),
  /** the Pump app's program. ⛔ It cannot trade hooked curves yet, so app-only stays off by default */
  pumpAppProgram: pk(process.env.PUMP_APP_PROGRAM, "6Vo3245eszAb5wuqEMw8mGdbfRUdKbHhDHP5LcaGuTAB"),
  appOnlyEnabled: process.env.APP_ONLY_ENABLED === "1",
  /** FOMO-only stays off until a real FOMO buy on one of OUR tokens has proven the co-signer check */
  fomoOnlyEnabled: process.env.FOMO_ONLY_ENABLED === "1",
  dataDir: process.env.DATA_DIR || new URL("../data/", import.meta.url).pathname,
  platformKeyPath: process.env.PLATFORM_KEY || new URL("../keys/platform.json", import.meta.url).pathname,
  treasury: process.env.TREASURY ? new PublicKey(process.env.TREASURY) : null,
  apiPort: Number(process.env.PORT || 5310),
  /** the hot wallet this deployment must run as; a different key file is refused at start */
  expectedPlatform: process.env.EXPECTED_PLATFORM ? new PublicKey(process.env.EXPECTED_PLATFORM) : null,
  /** where pump.fun-compatible metadata uploads go (pump.fun's own IPFS route) */
  ipfsUpstream: process.env.IPFS_UPSTREAM || "https://pump.fun/api/ipfs",
};

export const connect = (url = env.rpcUrl, rps = env.rpcRps) =>
  new Connection(url, pacedOptions(rps, { commitment: "confirmed", disableRetryOnRateLimit: false }));

export function loadKeypair(path) {
  if (!existsSync(path)) throw new Error(`keypair file missing: ${path}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

/** data/configs.json: graduation size (SOL) → DBC config address, written by scripts/create-configs.mjs */
export function loadConfigs(dir = env.dataDir, { optional = false } = {}) {
  const p = `${dir}/configs.json`;
  if (!existsSync(p)) {
    if (optional) return {};
    throw new Error(`no ${p}: run scripts/create-configs.mjs first`);
  }
  const j = JSON.parse(readFileSync(p, "utf8"));
  return Object.fromEntries(Object.entries(j.configs ?? {}).map(([g, c]) => [g, new PublicKey(c)]));
}
