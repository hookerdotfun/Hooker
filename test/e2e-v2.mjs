// The v2 rules end to end on the local validator (scripts/validator.sh): allowlist, blocklist, trade
// guard, rising max per wallet, trading hours, sniper-fee cap and anti-bundle, each on its own token,
// each traded through Meteora's real program the way a buyer's wallet would. Run: TEST_SIZES=2 node test/e2e-v2.mjs
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedWithTransferHookInstruction } from "@solana/spl-token";
import { rmSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "../lib/env.mjs";
import { dbcClient, getPool, getConfig } from "../lib/chain.mjs";
import BN from "bn.js";
import { ensureConfigs } from "../lib/configs.mjs";
import { buildLaunchTx, buildSwapTx, hookTransferAccounts, buildListTxs, listAddIx, listSealIx } from "../lib/launch.mjs";
import { DEFAULT_RULES, decodeRules, decodeList, hookPdas, hookErrorFromLogs, sortWallets } from "../lib/rules.mjs";

process.env.TEST_SIZES ||= "2";
const conn = connect(process.env.LOCAL_RPC || "http://127.0.0.1:8997", 0);
const dbc = dbcClient(conn);
const HOOK = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL("../keys/hooker-hook-keypair.json", import.meta.url))))).publicKey;
const DATA = new URL("../data/test-v2/", import.meta.url).pathname;
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });

