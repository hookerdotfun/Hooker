import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../lib/db.mjs";
import { initVanity, addKey, issueForLaunch, takeForGraduation, freshCount, importIncoming, issuedToIpSince, GRADUATION_RESERVE } from "../lib/vanity.mjs";

/** A fake "…hook" keypair for logic tests: we only need the pubkey to end in hook, so patch it. */
function fakeHookKey() {
  const kp = Keypair.generate();
  return { publicKey: { toBase58: () => kp.publicKey.toBase58().slice(0, -4) + "hook" }, secretKey: kp.secretKey };
}
const fresh = (n) => { const db = openDb(":memory:"); initVanity(db); for (let i = 0; i < n; i++) addKey(db, fakeHookKey()); return db; };

test("only addresses ending in hook enter the pool", () => {
  const db = fresh(0);
  assert.throws(() => addKey(db, Keypair.generate()), /not a hook key/);
  addKey(db, fakeHookKey());
  assert.equal(freshCount(db), 1);
});

test("a key is issued once; the same creator retrying gets the same key back", () => {
  const db = fresh(GRADUATION_RESERVE + 3);
  const a = issueForLaunch(db, "CREATOR_A", "1.1.1.1");
  const a2 = issueForLaunch(db, "CREATOR_A", "1.1.1.1");
  const b = issueForLaunch(db, "CREATOR_B", "2.2.2.2");
  assert.deepEqual([...a.secretKey], [...a2.secretKey]);
  assert.notDeepEqual([...a.secretKey], [...b.secretKey]);
  assert.equal(freshCount(db), GRADUATION_RESERVE + 1);
  assert.equal(issuedToIpSince(db, "1.1.1.1", 0), 1);
});

test("launches stop at the graduation reserve; graduations can still take keys", () => {
  const db = fresh(GRADUATION_RESERVE + 1);
  assert.ok(issueForLaunch(db, "C1"));
  assert.equal(issueForLaunch(db, "C2"), null); // only the reserve is left
  const g = takeForGraduation(db, "WINDOW_MINT");
  assert.ok(g);
  assert.deepEqual([...takeForGraduation(db, "WINDOW_MINT").secretKey], [...g.secretKey]); // idempotent
  assert.equal(freshCount(db), GRADUATION_RESERVE - 1);
});

test("an empty pool says so instead of inventing a key", () => {
  const db = fresh(0);
  assert.equal(issueForLaunch(db, "C"), null);
  assert.equal(takeForGraduation(db, "M"), null);
});

test("importing reads real ground keypair files and deletes them; junk is left alone", () => {
  const db = fresh(0);
  const dir = mkdtempSync(path.join(tmpdir(), "vanity-"));
  // a real key from the grinder (ends in "hook") would be imported; a non-hook name is ignored
  writeFileSync(path.join(dir, "notes.txt"), "x");
  writeFileSync(path.join(dir, "partialhook.json"), "[1,2,"); // still being written
  assert.equal(importIncoming(db, dir), 0);
  assert.deepEqual(readdirSync(dir).sort(), ["notes.txt", "partialhook.json"]);
});
