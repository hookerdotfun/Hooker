// Custom graduation caps (10 Oct 2026): a launch that graduates at the market cap its creator picked, or never.
//
// The fixed sizes share configs the graduator made once (lib/configs.mjs). A custom cap is a config of its OWN,
// made for one launch: the API builds it (lib/curve.mjs customCapCurve / noMigrationCurve), signs it with a fresh
// config key it then forgets, and the creator's wallet pays its rent and sends it right before the launch. Its
// fee claimer and leftover receiver are the platform, exactly like the shared ones, so graduation works the same.
//
// ⛔ A config's signature covers its whole message: nobody can send our config key with other numbers. Even so
// the graduator reads every custom config back from chain before it trusts it (`checkCustomConfig`).
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { customCapCurve, noMigrationCurve, configRest, ECONOMICS, FEE_TIERS, NO_MIGRATION_THRESHOLD } from "./curve.mjs";
import { feeIsFlat } from "./configs.mjs";
import { now } from "./db.mjs";

export function ensureCustomTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS custom_configs (
    address TEXT PRIMARY KEY, mint TEXT NOT NULL, creator TEXT NOT NULL,
    kind TEXT NOT NULL,            -- 'cap' (graduates at cap_sol) | 'none' (never migrates)
    cap_sol REAL, grad_sol REAL,   -- market cap and SOL raised at graduation; null for 'none'
    anti_snipe INTEGER NOT NULL, tier INTEGER NOT NULL, threshold TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS custom_configs_mint ON custom_configs (mint)");
}

/** The curve for a choice: { kind: "cap", capSol } or { kind: "none" }. */
export function curveFor(choice, p, { antiSnipe = false, tier = 0 } = {}) {
  const rest = configRest({ antiSnipe, tier });
  return choice.kind === "none" ? noMigrationCurve(p, rest) : customCapCurve(choice.capSol, p, rest);
}

/**
 * Builds the config transaction for one launch and records it. `platform` is the fee claimer (the hot wallet's
 * public key), `payer` the creator. Returns { tx (legacy, signed by the config key), config, curve }.
 */
export async function issueCustomConfig({ db, dbc, p, platform, hookProgram, creator, mint, choice, antiSnipe = false, tier = 0 }) {
  ensureCustomTable(db);
  const curve = curveFor(choice, p, { antiSnipe, tier });
  const kp = Keypair.generate();
  const tx = await dbc.partner.createConfigWithTransferHook({
    ...curve.params, config: kp.publicKey, feeClaimer: platform, leftoverReceiver: platform,
    quoteMint: NATIVE_MINT, payer: new PublicKey(creator), transferHookProgram: hookProgram,
  });
  db.prepare(`INSERT INTO custom_configs (address, mint, creator, kind, cap_sol, grad_sol, anti_snipe, tier, threshold, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(kp.publicKey.toBase58(), String(mint), String(creator), choice.kind, choice.kind === "cap" ? curve.endCap : null, curve.raiseSol,
      antiSnipe ? 1 : 0, tier, curve.params.migrationQuoteThreshold.toString(), now());
  return { tx, config: kp.publicKey, configKey: kp, curve };
}

/** What a custom config's pools need to know: the same shape as configs.json's `all` entries. */
const entry = (r) => ({ sizeSol: r.grad_sol, retired: false, antiSnipe: !!r.anti_snipe, tier: r.tier, custom: r.kind, capSol: r.cap_sol, noMigration: r.kind === "none" });

export function customConfig(db, address) {
  ensureCustomTable(db);
  const r = db.prepare("SELECT * FROM custom_configs WHERE address = ?").get(String(address));
  return r ? { ...r, ...entry(r) } : null;
}

/** The custom configs issued for a mint (a creator may build a launch more than once before signing). */
export function customConfigsForMint(db, mint) {
  ensureCustomTable(db);
  return db.prepare("SELECT * FROM custom_configs WHERE mint = ? ORDER BY created_at DESC").all(String(mint)).map((r) => ({ ...r, ...entry(r) }));
}

/** Pools that may exist on custom configs and are not in the ledger yet: each custom config is for ONE mint, so
 *  its pool address is known without scanning the program (Meteora's pool PDA = quote, mint, config). */
export function customPoolCandidates(db, { since = 0 } = {}) {
  ensureCustomTable(db);
  return db.prepare(`SELECT c.* FROM custom_configs c LEFT JOIN launches l ON l.mint = c.mint WHERE l.mint IS NULL AND c.created_at >= ?`).all(since)
    .map((r) => ({ ...r, ...entry(r), pool: deriveDbcPoolAddress(NATIVE_MINT, new PublicKey(r.mint), new PublicKey(r.address)) }));
}

/** Why a custom config on chain is not the one we issued, or null. `c` is the decoded config account. */
export function checkCustomConfig(c, row, platform) {
  if (!c) return "the config is not on chain";
  if (!c.feeClaimer.equals(new PublicKey(platform)) || !c.leftoverReceiver.equals(new PublicKey(platform))) return "the config pays someone else";
  if (c.migrationFeePercentage !== ECONOMICS.migrationFeePct) return "the config's migration fee is not ours";
  const wantPct = row.tier === 0 ? ECONOMICS.creatorTradingFeePct : FEE_TIERS[row.tier]?.creatorPct;
  if (c.creatorTradingFeePercentage !== wantPct) return "the config's fee split is not ours";
  if (c.migrationQuoteThreshold.toString() !== row.threshold) return "the config's graduation is not the one issued";
  if (feeIsFlat(c) === !!row.anti_snipe) return "the config's anti-snipe fee is not the one issued";
  if (row.kind === "none" && BigInt(row.threshold) !== NO_MIGRATION_THRESHOLD) return "a no-migration config must never fill";
  return null;
}
