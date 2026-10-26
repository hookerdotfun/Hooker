import { test } from "node:test";
import assert from "node:assert/strict";
import { findProblems, plan, settle, deliver } from "../lib/alert.mjs";

const nowSec = 1_800_000_000;
const healthy = { nowSec, heartbeat: nowSec - 10, apiOk: true, gateExpected: true, gateOk: true, launches: [], hotLamports: 1e9, hotLowLamports: 3e8, newestBackupSec: nowSec - 600, hotWallet: "HOT" };
const keys = (o) => findProblems({ ...healthy, ...o }).map((p) => p.key);

test("a healthy box raises nothing", () => assert.deepEqual(keys({}), []));

test("a dead, missing or hung graduator is reported", () => {
  assert.deepEqual(keys({ heartbeat: null }), ["graduator-down"]);
  assert.deepEqual(keys({ heartbeat: nowSec - 600 }), ["graduator-down"]);
  assert.deepEqual(keys({ heartbeat: nowSec - 60 }), []); // a slow tick is not an outage
});

test("api and gate down; gate only when the gate is installed", () => {
  assert.deepEqual(keys({ apiOk: false }), ["api-down"]);
  assert.deepEqual(keys({ gateOk: false }), ["gate-down"]);
  assert.deepEqual(keys({ gateExpected: false, gateOk: false }), []);
});

test("stalled, struggling and silent-stuck graduations, one key per mint", () => {
  const launches = [
    { mint: "A", status: "stalled", stalled_from: "burned", attempts: 30, error: "x" },
    { mint: "B", status: "launched", attempts: 6, updated_at: nowSec },
    { mint: "C", status: "burned", attempts: 0, updated_at: nowSec - 3600 }, // the 4 Oct case: nothing failing, nothing moving
    { mint: "D", status: "settled", attempts: 1, updated_at: nowSec - 60 },
    { mint: "E", status: "trading", attempts: 0, updated_at: nowSec - 86400 }, // a quiet curve is normal
  ];
  assert.deepEqual(keys({ launches }), ["stalled:A", "retrying:B", "stuck:C"]);
});

test("hot wallet low; an UNREAD balance is not low", () => {
  assert.deepEqual(keys({ hotLamports: 1e8 }), ["hot-low"]);
  assert.deepEqual(keys({ hotLamports: null }), []);
});

test("backups stale or missing", () => {
  assert.deepEqual(keys({ newestBackupSec: nowSec - 7200 }), ["backup-stale"]);
  assert.deepEqual(keys({ newestBackupSec: null }), ["backup-stale"]);
});

test("sent once, repeated after the repeat window, resolved once when it clears", () => {
  const p = [{ key: "api-down", text: "🛑 hooker-api is not answering. More." }];
  let state = {}, t = 0;
  const run = (problems, ok = true) => {
    const { messages, next } = plan(problems, state, t, 1000);
    state = settle(next, new Map(messages.map((m) => [m.key, ok])), t);
    return messages;
  };
  assert.equal(run(p).length, 1);
  t = 500; assert.equal(run(p).length, 0);                 // inside the window: quiet
  t = 1200; const again = run(p);
  assert.equal(again.length, 1); assert.match(again[0].text, /still, since/);
  t = 1300; const done = run([]);
  assert.equal(done.length, 1); assert.match(done[0].text, /^✅ Resolved: hooker-api is not answering$/);
  t = 1400; assert.equal(run([]).length, 0);
});

test("a failed send is retried next run; a blip that never got out is not 'resolved'", () => {
  const p = [{ key: "hot-low", text: "⚠ low" }];
  let state = {};
  let r = plan(p, state, 0, 1000); state = settle(r.next, new Map([["hot-low", false]]), 0);
  r = plan(p, state, 10, 1000); assert.equal(r.messages.length, 1); // due again at once
  state = settle(r.next, new Map([["hot-low", false]]), 10);
  r = plan([], state, 20, 1000); assert.equal(r.messages.length, 0); // never delivered → no resolved line
});

test("underscore state (hot balance cache, daily marker) survives a plan", () => {
  const { next } = plan([], { _hot: { lamports: 5, at: 1 }, _daily: { day: "x" } }, 0);
  assert.deepEqual(next, { _hot: { lamports: 5, at: 1 }, _daily: { day: "x" } });
});

test("deliver posts to both channels, never throws, and redacts the bot token from errors", async () => {
  const calls = [];
  const ok = await deliver("hi", { ch: { webhook: "https://w", telegram: { token: "1:abc", chat: "9" } }, fetchImpl: async (u, o) => (calls.push([u, JSON.parse(o.body)]), { ok: true }), log: () => {} });
  assert.equal(ok, true);
  assert.equal(calls[0][1].content, "hooker.fun · hi");
  assert.deepEqual(calls[1], ["https://api.telegram.org/bot1:abc/sendMessage", { chat_id: "9", text: "hooker.fun · hi", disable_web_page_preview: true }]);
  const lines = [];
  const bad = await deliver("hi", { ch: { webhook: null, telegram: { token: "123:secret-x", chat: "9" } }, fetchImpl: async () => { throw new Error("fetch https://api.telegram.org/bot123:secret-x/sendMessage failed"); }, log: (l) => lines.push(l) });
  assert.equal(bad, false);
  assert.doesNotMatch(lines.join(), /secret/);
});
