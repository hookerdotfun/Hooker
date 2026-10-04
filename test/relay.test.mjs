import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { isRelayable } from "../lib/relay.mjs";
import { listAddIx, listSealIx } from "../lib/launch.mjs";
import { DBC_PROGRAM } from "../lib/chain.mjs";

const hookProgram = Keypair.generate().publicKey, dev = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey, other = Keypair.generate().publicKey, pool = Keypair.generate().publicKey;
const ctx = { known: new Set([pool.toBase58()]), mints: new Set([mint.toBase58()]), hookProgram };
const tx = (...ixs) => new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ...ixs);

test("a trade on one of our pools is relayed", () => {
  assert.ok(isRelayable(tx(new TransactionInstruction({ programId: DBC_PROGRAM, keys: [{ pubkey: pool, isSigner: false, isWritable: true }], data: Buffer.alloc(8) })), ctx));
});
test("a creator's list add and seal are relayed", () => {
  const add = listAddIx({ hookProgram, dev, mint, wallets: [Keypair.generate().publicKey] });
  assert.ok(isRelayable(tx(add), ctx));
  assert.ok(isRelayable(tx(add, listSealIx({ hookProgram, dev, mint })), ctx));
});
test("anything else is not", () => {
  assert.ok(!isRelayable(tx(), ctx));                                                                    // compute budget only
  assert.ok(!isRelayable(tx(listAddIx({ hookProgram, dev, mint: other, wallets: [dev] })), ctx));       // a mint not launched here
  assert.ok(!isRelayable(tx(listAddIx({ hookProgram, dev, mint, wallets: [dev] }), SystemProgram.transfer({ fromPubkey: dev, toPubkey: other, lamports: 1 })), ctx)); // a list add plus a transfer
  const wrongList = listAddIx({ hookProgram, dev, mint, wallets: [dev] }); wrongList.keys[3].pubkey = other;
  assert.ok(!isRelayable(tx(wrongList), ctx));                                                           // not the mint's list account
  assert.ok(!isRelayable(tx(new TransactionInstruction({ programId: hookProgram, keys: listAddIx({ hookProgram, dev, mint, wallets: [dev] }).keys, data: Buffer.from("somethingelse") })), ctx));
  assert.ok(!isRelayable(tx(new TransactionInstruction({ programId: DBC_PROGRAM, keys: [{ pubkey: other, isSigner: false, isWritable: true }], data: Buffer.alloc(8) })), ctx)); // someone else's pool
});

test("pump.fun creator-fee claims are relayed; nothing else rides along", async () => {
  const { isPumpCreatorClaim } = await import("../lib/relay.mjs");
  const { createHash } = await import("node:crypto");
  const { TransactionInstruction, PublicKey, Keypair, SystemProgram, ComputeBudgetProgram } = await import("@solana/web3.js");
  const ix = (program, name) => new TransactionInstruction({ programId: new PublicKey(program), keys: [], data: createHash("sha256").update(`global:${name}`).digest().subarray(0, 8) });
  const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
  const ataIdem = new TransactionInstruction({ programId: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), keys: [], data: Buffer.from([1]) });
  const close = new TransactionInstruction({ programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), keys: [], data: Buffer.from([9]) });
  const tx = (...ixs) => ({ instructions: ixs });
  assert.equal(isPumpCreatorClaim(tx(ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), ix(PUMP, "collect_creator_fee"), ataIdem, ix(AMM, "collect_coin_creator_fee"), close)), true);
  assert.equal(isPumpCreatorClaim(tx(ix(PUMP, "collect_creator_fee_v2"))), true);
  assert.equal(isPumpCreatorClaim(tx(ataIdem, close)), false, "no collect: not a claim");
  assert.equal(isPumpCreatorClaim(tx(ix(PUMP, "collect_creator_fee"), SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }))), false, "a transfer riding along");
  assert.equal(isPumpCreatorClaim(tx(ix(PUMP, "collect_creator_fee"), ix(PUMP, "buy"))), false, "another pump.fun instruction");
  assert.equal(isPumpCreatorClaim(tx(ix(PUMP, "collect_creator_fee"), new TransactionInstruction({ programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), keys: [], data: Buffer.from([3]) }))), false, "a token transfer");
});
