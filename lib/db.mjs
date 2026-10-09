// The graduation ledger. node:sqlite, one file, written before every action that moves value so a
// restart always knows what was already sent.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const STATUSES = ["trading", "complete", "fee_withdrawn", "fees_claimed", "indexed", "launched", "settled", "burned", "pushed", "migrated", "done"];

export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 10000;
    CREATE TABLE IF NOT EXISTS launches (
      mint TEXT PRIMARY KEY, pool TEXT NOT NULL, config TEXT NOT NULL, creator TEXT NOT NULL,
      name TEXT, symbol TEXT, uri TEXT, grad_sol REAL,
      created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'trading',
      error TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0,
      migration_fee TEXT, fees_claimed TEXT, grad_sig TEXT, grad_slot INTEGER, events_json TEXT, recipients INTEGER,
      pump_mint TEXT, pump_mint_secret TEXT, pump_spend TEXT, pump_bought TEXT, pump_pot TEXT,
      burn TEXT, treasury_amt TEXT, settle_json TEXT, updated_at INTEGER,
      index_cache_json TEXT, index_cache_sig TEXT, stalled_from TEXT, surplus_burned TEXT
    );
    CREATE TABLE IF NOT EXISTS pending (
      mint TEXT NOT NULL, step TEXT NOT NULL, sig TEXT NOT NULL, valid_height INTEGER NOT NULL,
      PRIMARY KEY (mint, step)
    );
    CREATE TABLE IF NOT EXISTS pushes (
      mint TEXT NOT NULL, owner TEXT NOT NULL, amount TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', sig TEXT, valid_height INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (mint, owner)
    );
    CREATE TABLE IF NOT EXISTS lock (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT, heartbeat INTEGER);
    -- what a creator chose for graduation (custom pair + pump.fun creator fee), written by the API when it
    -- builds the launch (the same choice is in the launch tx's memo), copied onto the launch at registration
    CREATE TABLE IF NOT EXISTS launch_intents (mint TEXT PRIMARY KEY, pair_mint TEXT, pair_cfee INTEGER, created_at INTEGER NOT NULL);
    -- the burn ledger (lib/flywheel.mjs): every claim of the burn wallet's creator fees and every buy-and-burn of $HOOKER
    CREATE TABLE IF NOT EXISTS burns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, sig TEXT, dry INTEGER NOT NULL DEFAULT 0,
      lamports_in TEXT, lamports_spent TEXT, hooker_burned TEXT, note TEXT
    );
  `);
  // columns added after the first ledgers were written
  const have = new Set(db.prepare("PRAGMA table_info(launches)").all().map((c) => c.name));
  // pair_*: the custom pair (lib/pairs.mjs). pair_state: null (none chosen) → "chosen" → "swapped" | "fallback"
  for (const [col, type] of [["index_cache_json", "TEXT"], ["index_cache_sig", "TEXT"], ["stalled_from", "TEXT"], ["surplus_burned", "TEXT"], ["pump_topup", "TEXT"], ["held_total", "TEXT"],
    ["pair_mint", "TEXT"], ["pair_cfee", "INTEGER"], ["pair_state", "TEXT"], ["pair_note", "TEXT"], ["pair_before", "TEXT"], ["pair_amount", "TEXT"], ["pair_program", "TEXT"],
    ["pair_sig", "TEXT"], ["pair_valid", "INTEGER"], ["fee_to", "TEXT"],
    // custom caps (10 Oct 2026): no_migration = the curve never fills; pump_extra = SOL of the raise past what fills pump.fun's
    // whole curve, spent on PumpSwap once the coin is there; pump_curve_bought = the coins the create+buy itself delivered
    ["no_migration", "INTEGER"], ["cap_sol", "REAL"], ["pump_extra", "TEXT"], ["pump_curve_bought", "TEXT"]])
    if (!have.has(col)) db.exec(`ALTER TABLE launches ADD COLUMN ${col} ${type}`);
  // ⛔ 4 Oct 2026: the box's pushes table predated `attempts`; without it the push step filtered every
  // wallet out and a graduation sat at `burned` in silence. Every table's late columns are added here.
  const havePush = new Set(db.prepare("PRAGMA table_info(pushes)").all().map((c) => c.name));
  for (const [col, type] of [["attempts", "INTEGER NOT NULL DEFAULT 0"]])
    if (!havePush.has(col)) db.exec(`ALTER TABLE pushes ADD COLUMN ${col} ${type}`);
  return db;
}

export const now = () => Math.floor(Date.now() / 1000);

export function registerLaunch(db, l) {
  // a pair chosen when the API built this launch rides along (launch_intents)
  const intent = db.prepare("SELECT pair_mint, pair_cfee FROM launch_intents WHERE mint = ?").get(l.mint);
  // its …hook key is spent now (lib/vanity.mjs markLaunched); a ledger without the vanity table has nothing to retire
  try { db.prepare("UPDATE vanity SET state = 'launched' WHERE pubkey = ? AND state = 'issued'").run(l.mint); } catch {}
  db.prepare(`INSERT OR IGNORE INTO launches (mint, pool, config, creator, name, symbol, uri, grad_sol, created_at, updated_at, pair_mint, pair_cfee, pair_state, no_migration, cap_sol)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(l.mint, l.pool, l.config, l.creator, l.name ?? null, l.symbol ?? null, l.uri ?? null, l.gradSol ?? null, l.createdAt ?? now(), now(),
      intent?.pair_mint ?? null, intent?.pair_mint ? intent.pair_cfee ?? 0 : null, intent?.pair_mint ? "chosen" : null, l.noMigration ? 1 : 0, l.capSol ?? null);
}

