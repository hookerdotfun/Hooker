// Custom pairs, end to end on the local mainnet clone (pump.fun's real bytecode + its real quote-control list
// + two real pair tokens with a test mint authority: scripts/make-pair-fixtures.mjs):
//   launch with a pair (memo + intent) → curve fills → graduation swaps SOL into the pair → pump.fun coin
//   paired with it, with the creator's pump.fun creator fee → every holder paid.
// The SWAP is a stand-in market here (Jupiter cannot run locally); it is proven on mainnet by the test script.
//   TEST_SIZES=2 node test/e2e-pairs.mjs      (needs 3 ground …hook keys in keys/test-vanity)
import { Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, getMint } from "@solana/spl-token";
import { readFileSync, readdirSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "../lib/env.mjs";
import { dbcClient, getPool } from "../lib/chain.mjs";
import { ensureConfigs, configEntries } from "../lib/configs.mjs";
import { buildLaunchTx, buildSwapTx } from "../lib/launch.mjs";
import { DEFAULT_RULES } from "../lib/rules.mjs";
import { openDb, registerLaunch, recordIntent, getLaunch } from "../lib/db.mjs";
import { addKey, initVanity } from "../lib/vanity.mjs";
import { Graduator } from "../lib/graduate.mjs";
import { pairMemo, parsePairMemo, MEMO_PROGRAM, pairAccountSetup } from "../lib/pairs.mjs";
import { PAIR_TESTS } from "../scripts/make-pair-fixtures.mjs";
import { pumpMarketCap } from "../lib/pumpprice.mjs";
const { OnlinePumpSdk, holderRewardsPda, PUMP_SDK, getBuySolAmountFromTokenAmount, canonicalPumpPoolPdaWithQuote } = createRequire(import.meta.url)("@pump-fun/pump-sdk");
import BN from "bn.js";

const conn = connect(process.env.LOCAL_RPC || "http://127.0.0.1:8997", 0);
const dbc = dbcClient(conn), pump = new OnlinePumpSdk(conn);
const key = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL(`../keys/${f}`, import.meta.url)))));
const HOOK = key("hooker-hook-keypair.json").publicKey, PAIR_AUTH = key("test-pair-authority.json");
const DATA = new URL("../data/test-pairs/", import.meta.url).pathname;
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
let checks = 0;
const ok = (c, m) => { if (!c) { console.error("❌ FAIL:", m); process.exit(1); } checks++; console.log("✅", m); };
const fund = async (...kps) => { for (const k of kps) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed"); };
async function send(tx, signers) {
  if (!(tx instanceof VersionedTransaction)) return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = blockhash; tx.sign(signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
  const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (r.value.err) throw new Error(`failed: ${JSON.stringify(r.value.err)}`);
  return sig;
}

const platform = Keypair.generate(), treasury = Keypair.generate(), sink = Keypair.generate();
const W = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
await fund(platform, ...W, PAIR_AUTH);
// on mainnet Meteora keeps the DBC pool authority funded (flash rent for migration); a clone starts it at 0
await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: platform.publicKey, toPubkey: new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"), lamports: 2 * LAMPORTS_PER_SOL })), [platform]);

const db = openDb(`${DATA}/hooker.db`);
initVanity(db);
const VK = new URL("../keys/test-vanity/", import.meta.url).pathname;
const ground = readdirSync(VK).filter((f) => f.endsWith("hook.json")).slice(0, 3);
if (ground.length < 3) { console.error(`need 3 ground …hook keys in ${VK} (tools/grind), have ${ground.length}`); process.exit(1); }
for (const f of ground) { addKey(db, Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(VK + f, "utf8"))))); renameSync(VK + f, `${VK}used/${f}`); }

console.log("── configs (2 SOL test size)");
const st = await ensureConfigs({ conn, platform, hookProgram: HOOK, dataDir: DATA, log: () => {} });
const flat2 = new PublicKey(st.flatConfigs["2"]);

