// King of the Hill payouts. The hook (programs/hooker-hook/src/v3.rs) only keeps score: who holds the
// crown, and the value in SOL traded during each reign, in a ring of the last 32 reigns in the token's
// ["state", mint] account. A hook cannot move SOL, so this keeper pays each King KING_BPS of the value
// traded during their reign, from the hot wallet: Hooker's half of the trading fees (0.4% of volume;
// operator's choice, 6 Oct 2026). At graduation the token's King payouts are taken out of that half
// before the holder top-up (lib/graduate.mjs `feesAfterKings`).
//
// ⛔ Exactly once: the reign's value is copied into the ledger (it only ever grows), and every payout's
// signature and amount are written BEFORE it is sent; a restart reads its fate before paying again.
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { decodeRules, decodeState, hookPdas, KING_BPS } from "./rules.mjs";
import { asLegacy, fateOf, sendRemembered } from "./chain.mjs";

/** The smallest payout sent (above Solana's rent floor, so it can land in an empty wallet). */
export const MIN_KING_PAYOUT = 1_000_000n;

export function initKings(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS king_reigns (
    mint TEXT NOT NULL, reign INTEGER NOT NULL, king TEXT NOT NULL, value TEXT NOT NULL, ended INTEGER NOT NULL DEFAULT 0,
    paid TEXT NOT NULL DEFAULT '0', pend_sig TEXT, pend_valid INTEGER, pend_amount TEXT, updated_at INTEGER,
    PRIMARY KEY (mint, reign))`);
}

export const owedFor = (value) => (BigInt(value) * BigInt(KING_BPS)) / 10_000n;
const now = () => Math.floor(Date.now() / 1000);

/** What the token's Kings are owed in total, paid or not: taken out of Hooker's half at graduation. */
export function kingOwedTotal(db, mint) {
  return db.prepare("SELECT value FROM king_reigns WHERE mint = ?").all(mint).reduce((a, r) => a + owedFor(r.value), 0n);
}
export const kingReigns = (db, mint) => db.prepare("SELECT * FROM king_reigns WHERE mint = ? ORDER BY reign DESC").all(mint);

/**
 * Copies every reign in the state accounts of `mints` into the ledger. `isKing(mint)` caches whether a
 * token plays (its rules never change). One batched read per 100 tokens.
 */
export async function syncKings({ conn, db, hookProgram, mints, log = () => {} }) {
  const up = db.prepare(`INSERT INTO king_reigns (mint, reign, king, value, ended, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (mint, reign) DO UPDATE SET value = CASE WHEN CAST(excluded.value AS INTEGER) > CAST(value AS INTEGER) THEN excluded.value ELSE value END,
    ended = MAX(ended, excluded.ended), updated_at = excluded.updated_at`);
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(chunk.map((m) => hookPdas(hookProgram, m).state), "confirmed");
    for (const [j, info] of infos.entries()) {
      const st = info?.owner.equals(new PublicKey(hookProgram)) ? decodeState(info.data) : null;
      if (!st) continue;
      const known = db.prepare("SELECT MAX(reign) AS r FROM king_reigns WHERE mint = ?").get(chunk[j])?.r ?? 0;
      const oldest = st.reigns.length ? Math.min(...st.reigns.map((r) => r.reign)) : 0;
      if (oldest > known + 1) log(`⚠ ${chunk[j]}: reigns ${known + 1}..${oldest - 1} fell out of the ring before they were read; their Kings are not paid`);
      for (const r of st.reigns) up.run(chunk[j], r.reign, r.king ?? "", r.valueLamports.toString(), r.ended ? 1 : 0, now());
    }
  }
}

/** Pays every King what they are owed and not yet paid, from `platform` (the hot wallet). */
export async function payKings({ conn, db, platform, min = MIN_KING_PAYOUT, log = () => {} }) {
  let sent = 0n;
  for (const r of db.prepare("SELECT * FROM king_reigns WHERE king != ''").all()) {
    let paid = BigInt(r.paid);
    if (r.pend_sig) {
      const fate = await fateOf(conn, r.pend_sig, r.pend_valid);
      if (fate === "unknown") continue;
      if (fate === "ok") paid += BigInt(r.pend_amount);
      db.prepare("UPDATE king_reigns SET paid = ?, pend_sig = NULL, pend_valid = NULL, pend_amount = NULL WHERE mint = ? AND reign = ?").run(paid.toString(), r.mint, r.reign);
    }
    const due = owedFor(r.value) - paid;
    if (due < min) continue;
    const tx = asLegacy([SystemProgram.transfer({ fromPubkey: platform.publicKey, toPubkey: new PublicKey(r.king), lamports: due })], platform.publicKey);
    try {
      const sig = await sendRemembered(conn, tx, [platform], (sig, h) =>
        db.prepare("UPDATE king_reigns SET pend_sig = ?, pend_valid = ?, pend_amount = ? WHERE mint = ? AND reign = ?").run(sig, h, due.toString(), r.mint, r.reign));
      db.prepare("UPDATE king_reigns SET paid = ?, pend_sig = NULL, pend_valid = NULL, pend_amount = NULL WHERE mint = ? AND reign = ?").run((paid + due).toString(), r.mint, r.reign);
      sent += due;
      log(`👑 paid King ${r.king.slice(0, 8)}… of ${r.mint.slice(0, 8)}… (reign ${r.reign}) ${Number(due) / 1e9} SOL (${sig})`);
    } catch (e) {
      // only a refused simulation (or a landed failure) proves nothing was paid: anything else waits for fateOf
      if (e.preflight || e.landedFailed) db.prepare("UPDATE king_reigns SET pend_sig = NULL, pend_valid = NULL, pend_amount = NULL WHERE mint = ? AND reign = ?").run(r.mint, r.reign);
      log(`⚠ King payout for ${r.mint.slice(0, 8)}… reign ${r.reign} failed: ${e.message}`);
    }
  }
  return sent;
}

/** Which of `mints` play King of the Hill (rules are immutable, so the answer is cached for good). */
export function kingFilter({ conn, hookProgram }) {
  const cache = new Map();
  return async (mints) => {
    const todo = mints.filter((m) => !cache.has(m));
    for (let i = 0; i < todo.length; i += 100) {
      const chunk = todo.slice(i, i + 100);
      const infos = await conn.getMultipleAccountsInfo(chunk.map((m) => hookPdas(hookProgram, m).cfg), "confirmed");
      infos.forEach((a, j) => { if (a) { try { cache.set(chunk[j], decodeRules(a.data).kingOn); } catch { cache.set(chunk[j], false); } } });
    }
    return mints.filter((m) => cache.get(m));
  };
}