let checks = 0;
const ok = (c, m) => { if (!c) { console.error("❌ FAIL:", m); process.exit(1); } checks++; console.log("✅", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fund(...kps) { for (const k of kps) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed"); }
const send = (tx, signers) => sendAndConfirmTransaction(conn, Array.isArray(tx) ? new Transaction().add(...tx) : tx, signers, { commitment: "confirmed" });
/** "passed", or the hook's refusal code, or "other: …" when it failed for another reason. */
async function hookCode(fn) {
  try { await fn(); return "passed"; } catch (e) {
    const code = hookErrorFromLogs(e.transactionLogs ?? e.logs, HOOK);
    return code ?? `other: ${String(e.message).slice(0, 160)}`;
  }
}
const ata = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
const bal = async (mint, owner) => { const a = await conn.getTokenAccountBalance(ata(mint, owner), "confirmed").catch(() => null); return a ? BigInt(a.value.amount) : 0n; };

const platform = Keypair.generate(), creator = Keypair.generate();
const W = Object.fromEntries(["A", "B", "C", "D", "E"].map((k) => [k, Keypair.generate()]));
await fund(platform, creator, ...Object.values(W));
await send([SystemProgram.transfer({ fromPubkey: platform.publicKey, toPubkey: new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"), lamports: 2 * LAMPORTS_PER_SOL })], [platform]);
// on mainnet Jito's tip accounts hold SOL; a fresh validator has none, and a tip below rent would fail
await send([SystemProgram.transfer({ fromPubkey: platform.publicKey, toPubkey: new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"), lamports: LAMPORTS_PER_SOL })], [platform]);
console.log("\n── configs");
const { configs, flatConfigs } = await ensureConfigs({ conn, platform, hookProgram: HOOK, dataDir: DATA, log: (m) => console.log("  ", m) });
const config = new PublicKey(configs[Object.keys(configs).map(Number).sort((a, b) => b - a)[0]]); // the biggest: nothing graduates by accident

const tokens = {};
async function launch(name, rules, devBuy = 100_000_000n, cfg = config) {
  const { tx, mint, pool } = await buildLaunchTx({ dbc, hookProgram: HOOK, config: cfg, creator: creator.publicKey, name, symbol: name.slice(0, 6).toUpperCase(),
    uri: "https://example.com/t.json", rules, devBuyLamports: devBuy });
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  await send(tx, [creator, mint]);
  const r = decodeRules((await conn.getAccountInfo(hookPdas(HOOK, mint.publicKey).cfg)).data);
  tokens[name] = { mint: mint.publicKey, pool, rules: r };
  return tokens[name];
}
/** A wallet's buy through Meteora's SDK — the same route FOMO, terminals and bots take. */
async function buy(t, who, lamports, { edit } = {}) {
  const tx = await buildSwapTx({ dbc, pool: t.pool, owner: who.publicKey, buy: true, amountIn: lamports });
  if (edit) edit(tx);
  return send(tx, [who]);
}
const sell = async (t, who, amount) => send(await buildSwapTx({ dbc, pool: t.pool, owner: who.publicKey, buy: false, amountIn: amount }), [who]);
async function walletTransfer(t, from, to, amount) {
  const ix = await createTransferCheckedWithTransferHookInstruction(conn, ata(t.mint, from.publicKey), t.mint, ata(t.mint, to), from.publicKey, amount, 6, [], "confirmed", TOKEN_2022_PROGRAM_ID);
  return send([createAssociatedTokenAccountIdempotentInstruction(from.publicKey, ata(t.mint, to), to, t.mint, TOKEN_2022_PROGRAM_ID), ix], [from]);
}
async function resolvedMatchesOurs(t) {
  const ix = await createTransferCheckedWithTransferHookInstruction(conn, PublicKey.default, t.mint, PublicKey.default, PublicKey.default, 0n, 6, [], "confirmed", TOKEN_2022_PROGRAM_ID);
  return JSON.stringify(ix.keys.slice(4).map((k) => [k.pubkey.toBase58(), k.isWritable])) === JSON.stringify(hookTransferAccounts(HOOK, t.mint, t.rules).map((k) => [k.pubkey.toBase58(), k.isWritable]));
}
const base = { ...DEFAULT_RULES, earlySecs: 0, earlyMaxWalletBps: 0, maxWalletBps: 0 };

// ── every hook off (the default since 4 Oct 2026), on a FLAT-fee config: no anti-snipe fee ────────
{
  const flatCfg = new PublicKey(flatConfigs[Object.keys(flatConfigs).map(Number).sort((a, b) => b - a)[0]]);
  const fee = async (pool) => { const p = await getPool(dbc, pool); return BigInt(p.partnerQuoteFee.toString()) + BigInt(p.protocolQuoteFee.toString()) + BigInt(p.creatorQuoteFee.toString()); };
  const F = await launch("Plain", { ...DEFAULT_RULES }, 100_000_000n, flatCfg);
  ok(!F.rules.venueLock && F.rules.maxWalletBps === 0 && F.rules.earlySecs === 0 && F.rules.holderShareBps === 0 && !F.rules.allowlist, "an all-defaults launch has every hook off on chain");
  const f0 = await fee(F.pool); await buy(F, W.E, 100_000_000n); const paid = Number(await fee(F.pool) - f0) / 1e8;
  ok(paid < 0.011, `no anti-snipe fee picked: a buy in the first seconds paid ${(paid * 100).toFixed(2)}%, the flat 1%`);
  await walletTransfer(F, W.E, W.D.publicKey, 1_000n); ok(true, "and it moves between wallets freely");
  const A = await launch("Snipy", { ...DEFAULT_RULES }, 100_000_000n, config);
  const a0 = await fee(A.pool); await buy(A, W.E, 100_000_000n); const paidA = Number(await fee(A.pool) - a0) / 1e8;
  ok(paidA > 0.35, `anti-snipe fee picked: a buy in the first seconds paid ${(paidA * 100).toFixed(1)}% (starts at 50%)`);

  // ── the creator's fee steps: the 3% step charges 4.25% and gives the creator 88% of what Meteora leaves ──
  const st = (await import("../lib/configs.mjs")).loadConfigState(DATA);
  const big = Object.keys(st.tierConfigs["3"].flat).map(Number).sort((a, b) => b - a)[0];
  const T3 = await launch("Fee3", { ...DEFAULT_RULES }, 100_000_000n, new PublicKey(st.tierConfigs["3"].flat[big]));
  const p0 = await getPool(dbc, T3.pool);
  const part = (p) => ({ c: BigInt(p.creatorQuoteFee.toString()), pl: BigInt(p.partnerQuoteFee.toString()), pr: BigInt(p.protocolQuoteFee.toString()) });
  const q0 = part(p0); await buy(T3, W.E, 1_000_000_000n); const q1 = part(await getPool(dbc, T3.pool));
  const dc = Number(q1.c - q0.c), dp = Number(q1.pl - q0.pl), dm = Number(q1.pr - q0.pr), tot = dc + dp + dm;
  ok(Math.abs(tot / 1e9 - 0.0425) < 0.0015, `the 3% step: a 1 SOL buy paid ${(tot / 1e7).toFixed(2)}% in fees (want 4.25%)`);
  ok(Math.abs(dc / 1e9 - 0.0299) < 0.001 && Math.abs(dp / 1e9 - 0.0041) < 0.0005, `of it the creator got ${(dc / 1e7).toFixed(2)}% and the platform ${(dp / 1e7).toFixed(2)}% (want ≈2.99% / 0.41%)`);
}

// ── allowlist ──────────────────────────────────────────────────────────────────────────────────
console.log("\n── allowlist");
const L = await launch("Allow", { ...base, allowlist: true });
ok(L.rules.version === 2 && L.rules.allowlist, "a v2 config with an allowlist reads back from chain");
ok(await resolvedMatchesOurs(L), "placeholder-key resolution (what Meteora's SDK, FOMO and bots use) finds the list account: it hangs off the mint alone");
ok((await hookCode(async () => buy(L, W.A, 50_000_000n))) === 6, "a wallet that is not on the allowlist cannot buy");
const listed = sortWallets([W.A.publicKey, W.B.publicKey, W.C.publicKey]);
{
  const { txs, added } = buildListTxs({ hookProgram: HOOK, dev: creator.publicKey, mint: L.mint, wallets: [W.C.publicKey, W.A.publicKey, W.B.publicKey, W.A.publicKey] });
  ok(added === 3 && txs.length === 1, "the list builder sorts and deduplicates the creator's wallets");
  for (const tx of txs) await send(tx, [creator]);
}
let list = decodeList((await conn.getAccountInfo(hookPdas(HOOK, L.mint).list)).data);
ok(list.count === 3 && !list.sealed && list.wallets.every((w, i) => w.equals(listed[i])), "the list holds the three wallets, sorted, still open");
ok((await hookCode(async () => buy(L, W.A, 50_000_000n))) === "passed", "a listed wallet can buy");
ok((await hookCode(async () => walletTransfer(L, W.A, W.D.publicKey, 1_000n))) === 6, "nor can tokens be sent to an unlisted wallet");
ok((await hookCode(async () => walletTransfer(L, W.A, W.B.publicKey, 1_000n))) === "passed", "tokens can be sent to another listed wallet");
{
  const below = Keypair.generate().publicKey;
  // find a key that sorts below the last listed one: it can never be appended
  let k = below; while (Buffer.compare(k.toBuffer(), listed[2].toBuffer()) > 0) k = Keypair.generate().publicKey;
  ok((await hookCode(async () => send([listAddIx({ hookProgram: HOOK, dev: creator.publicKey, mint: L.mint, wallets: [k] })], [creator]))) === 13, "wallets can only be appended in ascending order");
  const r = buildListTxs({ hookProgram: HOOK, dev: creator.publicKey, mint: L.mint, wallets: [k], already: list.wallets });
  ok(r.added === 0 && r.tooLate.length === 1, "the builder reports a wallet that can no longer fit instead of dropping it silently");
  ok((await hookCode(async () => send([listAddIx({ hookProgram: HOOK, dev: W.E.publicKey, mint: L.mint, wallets: [Keypair.generate().publicKey] })], [W.E]))) === 14, "only the creator can change the list");
}
await send([listSealIx({ hookProgram: HOOK, dev: creator.publicKey, mint: L.mint })], [creator]);
list = decodeList((await conn.getAccountInfo(hookPdas(HOOK, L.mint).list)).data);
ok(list.sealed, "the creator sealed the list");
{
  let k = Keypair.generate().publicKey; while (Buffer.compare(k.toBuffer(), listed[2].toBuffer()) < 0) k = Keypair.generate().publicKey;
  ok((await hookCode(async () => send([listAddIx({ hookProgram: HOOK, dev: creator.publicKey, mint: L.mint, wallets: [k] })], [creator]))) === 12, "a sealed list cannot grow");
}
ok((await hookCode(async () => sell(L, W.A, (await bal(L.mint, W.A.publicKey)) / 2n))) === "passed", "a listed holder can always sell");

// ── blocklist ──────────────────────────────────────────────────────────────────────────────────
console.log("\n── blocklist");
const B = await launch("Block", { ...base, blocklist: true });
ok(await resolvedMatchesOurs(B), "placeholder-key resolution finds the blocklist account");
ok((await hookCode(async () => buy(B, W.B, 50_000_000n))) === "passed", "before the list exists anyone can buy");
for (const tx of buildListTxs({ hookProgram: HOOK, dev: creator.publicKey, mint: B.mint, wallets: [W.C.publicKey], seal: true }).txs) await send(tx, [creator]);
ok((await hookCode(async () => buy(B, W.C, 50_000_000n))) === 7, "a blocked wallet cannot buy");
ok((await hookCode(async () => walletTransfer(B, W.B, W.C.publicKey, 1_000n))) === 7, "nor be sent tokens");
ok((await hookCode(async () => buy(B, W.D, 50_000_000n))) === "passed", "everyone else can");
ok((await hookCode(async () => sell(B, W.B, (await bal(B.mint, W.B.publicKey)) / 2n))) === "passed", "sells pass");

// ── trade guard ────────────────────────────────────────────────────────────────────────────────
console.log("\n── trade guard (0.5% of supply per transfer)");
const G = await launch("Guard", { ...base, tradeGuardBps: 50 });
ok((await hookCode(async () => buy(G, W.A, 1_000_000_000n))) === 8, "a buy of more than 0.5% of supply in one go is refused");
ok((await hookCode(async () => buy(G, W.A, 30_000_000n))) === "passed", "a smaller buy passes");
ok((await hookCode(async () => sell(G, W.A, await bal(G.mint, W.A.publicKey)))) === "passed", "a sell passes whatever its size");

// ── the platform's own fee claim (what claim-abandoned-fees does, on a curve with trades) ─────────
{
  const before = await conn.getBalance(platform.publicKey, "confirmed");
  const p0 = await getPool(dbc, G.pool);
  ok(BigInt(p0.partnerQuoteFee.toString()) > 0n, "the trade-guard token's pool holds platform fees from its trades");
  const tx = await dbc.partner.claimPartnerTradingFee2({ feeClaimer: platform.publicKey, payer: platform.publicKey, receiver: platform.publicKey, pool: G.pool, maxBaseAmount: new BN("18446744073709551615"), maxQuoteAmount: new BN("18446744073709551615") });
  await send(tx, [platform]);
  ok((await conn.getBalance(platform.publicKey, "confirmed")) > before && BigInt((await getPool(dbc, G.pool)).partnerQuoteFee.toString()) === 0n, "the hot wallet can claim the platform's fees from a live curve, and the pool's counter resets");
  ok((await hookCode(async () => send(await dbc.partner.claimPartnerTradingFee2({ feeClaimer: W.E.publicKey, payer: W.E.publicKey, receiver: W.E.publicKey, pool: G.pool, maxBaseAmount: new BN(1), maxQuoteAmount: new BN(1) }), [W.E]))) !== "passed", "nobody else can");
}

// ── rising max per wallet ──────────────────────────────────────────────────────────────────────
console.log("\n── rising max per wallet (0.5% → 3% over 40 s)");
const R = await launch("Ramp", { ...base, maxWalletBps: 300, rampStartBps: 50, rampSecs: 40 });
ok((await hookCode(async () => buy(R, W.A, 400_000_000n))) === 1, "right after launch a wallet cannot go past the starting cap");
ok((await hookCode(async () => buy(R, W.A, 100_000_000n))) === "passed", "a buy under the starting cap passes");
await sleep(42_000);
ok((await hookCode(async () => buy(R, W.A, 400_000_000n))) === "passed", "once the ramp has risen, the same buy passes");

// ── trading hours ──────────────────────────────────────────────────────────────────────────────
console.log("\n── trading hours");
{
  const now = await conn.getBlockTime(await conn.getSlot("confirmed"));
  const tz = 120, local = now + tz * 60, minute = Math.floor((((local % 86_400) + 86_400) % 86_400) / 60);
  const closed = await launch("Closed", { ...base, hoursOn: true, hoursDays: 127, hoursOpenMin: (minute + 120) % 1440, hoursCloseMin: (minute + 180) % 1440, tzOffsetMin: tz });
  ok((await hookCode(async () => buy(closed, W.A, 50_000_000n))) === 9, "outside its hours a token cannot be bought");
  const open = await launch("Open", { ...base, hoursOn: true, hoursDays: 127, hoursOpenMin: (minute + 1380) % 1440, hoursCloseMin: (minute + 60) % 1440, tzOffsetMin: tz });
  ok((await hookCode(async () => buy(open, W.A, 50_000_000n))) === "passed", "inside its hours it can (a window across midnight in UTC+2)");
  const wd = (Math.floor(local / 86_400) + 4) % 7;
  const otherDay = await launch("OffDay", { ...base, hoursOn: true, hoursDays: 127 & ~(1 << wd) & ~(1 << ((wd + 6) % 7)), hoursOpenMin: (minute + 1380) % 1440, hoursCloseMin: (minute + 60) % 1440, tzOffsetMin: tz });
  ok((await hookCode(async () => buy(otherDay, W.A, 50_000_000n))) === 9, "on a day the token is closed it cannot be bought, even at an open hour");
  ok((await hookCode(async () => walletTransfer(open, W.A, W.B.publicKey, 1_000n))) === "passed", "wallet-to-wallet transfers are not trades and pass");
}

// ── sniper-fee cap ─────────────────────────────────────────────────────────────────────────────
console.log("\n── sniper-fee cap (first 5 minutes: ≤ 50,000 µL/CU, ≤ 0.0001 SOL tip)");
const S = await launch("Snipe", { ...base, snipeSecs: 300, snipeMaxCuPrice: 50_000, snipeMaxTip: 100_000 });
const setPrice = (p) => (tx) => {
  const i = tx.instructions.findIndex((x) => x.programId.equals(ComputeBudgetProgram.programId) && x.data[0] === 3);
  const ix = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p });
  if (i >= 0) tx.instructions[i] = ix; else tx.instructions.unshift(ix);
};
const tip = (lamports) => (tx) => tx.add(SystemProgram.transfer({ fromPubkey: tx.feePayer, toPubkey: new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"), lamports }));
ok((await hookCode(async () => buy(S, W.A, 50_000_000n, { edit: setPrice(1_000_000) }))) === 10, "a buy paying a sniper-sized priority fee is refused");
ok((await hookCode(async () => buy(S, W.A, 50_000_000n, { edit: tip(1_000_000) }))) === 10, "a buy tipping Jito 0.001 SOL is refused");
{ const r = await hookCode(async () => buy(S, W.A, 50_000_000n, { edit: (tx) => { setPrice(20_000)(tx); tip(50_000)(tx); } }));
  if (r !== "passed") console.log("   got:", r);
  ok(r === "passed", "a buy with a normal fee and a small tip passes"); }
ok((await hookCode(async () => sell(S, W.A, (await bal(S.mint, W.A.publicKey)) / 2n))) === "passed", "sells are never fee-capped");

// ── anti-bundle ────────────────────────────────────────────────────────────────────────────────
console.log("\n── anti-bundle (1 buy per block)");
const U = await launch("Bundle", { ...base, bundleMax: 1 });
ok(await resolvedMatchesOurs(U), "placeholder-key resolution finds the counter, writable");
{
  const t1 = await buildSwapTx({ dbc, pool: U.pool, owner: W.A.publicKey, buy: true, amountIn: 50_000_000n });
  const t2 = await buildSwapTx({ dbc, pool: U.pool, owner: W.B.publicKey, buy: true, amountIn: 50_000_000n });
  const strip = (tx) => tx.instructions.filter((x) => !x.programId.equals(ComputeBudgetProgram.programId));
  const both = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...strip(t1), ...strip(t2));
  both.feePayer = W.A.publicKey;
  ok((await hookCode(async () => send(both, [W.A, W.B]))) === 11, "two buys bundled into one block are refused");
  ok((await hookCode(async () => buy(U, W.A, 50_000_000n))) === "passed", "a single buy passes");
  // a direct `execute` call cannot move the counter: the source account is not mid-transfer
  const { cfg, slot, extraAccountMetas } = hookPdas(HOOK, U.mint);
  const pool = await getPool(dbc, U.pool);
  const exec = new TransactionInstruction({ programId: HOOK, keys: [
    { pubkey: pool.baseVault, isSigner: false, isWritable: false }, { pubkey: U.mint, isSigner: false, isWritable: false },
    { pubkey: ata(U.mint, W.A.publicKey), isSigner: false, isWritable: false }, { pubkey: W.E.publicKey, isSigner: false, isWritable: false },
    { pubkey: extraAccountMetas, isSigner: false, isWritable: false }, { pubkey: cfg, isSigner: false, isWritable: false },
    { pubkey: new PublicKey("Sysvar1nstructions1111111111111111111111111"), isSigner: false, isWritable: false },
    { pubkey: slot, isSigner: false, isWritable: true } ],
    data: Buffer.concat([Buffer.from([105, 37, 101, 197, 75, 251, 102, 26]), Buffer.alloc(8)]) });
  const before = (await conn.getAccountInfo(slot)).data.toString("hex");
  ok((await hookCode(async () => send([exec], [W.E]))) !== "passed", "calling the hook directly outside a transfer is refused");
  ok((await conn.getAccountInfo(slot)).data.toString("hex") === before, "and leaves the counter untouched, so nobody can jam the token");
  // the review's attack: another token's REAL vault (Token-2022, owned by the pool authority) as the source
  const otherPool = await getPool(dbc, L.pool);
  const forged = new TransactionInstruction({ programId: HOOK, keys: exec.keys.map((k, i) => (i === 0 ? { ...k, pubkey: otherPool.baseVault } : k)), data: exec.data });
  ok((await hookCode(async () => send([forged], [W.E]))) !== "passed", "another token's vault cannot stand in for this token's source");
  // a source that is not a Token-2022 account at all
  const fake = new TransactionInstruction({ programId: HOOK, keys: exec.keys.map((k, i) => (i === 0 ? { ...k, pubkey: W.E.publicKey } : k)), data: exec.data });
  ok((await hookCode(async () => send([fake], [W.E]))) !== "passed", "nor can an account that is not a Token-2022 account");
  ok((await conn.getAccountInfo(slot)).data.toString("hex") === before, "the counter is still untouched");
  ok((await hookCode(async () => sell(U, W.A, (await bal(U.mint, W.A.publicKey)) / 2n))) === "passed", "sells are not counted");
}

// ── everything at once, through to a full curve ───────────────────────────────────────────────
console.log("\n── allowlist + anti-bundle + trade guard on the 2 SOL test curve, filled");
{
  const small = new PublicKey(configs[Object.keys(configs).map(Number).sort((a, b) => a - b)[0]]);
  const { tx, mint, pool } = await buildLaunchTx({ dbc, hookProgram: HOOK, config: small, creator: creator.publicKey, name: "All", symbol: "ALL", uri: "https://example.com/t.json",
    rules: { ...base, allowlist: true, bundleMax: 2, tradeGuardBps: 10_000 }, devBuyLamports: 100_000_000n });
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  await send(tx, [creator, mint]);
  const T = { mint: mint.publicKey, pool, rules: decodeRules((await conn.getAccountInfo(hookPdas(HOOK, mint.publicKey).cfg)).data) };
  for (const t of buildListTxs({ hookProgram: HOOK, dev: creator.publicKey, mint: T.mint, wallets: [W.D.publicKey], seal: true }).txs) await send(t, [creator]);
  // ⚠ 5 SOL: in its first seconds the 50% anti-snipe fee takes half of a buy, and 2 SOL must reach the curve
  ok((await hookCode(async () => buy(T, W.D, 5_000_000_000n))) === "passed", "a listed wallet's buy fills the curve (Meteora switches the hook off in it)");
  const p = await getPool(dbc, pool);
  // Meteora's own stage (2 = LockedVesting: complete, ready to migrate), not just "it holds SOL"
  ok(p.isMigrated === 0 && Number(p.migrationProgress) === 2, `the curve is full and ready for the graduation service (Meteora stage ${p.migrationProgress})`);
  ok((await hookCode(async () => buy(T, W.E, 10_000_000n))) !== "passed", "no buys after the curve is full");

  // the creator's fees: claimable while it trades AND after the curve has migrated (both by the creator alone)
  const claim = async (who) => send(await dbc.creator.claimCreatorTradingFee2({ creator: who.publicKey, payer: who.publicKey, receiver: who.publicKey, pool, maxBaseAmount: new BN("18446744073709551615"), maxQuoteAmount: new BN("18446744073709551615") }), [who]);
  ok((await hookCode(async () => claim(W.E))) !== "passed", "nobody but the creator can claim the creator's trading fees");
  const { DAMM_V2_MIGRATION_FEE_ADDRESS } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const cfg = await getConfig(dbc, small);
  const migrate = async () => { const m = await dbc.migration.migrateToDammV2({ payer: W.E.publicKey, pool, dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[cfg.migrationFeeOption] }); return send(m.transaction, [W.E, m.firstPositionNftKeypair, m.secondPositionNftKeypair]); };
  await migrate();
  ok((await getPool(dbc, pool)).isMigrated !== 0, "the curve migrated (anyone may trigger it, as the graduator does)");
  const before = await conn.getBalance(creator.publicKey, "confirmed");
  ok((await hookCode(async () => claim(creator))) === "passed" && (await conn.getBalance(creator.publicKey, "confirmed")) > before, "after migration the creator still claims their trading fees, and receives SOL");
}

console.log(`\n${checks} checks passed`);
process.exit(0);