// the stand-in market: SOL leaves the hot wallet, the pair token arrives at a fixed rate (units per SOL)
const RATE = { WBTC: 142_000n, SPYx: 15_700_000n };
const programOf = async (mint) => (await conn.getAccountInfo(new PublicKey(mint))).owner;
let failCheckFor = null; // a pair the next graduation's check refuses (the fallback case)
const g = new Graduator({ conn, db, platform, treasury: treasury.publicKey, hookProgram: HOOK, configs: configEntries(st), dataDir: DATA, log: (...a) => console.log("   ·", ...a),
  pairCheck: async (_c, pair) => (pair === failCheckFor ? { ok: false, why: "test: liquidity gone" } : { ok: true, tokenProgram: await programOf(pair) }),
  pairSwap: async ({ pair, lamports, user }) => {
    const sym = PAIR_TESTS.find((t) => t.mint === pair).symbol, prog = await programOf(pair), mint = new PublicKey(pair);
    const ata = getAssociatedTokenAddressSync(mint, user.publicKey, true, prog);
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: sink.publicKey, lamports: Number(lamports) }),
      createAssociatedTokenAccountIdempotentInstruction(user.publicKey, ata, user.publicKey, mint, prog),
      createMintToInstruction(mint, ata, PAIR_AUTH.publicKey, (lamports * RATE[sym]) / 1_000_000_000n, [], prog));
    return { tx, signers: [user, PAIR_AUTH] };
  } });

async function graduate({ label, pair, cfee, holderRewards }) {
  console.log(`\n── ${label}`);
  const creator = Keypair.generate(); await fund(creator);
  const memo = pair ? pairMemo(pair, cfee) : null;
  const { tx, mint, pool } = await buildLaunchTx({ dbc, hookProgram: HOOK, config: flat2, creator: creator.publicKey, name: label.slice(0, 32), symbol: "PAIR",
    uri: "https://ipfs.io/ipfs/bafkreifra3rgfzkyof45xg3jtbdsu6qwwsfed7dhn5arjvys73lx7xkeim", rules: { ...DEFAULT_RULES, holderRewards }, devBuyLamports: 100_000_000n, memo, lut: await g.ensureLut() }); // launches go over the lookup table, as the API builds them
  if (pair) recordIntent(db, mint.publicKey.toBase58(), pair, cfee);
  const sig = await send(tx, [creator, mint]);
  registerLaunch(db, { mint: mint.publicKey.toBase58(), pool: pool.toBase58(), config: flat2.toBase58(), creator: creator.publicKey.toBase58(), name: label, symbol: "PAIR", uri: "x", gradSol: 2 });
  if (pair) {
    const ltx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const keys = ltx.transaction.message.getAccountKeys({ accountKeysFromLookups: ltx.meta.loadedAddresses }).keySegments().flat();
    const memoIx = ltx.transaction.message.compiledInstructions.find((ix) => keys[ix.programIdIndex].equals(MEMO_PROGRAM));
    const parsed = memoIx && parsePairMemo(Buffer.from(memoIx.data).toString("utf8"));
    ok(parsed?.pair === pair && parsed.creatorFeeBps === cfee, `the launch transaction carries the choice publicly: "${pairMemo(pair, cfee)}"`);
  }
  // two buyers fill the 2 SOL curve
  for (const w of W.slice(0, 2)) await send(await buildSwapTx({ dbc, pool, owner: w.publicKey, buy: true, amountIn: 1_500_000_000n }), [w]);
  for (let i = 0; i < 40 && getLaunch(db, mint.publicKey.toBase58()).status !== "done"; i++) { await g.tick(); db.prepare("UPDATE launches SET next_try = 0").run(); }
  const l = getLaunch(db, mint.publicKey.toBase58());
  ok(l.status === "done", `${label}: graduated (status ${l.status}${l.error ? `, last error: ${l.error.slice(0, 120)}` : ""})`);
  const pumpMint = new PublicKey(l.pump_mint);
  const bc = await pump.fetchBondingCurve(pumpMint);
  return { l, bc, pumpMint, creator };
}

