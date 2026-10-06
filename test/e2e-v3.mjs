// The v3 rules end to end on the local validator (scripts/validator.sh, with the v3 hook in fixtures/):
// anti-dump caps, graduated sell caps, plague, DEX-only, P2P-only, hot potato, ping pong, chapters, the
// three oscillators, King of the Hill (with the keeper's payouts) and trading hours with daylight saving
// and closed sells. Each on its own token, traded through Meteora's real program the way a buyer's
// wallet would, launched as a v0 transaction over the lookup table exactly like the API does.
// Run: TEST_SIZES=2 node test/e2e-v3.mjs
import { Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedWithTransferHookInstruction } from "@solana/spl-token";
import { rmSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "../lib/env.mjs";
import { dbcClient, getPool } from "../lib/chain.mjs";
import { ensureConfigs } from "../lib/configs.mjs";
import { ensureLut } from "../lib/lut.mjs";
import { openDb } from "../lib/db.mjs";
import { buildLaunchTx, buildSwapTx, hookTransferAccounts, launchSize, launchStaticKeys } from "../lib/launch.mjs";
import { DEFAULT_RULES, decodeRules, decodeState, hookPdas, hookErrorFromLogs, oscCapBps, kingBar, OSC, KING_BPS } from "../lib/rules.mjs";
import { initKings, syncKings, payKings, kingOwedTotal, owedFor } from "../lib/king.mjs";

process.env.TEST_SIZES ||= "2";
const conn = connect(process.env.LOCAL_RPC || "http://127.0.0.1:8997", 0);
const dbc = dbcClient(conn);
const HOOK = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL("../keys/hooker-hook-keypair.json", import.meta.url))))).publicKey;
const DATA = new URL("../data/test-v3/", import.meta.url).pathname;
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });

