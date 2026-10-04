import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { createLander, inspect } from "../lib/lander.mjs";
import { priorityFee, PRIORITY_FEE, PRIORITY_FEE_MAX } from "../lib/chain.mjs";

const kp = Keypair.generate();
const rawTx = (bh = bs58.encode(Buffer.alloc(32, 7))) => {
  const t = new Transaction({ feePayer: kp.publicKey, recentBlockhash: bh }).add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 }));
  t.sign(kp);
  return t.serialize();
};

/** A pretend network: `status` decides what getSignatureStatuses says on each poll. */
function fakeConn({ statusAt = () => null, validUntilPoll = Infinity }) {
  let polls = 0;
  const sends = [];
  return {
    sends, get polls() { return polls; },
    getSignatureStatuses: async (sigs) => { polls++; return { value: sigs.map((s) => statusAt(polls, s)) }; },
    isBlockhashValid: async () => ({ value: polls < validUntilPoll }),
    sendRawTransaction: async (raw) => { sends.push(raw); return "x"; },
  };
}
const fast = { pollMs: 1, resendMs: 0, expiryMs: 0, giveUpMs: 5_000 };

test("inspect reads the signature and blockhash", () => {
  const raw = rawTx();
  const { sig, blockhash } = inspect(raw);
  assert.equal(sig, bs58.encode(Transaction.from(raw).signature));
  assert.equal(blockhash, bs58.encode(Buffer.alloc(32, 7)));
});

test("a transaction that lands on the 3rd poll is reported landed, and was rebroadcast while waiting", async () => {
  const conn = fakeConn({ statusAt: (n) => (n >= 3 ? { confirmationStatus: "confirmed", err: null } : null) });
  const out = await createLander(conn, fast).track(rawTx());
  assert.deepEqual(out, { landed: true, err: null });
  assert.ok(conn.sends.length >= 1, "rebroadcast at least once");
});

test("a transaction that landed but failed reports its error, not success", async () => {
  const conn = fakeConn({ statusAt: () => ({ confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } }) });
  const out = await createLander(conn, fast).track(rawTx());
  assert.equal(out.landed, true); assert.ok(out.err);
});

test("dropped: once its blockhash expires and it is nowhere, the answer is a definite 'expired'", async () => {
  const conn = fakeConn({ validUntilPoll: 3 });
  const out = await createLander(conn, fast).track(rawTx());
  assert.deepEqual(out, { landed: false, why: "expired" });
});

test("landing in the same moment the blockhash expires still counts as landed", async () => {
  // the regular poll sees nothing; the final history search after expiry finds it
  let finalLook = false;
  const conn = fakeConn({ validUntilPoll: 2 });
  const base = conn.getSignatureStatuses;
  conn.getSignatureStatuses = async (sigs, opts) => (opts?.searchTransactionHistory ? (finalLook = true, { value: [{ confirmationStatus: "confirmed", err: null }] }) : base(sigs));
  const out = await createLander(conn, fast).track(rawTx());
  assert.ok(finalLook); assert.deepEqual(out, { landed: true, err: null });
});

test("many transactions in flight share ONE status read per poll", async () => {
  const conn = fakeConn({ statusAt: (n) => (n >= 2 ? { confirmationStatus: "confirmed", err: null } : null) });
  const lander = createLander(conn, fast);
  const outs = await Promise.all(Array.from({ length: 30 }, (_, i) => lander.track(rawTx(bs58.encode(Buffer.alloc(32, i + 1))))));
  assert.ok(outs.every((o) => o.landed));
  assert.ok(conn.polls <= 3, `${conn.polls} status reads for 30 transactions`);
});

test("priority fee: Helius's estimate, clamped; any other RPC gives the fixed floor", async () => {
  const at = (est) => ({ _rpcRequest: async () => ({ result: { priorityFeeEstimate: est } }) });
  let t = 1e12;
  assert.equal(await priorityFee(at(12_345), { now: (t += 20_000) }), 12_345);
  assert.equal(await priorityFee(at(9_999_999), { now: (t += 20_000) }), PRIORITY_FEE_MAX);
  assert.equal(await priorityFee(at(1), { now: (t += 20_000) }), PRIORITY_FEE);
  assert.equal(await priorityFee({ _rpcRequest: async () => { throw new Error("method not found"); } }, { now: (t += 20_000) }), PRIORITY_FEE);
});
