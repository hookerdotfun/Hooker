// node --test settle.test.mjs — the settlement maths on hand-built histories, no chain needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { settle, cutAtGraduation } from "../lib/settle.mjs";

const SOL = 1_000_000_000n;
const flat = (bps) => () => bps;
// accounts are named after their owner with a suffix, so tests read naturally
const buy = (slot, owner, tokens, sol, account = owner + "_acct") => ({ slot, sig: `buy-${slot}`, isSwap: true, deltas: [{ account, owner, amount: tokens }], dVault: -tokens, dQuote: sol });
const sell = (slot, owner, tokens, sol, account = owner + "_acct") => ({ slot, sig: `sell-${slot}`, isSwap: true, deltas: [{ account, owner, amount: -tokens }], dVault: tokens, dQuote: -sol });
const move = (slot, from, to, tokens) => ({ slot, sig: `move-${slot}`, isSwap: false, deltas: [{ account: from + "_acct", owner: from, amount: -tokens }, { account: to + "_acct", owner: to, amount: tokens }], dVault: 0n, dQuote: 0n });
const row = (s, o) => s.rows.find((r) => r.owner === o);
const conserved = (s, base, pot) => assert.equal(s.toHolders + s.burned + s.toTreasury, base + pot);

test("no rules: allocation is pro-rata to the snapshot", () => {
  const s = settle({ events: [buy(1, "A", 300n, SOL), buy(2, "B", 700n, SOL)], pumpBase: 1_000_000n, pumpPot: 0n, feeBps: flat(0n), burnBps: 0n });
  assert.equal(row(s, "A").alloc, 300_000n);
  assert.equal(row(s, "B").alloc, 700_000n);
  conserved(s, 1_000_000n, 0n);
});

test("fee and burn come off the buyer's allocation", () => {
  const s = settle({ events: [buy(1, "A", 1000n, SOL)], pumpBase: 1_000_000n, pumpPot: 0n, feeBps: flat(500n), burnBps: 200n });
  assert.deepEqual([row(s, "A").gross, row(s, "A").fee, row(s, "A").burn, row(s, "A").alloc], [1_000_000n, 50_000n, 20_000n, 930_000n]);
  assert.equal(s.burned, 20_000n);
  assert.equal(s.toTreasury, 50_000n);
  conserved(s, 1_000_000n, 0n);
});

test("the fee scales with the SOL size of each buy", () => {
  const feeBps = (lamports) => 50n + (50n * lamports) / SOL;
  const s = settle({ events: [buy(1, "A", 500n, 1n * SOL), buy(2, "B", 500n, 7n * SOL)], pumpBase: 1_000_000n, pumpPot: 0n, feeBps, burnBps: 0n });
  assert.deepEqual(s.buys.map((b) => b.feeBps), [100n, 400n]);
  assert.equal(row(s, "A").fee, 5_000n);
  assert.equal(row(s, "B").fee, 20_000n);
});

test("moving tokens to a fresh wallet does NOT shed the fee or the burn", () => {
  const s = settle({ events: [buy(1, "A", 1000n, SOL), move(2, "A", "FRESH", 1000n)], pumpBase: 1_000_000n, pumpPot: 0n, feeBps: flat(500n), burnBps: 200n });
  assert.equal(row(s, "A").alloc, 0n);
  assert.deepEqual([row(s, "FRESH").fee, row(s, "FRESH").burn, row(s, "FRESH").alloc], [50_000n, 20_000n, 930_000n]);
  conserved(s, 1_000_000n, 0n);
});

test("a partial transfer moves a pro-rata share of what is owed", () => {
  const s = settle({ events: [buy(1, "A", 1000n, SOL), move(2, "A", "B", 250n)], pumpBase: 1_000_000n, pumpPot: 0n, feeBps: flat(400n), burnBps: 0n });
  assert.equal(row(s, "A").fee, 30_000n);
  assert.equal(row(s, "B").fee, 10_000n);
});

test("tokens sold back take their dues with them; the seller keeps the rest", () => {
  const s = settle({ events: [buy(1, "A", 1000n, SOL), buy(2, "B", 1000n, SOL), sell(3, "A", 500n, SOL / 2n)], pumpBase: 1_500_000n, pumpPot: 0n, feeBps: flat(1000n), burnBps: 0n });
  assert.equal(row(s, "A").gross, 500_000n);
  assert.equal(row(s, "A").fee, 50_000n);
  assert.equal(row(s, "B").fee, 100_000n);
  conserved(s, 1_500_000n, 0n);
});

test("the dev buy inside the launch transaction is a buy and owes its dues", () => {
  // the launch tx mints the supply into the vault (dVault > 0) and sells the dev buy out of it in one go
  const launch = { slot: 1, sig: "launch", isSwap: true, deltas: [{ account: "DEV_acct", owner: "DEV", amount: 1000n }], dVault: 999_000n, dQuote: SOL };
  const s = settle({ events: [launch], pumpBase: 1_000_000n, pumpPot: 0n, feeBps: flat(500n), burnBps: 0n });
  assert.equal(s.buys.length, 1);
  assert.equal(row(s, "DEV").fee, 50_000n);
});