let checks = 0;
const ok = (c, m) => { if (!c) { console.error("❌ FAIL:", m); process.exit(1); } checks++; console.log("✅", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fund(...kps) { for (const k of kps) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed"); }
const send = (tx, signers) => sendAndConfirmTransaction(conn, Array.isArray(tx) ? new Transaction().add(...tx) : tx, signers, { commitment: "confirmed" });
async function hookCode(fn) {
  try { await fn(); return "passed"; } catch (e) {
    const code = hookErrorFromLogs(e.transactionLogs ?? e.logs, HOOK);
    if (process.env.DEBUG) console.log((e.transactionLogs ?? e.logs ?? [String(e.message)]).filter((l) => /log|failed|consumed/i.test(l)).join("\n"));
    return code ?? `other: ${String(e.message).slice(0, 200)}`;
  }
}
const ata = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
const bal = async (mint, owner) => { const a = await conn.getTokenAccountBalance(ata(mint, owner), "confirmed").catch(() => null); return a ? BigInt(a.value.amount) : 0n; };
const chainNow = async () => conn.getBlockTime(await conn.getSlot("confirmed"));

const platform = Keypair.generate(), creator = Keypair.generate();
const W = Object.fromEntries(["A", "B", "C", "D", "E"].map((k) => [k, Keypair.generate()]));
await fund(platform, creator, ...Object.values(W));
console.log("\n── configs + lookup table");
const { configs, flatConfigs } = await ensureConfigs({ conn, platform, hookProgram: HOOK, dataDir: DATA, log: (m) => console.log("  ", m) });
// the biggest FLAT config: no anti-snipe fee to distort sizes, and nothing graduates by accident
const config = new PublicKey(flatConfigs[Object.keys(flatConfigs).map(Number).sort((a, b) => b - a)[0]]);
const lut = await ensureLut({ conn, payer: platform, keys: await launchStaticKeys({ dbc, hookProgram: HOOK, configs: [...Object.values(configs), ...Object.values(flatConfigs)] }), log: (m) => console.log("  ", m) });

const SUPPLY = 1_000_000_000_000_000n; // 1B tokens, 6 decimals
const pctOf = (bps) => (SUPPLY * BigInt(Math.round(bps * 100))) / 1_000_000n; // bps (may be fractional) → base units
async function launch(name, rules, devBuy = 100_000_000n) {
  const built = await buildLaunchTx({ dbc, hookProgram: HOOK, config, creator: creator.publicKey, name, symbol: name.slice(0, 6).toUpperCase(),
    uri: "https://gateway.pinata.cloud/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy", rules, devBuyLamports: devBuy, lut });
  const { tx, mint, pool } = built;
  const size = launchSize(tx);
  tx.message.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign([creator, mint]);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction(sig, "confirmed");
  const st = await conn.getSignatureStatus(sig);
  if (st.value?.err) throw new Error(`launch failed: ${JSON.stringify(st.value.err)}`);
  const r = decodeRules((await conn.getAccountInfo(hookPdas(HOOK, mint.publicKey).cfg)).data);
  return { mint: mint.publicKey, pool, rules: r, size };
}
/** Lamports that buy about `bps` of supply at the pool's current price (flat 1% fee). */
async function lamportsFor(t, bps) {
  const p = await getPool(dbc, t.pool);
  const price = (Number(BigInt(p.sqrtPrice.toString())) / 2 ** 64) ** 2; // lamports per base unit
  return BigInt(Math.ceil(Number(pctOf(bps)) * price / 0.99));
}
const buyBps = async (t, who, bps) => send(await buildSwapTx({ dbc, pool: t.pool, owner: who.publicKey, buy: true, amountIn: await lamportsFor(t, bps) }), [who]);
const buySol = async (t, who, lamports) => send(await buildSwapTx({ dbc, pool: t.pool, owner: who.publicKey, buy: true, amountIn: lamports }), [who]);
const sell = async (t, who, amount) => send(await buildSwapTx({ dbc, pool: t.pool, owner: who.publicKey, buy: false, amountIn: amount }), [who]);
async function walletTransfer(t, from, to, amount) {
  const ix = await createTransferCheckedWithTransferHookInstruction(conn, ata(t.mint, from.publicKey), t.mint, ata(t.mint, to), from.publicKey, amount, 6, [], "confirmed", TOKEN_2022_PROGRAM_ID);
  return send([createAssociatedTokenAccountIdempotentInstruction(from.publicKey, ata(t.mint, to), to, t.mint, TOKEN_2022_PROGRAM_ID), ix], [from]);
}
async function resolvedMatchesOurs(t) {
  const ix = await createTransferCheckedWithTransferHookInstruction(conn, PublicKey.default, t.mint, PublicKey.default, PublicKey.default, 0n, 6, [], "confirmed", TOKEN_2022_PROGRAM_ID);
  return JSON.stringify(ix.keys.slice(4).map((k) => [k.pubkey.toBase58(), k.isWritable])) === JSON.stringify(hookTransferAccounts(HOOK, t.mint, t.rules, t.pool).map((k) => [k.pubkey.toBase58(), k.isWritable]));
}
const state = async (t) => decodeState((await conn.getAccountInfo(hookPdas(HOOK, t.mint).state, "confirmed"))?.data);
const off = { ...DEFAULT_RULES };
/** ONLY=ping,king node test/e2e-v3.mjs runs just those sections. */
const want = (k) => !process.env.ONLY || process.env.ONLY.split(",").includes(k);

// ── a launch without v3 rules is exactly what it was ─────────────────────────────────────────────
console.log("\n── no v3 rules: unchanged");
if (want("plain")) {
  const P = await launch("Plain", { ...off, maxWalletBps: 300 });
  const raw = (await conn.getAccountInfo(hookPdas(HOOK, P.mint).cfg)).data;
  ok(raw.length === 256 && raw.subarray(168).every((b) => b === 0), "a launch without v3 rules writes the same 256-byte v2 config (v3 bytes all zero)");
  ok(!(await conn.getAccountInfo(hookPdas(HOOK, P.mint).state)), "and gets no state account");
  ok(await resolvedMatchesOurs(P), "its transfers resolve the same extra accounts as before");
}

// ── anti-dump caps ──────────────────────────────────────────────────────────────────────────────
console.log("\n── anti-dump caps (max buy 0.5%, max sell 0.2%)");
if (want("antidump")) {
  const T = await launch("Dump", { ...off, maxBuyBps: 50, maxSellBps: 20 });
  ok(T.rules.maxBuyBps === 50 && T.rules.maxSellBps === 20, "the caps read back from chain");
  ok((await hookCode(() => buyBps(T, W.A, 80))) === 15, "a 0.8% buy is refused");
  ok((await hookCode(() => buyBps(T, W.A, 35))) === "passed", "a 0.35% buy passes");
  ok((await hookCode(() => sell(T, W.A, pctOf(30)))) === 16, "a 0.3% sell is refused");
  ok((await hookCode(() => sell(T, W.A, pctOf(15)))) === "passed", "a 0.15% sell passes");
  ok((await hookCode(() => sell(T, creator, pctOf(25)))) === 16, "the creator is not exempt from the sell cap");
  ok((await hookCode(() => walletTransfer(T, W.A, W.B.publicKey, pctOf(10)))) === "passed", "sends are not trades: they pass");
}

// ── graduated sell caps ─────────────────────────────────────────────────────────────────────────
console.log("\n── graduated sell caps (1% for small bags, 0.1% from a 2% bag)");
if (want("sellscale")) {
  const T = await launch("GradSell", { ...off, sellSmallBps: 100, sellFloorBps: 10, sellBagBps: 200 });
  await buyBps(T, W.B, 250); await buyBps(T, W.A, 30);
  ok((await hookCode(() => sell(T, W.B, pctOf(50)))) === 16, "a whale (2.5% bag) cannot sell 0.5% in one go");
  ok((await hookCode(() => sell(T, W.B, pctOf(8)))) === "passed", "the whale can sell 0.08%");
  ok((await hookCode(async () => sell(T, W.A, await bal(T.mint, W.A.publicKey)))) === "passed", "a small holder (0.3% bag) sells everything at once");
}

// ── plague ──────────────────────────────────────────────────────────────────────────────────────
console.log("\n── plague (dose 1 token)");
if (want("plague")) {
  const T = await launch("Plague", { ...off, plagueDose: 1_000_000 });
  ok((await hookCode(() => buySol(T, W.A, 50_000_000n))) === 17, "an uninfected wallet cannot buy");
  await walletTransfer(T, creator, W.A.publicKey, 2_000_000n);
  ok((await hookCode(() => buySol(T, W.A, 50_000_000n))) === "passed", "once the creator sends it a dose, it can");
  await walletTransfer(T, W.A, W.B.publicKey, 1_000_000n);
  ok((await hookCode(() => buySol(T, W.B, 50_000_000n))) === "passed", "and it infects another wallet by sending a dose");
  await walletTransfer(T, W.A, W.C.publicKey, 500_000n);
  ok((await hookCode(() => buySol(T, W.C, 50_000_000n))) === 17, "half a dose does not infect");
  ok((await hookCode(async () => sell(T, W.A, await bal(T.mint, W.A.publicKey)))) === "passed", "selling is never restricted");
  ok((await hookCode(() => buySol(T, W.A, 50_000_000n))) === 17, "a wallet that sold everything has to be infected again");
}

// ── DEX-only ────────────────────────────────────────────────────────────────────────────────────
console.log("\n── DEX-only");
if (want("dex")) {
  const T = await launch("DexOnly", { ...off, dexOnly: true });
  ok((await hookCode(() => buySol(T, W.A, 50_000_000n))) === "passed", "buys work");
  ok((await hookCode(() => walletTransfer(T, W.A, W.B.publicKey, 1_000n))) === 18, "a wallet-to-wallet send is refused");
  ok((await hookCode(() => walletTransfer(T, creator, W.B.publicKey, 1_000n))) === 18, "the creator's too");
  ok((await hookCode(async () => sell(T, W.A, await bal(T.mint, W.A.publicKey)))) === "passed", "sells work");
}

// ── P2P-only ────────────────────────────────────────────────────────────────────────────────────
console.log("\n── P2P-only");
if (want("p2p")) {
  const T = await launch("P2P", { ...off, p2pOnly: true });
  ok((await bal(T.mint, creator.publicKey)) > 0n, "the creator's launch buy went through");
  ok((await hookCode(() => buySol(T, W.A, 50_000_000n))) === 19, "nobody else can buy from the curve");
  ok((await hookCode(() => walletTransfer(T, creator, W.A.publicKey, pctOf(10)))) === "passed", "the creator hands tokens out");
  ok((await hookCode(() => walletTransfer(T, W.A, W.B.publicKey, pctOf(5)))) === "passed", "and they move wallet to wallet");
  ok((await hookCode(() => sell(T, W.A, pctOf(1)))) === 19, "nobody can sell to the curve");
  ok((await hookCode(() => sell(T, creator, pctOf(1)))) === 19, "the creator neither");
}

// ── hot potato ──────────────────────────────────────────────────────────────────────────────────
console.log("\n── hot potato (min 0.01%, cold after 6 s)");
if (want("potato")) {
  const T = await launch("Potato", { ...off, potatoOn: true, potatoMinBps: 1, potatoColdSecs: 6 });
  ok(await resolvedMatchesOurs(T), "placeholder-key resolution (Meteora's SDK, FOMO, bots) finds the state account: it hangs off the mint alone");
  ok((await state(T)).potato.holder === creator.publicKey.toBase58(), "the creator's launch buy took the potato (nobody is exempt)");
  ok((await hookCode(() => walletTransfer(T, creator, W.E.publicKey, 1_000n))) === 21, "so the creator cannot send");
  await buyBps(T, W.A, 10);
  ok((await state(T)).potato.holder === W.A.publicKey.toBase58(), "A's buy passes the potato to A");
  ok((await hookCode(() => walletTransfer(T, creator, W.E.publicKey, 1_000n))) === "passed", "the creator is free again");
  ok((await hookCode(() => sell(T, W.A, pctOf(1)))) === 21, "A cannot sell");
  ok((await hookCode(() => walletTransfer(T, W.A, W.B.publicKey, 1_000n))) === 21, "nor send");
  await buySol(T, W.B, 1_000_000n);
  ok((await state(T)).potato.holder === W.A.publicKey.toBase58(), "a dust buy goes through but does not pass the potato");
  await buyBps(T, W.B, 10);
  ok((await hookCode(() => sell(T, W.A, pctOf(1)))) === "passed", "once B buys properly, A sells");
  ok((await hookCode(() => sell(T, W.B, pctOf(1)))) === 21, "and B holds the potato");
  await sleep(7_000);
  ok((await hookCode(() => sell(T, W.B, pctOf(1)))) === "passed", "after 6 s without a buy the potato is cold: B sells");
  // a direct `execute` call (no transfer) cannot move the state
  const { cfg, state: st, extraAccountMetas } = hookPdas(HOOK, T.mint);
  const before = (await conn.getAccountInfo(st)).data.toString("hex");
  const exec = new TransactionInstruction({ programId: HOOK, keys: [
    { pubkey: (await getPool(dbc, T.pool)).baseVault, isSigner: false, isWritable: false }, { pubkey: T.mint, isSigner: false, isWritable: false },
    { pubkey: ata(T.mint, W.E.publicKey), isSigner: false, isWritable: false }, { pubkey: W.E.publicKey, isSigner: false, isWritable: false },
    { pubkey: extraAccountMetas, isSigner: false, isWritable: false }, { pubkey: cfg, isSigner: false, isWritable: false },
    { pubkey: new PublicKey("Sysvar1nstructions1111111111111111111111111"), isSigner: false, isWritable: false },
    { pubkey: st, isSigner: false, isWritable: true }],
    data: Buffer.concat([Buffer.from([105, 37, 101, 197, 75, 251, 102, 26]), Buffer.from(new BigUint64Array([10n ** 13n]).buffer)]) });
  ok((await hookCode(() => send([exec], [W.E]))) !== "passed", "calling the hook directly (a forged 'buy' to E) is refused");
  ok((await conn.getAccountInfo(st)).data.toString("hex") === before, "and the potato did not move");
}

// ── ping pong ───────────────────────────────────────────────────────────────────────────────────
console.log("\n── ping pong (min 0.01%, turn frees after 8 s)");
if (want("ping")) {
  const T = await launch("PingPong", { ...off, pingOn: true, pingMinBps: 1, pingFreeSecs: 8 });
  ok((await state(T)).ping.next === "sell", "the creator's launch buy took the first turn: sellers next");
  ok((await hookCode(() => buyBps(T, W.A, 10))) === 22, "a buy now is refused");
  const c1 = await hookCode(() => sell(T, creator, pctOf(5)));
  ok(c1 === "passed", `a sell takes the turn (the creator too plays by it) [${c1}]`);
  ok((await hookCode(() => buyBps(T, W.A, 10))) === "passed", "then a buy");
  ok((await hookCode(() => buyBps(T, W.B, 10))) === 22, "and a second buy in a row is refused");
  ok((await hookCode(() => sell(T, W.A, pctOf(0.5)))) === "passed", "a dust sell goes through on its own turn");
  ok((await state(T)).ping.next === "sell", "without handing the turn over");
  {
    // one transaction taking both turns: sell (sellers' turn) then buy (would be the buyers' turn)
    const s1 = await buildSwapTx({ dbc, pool: T.pool, owner: W.A.publicKey, buy: false, amountIn: pctOf(5) });
    const b1 = await buildSwapTx({ dbc, pool: T.pool, owner: W.A.publicKey, buy: true, amountIn: await lamportsFor(T, 5) });
    const both = new Transaction().add(...s1.instructions, ...b1.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)));
    ok((await hookCode(() => send(both, [W.A]))) === 22, "a sell and a buy in one transaction is refused: one transaction cannot take both turns");
  }
  ok((await hookCode(() => sell(T, W.A, pctOf(5)))) === "passed", "the sell on its own passes");
  await sleep(9_000);
  ok((await hookCode(() => sell(T, W.A, pctOf(2)))) === "passed", "after 8 s nobody took the buyers' turn: either side may go");
}

// ── chapters ────────────────────────────────────────────────────────────────────────────────────
console.log("\n── chapters (0.5% per wallet, doubling every 1% of supply traded)");
if (want("chapters")) {
  const T = await launch("Chapters", { ...off, chapterStartBps: 50, chapterVolume: Number(pctOf(100)) });
  const ch1 = await hookCode(() => buyBps(T, W.A, 70));
  ok(ch1 === 24, `in chapter 1 a 0.7% bag is refused [${ch1}]`);
  await buyBps(T, W.B, 40); await buyBps(T, W.C, 40);
  const v = (await state(T)).volume;
  ok(v >= pctOf(100), `the state counted ${(Number(v) / Number(SUPPLY) * 100).toFixed(2)}% of supply traded: chapter 2`);
  ok((await hookCode(() => buyBps(T, W.A, 70))) === "passed", "now the cap is 1% and the 0.7% buy passes");
  ok((await hookCode(async () => sell(T, W.A, await bal(T.mint, W.A.publicKey)))) === "passed", "selling always works");
}

// ── oscillators ─────────────────────────────────────────────────────────────────────────────────
console.log("\n── oscillators");
for (const [name, osc] of [
  ["Breath", { oscKind: OSC.breath, oscPeriod: 3_600, oscBaseBps: 100, oscAmpPct: 100, oscFloorBps: 10 }],
  ["Momentum", { oscKind: OSC.momentum, oscPeriod: 240, oscDampPermille: 10, oscAmpPct: 100, oscBaseBps: 50, oscFloorBps: 20 }],
  ["Resonance", { oscKind: OSC.resonance, oscPeriod: 240, oscDampPermille: 10, oscAmpPct: 100, oscBaseBps: 50, oscFloorBps: 20 }],
  ["Coupled", { oscKind: OSC.coupled, oscPeriod: 240, oscDampPermille: 10, oscCouplingPct: 20, oscAmpPct: 100, oscBaseBps: 50, oscFloorBps: 20 }],
]) {
  if (!want("osc") && !want(name.toLowerCase())) continue;
  const T = await launch(name, { ...off, ...osc });
  const capNow = async () => oscCapBps(T.rules, await state(T), await chainNow());
  let cap = await capNow();
  ok((await hookCode(() => buyBps(T, W.A, cap * 1.4))) === 23, `${name}: a buy 40% over the cap the site shows (${(cap / 100).toFixed(2)}%) is refused`);
  ok((await hookCode(() => buyBps(T, W.A, cap * 0.85))) === "passed", `${name}: a buy at 85% of it passes`);
  if (osc.oscKind !== OSC.breath) {
    await sleep(35_000); // about a seventh of a period: the kick has swung the cap up
    cap = await capNow();
    ok(cap > osc.oscBaseBps * 1.15, `${name}: the buy kicked the oscillator: the cap swung up to ${(cap / 100).toFixed(2)}% from ${(osc.oscBaseBps / 100).toFixed(2)}%`);
    ok((await hookCode(() => buyBps(T, W.B, cap * 0.8))) === "passed", `${name}: a buy the resting cap would refuse now passes (the hook and the site agree)`);
    cap = await capNow();
    ok((await hookCode(() => buyBps(T, W.C, cap * 1.4))) === 23, `${name}: and 40% over the moving cap is still refused`);
  }
}

// ── King of the Hill ────────────────────────────────────────────────────────────────────────────
console.log("\n── King of the Hill (crown from 0.05 SOL, beat by 10%, bar halves every 6 h)");
if (want("king")) {
  const T = await launch("King", { ...off, kingOn: true, kingMinLamports: 50_000_000, kingBeatPct: 10, kingDecayUnit: 2, kingDecayN: 6 });
  console.log(`   launch transaction: ${T.size} bytes (v0 over the lookup table; limit 1,232)`);
  ok(T.size <= 1232, "a King launch with a dev buy fits one transaction");
  ok(await resolvedMatchesOurs(T), "placeholder-key resolution finds the state account and the pool");
  ok(!(await state(T)).king.king, "the creator's launch buy does not crown the creator (not allowed by default)");
  await buySol(T, W.A, 20_000_000n);
  ok(!(await state(T)).king.king, "a 0.02 SOL buy is under the minimum: no King");
  await buySol(T, W.A, 100_000_000n);
  let s = await state(T);
  const bid = Number(s.king.bidLamports) / 1e9;
  ok(s.king.king === W.A.publicKey.toBase58() && s.king.reign === 1, `A takes the crown with a 0.1 SOL buy (valued at ${bid.toFixed(4)} SOL at the pool's price)`);
  ok(bid > 0.095 && bid < 0.105, "the buy is valued at what it paid into the curve (within 5%)");
  const bar = kingBar(T.rules, s, await chainNow());
  await buySol(T, W.B, bar * 95n / 100n);
  ok((await state(T)).king.king === W.A.publicKey.toBase58(), "B's buy just under the bar (bid + 10%) does not take it");
  await buySol(T, W.B, 200_000_000n);
  s = await state(T);
  ok(s.king.king === W.B.publicKey.toBase58() && s.king.reign === 2, "B's 0.2 SOL buy takes the crown: reign 2");
  const r1 = s.reigns.find((r) => r.reign === 1);
  ok(r1.ended && Number(r1.valueLamports) > 0.28e9 && Number(r1.valueLamports) < 0.32e9, `A's reign ended with ${(Number(r1.valueLamports) / 1e9).toFixed(3)} SOL traded during it (B's two buys)`);
  await walletTransfer(T, W.B, W.C.publicKey, 1_000n);
  s = await state(T);
  ok(!s.king.king && s.reigns.find((r) => r.reign === 2).ended, "B sent tokens away: the crown is given up, the throne is empty");
  await buySol(T, W.C, 60_000_000n);
  ok((await state(T)).king.king === W.C.publicKey.toBase58(), "with the throne empty, the minimum takes it: C is King");
  await sell(T, W.A, (await bal(T.mint, W.A.publicKey)) / 2n);

  // the keeper: copies the reigns into the ledger and pays each King KING_BPS of their reign's value
  const db = openDb(":memory:"); initKings(db);
  await syncKings({ conn, db, hookProgram: HOOK, mints: [T.mint.toBase58()] });
  const owed = kingOwedTotal(db, T.mint.toBase58());
  s = await state(T);
  const expect = s.reigns.reduce((a, r) => a + owedFor(r.valueLamports), 0n);
  ok(owed === expect && owed > 0n, `the ledger owes the Kings ${(Number(owed) / 1e9).toFixed(5)} SOL (${KING_BPS / 100}% of the value traded in their reigns)`);
  const before = await Promise.all([W.A, W.B, W.C].map((k) => conn.getBalance(k.publicKey, "confirmed")));
  const paid = await payKings({ conn, db, platform, min: 1n });
  const after = await Promise.all([W.A, W.B, W.C].map((k) => conn.getBalance(k.publicKey, "confirmed")));
  const got = after.map((b, i) => b - before[i]);
  ok(paid === owed && got.reduce((a, b) => a + b, 0) === Number(owed), `the keeper paid them: A ${got[0]}, B ${got[1]}, C ${got[2]} lamports`);
  ok((await payKings({ conn, db, platform, min: 1n })) === 0n, "a second pass pays nothing more");
}

// ── trading hours: daylight saving and closed sells ─────────────────────────────────────────────
console.log("\n── trading hours with daylight saving (New York) and closed sells");
if (want("hours")) {
  const now = await chainNow();
  const nyMin = (ts) => { const [h, m] = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ts * 1000)).split(":").map(Number); return h * 60 + m; };
  const local = nyMin(now);
  const winOpen = (local + 1440 - 15) % 1440, winClose = (local + 15) % 1440;
  const inDst = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "short" }).format(new Date(now * 1000)).includes("EDT");
  const hours = { hoursOn: true, hoursDays: 127, hoursOpenMin: winOpen, hoursCloseMin: winClose, tzOffsetMin: -300 };
  const Dst = await launch("NYdst", { ...off, ...hours, hoursDst: 1 });
  const Std = await launch("NYstd", { ...off, ...hours });
  ok((await hookCode(() => buySol(Dst, W.A, 20_000_000n))) === "passed", "a window around New York's time right now, following US daylight saving: buys are open");
  ok((await hookCode(() => buySol(Std, W.A, 20_000_000n))) === (inDst ? 9 : "passed"),
    inDst ? "the same window on a fixed UTC−5 is an hour off while New York is on daylight time: closed" : "outside daylight time both read the same");
  const later = { ...hours, hoursOpenMin: (local + 120) % 1440, hoursCloseMin: (local + 180) % 1440 };
  const Closed = await launch("Shut", { ...off, ...later, hoursDst: 1, hoursSells: true });
  const Open = await launch("SellsOk", { ...off, ...later, hoursDst: 1 });
  ok((await hookCode(() => sell(Closed, creator, 1_000_000n))) === 20, "outside the hours, a token that closes sells too refuses a sell (the creator's too)");
  ok((await hookCode(() => sell(Open, creator, 1_000_000n))) === "passed", "a token that keeps sells open lets it through");
  ok((await hookCode(() => walletTransfer(Closed, creator, W.B.publicKey, 1_000n))) === "passed", "wallet-to-wallet sends always work");
}

