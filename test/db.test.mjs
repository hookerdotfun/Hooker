import { test } from "node:test";
import assert from "node:assert/strict";
import * as sqlite from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb, takeLock, releaseLock, registerLaunch, activeLaunches, update, getLaunch } from "../lib/db.mjs";

test("only one graduator can hold the ledger", () => {
  const db = openDb(":memory:");
  assert.equal(takeLock(db, "a"), true);
  assert.equal(takeLock(db, "b"), false);           // a is alive
  assert.equal(takeLock(db, "a"), true);            // a renews
  db.prepare("UPDATE lock SET heartbeat = heartbeat - 120").run();
  assert.equal(takeLock(db, "b"), true);            // a went silent: b takes over
  assert.equal(takeLock(db, "a"), false);
  releaseLock(db, "b");                             // b stops cleanly: the next one needs no wait
  assert.equal(takeLock(db, "c"), true);
});

test("registering twice keeps the first record; backoff hides a launch until its time", () => {
  const db = openDb(":memory:");
  const l = { mint: "M", pool: "P", config: "C", creator: "X", name: "n" };
  registerLaunch(db, l);
  update(db, "M", { status: "complete" });
  registerLaunch(db, { ...l, name: "other" });
  assert.equal(getLaunch(db, "M").status, "complete");
  assert.equal(getLaunch(db, "M").name, "n");
  update(db, "M", { next_try: Math.floor(Date.now() / 1000) + 60 });
  assert.equal(activeLaunches(db).length, 0);
  update(db, "M", { status: "done", next_try: 0 });
  assert.equal(activeLaunches(db).length, 0);       // done launches are never revisited
});

test("a ledger from before pushes.attempts existed gets the column on open", () => {
  const { DatabaseSync } = sqlite;
  const f = `${mkdtempSync(`${tmpdir()}/hooker-db-`)}/old.db`;
  const raw = new DatabaseSync(f);
  raw.exec("CREATE TABLE launches (mint TEXT PRIMARY KEY, pool TEXT, config TEXT, creator TEXT, name TEXT, symbol TEXT, uri TEXT, grad_sol REAL, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'trading', updated_at INTEGER, next_try INTEGER NOT NULL DEFAULT 0, error TEXT); CREATE TABLE pushes (mint TEXT, owner TEXT, amount TEXT, status TEXT NOT NULL DEFAULT 'pending', sig TEXT, valid_height INTEGER, PRIMARY KEY (mint, owner)); INSERT INTO pushes (mint, owner, amount) VALUES ('m', 'o', '1')");
  raw.close();
  const db = openDb(f);
  const row = db.prepare("SELECT attempts FROM pushes WHERE mint = 'm'").get();
  assert.equal(row.attempts, 0);
});
