import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey, Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint, getExtensionData, ExtensionType } from "@solana/spl-token";
import { pairMemo, parsePairMemo, mintProblem } from "../lib/pairs.mjs";

const fixture = (sym) => {
  const j = JSON.parse(readFileSync(new URL(`../fixtures/pair-${sym}-mint.json`, import.meta.url)));
  return { data: Buffer.from(j.account.data[0], "base64"), owner: new PublicKey(j.account.owner), lamports: j.account.lamports, executable: false };
};
/** Where an extension's data starts inside a Token-2022 mint: walk the TLV list after the account-type byte (165). */
const extOffset = (info, type) => {
  for (let o = 166; o + 4 <= info.data.length; ) {
    const t = info.data.readUInt16LE(o), len = info.data.readUInt16LE(o + 2);
    if (t === type) return o + 4;
    o += 4 + len;
  }
  throw new Error(`extension ${type} not found`);
};

test("the launch memo round-trips, and anything else is not a pair memo", () => {
  const pair = Keypair.generate().publicKey.toBase58();
  assert.deepEqual(parsePairMemo(pairMemo(pair, 150)), { pair, creatorFeeBps: 150 });
  assert.deepEqual(parsePairMemo(pairMemo(pair, 0)), { pair, creatorFeeBps: 0 });
  for (const bad of ["", "hooker:pair=x;cfee=1", `hooker:pair=${pair};cfee=1000`, `pair=${pair}`]) assert.equal(parsePairMemo(bad), null, bad);
});

test("a classic SPL pair token (WBTC) and today's SPYx xStock are usable", () => {
  assert.equal(mintProblem(fixture("WBTC")), null);
  assert.equal(mintProblem(fixture("SPYx")), null);
});

test("a Token-2022 pair token is refused if it gains a transfer hook, freezes new accounts, or is paused", () => {
  const hooked = fixture("SPYx"); // TransferHook data: authority (32) then program id (32)
  Keypair.generate().publicKey.toBuffer().copy(hooked.data, extOffset(hooked, ExtensionType.TransferHook) + 32);
  assert.match(mintProblem(hooked), /transfer hook/);

  const frozen = fixture("SPYx"); // DefaultAccountState: one byte, 2 = Frozen
  frozen.data[extOffset(frozen, ExtensionType.DefaultAccountState)] = 2;
  assert.match(mintProblem(frozen), /freezes/);

  const paused = fixture("SPYx"); // PausableConfig: authority (32) then paused (1)
  paused.data[extOffset(paused, ExtensionType.PausableConfig) + 32] = 1;
  assert.match(mintProblem(paused), /paused/);
});

test("missing or non-token accounts are refused", () => {
  assert.match(mintProblem(null), /does not exist/);
  assert.match(mintProblem({ data: Buffer.alloc(82), owner: PublicKey.default, lamports: 1, executable: false }), /not a token/);
  assert.equal(mintProblem({ ...fixture("WBTC"), owner: TOKEN_PROGRAM_ID }), null);
});
