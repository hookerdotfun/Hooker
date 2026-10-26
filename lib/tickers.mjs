// Anti-vamp ticker lock (26 Oct 2026): a ticker launched on Hooker cannot be launched on Hooker again, by ANY wallet (its own
// creator included), for the lock the creator picked at launch: 24 hours, 3 days or 7 days.
//
// One row per launch the API built (or the graduation service found): its ticker's key, who, the lock, when it was built and
// when it landed. A landed row holds the ticker from landed_at for lock_secs. A row that was built but has not landed holds
// it against OTHER wallets for PREPARE_HOLD_SECS, so two wallets preparing the same ticker at once cannot both get it, and an
// abandoned prepare cannot squat it. ⛔ This is Hooker's own rule, enforced by the API and the site, not on chain: a pool made
// straight on a Hooker config with a locked ticker is HIDDEN from the site (it still trades and graduates, nobody's SOL is held).

export const TICKER_LOCKS = Object.freeze({ "24h": 86_400, "3d": 259_200, "7d": 604_800 });
export const DEFAULT_TICKER_LOCK = "24h";
export const PREPARE_HOLD_SECS = 900;

/** The ticker as the lock sees it: NFKC, no invisible characters or spaces, no leading $, upper case. */
export const tickerKey = (s) => String(s ?? "").normalize("NFKC").replace(/[\p{Cf}\p{White_Space}]/gu, "").replace(/^\$+/, "").toUpperCase();

export function ensureTickerTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS tickers (
    mint TEXT PRIMARY KEY, sym TEXT NOT NULL, creator TEXT NOT NULL, lock_secs INTEGER NOT NULL,
    built_at INTEGER NOT NULL, landed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS tickers_sym ON tickers (sym);`);
}

/**
 * What holds this ticker at `nowSec`, or null when it is free: { mint, until, preparing }. `creator` is the wallet asking: its
 * own unlanded prepare does not hold the ticker against itself (a retry), its own LANDED launch does.
 */
export function tickerHold(db, symbol, { creator = null, nowSec = Math.floor(Date.now() / 1000), excludeMint = null } = {}) {
  const sym = tickerKey(symbol);
  if (!sym) return null;
  const rows = db.prepare("SELECT mint, creator, lock_secs, built_at, landed_at FROM tickers WHERE sym = ?").all(sym);
  let best = null;
  for (const r of rows) {
    if (r.mint === excludeMint) continue;
    const until = r.landed_at != null ? r.landed_at + r.lock_secs : r.creator === creator ? 0 : r.built_at + PREPARE_HOLD_SECS;
    if (until > nowSec && (!best || until > best.until)) best = { mint: r.mint, until, preparing: r.landed_at == null };
  }
  return best;
}

/** The API built a launch for this ticker: it holds the ticker from now (see tickerHold). */
export function holdTicker(db, { mint, symbol, creator, lockSecs, nowSec = Math.floor(Date.now() / 1000) }) {
  db.prepare("INSERT OR REPLACE INTO tickers (mint, sym, creator, lock_secs, built_at, landed_at) VALUES (?, ?, ?, ?, ?, NULL)")
    .run(mint, tickerKey(symbol), creator, lockSecs, nowSec);
}

/**
 * A launch landed (registered by the API or found by the graduation service). Starts its lock, and says whether ANOTHER
 * launch already held the ticker when it landed: such a launch is a vamp and is kept off the site. One that never went
 * through the API gets the shortest lock.
 */
export function landTicker(db, { mint, symbol, creator, createdAt }) {
  const sym = tickerKey(symbol);
  if (!sym) return { vamp: false };
  const blocking = db.prepare(`SELECT mint FROM tickers WHERE sym = ? AND mint != ? AND landed_at IS NOT NULL
    AND (landed_at < ? OR (landed_at = ? AND mint < ?)) AND landed_at + lock_secs > ? LIMIT 1`).get(sym, mint, createdAt, createdAt, mint, createdAt);
  // a vamp holds nothing: it cannot stretch the lock it broke past its end
  const own = db.prepare("SELECT 1 FROM tickers WHERE mint = ?").get(mint);
  if (own) db.prepare(`UPDATE tickers SET landed_at = ?, sym = ?${blocking ? ", lock_secs = 0" : ""} WHERE mint = ?`).run(createdAt, sym, mint);
  else db.prepare("INSERT INTO tickers (mint, sym, creator, lock_secs, built_at, landed_at) VALUES (?, ?, ?, ?, ?, ?)").run(mint, sym, creator, blocking ? 0 : TICKER_LOCKS[DEFAULT_TICKER_LOCK], createdAt, createdAt);
  return blocking ? { vamp: true, by: blocking.mint } : { vamp: false };
}

/** A launch's own lock, for its page: { lockSecs, until } (until null while it has not landed). */
export function tickerLockOf(db, mint) {
  const r = db.prepare("SELECT lock_secs, landed_at FROM tickers WHERE mint = ?").get(mint);
  return r ? { lockSecs: r.lock_secs, until: r.landed_at != null ? r.landed_at + r.lock_secs : null } : null;
}