/** The API's record of a launch it built with a custom pair. Overwrites (a creator may rebuild before signing). */
export const recordIntent = (db, mint, pairMint, cfee) =>
  db.prepare("INSERT OR REPLACE INTO launch_intents (mint, pair_mint, pair_cfee, created_at) VALUES (?, ?, ?, ?)").run(mint, pairMint, cfee ?? 0, now());

export const getLaunch = (db, mint) => db.prepare("SELECT * FROM launches WHERE mint = ?").get(mint);
export const listLaunches = (db, { limit = 100 } = {}) => db.prepare("SELECT * FROM launches ORDER BY created_at DESC LIMIT ?").all(limit);
export const activeLaunches = (db) => db.prepare("SELECT * FROM launches WHERE status NOT IN ('done', 'stalled') AND next_try <= ? ORDER BY created_at").all(now());

export function update(db, mint, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE launches SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE mint = ?`)
    .run(...keys.map((k) => fields[k]), now(), mint);
}

export const getPending = (db, mint, step) => db.prepare("SELECT * FROM pending WHERE mint = ? AND step = ?").get(mint, step);
export const setPending = (db, mint, step, sig, h) => db.prepare("INSERT OR REPLACE INTO pending (mint, step, sig, valid_height) VALUES (?, ?, ?, ?)").run(mint, step, sig, h);
export const clearPending = (db, mint, step) => db.prepare("DELETE FROM pending WHERE mint = ? AND step = ?").run(mint, step);

/** A stopping graduator hands the lock back, so its replacement starts at once instead of waiting out the heartbeat. */
export const releaseLock = (db, holder) => db.prepare("DELETE FROM lock WHERE id = 1 AND holder = ?").run(holder);

/** Single-instance guard: two graduators on one ledger could each send the same push. */
export function takeLock(db, holder, staleSecs = 60) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM lock WHERE id = 1").get();
    if (row && row.holder !== holder && now() - row.heartbeat < staleSecs) { db.exec("ROLLBACK"); return false; }
    db.prepare("INSERT OR REPLACE INTO lock (id, holder, heartbeat) VALUES (1, ?, ?)").run(holder, now());
    db.exec("COMMIT");
    return true;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
