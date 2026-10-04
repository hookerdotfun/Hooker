import { test } from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, AddressLookupTableAccount, ComputeBudgetProgram, Transaction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import { createRequire } from "node:module";
import { pumpStaticKeys, buildV0, v0Size } from "../lib/lut.mjs";
const { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount } = createRequire(import.meta.url)("@pump-fun/pump-sdk");

// pump.fun's Global and fee config come from the local validator (mainnet clones); skipped without it
const conn = new Connection(process.env.LOCAL_RPC || "http://127.0.0.1:8997", "confirmed");
const up = await conn.getSlot().then(() => true, () => false);

test("the worst-case create+buy fits in one transaction with the lookup table, and not without", { skip: !up && "needs the local validator" }, async () => {
  const pump = new OnlinePumpSdk(conn);
  const global = await pump.fetchGlobal(), feeConfig = await pump.fetchFeeConfig();
  const keys = await pumpStaticKeys({ global, feeConfig });
  assert.ok(keys.length >= 12, `found ${keys.length} fixed accounts`);
  const lut = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: keys } });
  const mint = Keypair.generate().publicKey, creator = Keypair.generate().publicKey, user = Keypair.generate().publicKey;
  const solAmount = new BN(1_881_184_246);
  const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount, quoteMint: NATIVE_MINT });
  for (const holderReward of [true, false]) {
    const ixs = await PUMP_SDK.createV2AndBuyInstructions({ global, mint, name: "A".repeat(32), symbol: "B".repeat(10), uri: "https://gateway.pinata.cloud/ipfs/" + "b".repeat(166), creator, user, amount, solAmount, mayhemMode: false, holderReward });
    const all = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs];
    const legacy = new Transaction().add(...all); legacy.feePayer = user; legacy.recentBlockhash = "11111111111111111111111111111111";
    const legacySize = legacy.compileMessage().serialize().length + 1 + 128;
    const v0 = buildV0(user, all, "11111111111111111111111111111111", [lut]);
    const size = v0Size(v0, 2);
    console.log(`   holderReward ${holderReward}: legacy ${legacySize} bytes, with the lookup table ${size} bytes (${keys.length} fixed accounts)`);
    assert.ok(legacySize > 1232, "the legacy form is over the limit (that is the bug)");
    assert.ok(size <= 1232 - 60, "the v0 form fits with room to spare");
    assert.equal(v0.message.addressTableLookups.length, 1);
  }
});