// ── the largest launch the site can build ───────────────────────────────────────────────────────
console.log("\n── worst case transaction size");
if (want("size")) {
  const v3all = { ...off, hoursOn: true, hoursDays: 62, hoursOpenMin: 570, hoursCloseMin: 960, tzOffsetMin: -300, hoursDst: 1, hoursHolidays: true, hoursSells: true,
    maxBuyBps: 200, sellSmallBps: 100, sellFloorBps: 10, sellBagBps: 300, plagueDose: 1_000_000_000, potatoOn: true, potatoMinBps: 100, potatoColdSecs: 86_400,
    pingOn: true, pingMinBps: 100, pingFreeSecs: 86_400, chapterStartBps: 100, chapterVolume: Number(pctOf(100)),
    oscKind: OSC.coupled, oscPeriod: 1_200, oscBaseBps: 100, oscFloorBps: 25, oscAmpPct: 100, oscDampPermille: 400, oscCouplingPct: 60,
    kingOn: true, kingMinLamports: 10_000_000_000, kingBeatPct: 50, kingDecayUnit: 3, kingDecayN: 60, kingDevCan: true, holderShareBps: 5_000, burnBps: 2_000, feeCapBps: 1_000, feeBaseBps: 500, feePerSolBps: 100 };
  const longest = { name: "N".repeat(32), symbol: "S".repeat(10), uri: "https://gateway.pinata.cloud/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy/".padEnd(120, "x") };
  const size = async (rules) => launchSize((await buildLaunchTx({ dbc, hookProgram: HOOK, config, creator: creator.publicKey, ...longest, rules, devBuyLamports: 100_000_000n, lut })).tx);
  const n = await size(v3all);
  ok(n <= 1232, `every v3 rule at once (all bytes non-zero), longest name, symbol and URI, a dev buy: ${n} bytes (limit 1,232)`);
  const everything = { ...v3all, fomoOnly: true, cosigner: Keypair.generate().publicKey, allowlist: true, bundleMax: 2, snipeSecs: 600, snipeMaxCuPrice: 100_000, snipeMaxTip: 100_000 };
  const m = await size(everything);
  console.log(`   with FOMO-only, an allowlist and anti-bundle on top as well: ${m} bytes, over the limit: the API refuses it in words (drop a rule)`);
}

console.log(`\n${checks} checks passed`);
process.exit(0);
