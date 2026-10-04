import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadFeatured, featuredSummary } from "../lib/featured.mjs";

const ok = { mint: "4EndSFFpYMFoXHwUdLbR7QCUBeigdeEeYqCQX2Ydhook", creator: "fomosZ2wByGHXygzSzDg1J7uFVCiAj9KbZVjr342hnX", name: "Hooker", symbol: "HOOKER", image: "/hooker-token.png", createdAt: 1791112082 };
const file = (coins) => { const p = `${mkdtempSync(`${tmpdir()}/feat-`)}/f.json`; writeFileSync(p, JSON.stringify({ coins })); return p; };

test("the repo's featured.json loads", () => assert.ok(Array.isArray(loadFeatured())));
test("a good entry loads; a missing field or a bad address or an off-site image is refused", () => {
  assert.equal(loadFeatured(file([ok]))[0].symbol, "HOOKER");
  assert.throws(() => loadFeatured(file([{ ...ok, createdAt: undefined }])), /createdAt/);
  assert.throws(() => loadFeatured(file([{ ...ok, mint: "nope" }])));
  assert.throws(() => loadFeatured(file([{ ...ok, image: "https://evil.example/x.png" }])), /image/);
});
test("summary: shown like a Hooker graduation (done, on Pumpfun), priced like one; unpriced is null, not 0", () => {
  const s = featuredSummary(ok, { venue: "pump.fun", marketCapSol: 30, progress: 0.25 }, 200);
  assert.equal(s.native, true); assert.equal(s.status, "done"); assert.equal(s.marketCapUsd, 6000);
  assert.deepEqual(s.graduated, { status: "done", pumpMint: ok.mint, pumpUrl: `https://pump.fun/coin/${ok.mint}`, settled: null });
  assert.equal(s.graduated.settled, null); // never a "holders paid" count: that did not happen to it
  const n = featuredSummary(ok, null, 200);
  assert.equal(n.marketCapUsd, null); assert.equal(n.venue, "pump.fun");
});

test("hideLaunchesBefore: the repo's value loads; a non-number is refused; absent means hide nothing", async () => {
  const { loadHideBefore } = await import("../lib/featured.mjs");
  assert.ok(loadHideBefore() > 1_790_000_000);
  const p = `${mkdtempSync(`${tmpdir()}/feat-`)}/f.json`;
  writeFileSync(p, JSON.stringify({ coins: [], hideLaunchesBefore: "soon" })); assert.throws(() => loadHideBefore(p));
  writeFileSync(p, JSON.stringify({ coins: [] })); assert.equal(loadHideBefore(p), 0);
});
