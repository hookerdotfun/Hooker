import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { encodeRules, decodeRules, validateRules, DEFAULT_RULES, feeBpsFor, CFG2_LEN, decodeList, sortWallets } from "../lib/rules.mjs";

const dev = Keypair.generate().publicKey, fomo = Keypair.generate().publicKey;
// the rules these tests were written against (DEFAULT_RULES until 4 Oct 2026; every hook is off by default since)
const base = { ...DEFAULT_RULES, dev, venueLock: true, maxWalletBps: 300, earlySecs: 300, earlyMaxWalletBps: 50, holderShareBps: 5_000 };

test("every hook is off by default (operator, 4 Oct 2026)", () => {
  const d = DEFAULT_RULES;
  assert.equal(d.venueLock, false); assert.equal(d.fomoOnly, false); assert.equal(d.holderRewards, false);
  for (const k of ["maxWalletBps", "earlySecs", "earlyMaxWalletBps", "feeBaseBps", "feePerSolBps", "feeCapBps", "burnBps", "holderShareBps", "tradeGuardBps", "rampSecs", "bundleMax", "snipeSecs"]) assert.equal(d[k], 0, k);
  assert.equal(d.allowlist || d.blocklist || d.hoursOn, false);
  assert.deepEqual(validateRules({ ...d, dev }), []); // and an all-off token is a valid launch
});

test("the layout is 256 bytes (v2) and round-trips", () => {
  const r = { ...base, fomoOnly: true, holderRewards: true, cosigner: fomo, maxWalletBps: 250, earlySecs: 60, earlyMaxWalletBps: 40, feeBaseBps: 50, feePerSolBps: 50, feeCapBps: 1000, burnBps: 200, holderShareBps: 5000 };
  const b = encodeRules(r);
  assert.equal(b.length, CFG2_LEN);
  assert.equal(b[0], 2);
  assert.equal(b[1], 1 | 4 | 8); // cosign + venue lock + holder rewards
  const d = decodeRules(b);
  for (const k of ["fomoOnly", "appOnly", "venueLock", "holderRewards", "maxWalletBps", "earlySecs", "earlyMaxWalletBps", "feeBaseBps", "feePerSolBps", "feeCapBps", "burnBps", "holderShareBps"]) assert.equal(d[k], r[k], k);
  assert.ok(d.dev.equals(dev) && d.cosigner.equals(fomo) && d.app.equals(PublicKey.default));
  assert.equal(d.launchTs, 0); // written by the program from its clock
});

test("byte offsets match the program's table", () => {
  const b = encodeRules({ ...base, maxWalletBps: 0x0102, earlySecs: 0x00010203, earlyMaxWalletBps: 0x0708, feeBaseBps: 1, feePerSolBps: 2, feeCapBps: 3, burnBps: 4, holderShareBps: 5 });
  assert.equal(b.readUInt16LE(98), 0x0102);
  assert.equal(b.readUInt32LE(108), 0x00010203);
  assert.equal(b.readUInt16LE(112), 0x0708);
  assert.deepEqual([114, 116, 118, 120, 122].map((o) => b.readUInt16LE(o)), [1, 2, 3, 4, 5]);
  assert.deepEqual([...b.subarray(124, 128)], [0, 0, 0, 0]);
  assert.ok(b.subarray(128).every((x) => x === 0)); // no v2 rule picked
});

test("v2 rules sit at the program's offsets and round-trip", () => {
  const r = { ...base, blocklist: true, tradeGuardBps: 0x0203, rampStartBps: 100, rampSecs: 0x00040506, hoursOn: true, hoursDays: 0b0111110,
    hoursOpenMin: 570, hoursCloseMin: 960, tzOffsetMin: -240, bundleMax: 3, snipeSecs: 120, snipeMaxCuPrice: 100_000, snipeMaxTip: 50_000 };
  const b = encodeRules(r);
  assert.equal(b[128], 2 | 4 | 8 | 16); // block + bundle + hours + snipe
  assert.equal(b[129], 0b0111110);
  assert.equal(b.readUInt16LE(130), 0x0203);
  assert.equal(b.readUInt16LE(132), 100);
  assert.equal(b.readUInt32LE(134), 0x00040506);
  assert.deepEqual([b.readUInt16LE(138), b.readUInt16LE(140), b.readInt16LE(142), b.readUInt16LE(144)], [570, 960, -240, 3]);
  assert.equal(b.readUInt32LE(148), 120);
  assert.equal(b.readBigUInt64LE(152), 100_000n);
  assert.equal(b.readBigUInt64LE(160), 50_000n);
  assert.ok(b.subarray(146, 148).every((x) => x === 0) && b.subarray(168).every((x) => x === 0));
  const d = decodeRules(b);
  for (const k of ["blocklist", "allowlist", "tradeGuardBps", "rampStartBps", "rampSecs", "hoursOn", "hoursDays", "hoursOpenMin", "hoursCloseMin", "tzOffsetMin", "bundleMax", "snipeSecs", "snipeMaxCuPrice", "snipeMaxTip"])
    assert.equal(d[k], r[k] ?? false, k);
});

