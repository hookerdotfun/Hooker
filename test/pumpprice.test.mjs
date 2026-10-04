// Pins lib/pumpprice.mjs's byte offsets to the installed pump-swap-sdk IDL, so an SDK update that
// moves a field fails here instead of mispricing every graduated coin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { POOL_LAYOUT, decodePool, decodeCurve } from "../lib/pumpprice.mjs";

const require = createRequire(import.meta.url);
const SIZES = { u8: 1, u16: 2, u64: 8, i128: 16, bool: 1, pubkey: 32 };

test("Pool offsets match the pump-swap-sdk IDL", () => {
  const m = require("@pump-fun/pump-swap-sdk");
  const idl = Object.values(m).find((v) => v && v.instructions && v.types);
  const fields = idl.types.find((t) => t.name === "Pool").type.fields;
  let off = 8;
  const offsets = {};
  for (const f of fields) { offsets[f.name] = off; off += SIZES[f.type] ?? (() => { throw new Error(`unknown type ${f.type} for ${f.name}`); })(); }
  assert.equal(offsets.pool_base_token_account, POOL_LAYOUT.baseAccount);
  assert.equal(offsets.pool_quote_token_account, POOL_LAYOUT.quoteAccount);
  assert.equal(offsets.virtual_quote_reserves, POOL_LAYOUT.virtualQuote);
  assert.equal(fields.find((f) => f.name === "virtual_quote_reserves").type, "i128");
  assert.ok(POOL_LAYOUT.minLen >= offsets.virtual_quote_reserves + 16);
});

test("a filled curve decodes as complete, a short account as null", () => {
  const d = Buffer.alloc(49); d[48] = 1;
  assert.equal(decodeCurve(d).complete, true);
  assert.equal(decodeCurve(Buffer.alloc(10)), null);
  assert.equal(decodePool(Buffer.alloc(100)), null);
});
