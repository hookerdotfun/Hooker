import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { assertSeparate, spendable, KEEP_LAMPORTS, MIN_BUY_LAMPORTS } from "../lib/flywheel.mjs";

test("the burn wallet may never be $HOOKER's creator or the hot wallet (pump.fun has one creator vault per wallet)", () => {
  const burn = Keypair.generate().publicKey, hooker = Keypair.generate().publicKey, hot = Keypair.generate().publicKey;
  assert.doesNotThrow(() => assertSeparate(burn, { hookerCreator: hooker, platform: hot }));
  assert.throws(() => assertSeparate(hooker, { hookerCreator: hooker, platform: hot }), /HOOKER's creator/);
  assert.throws(() => assertSeparate(hot, { hookerCreator: hooker, platform: hot }), /hot wallet/);
});

test("a buy spends everything above the float, and nothing when the float is not covered", () => {
  assert.equal(spendable(KEEP_LAMPORTS), 0n);
  assert.equal(spendable(KEEP_LAMPORTS - 1n), 0n);
  assert.equal(spendable(KEEP_LAMPORTS + 5n), 5n);
  assert.equal(spendable(1_000_000_000n), 1_000_000_000n - KEEP_LAMPORTS);
  assert.ok(MIN_BUY_LAMPORTS > KEEP_LAMPORTS, "the minimum buy is above the float, so dust never triggers a transaction");
});