test("the holder pot is shared by balance × time held, and a wallet that sold out still earns", () => {
  const s = settle({ events: [buy(0, "A", 100n, SOL), buy(5, "B", 100n, SOL), sell(10, "A", 100n, SOL)], pumpBase: 1_000n, pumpPot: 300n, feeBps: flat(0n), burnBps: 0n });
  assert.equal(row(s, "A").reward, 200n);
  assert.equal(row(s, "B").reward, 100n);
  assert.equal(row(s, "A").alloc, 200n);
  conserved(s, 1_000n, 300n);
});

test("a window that graduates inside one slot shares the pot by balance", () => {
  const s = settle({ events: [buy(7, "A", 100n, SOL), buy(7, "B", 300n, SOL)], pumpBase: 400n, pumpPot: 40n, feeBps: flat(0n), burnBps: 0n });
  assert.equal(row(s, "A").reward, 10n);
  assert.equal(row(s, "B").reward, 30n);
});

test("rounding dust goes to the treasury and nothing is lost", () => {
  const events = [buy(1, "A", 1n, SOL), buy(2, "B", 1n, SOL), buy(3, "C", 1n, SOL)];
  const s = settle({ events, pumpBase: 100n, pumpPot: 10n, feeBps: flat(333n), burnBps: 111n });
  conserved(s, 100n, 10n);
  assert.ok(s.toTreasury >= s.fees);
});

test("a hole in the history is a stop, not a guess", () => {
  assert.throws(() => settle({ events: [move(1, "A", "B", 5n)], pumpBase: 1n, pumpPot: 0n, feeBps: flat(0n), burnBps: 0n }), /history hole/);
  assert.throws(() => settle({ events: [], pumpBase: 1n, pumpPot: 0n, feeBps: flat(0n), burnBps: 0n }), /nothing to settle/);
});

test("dust wallets are not paid: their share is burned, so sending can never eat the raise", () => {
  const events = [buy(1, "WHALE", 1_000_000n, SOL)];
  for (let i = 0; i < 1000; i++) events.push(buy(2 + i, `DUST${i}`, 1n, 1_000n));
  const s = settle({ events, pumpBase: 10_000_000n, pumpPot: 0n, feeBps: flat(0n), burnBps: 0n, minAlloc: 100n });
  const paid = s.rows.filter((r) => r.alloc > 0n);
  assert.equal(paid.length, 1);
  assert.equal(paid[0].owner, "WHALE");
  conserved(s, 10_000_000n, 0n);
});

test("an account whose owner changed off-history is paid to its CURRENT owner, and never breaks the replay", () => {
  // A buys into account X, hands X to B with SetAuthority (invisible to the mint's history), B sells 1 from X
  const events = [buy(1, "A", 1000n, SOL, "X"), { slot: 2, sig: "sell-2", isSwap: true, deltas: [{ account: "X", owner: "B", amount: -1n }], dVault: 1n, dQuote: 1n }];
  const s = settle({ events, pumpBase: 999_000n, pumpPot: 0n, feeBps: flat(0n), burnBps: 0n, owners: new Map([["X", "B"]]) });
  assert.equal(row(s, "A"), undefined);
  assert.equal(row(s, "B").alloc, 999_000n);
  conserved(s, 999_000n, 0n);
});

test("owners that must never be paid (the platform, Meteora's authority) have their share burned", () => {
  const s = settle({ events: [buy(1, "A", 500n, SOL), buy(2, "PLATFORM", 500n, SOL)], pumpBase: 1_000_000n, pumpPot: 0n, feeBps: flat(0n), burnBps: 0n, excludeOwners: new Set(["PLATFORM"]) });
  assert.equal(row(s, "PLATFORM").alloc, 0n);
  assert.equal(s.burned, 500_000n);
  conserved(s, 1_000_000n, 0n);
});

test("the graduating transaction is the last SWAP that took tokens out of the curve, never a forged one", () => {
  const real = buy(5, "A", 100n, SOL);
  const forged = { slot: 9, sig: "leftover+deposit", isSwap: false, deltas: [{ account: "PLATFORM_acct", owner: "PLATFORM", amount: 500_000n }], dVault: -500_000n, dQuote: 1n };
  const cut = cutAtGraduation([buy(1, "B", 100n, SOL), real, forged]);
  assert.equal(cut.gradSig, "buy-5");
  assert.equal(cut.events.length, 2);
  assert.throws(() => cutAtGraduation([forged]), /no buy found/);
});

test("a stranger's SOL deposit into the vault does not turn a transfer into a buy", () => {
  const sneaky = { slot: 2, sig: "move+deposit", isSwap: false, deltas: [{ account: "A_acct", owner: "A", amount: -100n }, { account: "B_acct", owner: "B", amount: 100n }], dVault: 0n, dQuote: 5n * SOL };
  const s = settle({ events: [buy(1, "A", 100n, SOL), sneaky], pumpBase: 100n, pumpPot: 0n, feeBps: flat(1000n), burnBps: 0n });
  assert.equal(s.buys.length, 1);
  assert.equal(row(s, "B").fee, 10n); // carried over from A's buy, not charged anew
});
