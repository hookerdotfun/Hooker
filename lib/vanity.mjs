// The pool of mint keypairs whose address ends in `hook`. Every Hooker token uses two: one for the
// window token on Meteora (handed to the creator's launch) and one for the pump.fun coin it becomes
// (taken by the graduation service, never shown to anyone before that launch lands).
//
// Finding one takes ~11M tries on average (58^4, case-sensitive): about a minute on a laptop with
// tools/grind. A launch cannot wait for that, so a grinder keeps the pool stocked ahead of time.
//
// ⛔⛔ A key is ISSUED ONCE. Once a mint address has left this server (in a launch transaction the
// creator may never sign), anyone who saw it can pre-create the pump.fun coin's accounts at it and
// make pump.fun's create fail for that address forever. So an issued key is never handed to anyone
// else, whether or not the launch landed. (Ported from ~/dotspad/lib/vanity.mjs, live there.)
import { Keypair } from "@solana/web3.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

export const SUFFIX = "hook";
/** Fresh keys held back for graduations: a launch is refused rather than leave a graduation keyless. */
export const GRADUATION_RESERVE = Number(process.env.VANITY_GRADUATION_RESERVE ?? 5);
/** A creator who prepares again within this window gets the SAME key back: retries cannot drain the pool. */
export const RESERVATION_SECS = 15 * 60;

const now = () => Math.floor(Date.now() / 1000);

export function initVanity(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS vanity (
    pubkey TEXT PRIMARY KEY,
    secret TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'fresh',   -- fresh | issued | graduation
    holder TEXT,                           -- creator wallet (issued) or window mint (graduation)
    ip TEXT,
    issued_at INTEGER,
    created_at INTEGER NOT NULL
  )`);
}

export function addKey(db, keypair) {
  const pk = keypair.publicKey.toBase58();
  if (!pk.endsWith(SUFFIX)) throw new Error(`not a ${SUFFIX} key: ${pk}`);
  db.prepare("INSERT OR IGNORE INTO vanity (pubkey, secret, created_at) VALUES (?, ?, ?)").run(pk, Buffer.from(keypair.secretKey).toString("base64"), now());
}

export const freshCount = (db) => db.prepare("SELECT COUNT(*) n FROM vanity WHERE state = 'fresh'").get().n;
const toKeypair = (secret) => Keypair.fromSecretKey(Buffer.from(secret, "base64"));

/**
 * One key for a creator's launch. The same creator preparing again within RESERVATION_SECS gets the
 * same key back. Returns null when only the graduation reserve is left.
 */
export function issueForLaunch(db, creator, ip = null, reserve = GRADUATION_RESERVE) {
  reserve ??= GRADUATION_RESERVE;
  const mine = db.prepare("SELECT secret FROM vanity WHERE state = 'issued' AND holder = ? AND issued_at > ? ORDER BY issued_at DESC LIMIT 1").get(creator, now() - RESERVATION_SECS);
  if (mine) return toKeypair(mine.secret);
  if (freshCount(db) <= reserve) return null;
  const row = db.prepare(`UPDATE vanity SET state = 'issued', holder = ?, ip = ?, issued_at = ?
    WHERE pubkey = (SELECT pubkey FROM vanity WHERE state = 'fresh' ORDER BY created_at LIMIT 1) RETURNING secret`).get(creator, ip, now());
  return row ? toKeypair(row.secret) : null;
}

/** Keys issued to one IP since `sinceSecs`: what the per-IP launch limit counts. */
export const issuedToIpSince = (db, ip, sinceSecs) => db.prepare("SELECT COUNT(*) n FROM vanity WHERE ip = ? AND issued_at > ?").get(ip, sinceSecs).n;

/**
 * The pump.fun coin's key for one graduation. Idempotent: the same window mint always gets the same
 * key, so a retry after a crash never burns a second one. Returns null when the pool is empty.
 */
export function takeForGraduation(db, windowMint) {
  const mine = db.prepare("SELECT secret FROM vanity WHERE state = 'graduation' AND holder = ?").get(windowMint);
  if (mine) return toKeypair(mine.secret);
  const row = db.prepare(`UPDATE vanity SET state = 'graduation', holder = ?, issued_at = ?
    WHERE pubkey = (SELECT pubkey FROM vanity WHERE state = 'fresh' ORDER BY created_at LIMIT 1) RETURNING secret`).get(windowMint, now());
  return row ? toKeypair(row.secret) : null;
}

/** Imports every `…hook.json` keypair file in `dir` (from the grinder or a push), then deletes it. */
export function importIncoming(db, dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(`${SUFFIX}.json`)) continue;
    const p = path.join(dir, f);
    // a file still being written does not parse yet: leave it for the next pass
    try { addKey(db, Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))))); } catch { continue; }
    try { rmSync(p); } catch {} // another process imported it first
    n++;
  }
  return n;
}

export const incomingDir = (dataDir) => { const d = path.join(dataDir, "vanity-incoming"); mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
