import { test } from "node:test";
import assert from "node:assert/strict";
import { abandonedReason } from "../lib/abandoned.mjs";

const day = 86_400, now = 100 * day;
const launch = { status: "trading", created_at: now - 40 * day };
const pool = (quote, fee) => ({ quoteReserve: String(quote), partnerQuoteFee: String(fee) });

test("only an old, unfilled curve with fees is claimable by hand", () => {
  assert.equal(abandonedReason({ launch, pool: pool(1e9, 5e7), threshold: 2e9, now }), null);
  assert.match(abandonedReason({ launch: null, pool: pool(1e9, 5e7), threshold: 2e9, now }), /not a Hooker launch/);
  assert.match(abandonedReason({ launch: { ...launch, status: "complete" }, pool: pool(1e9, 5e7), threshold: 2e9, now }), /graduation handles/);
  assert.match(abandonedReason({ launch, pool: null, threshold: 2e9, now }), /cannot be read/);
  assert.match(abandonedReason({ launch, pool: pool(2e9, 5e7), threshold: 2e9, now }), /curve is full/);        // the graduator's job
  assert.match(abandonedReason({ launch: { ...launch, created_at: now - 29 * day }, pool: pool(1e9, 5e7), threshold: 2e9, now }), /29\.0 days old/);
  assert.match(abandonedReason({ launch, pool: pool(1e9, 0), threshold: 2e9, now }), /no platform fees/);
  assert.equal(abandonedReason({ launch: { ...launch, created_at: now - 8 * day }, pool: pool(1e9, 5e7), threshold: 2e9, now, days: 7 }), null);
});