test("a v1 config still decodes, with every v2 rule off", () => {
  const b = encodeRules(base).subarray(0, 128);
  b[0] = 1;
  const d = decodeRules(b);
  assert.equal(d.version, 1);
  assert.equal(d.allowlist, false);
  assert.equal(d.bundleMax, 0);
});

test("v2 validation refuses what the program refuses", () => {
  const bad = (patch) => validateRules({ ...base, ...patch }).length > 0;
  assert.ok(bad({ allowlist: true, blocklist: true }));
  assert.ok(bad({ tradeGuardBps: 5 }));
  assert.ok(bad({ rampSecs: 600, rampStartBps: 0 }));             // ramp needs a start
  assert.ok(bad({ rampSecs: 600, rampStartBps: 300 }));           // start must be below the max (300)
  assert.ok(bad({ rampSecs: 600, rampStartBps: 100, maxWalletBps: 0 }));
  assert.ok(bad({ rampSecs: 8 * 86_400, rampStartBps: 100 }));
  assert.ok(bad({ rampStartBps: 100 }));                          // a start without a ramp
  assert.ok(bad({ hoursOn: true, hoursDays: 0, hoursOpenMin: 1, hoursCloseMin: 2 }));
  assert.ok(bad({ hoursOn: true, hoursDays: 1, hoursOpenMin: 600, hoursCloseMin: 600 }));
  assert.ok(bad({ hoursOn: true, hoursDays: 1, hoursOpenMin: 1440, hoursCloseMin: 600 }));
  assert.ok(bad({ hoursDays: 1 }));                               // hours without the rule
  assert.ok(bad({ bundleMax: 21 }));
  assert.ok(bad({ snipeSecs: 86_401 }));
  assert.ok(bad({ snipeMaxTip: 5 }));                             // a cap without the rule
  assert.ok(!bad({ allowlist: true, tradeGuardBps: 100, rampSecs: 600, rampStartBps: 100, hoursOn: true, hoursDays: 127, hoursOpenMin: 1200, hoursCloseMin: 120, bundleMax: 1, snipeSecs: 60 }));
});

test("lists are sorted by raw bytes, deduplicated, and decode", () => {
  const ks = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
  const s = sortWallets([...ks, ks[0], ks[3].toBase58()]);
  assert.equal(s.length, 5);
  for (let i = 1; i < s.length; i++) assert.ok(Buffer.compare(s[i - 1].toBuffer(), s[i].toBuffer()) < 0);
  const buf = Buffer.alloc(8 + 5 * 32);
  buf.writeUInt32LE(5, 0); buf[4] = 1;
  s.forEach((k, i) => k.toBuffer().copy(buf, 8 + i * 32));
  const d = decodeList(buf);
  assert.equal(d.count, 5);
  assert.equal(d.sealed, true);
  assert.ok(d.wallets.every((w, i) => w.equals(s[i])));
  assert.equal(decodeList(null), null);
});

test("validation refuses what would brick or mislead", () => {
  const bad = (patch) => validateRules({ ...base, ...patch }).length > 0;
  assert.ok(!bad({}));
  assert.ok(bad({ dev: null }));
  assert.ok(bad({ fomoOnly: true }));                 // no co-signer
  assert.ok(bad({ appOnly: true }));                  // no app
  assert.ok(bad({ maxWalletBps: 5 }));                // tighter than 0.1%
  assert.ok(bad({ earlySecs: 86_401 }));
  assert.ok(bad({ earlySecs: 60, earlyMaxWalletBps: 0 }));
  assert.ok(bad({ earlySecs: 0, earlyMaxWalletBps: 50 }));
  assert.ok(bad({ feeCapBps: 2001 }));
  assert.ok(bad({ feeBaseBps: 600, feeCapBps: 500 }));
  assert.ok(bad({ feePerSolBps: 10, feeCapBps: 0 }));
  assert.ok(bad({ burnBps: 2001 }));
  assert.ok(bad({ feeCapBps: 2000, burnBps: 1001 })); // fee + burn over 30%
  assert.ok(bad({ holderShareBps: 10_001 }));
  assert.throws(() => encodeRules({ ...base, burnBps: 5000 }));
});

test("the dynamic fee scales with SOL and stops at the cap", () => {
  const f = feeBpsFor({ feeBaseBps: 50, feePerSolBps: 50, feeCapBps: 400 });
  assert.equal(f(0n), 50n);
  assert.equal(f(1_000_000_000n), 100n);
  assert.equal(f(150_000_000n), 57n);
  assert.equal(f(100_000_000_000n), 400n);
});
