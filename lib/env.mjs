// Every setting the services read, in one place. Defaults are for the local validator.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync, existsSync } from "node:fs";
import { pacedOptions, rpsFromEnv } from "./rpc-pace.mjs";

const pk = (v, fallback) => new PublicKey(v || fallback);

export const env = {
  rpcUrl: process.env.RPC_URL || "http://127.0.0.1:8997",
  /** requests per second this process may send (0 = unpaced, for the local validator) */
  rpcRps: rpsFromEnv(0),
  hookProgram: pk(process.env.HOOK_PROGRAM, "5HFXZY3eJKvdy2EVJjB5kBkVYq7dfLPDvycroueUrst9"),
  /** FOMO's server key: it pays for and co-signs every FOMO trade (AgmLJ…zN51) */
  fomoCosigner: pk(process.env.FOMO_COSIGNER, "AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51"),
  /** the Pump app's program. ⛔ It cannot trade hooked curves yet, so app-only stays off by default */
  pumpAppProgram: pk(process.env.PUMP_APP_PROGRAM, "6Vo3245eszAb5wuqEMw8mGdbfRUdKbHhDHP5LcaGuTAB"),
  appOnlyEnabled: process.env.APP_ONLY_ENABLED === "1",
  /** FOMO-only stays off until a real FOMO buy on one of OUR tokens has proven the co-signer check */
  fomoOnlyEnabled: process.env.FOMO_ONLY_ENABLED === "1",
  // the v3 hook rules (src/v3.rs): ON only once the upgraded hook is live on this chain, or every such launch fails
  v3Rules: process.env.V3_RULES === "1",
  dataDir: process.env.DATA_DIR || new URL("../data/", import.meta.url).pathname,
  platformKeyPath: process.env.PLATFORM_KEY || new URL("../keys/platform.json", import.meta.url).pathname,
  treasury: process.env.TREASURY ? new PublicKey(process.env.TREASURY) : null,
  /** the burn wallet: named as creator of every graduated coin, so their creator fees buy and burn $HOOKER (lib/flywheel.mjs) */
  burnWallet: process.env.BURN_WALLET ? new PublicKey(process.env.BURN_WALLET) : null,
  burnKeyPath: process.env.BURN_KEY || new URL("../keys/burn.json", import.meta.url).pathname,
  /** the coin the burns are for, when there is one (none since 25 Oct 2026: no BURN_WALLET, graduated coins name their creator) */
  hookerMint: process.env.HOOKER_MINT ? new PublicKey(process.env.HOOKER_MINT) : null,
  /** FLYWHEEL_DRY=1: the keeper builds and simulates every claim and burn but sends nothing */
  flywheelDry: process.env.FLYWHEEL_DRY === "1",
  apiPort: Number(process.env.PORT || 5310),
  /** the hot wallet this deployment must run as; a different key file is refused at start */
  expectedPlatform: process.env.EXPECTED_PLATFORM ? new PublicKey(process.env.EXPECTED_PLATFORM) : null,
  /** where pump.fun-compatible metadata uploads go (pump.fun's own IPFS route) */
  ipfsUpstream: process.env.IPFS_UPSTREAM || "https://pump.fun/api/ipfs",
  /** our own Pinata key: when set, uploads are pinned here instead (pump.fun closed its open uploader 19 Oct 2026) */
  pinataJwt: process.env.PINATA_JWT || "",
  pinataUploads: process.env.PINATA_UPLOADS || "https://uploads.pinata.cloud",
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
