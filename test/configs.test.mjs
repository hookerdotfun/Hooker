import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Keypair } from "@solana/web3.js";
import { loadConfigState, configEntries } from "../lib/configs.mjs";

test("a retired set with the same sizes never hides the live configs from discovery", () => {
  const dir = mkdtempSync(`${tmpdir()}/hooker-cfg-`);
  const live = { 29.7: Keypair.generate().publicKey.toBase58(), 85: Keypair.generate().publicKey.toBase58() };
  const old = { 29.7: Keypair.generate().publicKey.toBase58(), 85: Keypair.generate().publicKey.toBase58() };
  const pump = { virtualSol: 30, virtualTokens: 1_073_000_000, supply: 1_000_000_000, realTokens: 793_100_000 };
  writeFileSync(`${dir}/configs.json`, JSON.stringify({ hookProgram: "x", pump, configs: live, retired: [{ pump, configs: old, retiredAt: "2026-10-04" }] }));
  const st = loadConfigState(dir);
  const entries = configEntries(st);
  assert.equal(entries.length, 4, "every config ever made is scanned");
  for (const addr of [...Object.values(live), ...Object.values(old)]) assert.ok(entries.some((e) => e.address.toBase58() === addr), addr);
  assert.deepEqual(entries.filter((e) => !e.retired).map((e) => e.address.toBase58()).sort(), Object.values(live).sort(), "the live ones are marked live");
  assert.deepEqual(Object.values(st.configs).map(String).sort(), Object.values(live).sort(), "only the live set is offered to launches");
});

test("anti-snipe and flat-fee sets: both offered, both discovered, each marked; an old file has no flat set", () => {
  const dir = mkdtempSync(`${tmpdir()}/hooker-cfg-`);
  const k = () => Keypair.generate().publicKey.toBase58();
  const pump = { virtualSol: 30, virtualTokens: 1_073_000_000, supply: 1_000_000_000, realTokens: 793_100_000 };
  const anti = { 29.7: k(), 85: k() }, flat = { 29.7: k(), 85: k() }, oldAnti = { 29.7: k() };
  writeFileSync(`${dir}/configs.json`, JSON.stringify({ hookProgram: "x", pump, configs: anti, flatConfigs: flat, retired: [{ pump, configs: oldAnti, retiredAt: "2026-10-03" }] }));
  const st = loadConfigState(dir);
  assert.equal(st.configs["29.7"].toBase58(), anti[29.7]);
  assert.equal(st.flatConfigs["29.7"].toBase58(), flat[29.7]);
  assert.equal(st.all[anti[85]].antiSnipe, true);
  assert.equal(st.all[flat[85]].antiSnipe, false);
  assert.equal(st.all[oldAnti[29.7]].antiSnipe, true); // sets made before 4 Oct are all anti-snipe
  assert.equal(configEntries(st).length, 5); // discovery scans every one
  writeFileSync(`${dir}/configs.json`, JSON.stringify({ hookProgram: "x", pump, configs: anti }));
  assert.deepEqual(loadConfigState(dir).flatConfigs, {});
});
