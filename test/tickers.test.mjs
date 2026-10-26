import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, registerLaunch, getLaunch } from "../lib/db.mjs";
import { tickerKey, tickerHold, holdTicker, tickerLockOf, TICKER_LOCKS, PREPARE_HOLD_SECS } from "../lib/tickers.mjs";

const A = "CreatorA1111111111111111111111111111111111", B = "CreatorB1111111111111111111111111111111111";
const reg = (db, mint, symbol, creator, createdAt) => registerLaunch(db, { mint, pool: `pool-${mint}`, config: "cfg", creator, name: symbol, symbol, uri: "u", gradSol: 85, createdAt });

test("the key ignores case, a leading $, spaces and invisible characters", () => {
  assert.equal(tickerKey("hooker"), "HOOKER");
  assert.equal(tickerKey("$Hooker"), "HOOKER");
  assert.equal(tickerKey("HOO KER"), "HOOKER");
  assert.equal(tickerKey("HOO​KER"), "HOOKER"); // zero-width space
  assert.equal(tickerKey("ＨＯＯＫＥＲ"), "HOOKER"); // full-width letters (NFKC)
  assert.equal(tickerKey(" ​ "), "");
});

test("a landed launch locks its ticker for everyone, its own creator too, for the lock it picked", () => {
  const db = openDb(":memory:"), t0 = 1_800_000_000;
  holdTicker(db, { mint: "m1", symbol: "CAT", creator: A, lockSecs: TICKER_LOCKS["3d"], nowSec: t0 });
  reg(db, "m1", "CAT", A, t0 + 10);
  assert.equal(tickerHold(db, "cat", { creator: B, nowSec: t0 + 86_400 * 2 }).until, t0 + 10 + 259_200);
  assert.ok(tickerHold(db, "$CAT", { creator: A, nowSec: t0 + 100 }), "the creator cannot relaunch it either");
  assert.equal(tickerHold(db, "CAT", { creator: B, nowSec: t0 + 10 + 259_200 }), null, "free once the lock ends");
  assert.deepEqual(tickerLockOf(db, "m1"), { lockSecs: 259_200, until: t0 + 10 + 259_200 });
});

test("a prepared launch holds the ticker against OTHER wallets for 15 minutes only; a retry by the same wallet passes", () => {
  const db = openDb(":memory:"), t0 = 1_800_000_000;
  holdTicker(db, { mint: "m1", symbol: "DOG", creator: A, lockSecs: 86_400, nowSec: t0 });
  assert.ok(tickerHold(db, "DOG", { creator: B, nowSec: t0 + 60 }).preparing);
  assert.equal(tickerHold(db, "DOG", { creator: A, nowSec: t0 + 60 }), null);
  assert.equal(tickerHold(db, "DOG", { creator: B, nowSec: t0 + PREPARE_HOLD_SECS }), null, "an abandoned prepare cannot squat it");
});

test("a pool that landed inside another launch's lock is hidden (a vamp); one after the lock is not", () => {
  const db = openDb(":memory:"), t0 = 1_800_000_000;
  holdTicker(db, { mint: "m1", symbol: "FISH", creator: A, lockSecs: 86_400, nowSec: t0 });
  reg(db, "m1", "FISH", A, t0);
  reg(db, "m2", "fish", B, t0 + 3_600); // never went through the API: made straight on a Hooker config
  assert.equal(getLaunch(db, "m2").hidden, 1);
  assert.ok(!getLaunch(db, "m1").hidden);
  assert.equal(tickerLockOf(db, "m2").lockSecs, 0, "a vamp holds no lock of its own");
  reg(db, "m4", "BIRD", B, t0);
  assert.equal(tickerLockOf(db, "m4").lockSecs, TICKER_LOCKS["24h"], "a launch with no recorded choice gets the shortest lock");
  reg(db, "m3", "FISH", B, t0 + 86_400 + 1);
  assert.ok(!getLaunch(db, "m3").hidden, "the first lock had ended");
  reg(db, "m1", "FISH", A, t0 + 999_999); // registered again (the API and the graduator both find a launch): nothing moves
  assert.equal(tickerLockOf(db, "m1").until, t0 + 86_400);
});