/** Every payout row is done AND each holder's wallet holds at least what the ledger says it was sent. */
async function allPaid(l) {
  const rows = db.prepare("SELECT owner, amount, status FROM pushes WHERE mint = ?").all(l.mint);
  if (rows.length < 3 || rows.some((r) => r.status !== "done")) return false;
  for (const r of rows) {
    const a = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(new PublicKey(l.pump_mint), new PublicKey(r.owner), true, TOKEN_2022_PROGRAM_ID), "confirmed").catch(() => null);
    if (!a || BigInt(a.value.amount) < BigInt(r.amount)) return false;
  }
  return true;
}
// 1. WBTC (classic SPL), 1.5% pump.fun creator fee, creator fees to holders
{
  const WBTC = PAIR_TESTS[0].mint;
  // ⛔ the review's attack: a stranger drops pair tokens into the platform's account first. The swap must still
  // happen, and what it delivered must come from the swap transaction itself, not from the wallet's balance.
  {
    const wprog = await programOf(WBTC), ata = getAssociatedTokenAddressSync(new PublicKey(WBTC), platform.publicKey, true, wprog);
    await send(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(W[2].publicKey, ata, platform.publicKey, new PublicKey(WBTC), wprog), createMintToInstruction(new PublicKey(WBTC), ata, PAIR_AUTH.publicKey, 5n, [], wprog)), [W[2], PAIR_AUTH]);
  }
  const { l, bc, pumpMint } = await graduate({ label: "Paired WBTC", pair: WBTC, cfee: 150, holderRewards: true });
  const expect = (BigInt(l.pump_spend) * RATE.WBTC) / 1_000_000_000n;
  ok(l.pair_state === "swapped" && BigInt(l.pair_amount) === expect && !!l.pair_sig, `the graduation swapped ${Number(l.pump_spend) / 1e9} SOL into exactly ${l.pair_amount} WBTC units (the swap tx's own delivery; the stranger's 5 units ignored)`);
  ok(bc.quoteMint?.toBase58() === WBTC, "the pump.fun coin is paired with WBTC on chain");
  ok(Number(bc.creatorFeeBps) === 150, `its pump.fun creator fee is 1.5% (${bc.creatorFeeBps} bps)`);
  ok(bc.creator.equals(holderRewardsPda(pumpMint)), "with creator fees to holders on, the coin's creator is the holders' rewards account: the fee goes to holders");
  ok(await allPaid(l), "every holder holds their pump.fun coins, on chain");
  // priced in WBTC, converted to SOL at the stand-in market's rate: the cap must be in SOL, not in WBTC units
  const solPerUnit = 1e8 / Number(RATE.WBTC); // SOL per whole WBTC at 142,000 units (8 decimals) per SOL
  const cap = await pumpMarketCap(conn, pumpMint, { quote: { mint: PAIR_TESTS[0].mint, decimals: 8, solPerUnit } });
  const solCap = await pumpMarketCap(conn, pumpMint); // the WRONG reading, as if WBTC units were lamports
  // a holder sells back on pump.fun's curve and is paid in WBTC (what a terminal then swaps to SOL)
  {
    const w = W[0], wbtc = new PublicKey(PAIR_TESTS[0].mint);
    const coins = BigInt((await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(pumpMint, w.publicKey, true, TOKEN_2022_PROGRAM_ID))).value.amount);
    const st = await pump.fetchSellState(pumpMint, w.publicKey, TOKEN_2022_PROGRAM_ID, wbtc);
    const ixs = await PUMP_SDK.sellV2Instructions({ global: await pump.fetchGlobal(), bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve,
      mint: pumpMint, user: w.publicKey, amount: new BN(coins.toString()), quoteAmount: new BN(1), slippage: 0, tokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: await programOf(wbtc) });
    const sell = ixs[ixs.length - 1];
    await send(new Transaction().add(...pairAccountSetup(sell, "sell_v2", wbtc, await programOf(wbtc), w.publicKey), ...ixs), [w]);
    const got = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(wbtc, w.publicKey, true, await programOf(wbtc)), "confirmed").catch(() => null);
    ok(got && BigInt(got.value.amount) > 0n, `a holder sold ${Number(coins) / 1e6} coins back on pump.fun's curve and received ${got?.value.amount} WBTC units`);
  }
  // ── then all the way: a whale buys out the rest of pump.fun's curve WITH WBTC, it migrates to PumpSwap (a WBTC pool),
  //    and the site must price it from that pool, not as zero and not from the drained curve
  {
    const wbtc = new PublicKey(PAIR_TESTS[0].mint), wprog = await programOf(PAIR_TESTS[0].mint), whale = Keypair.generate(); await fund(whale);
    const wAta = getAssociatedTokenAddressSync(wbtc, whale.publicKey, true, wprog);
    await send(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(whale.publicKey, wAta, whale.publicKey, wbtc, wprog), createMintToInstruction(wbtc, wAta, PAIR_AUTH.publicKey, 10n ** 8n, [], wprog)), [whale, PAIR_AUTH]);
    const G = await pump.fetchGlobal(), FC = await pump.fetchFeeConfig(), QC = await pump.fetchQuoteControl();
    const bs = await pump.fetchBuyState(pumpMint, whale.publicKey, TOKEN_2022_PROGRAM_ID, wbtc);
    const rest = bs.bondingCurve.realTokenReserves, supply = (await getMint(conn, pumpMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
    const cost = getBuySolAmountFromTokenAmount({ global: G, feeConfig: FC, mintSupply: new BN(supply.toString()), bondingCurve: bs.bondingCurve, amount: rest, quoteMint: wbtc, quoteControl: QC, creatorFeeBps: new BN(150) });
    const ixs = await PUMP_SDK.buyV2Instructions({ global: G, bondingCurveAccountInfo: bs.bondingCurveAccountInfo, bondingCurve: bs.bondingCurve, associatedUserAccountInfo: bs.associatedUserAccountInfo,
      mint: pumpMint, user: whale.publicKey, amount: rest, quoteAmount: cost, slippage: 25, tokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: wprog });
    await send(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), ...pairAccountSetup(ixs[ixs.length - 1], "buy_v2", wbtc, wprog, whale.publicKey), ...ixs), [whale]);
    const full = await pump.fetchBondingCurve(pumpMint);
    ok(full.complete, `pump.fun's WBTC curve filled (${cost} WBTC units more)`);
    const solPerUnit = 1e8 / Number(RATE.WBTC);
    const capAtFill = (Number(full.virtualQuoteReserves) / 1e8) * solPerUnit / (Number(full.virtualTokenReserves) / 1e6) * (Number(supply) / 1e6);
    ok((await pumpMarketCap(conn, pumpMint, { quote: { mint: wbtc.toBase58(), decimals: 8, solPerUnit } })) === null, "filled but not yet migrated: priced as unknown (null), never 0");
    await send(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), await PUMP_SDK.migrateV2Instruction({ withdrawAuthority: G.withdrawAuthority, mint: pumpMint, user: whale.publicKey, quoteMint: wbtc, baseTokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: wprog })), [whale]);
    ok(!!(await conn.getAccountInfo(canonicalPumpPoolPdaWithQuote(pumpMint, wbtc))), "migrated: a PumpSwap pool paired with WBTC exists");
    const pc = await pumpMarketCap(conn, pumpMint, { quote: { mint: wbtc.toBase58(), decimals: 8, solPerUnit } });
    ok(pc?.venue === "PumpSwap" && pc.marketCapSol > capAtFill * 0.9 && pc.marketCapSol < capAtFill * 1.4, `on PumpSwap the site prices it from the WBTC pool: ${pc?.marketCapSol.toFixed(1)} SOL (the curve ended at ${capAtFill.toFixed(1)})`);
  }
  ok(cap && cap.marketCapSol > 20 && cap.marketCapSol < 80, `the paired coin's market cap reads ${cap?.marketCapSol.toFixed(1)} SOL (the curve ended near 31.8 SOL), not ${solCap?.marketCapSol.toExponential(2)} (units read as lamports)`);
}
// 2. SPYx (Token-2022 xStock), 3% creator fee, to the creator
{
  const SPYx = PAIR_TESTS[1].mint;
  const { l, bc, creator } = await graduate({ label: "Paired SPYx", pair: SPYx, cfee: 300, holderRewards: false });
  ok(bc.quoteMint?.toBase58() === SPYx && Number(bc.creatorFeeBps) === 300, "SPYx (Token-2022 xStock): paired on chain, 3% creator fee");
  ok(bc.creator.equals(creator.publicKey), "without creator fees to holders, the coin's creator is the creator's own wallet");
  ok(await allPaid(l), "every holder holds their pump.fun coins, on chain");
}
// 3. the pair fails its graduation check → the coin graduates against SOL, holders still paid
{
  failCheckFor = PAIR_TESTS[0].mint;
  const { l, bc } = await graduate({ label: "Fallback to SOL", pair: PAIR_TESTS[0].mint, cfee: 100, holderRewards: false });
  ok(l.pair_state === "fallback" && /liquidity gone/.test(l.pair_note), `the pair was not used: "${l.pair_note}"`);
  const q = bc.quoteMint?.toBase58?.();
  ok(!q || q === NATIVE_MINT.toBase58() || q === PublicKey.default.toBase58(), `and the pump.fun coin is SOL-paired (quote ${q ?? "SOL"})`);
  ok(await allPaid(l), "every holder holds their pump.fun coins, on chain");
}
console.log(`\n${checks} checks passed`);
process.exit(0);
