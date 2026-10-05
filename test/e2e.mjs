// Hooker end to end on the local validator (scripts/validator.sh: mainnet Meteora + pump.fun cloned).
// Uses the product's own modules — configs, launch builder, hook, graduation service — and checks
// every number against the chain. Run: node test/e2e.mjs
import {
  Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { ensureLut, pumpStaticKeys } from "../lib/lut.mjs";
import { launchStaticKeys, launchSize } from "../lib/launch.mjs";
import { pairMemo } from "../lib/pairs.mjs";
import {
  TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getMint, getTransferHook, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedWithTransferHookInstruction, createTransferCheckedInstruction, createInitializeAccount3Instruction,
  createSetAuthorityInstruction, AuthorityType, getAccountLenForMint, NATIVE_MINT, createSyncNativeInstruction,
} from "@solana/spl-token";
import { DAMM_V2_MIGRATION_FEE_ADDRESS } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { rmSync, mkdirSync, readFileSync } from "node:fs";
import BN from "bn.js";
import { connect } from "../lib/env.mjs";
import { dbcClient, getPool, getConfig, DBC_PROGRAM } from "../lib/chain.mjs";
import { ensureConfigs } from "../lib/configs.mjs";
import { buildLaunchTx, buildSwapTx, hookTransferAccounts } from "../lib/launch.mjs";
import { DEFAULT_RULES, decodeRules, hookPdas, hookErrorFromLogs, validateRules } from "../lib/rules.mjs";
import { pumpMarketCap, decodePool } from "../lib/pumpprice.mjs";
import { loadConfigState } from "../lib/configs.mjs";
import { writeFileSync } from "node:fs";
import { Graduator, PUSH_COST, RESERVE } from "../lib/graduate.mjs";
import { openDb, getLaunch } from "../lib/db.mjs";
import { initVanity, addKey, issueForLaunch } from "../lib/vanity.mjs";
import { readdirSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
const { OnlinePumpSdk, PUMP_SDK, holderRewardsPda, getBuySolAmountFromTokenAmount, canonicalPumpPoolPda } = createRequire(import.meta.url)("@pump-fun/pump-sdk");

const conn = connect(process.env.LOCAL_RPC || "http://127.0.0.1:8997", 0);
const dbc = dbcClient(conn);
const keyOf = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL(`../keys/${f}`, import.meta.url))))).publicKey;
const HOOK = keyOf("hooker-hook-keypair.json");
const APP = keyOf("test-app-forwarder-keypair.json");
const DATA = new URL("../data/test/", import.meta.url).pathname;
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });

let checks = 0;
const ok = (c, m) => { if (!c) { console.error("❌ FAIL:", m); process.exit(1); } checks++; console.log("✅", m); };
const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fund(...kps) { for (const k of kps) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 200 * LAMPORTS_PER_SOL), "confirmed"); }
async function send(tx, signers) {
  if (Array.isArray(tx)) tx = new Transaction().add(...tx);
  if (tx instanceof VersionedTransaction) { // a launch over the lookup table
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.message.recentBlockhash = blockhash; tx.sign(signers);
    const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (r.value.err) throw new Error(`failed: ${JSON.stringify(r.value.err)}`);
    return sig;
  }
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
/** The hook's refusal code if `fn` fails because of the hook, else null (and a pass if it succeeds). */
async function hookCode(fn) {
  try { await fn(); return "passed"; } catch (e) { return hookErrorFromLogs(e.transactionLogs ?? e.logs, HOOK); }
}
const ata = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
const bal = async (mint, owner) => { const a = await conn.getTokenAccountBalance(ata(mint, owner), "confirmed").catch(() => null); return a ? BigInt(a.value.amount) : 0n; };
const lam = (pk) => conn.getBalance(pk, "confirmed");

// ── setup: platform, treasury, fomo stand-in, configs ──────────────────────────────────────────
const platform = Keypair.generate(), treasury = Keypair.generate(), fomo = Keypair.generate(), creator = Keypair.generate(), creatorB = Keypair.generate();
const W = Object.fromEntries(["A", "B", "C", "D"].map((k) => [k, Keypair.generate()]));
await fund(platform, fomo, creator, creatorB, ...Object.values(W));
// on mainnet Meteora keeps the DBC pool authority funded (flash rent for migration); a clone starts it at 0
await send([SystemProgram.transfer({ fromPubkey: platform.publicKey, toPubkey: new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"), lamports: 2 * LAMPORTS_PER_SOL })], [platform]);
// the …hook key pool, stocked from real ground keys (keys/test-vanity); a used key is moved to used/
const db = openDb(`${DATA}/hooker.db`);
initVanity(db);
const VK = new URL("../keys/test-vanity/", import.meta.url).pathname;
mkdirSync(`${VK}used`, { recursive: true });
const ground = readdirSync(VK).filter((f) => f.endsWith("hook.json")).slice(0, 3);
if (ground.length < 3) { console.error(`need 3 ground …hook keys in ${VK} (tools/grind), have ${ground.length}`); process.exit(1); }
for (const f of ground) { addKey(db, Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(VK + f, "utf8"))))); renameSync(VK + f, `${VK}used/${f}`); }
const hookKey = (creatorPk) => issueForLaunch(db, creatorPk.toBase58(), "test", 0);
console.log("\n── configs");
const { configs, pump: P } = await ensureConfigs({ conn, platform, hookProgram: HOOK, dataDir: DATA, log: (m) => console.log("  ", m) });
const sizes = Object.keys(configs).map(Number).sort((a, b) => a - b);
{ // the curve is pump.fun's: computed here from Global independently of lib/curve.mjs
  const G = await new OnlinePumpSdk(conn).fetchGlobal();
  const vs = Number(G.initialVirtualSolReserves) / 1e9, vt = Number(G.initialVirtualTokenReserves) / 1e6, sup = Number(G.tokenTotalSupply) / 1e6, real = Number(G.initialRealTokenReserves) / 1e6;
  const startCap = vs / vt * sup, completion = vs * vt / (vt - real) - vs;
  ok(sizes.length === 4 && Math.abs(P.capAt(0) - startCap) < 1e-6, `our curves start at pump.fun's own start cap, read from its Global account (${startCap.toFixed(2)} SOL)`);
  ok(sizes[3] === Math.floor(completion * 10) / 10 && sizes.every((s) => s <= completion), `the largest graduation equals where pump.fun's curve fills (${completion.toFixed(1)} SOL): ${sizes.join(" / ")} SOL`);
}
const again = await ensureConfigs({ conn, platform, hookProgram: HOOK, dataDir: DATA, log: () => {} });
ok(JSON.stringify(again.configs) === JSON.stringify(configs) && !again.changed, "re-running config creation changes nothing while pump.fun's curve is unchanged");
const config30 = new PublicKey(configs[sizes[0]]);

const IPFS_URI = "https://ipfs.io/ipfs/bafkreifra3rgfzkyof45xg3jtbdsu6qwwsfed7dhn5arjvys73lx7xkeim"; // 80 chars, what /api/ipfs returns
// the lookup table of fixed accounts (on the box the graduator makes it): launches ride on it
console.log("\n── lookup table");
const lut = await ensureLut({ conn, payer: platform, file: `${DATA}/lut.json`, log: (m) => console.log("  ", m),
  keys: [...await pumpStaticKeys({ global: await new OnlinePumpSdk(conn).fetchGlobal(), feeConfig: await new OnlinePumpSdk(conn).fetchFeeConfig() }), ...await launchStaticKeys({ dbc, hookProgram: HOOK, configs: Object.values(configs) })] });
ok(lut.state.addresses.length >= 25, `the table holds ${lut.state.addresses.length} fixed accounts of pump.fun and the launch`);
{ // the largest launch the API accepts: 32-char name, 10-char ticker, an 80-char IPFS link as our uploads make them, FOMO-only + allowlist + anti-bundle,
  // and (since 4 Oct 2026) a custom-pair memo with a 3-digit creator fee
  const worst = { rules: { ...DEFAULT_RULES, fomoOnly: true, cosigner: fomo.publicKey, allowlist: true, bundleMax: 2 }, name: "A".repeat(32), symbol: "B".repeat(10), uri: IPFS_URI, devBuyLamports: 100_000_000n, dbc, hookProgram: HOOK, config: config30, creator: creator.publicKey };
  const legacy = launchSize((await buildLaunchTx(worst)).tx), v0 = launchSize((await buildLaunchTx({ ...worst, lut })).tx);
  ok(legacy > 1232 && v0 <= 1232 - 40, `the largest allowed launch is ${legacy} bytes as a legacy transaction and ${v0} over the table (limit 1,232)`);
  // with a custom pair: every rule but a list, longest name/ticker/URI, + the pair note, still fits; the absolute
  // worst case (with a list too) is the one launch the API sends without the note (server/api.mjs)
  const pairNote = pairMemo("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", 300);
  const withNote = launchSize((await buildLaunchTx({ ...worst, rules: { ...worst.rules, allowlist: false }, lut, memo: pairNote })).tx);
  const worstNote = launchSize((await buildLaunchTx({ ...worst, lut, memo: pairNote })).tx);
  ok(withNote <= 1232, `a paired launch with every rule but a list carries its pair note in ${withNote} bytes; with a list too it would be ${worstNote}, so that one goes without the note`);
}

// ── launch A: FOMO-only, anti-snipe, dynamic fee, burn, holder share, pump.fun holder rewards ───
console.log(`\n── launch A (${sizes[0]} SOL graduation)`);
const rulesA = { ...DEFAULT_RULES, venueLock: true, fomoOnly: true, cosigner: fomo.publicKey, maxWalletBps: 1_500, earlySecs: 25, earlyMaxWalletBps: 100,
  feeBaseBps: 50, feePerSolBps: 50, feeCapBps: 1_000, burnBps: 200, holderShareBps: 5_000, holderRewards: true };
ok(validateRules({ ...rulesA, dev: creator.publicKey }).length === 0, "launch A's rules validate");
const devBuy = 500_000_000n;
const { tx: launchTx, mint: mintKp, pool: poolA } = await buildLaunchTx({ dbc, hookProgram: HOOK, config: config30, creator: creator.publicKey,
  name: "Hooker Test Worst Case Name 32ch", symbol: "HOOKWORST1", uri: IPFS_URI, rules: rulesA, devBuyLamports: devBuy, mint: hookKey(creator.publicKey), lut });
launchTx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
const size = launchSize(launchTx);
console.log(`   launch transaction: ${size} bytes, ${launchTx.message.compiledInstructions.length} instructions, v0 over the lookup table`);
const preFees = await lam(creator.publicKey);
await send(launchTx, [creator, mintKp]);
const mintA = mintKp.publicKey;
ok(!!(await getPool(dbc, poolA)), "pool, hook rules and dev buy landed in ONE transaction");
const pA = await getPool(dbc, poolA);
const feeOnDevBuy = BigInt(pA.partnerQuoteFee.toString()) + BigInt(pA.protocolQuoteFee.toString()) + BigInt(pA.creatorQuoteFee.toString());
ok(Number(feeOnDevBuy) / Number(devBuy) < 0.011, `the dev buy paid the minimum fee, not the anti-snipe fee (${(Number(feeOnDevBuy) * 100 / Number(devBuy)).toFixed(2)}%)`);
ok((await bal(mintA, creator.publicKey)) > 0n, "the creator holds the dev buy");
const onChain = decodeRules((await conn.getAccountInfo(hookPdas(HOOK, mintA).cfg)).data);
ok(onChain.fomoOnly && onChain.venueLock && onChain.holderRewards && onChain.maxWalletBps === 1_500 && onChain.burnBps === 200 && onChain.dev.equals(creator.publicKey), "the rules read back from chain as launched");
ok(Math.abs(onChain.launchTs - (await conn.getBlockTime(await conn.getSlot("confirmed")))) < 60, "the program stamped the launch time from the chain's clock");
ok((await getTransferHook(await getMint(conn, mintA, "confirmed", TOKEN_2022_PROGRAM_ID)))?.programId.equals(HOOK), "the window token carries our hook");
{ // the accounts we pass by hand for the launch buy == what the SDK resolves from chain now the mint exists
  const ix = await createTransferCheckedWithTransferHookInstruction(conn, PublicKey.default, mintA, PublicKey.default, PublicKey.default, 0n, 6, [], "confirmed", TOKEN_2022_PROGRAM_ID);
  ok(JSON.stringify(ix.keys.slice(4).map((k) => [k.pubkey.toBase58(), k.isWritable])) === JSON.stringify(hookTransferAccounts(HOOK, mintA).map((k) => [k.pubkey.toBase58(), k.isWritable])),
    "the hand-built hook accounts match Token-2022's own resolution");
}
ok(await hookCode(() => send(buildInit(mintA, W.A.publicKey), [W.A])) !== "passed", "nobody can rewrite launch A's rules afterwards");
function buildInit(mint, payer) {
  const { extraAccountMetas, cfg } = hookPdas(HOOK, mint);
  return [new TransactionInstruction({ programId: HOOK, keys: [
    { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: extraAccountMetas, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: cfg, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false } ], data: Buffer.concat([Buffer.from([43, 34, 13, 49, 167, 88, 235, 235]), Buffer.alloc(128)]) })];
}

// trading helpers
const swap = async (who, buy, amount, { cosign = true, pool = poolA, mint = mintA, viaApp = false } = {}) => {
  const tx = await buildSwapTx({ dbc, pool, owner: who.publicKey, buy, amountIn: amount });
  const signers = [who];
  if (buy && cosign) { // the shape of a real FOMO buy: FOMO's key pays a top-level ATA create
    tx.instructions.splice(1, 0, createAssociatedTokenAccountIdempotentInstruction(fomo.publicKey, ata(mint, who.publicKey), who.publicKey, mint, TOKEN_2022_PROGRAM_ID));
    signers.push(fomo);
  }
  if (viaApp) {
    const i = tx.instructions.findIndex((x) => x.programId.equals(DBC_PROGRAM));
    const d = tx.instructions[i];
    tx.instructions[i] = new TransactionInstruction({ programId: APP, keys: [{ pubkey: DBC_PROGRAM, isSigner: false, isWritable: false }, ...d.keys], data: d.data });
  }
  return send(tx, signers);
};
const p2p = async (from, to, amount, mint = mintA) => send([
  createAssociatedTokenAccountIdempotentInstruction(from.publicKey, ata(mint, to), to, mint, TOKEN_2022_PROGRAM_ID),
  await createTransferCheckedWithTransferHookInstruction(conn, ata(mint, from.publicKey), mint, ata(mint, to), from.publicKey, amount, 6, [], "confirmed", TOKEN_2022_PROGRAM_ID),
], [from]);
const feeTaken = async (pool) => { const p = await getPool(dbc, pool); return BigInt(p.partnerQuoteFee.toString()) + BigInt(p.protocolQuoteFee.toString()) + BigInt(p.creatorQuoteFee.toString()); };

console.log("\n── rules while trading");
{ const f0 = await feeTaken(poolA); await swap(W.A, true, 100_000_000n); const f = await feeTaken(poolA) - f0;
  ok(Number(f) / 1e8 > 0.35, `anti-snipe fee: a buy right after launch paid ${(Number(f) / 1e6).toFixed(1)}% (the curve fee decays from 50% to 1% over two minutes)`); }
ok(await hookCode(() => swap(W.B, true, 2_000_000_000n)) === 1, "anti-snipe cap: in the first 25 s a buy over 1% per wallet is REFUSED");
ok(await hookCode(() => swap(W.B, true, 100_000_000n, { cosign: false })) === 2, "FOMO-only: a buy without FOMO's signature is REFUSED");
const pda = PublicKey.findProgramAddressSync([Buffer.from("escrow")], SystemProgram.programId)[0];
ok(await hookCode(() => p2p(W.A, pda, 1n)) === 4, "venue lock: window tokens cannot move into a program-owned account (another pool, an escrow)");
await p2p(W.A, W.D.publicKey, (await bal(mintA, W.A.publicKey)) / 3n);
ok((await bal(mintA, W.D.publicKey)) > 0n, "a wallet-to-wallet transfer between real wallets passes");
await swap(W.A, false, (await bal(mintA, W.A.publicKey)) / 2n);
ok(true, "a sell without FOMO's signature passes (holders can always exit)");
console.log("   waiting out the 25 s launch window…");
// ⚠ the chain's clock, not this machine's: they drift apart (17 s measured on the local validator)
const chainNow = async () => conn.getBlockTime(await conn.getSlot("confirmed"));
while ((await chainNow()) <= onChain.launchTs + onChain.earlySecs + 1) await sleep(1000);
await swap(W.B, true, 2_000_000_000n);
ok((await bal(mintA, W.B.publicKey)) > 0n, "after the launch window the same buy passes (normal 15% cap)");
ok(await hookCode(() => swap(W.C, true, 25_000_000_000n)) === 1, "max per wallet: a buy that would hold over 15% is REFUSED");

// ── launch B: app-only, trades but never graduates (the service must leave it alone) ─────────
console.log("\n── launch B (app-only, stays trading)");
const { tx: txB, mint: mintKpB, pool: poolB } = await buildLaunchTx({ dbc, hookProgram: HOOK, config: new PublicKey(configs[sizes[1]]), creator: creatorB.publicKey,
  name: "App Only", symbol: "APPO", uri: "https://example.com/b.json", rules: { ...DEFAULT_RULES, appOnly: true, app: APP, earlySecs: 0, earlyMaxWalletBps: 0 }, mint: hookKey(creatorB.publicKey) , lut });
await send(txB, [creatorB, mintKpB]);
ok(await hookCode(() => swap(W.C, true, 100_000_000n, { cosign: false, pool: poolB, mint: mintKpB.publicKey })) === 3, "app-only: a buy calling Meteora directly is REFUSED");
await swap(W.C, true, 100_000_000n, { cosign: false, pool: poolB, mint: mintKpB.publicKey, viaApp: true });
ok((await bal(mintKpB.publicKey, W.C.publicKey)) > 0n, "app-only: the same buy inside the app passes");

// ── fill launch A ────────────────────────────────────────────────────────────────────────────
console.log("\n── filling launch A");
const smalls = Array.from({ length: 22 }, () => Keypair.generate());
for (let i = 0; i < smalls.length; i += 20)
  await send(smalls.slice(i, i + 20).map((k) => SystemProgram.transfer({ fromPubkey: W.D.publicKey, toPubkey: k.publicKey, lamports: 0.3 * LAMPORTS_PER_SOL })), [W.D]);
await Promise.all(smalls.map((k) => swap(k, true, 150_000_000n)));
// dust: shares worth less than 3 × the cost of sending them are burned, never paid
const dust = Array.from({ length: 4 }, () => Keypair.generate());
await send(dust.map((k) => SystemProgram.transfer({ fromPubkey: W.D.publicKey, toPubkey: k.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL })), [W.D]);
await Promise.all(dust.map((k) => swap(k, true, 2_000_000n)));
await p2p(smalls[0], smalls[1].publicKey, (await bal(mintA, smalls[0].publicKey)) / 2n);
// H1: a PLAIN token account (no ImmutableOwner) whose owner is changed with SetAuthority, a change the
// mint's history never sees; the new owner then moves tokens out of it
const plainKp = Keypair.generate(), heir = Keypair.generate();
await fund(heir);
{ const mintInfo = await getMint(conn, mintA, "confirmed", TOKEN_2022_PROGRAM_ID);
  const space = getAccountLenForMint(mintInfo);
  await send([SystemProgram.createAccount({ fromPubkey: W.D.publicKey, newAccountPubkey: plainKp.publicKey, space, lamports: await conn.getMinimumBalanceForRentExemption(space), programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeAccount3Instruction(plainKp.publicKey, mintA, W.D.publicKey, TOKEN_2022_PROGRAM_ID)], [W.D, plainKp]);
  const half = (await bal(mintA, W.D.publicKey)) / 2n;
  await send([await createTransferCheckedWithTransferHookInstruction(conn, ata(mintA, W.D.publicKey), mintA, plainKp.publicKey, W.D.publicKey, half, 6, [], "confirmed", TOKEN_2022_PROGRAM_ID)], [W.D]);
  await send([createSetAuthorityInstruction(plainKp.publicKey, W.D.publicKey, AuthorityType.AccountOwner, heir.publicKey, [], TOKEN_2022_PROGRAM_ID)], [W.D]);
  await send([createAssociatedTokenAccountIdempotentInstruction(heir.publicKey, ata(mintA, heir.publicKey), heir.publicKey, mintA, TOKEN_2022_PROGRAM_ID),
    await createTransferCheckedWithTransferHookInstruction(conn, plainKp.publicKey, mintA, ata(mintA, heir.publicKey), heir.publicKey, 1n, 6, [], "confirmed", TOKEN_2022_PROGRAM_ID)], [heir]);
  ok((await conn.getTokenAccountBalance(plainKp.publicKey)).value.amount !== "0", "(setup) a token account changed owner off-history and its new owner moved tokens from it"); }
const threshold = BigInt((await getConfig(dbc, config30)).migrationQuoteThreshold.toString());
for (let i = 0; i < 40; i++) {
  const p = await getPool(dbc, poolA);
  if (BigInt(p.quoteReserve.toString()) >= threshold) break;
  const w = Keypair.generate(); await fund(w);
  await swap(w, true, 3_000_000_000n); // partial fill: the last buy takes only what is left
}
const doneA = await getPool(dbc, poolA);
ok(BigInt(doneA.quoteReserve.toString()) >= threshold, `launch A's curve filled at ${sol(doneA.quoteReserve)} SOL`);
ok(!(await getTransferHook(await getMint(conn, mintA, "confirmed", TOKEN_2022_PROGRAM_ID)))?.programId || (await getTransferHook(await getMint(conn, mintA, "confirmed", TOKEN_2022_PROGRAM_ID))).programId.equals(PublicKey.default), "the hook was revoked by the filling buy");
// after graduation the window token moves freely; the settlement must ignore it
const lateFrom = smalls[2], lateTo = Keypair.generate();
await fund(lateFrom);
await send([createAssociatedTokenAccountIdempotentInstruction(lateFrom.publicKey, ata(mintA, lateTo.publicKey), lateTo.publicKey, mintA, TOKEN_2022_PROGRAM_ID),
  createTransferCheckedInstruction(ata(mintA, lateFrom.publicKey), mintA, ata(mintA, lateTo.publicKey), lateFrom.publicKey, await bal(mintA, lateFrom.publicKey), 6, [], TOKEN_2022_PROGRAM_ID)], [lateFrom]);

// H2: before the graduator has even looked, a stranger migrates the pool (permissionless), deposits
// a lamport of wrapped SOL into the quote vault and withdraws the leftover in one transaction: tokens
// leave the vault and SOL enters it, which must NOT pass for the graduating buy
{ const stranger = Keypair.generate(); await fund(stranger);
  const { transaction: mtx, firstPositionNftKeypair, secondPositionNftKeypair } = await dbc.migration.migrateToDammV2({ payer: stranger.publicKey, pool: poolA, dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[0] });
  await send(mtx, [stranger, firstPositionNftKeypair, secondPositionNftKeypair]);
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, stranger.publicKey);
  const leftoverTx = await dbc.migration.withdrawLeftover({ payer: stranger.publicKey, pool: poolA });
  const { createTransferInstruction } = await import("@solana/spl-token");
  await send([createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, wsol, stranger.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: wsol, lamports: 1_000 }), createSyncNativeInstruction(wsol),
    createTransferInstruction(wsol, doneA.quoteVault, stranger.publicKey, 1_000), ...leftoverTx.instructions], [stranger]);
  const pAfterStranger = await getPool(dbc, poolA);
  ok(!!pAfterStranger.isMigrated && !!pAfterStranger.isWithdrawLeftover && (await bal(mintA, platform.publicKey)) > 0n, "(setup) a stranger migrated the pool, deposited SOL into its vault and sent the leftover to the platform before settlement"); }

// ── the graduation service, with two crashes ─────────────────────────────────────────────────
console.log("\n── graduation service");
const platformBefore = await lam(platform.publicKey);
const mk = () => new Graduator({ conn, db, platform, treasury: treasury.publicKey, hookProgram: HOOK, configs: Object.fromEntries(Object.entries(configs).map(([g, c]) => [g, new PublicKey(c)])), log: (...a) => console.log("   ·", ...a) });
let g = mk();
await g.discover();
ok(!!getLaunch(db, mintA.toBase58()) && !!getLaunch(db, mintKpB.publicKey.toBase58()), "the service discovered both launches on its own");
// crash 1: die right after the second push batch lands, before the ledger records it
let batches = 0;
g.crashAfterSend = () => ++batches === 2;
await g.tick();
const crashed = getLaunch(db, mintA.toBase58());
const sending = db.prepare("SELECT COUNT(*) n FROM pushes WHERE mint = ? AND status = 'sending'").get(mintA.toBase58()).n;
ok(crashed.status === "burned" && sending > 0 && crashed.error?.includes("simulated crash"), `crash mid-push: status ${crashed.status}, ${sending} wallets in a batch that landed but was never recorded`);
// crash 2: a brand-new process on the same ledger
// push failure isolation, in the SECOND process: two wallets still unpaid after the crash
const [flaky, hopeless] = db.prepare("SELECT owner FROM pushes WHERE mint = ? AND status = 'pending' ORDER BY owner LIMIT 2").all(mintA.toBase58()).map((r) => r.owner);
let flakyFails = 0;
db.prepare("UPDATE launches SET next_try = 0").run();
g = mk();
let netErr = false;
g.sabotage = (batch) => {
  if (!netErr) { netErr = true; throw new Error("ECONNRESET: socket hang up"); } // a plain network error: the send may or may not have gone out
  return (batch.some((r) => r.owner === flaky) && flakyFails++ < 3) || batch.some((r) => r.owner === hopeless);
};
let airdropped = false, airdropPayer = null;
g.onBatch = async () => { // someone sends 1 unit of the coin to the platform's own account during the push
  if (airdropped) return; airdropped = true;
  const payer = smalls.find((k) => db.prepare("SELECT status FROM pushes WHERE mint = ? AND owner = ?").get(mintA.toBase58(), k.publicKey.toBase58())?.status === "done");
  airdropPayer = payer.publicKey.toBase58();
  const pm = new PublicKey(getLaunch(db, mintA.toBase58()).pump_mint);
  await send([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(pm, platform.publicKey), platform.publicKey, pm, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(ata(pm, payer.publicKey), pm, ata(pm, platform.publicKey), payer.publicKey, 1n, 6, [], TOKEN_2022_PROGRAM_ID)], [payer]);
};
for (let i = 0; i < 60 && getLaunch(db, mintA.toBase58()).status !== "done"; i++) {
  const before = getLaunch(db, mintA.toBase58()).status;
  await g.tick(); db.prepare("UPDATE launches SET next_try = 0").run();
  if (getLaunch(db, mintA.toBase58()).status === before) await sleep(3000); // e.g. waiting for an in-flight signature to expire
}
const L = getLaunch(db, mintA.toBase58());
ok(L.status === "done", `a fresh process finished the graduation (${L.status})`);
ok(getLaunch(db, mintKpB.publicKey.toBase58()).status === "trading", "launch B was left alone (its curve has not filled)");

// ── check everything against the chain ──────────────────────────────────────────────────────
console.log("\n── results");
const pumpMint = new PublicKey(L.pump_mint);
const rows = db.prepare("SELECT * FROM pushes WHERE mint = ?").all(mintA.toBase58());
let paid = 0n, failedAmt = 0n;
for (const r of rows) {
  const b = await bal(pumpMint, new PublicKey(r.owner));
  if (r.status === "failed") { failedAmt += BigInt(r.amount); if (b !== 0n) { console.error(`failed wallet ${r.owner} was paid`); process.exit(1); } continue; }
  const expected = BigInt(r.amount) - (r.owner === airdropPayer ? 1n : 0n); // it gave 1 unit to the platform after being paid
  if (b !== expected) { console.error(`wallet ${r.owner}: ${b} != planned ${expected}`); process.exit(1); }
  paid += BigInt(r.amount);
}
ok(rows.filter((r) => r.status === "done").length === rows.length - 1, `every payable wallet received exactly its planned amount, NONE twice (${rows.length - 1} wallets, despite the crash)`);
ok(rows.find((r) => r.owner === flaky)?.status === "done" && rows.find((r) => r.owner === flaky).attempts >= 4, "a wallet whose batches failed three times was paid on its own afterwards");
ok(rows.find((r) => r.owner === hopeless)?.status === "failed" && failedAmt > 0n, "a wallet that can never be paid was given up on; the other wallets were not held up");
ok(netErr && rows.every((r) => r.status !== "sending"), "a network error on a push send was NOT treated as 'never sent': the ledger waited for the signature's fate, then carried on");
ok(rows.some((r) => r.owner === heir.publicKey.toBase58()) && !rows.some((r) => r.owner === W.D.publicKey.toBase58() && BigInt(r.amount) === 0n), "the account whose owner changed off-history was paid to its CURRENT owner, and did not freeze the graduation");
ok(BigInt(L.surplus_burned ?? 0) === 1n, "the unit someone sent to the platform mid-push was burned, not a reason to stall");
const S = JSON.parse(L.settle_json);
ok(paid + failedAmt === BigInt(S.toHolders), "holders received exactly the settlement's total (minus the unpayable share, burned)");
ok((await bal(pumpMint, platform.publicKey)) === 0n, "the platform holds none of the coin afterwards");
ok((await bal(pumpMint, treasury.publicKey)) === BigInt(L.treasury_amt), `the treasury holds exactly the dynamic fees + dust (${L.treasury_amt})`);
const pumpInfo = await getMint(conn, pumpMint, "confirmed", TOKEN_2022_PROGRAM_ID);
ok(pumpInfo.supply === 1_000_000_000_000_000n - BigInt(L.burn) - failedAmt - BigInt(L.surplus_burned ?? 0) && BigInt(L.burn) > 0n, `the auto burn (and the unpayable share) really reduced the pump.fun coin's supply by ${BigInt(L.burn) + failedAmt}`);
ok(BigInt(L.burn) + failedAmt + BigInt(L.treasury_amt) + paid === BigInt(L.pump_bought), "holders + burn + treasury == every token the pump.fun buy returned");
ok(rows.some((r) => r.owner === lateFrom.publicKey.toBase58()) && !rows.some((r) => r.owner === lateTo.publicKey.toBase58()), "a transfer made after graduation did not change who got paid");
ok(dust.every((k) => !rows.some((r) => r.owner === k.publicKey.toBase58())), "dust wallets were not paid (sending cost more than their share); their share was burned");
ok(rows.some((r) => r.owner === W.D.publicKey.toBase58()), "a wallet that only received tokens wallet-to-wallet was paid (and carries its share of fee and burn)");
const pump = new OnlinePumpSdk(conn);
const bc = await pump.fetchBondingCurve(pumpMint);
ok(bc.creator.equals(holderRewardsPda(pumpMint)), "holder rewards from the token's on-chain rules: the pump.fun coin's creator fees go to its holders, permanently");
ok(!getTransferHook(pumpInfo), "the pump.fun coin has no hook: a normal pump.fun coin");
ok(mintA.toBase58().endsWith("hook") && mintKpB.publicKey.toBase58().endsWith("hook") && pumpMint.toBase58().endsWith("hook"),
  `every address ends in hook: Meteora ${mintA.toBase58().slice(-8)}, pump.fun ${pumpMint.toBase58().slice(-8)}`);
const capSol = Number(bc.virtualQuoteReserves) / Number(bc.virtualTokenReserves) * Number(pumpInfo.supply) / LAMPORTS_PER_SOL;
const endCap = P.capAt(sizes[0]);
console.log(`   window ended at a ${endCap.toFixed(1)} SOL cap; the pump.fun coin opens at ${capSol.toFixed(1)} SOL`);
// ⭐ the pump.fun coin opens where the SOL spent on it says: the raise plus the fee-funded buys (the 1:1
// top-up and the holder share, both paid from the platform's trading fees). With the 50% anti-snipe fee
// those fees are large, so it opens ABOVE the curve's end (holders get more), never below it.
const gl = getLaunch(db, mintA.toBase58());
const spentSol = Number(gl.pump_spend ?? 0) / LAMPORTS_PER_SOL;
const expectCap = P.capAt(spentSol);
console.log(`   pump.fun buy ${spentSol.toFixed(2)} SOL (of it a ${(Number(gl.pump_topup ?? 0) / 1e9).toFixed(2)} SOL top-up from fees) → expected open ${expectCap.toFixed(1)} SOL`);
// pump.fun's own fee comes off the buy, so it opens a little under capAt(spent); never under the curve's end
ok(spentSol > 0 && capSol >= endCap * 0.97 && capSol <= expectCap * 1.02, `market cap is continuous across graduation: opens ${((capSol / endCap - 1) * 100).toFixed(1)}% vs the curve's end, ${((capSol / expectCap - 1) * 100).toFixed(1)}% vs what was spent`);
const pAfter = await getPool(dbc, poolA);
ok(!!pAfter.isMigrated && !!pAfter.isWithdrawLeftover, "the pool is migrated and the leftover withdrawn (the stranger's doing, found done by the service)");

// ── the coin's life on pump.fun: priced right in every phase ──────────────────────────────
console.log("\n── pricing the coin on pump.fun, then on PumpSwap");
const pc1 = await pumpMarketCap(conn, pumpMint);
ok(pc1?.venue === "pump.fun" && Math.abs(pc1.marketCapSol / capSol - 1) < 0.01, `on pump.fun's curve the site prices it from the curve's virtual reserves (${pc1?.marketCapSol.toFixed(1)} SOL)`);
// a whale fills the rest of pump.fun's curve
const whale = Keypair.generate(); await fund(whale);
const buyState = await pump.fetchBuyState(pumpMint, whale.publicKey, TOKEN_2022_PROGRAM_ID);
const G2 = await pump.fetchGlobal(), FC = await pump.fetchFeeConfig();
const rest = buyState.bondingCurve.realTokenReserves;
// ⚠ mintSupply null means "a brand-new curve" to the SDK: pass the real supply or the quote is priced from 28 SOL
const costSol = getBuySolAmountFromTokenAmount({ global: G2, feeConfig: FC, mintSupply: new BN((pumpInfo.supply - BigInt(L.burn)).toString()), bondingCurve: buyState.bondingCurve, amount: rest, quoteMint: new PublicKey("So11111111111111111111111111111111111111112") });
await send([...(await PUMP_SDK.buyInstructions({ global: G2, bondingCurveAccountInfo: buyState.bondingCurveAccountInfo, bondingCurve: buyState.bondingCurve, associatedUserAccountInfo: buyState.associatedUserAccountInfo,
  mint: pumpMint, user: whale.publicKey, amount: rest, solAmount: costSol, slippage: 25, tokenProgram: TOKEN_2022_PROGRAM_ID }))], [whale]);
const bcFull = await pump.fetchBondingCurve(pumpMint);
ok(bcFull.complete, `pump.fun's curve filled (${(Number(costSol) / 1e9).toFixed(2)} SOL more)`);
const liveSupply = (await getMint(conn, pumpMint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply; // after every burn (auto, dust, unpayable)
const capAtFill = Number(bcFull.virtualQuoteReserves) / Number(bcFull.virtualTokenReserves) * Number(liveSupply) / 1e9;
ok((await pumpMarketCap(conn, pumpMint)) === null, "filled but not yet migrated: the site prices it as unknown (null), never as 0");
// anyone may migrate a filled curve to PumpSwap
const { ComputeBudgetProgram } = await import("@solana/web3.js");
await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), await PUMP_SDK.migrateInstruction({ withdrawAuthority: G2.withdrawAuthority, mint: pumpMint, user: whale.publicKey, tokenProgram: TOKEN_2022_PROGRAM_ID })], [whale]);
const bcAfter = await pump.fetchBondingCurve(pumpMint);
console.log(`   after migration the curve reads virtual ${bcAfter.virtualTokenReserves}/${bcAfter.virtualQuoteReserves}, complete=${bcAfter.complete}`);
const pc2 = await pumpMarketCap(conn, pumpMint);
const poolAcct = await conn.getAccountInfo(canonicalPumpPoolPda(pumpMint), "confirmed");
const pool2 = decodePool(poolAcct?.data);
ok(pc2?.venue === "PumpSwap" && pc2.marketCapSol > 0, `on PumpSwap the site prices it from the pool (${pc2?.marketCapSol.toFixed(1)} SOL cap; the curve ended at ${capAtFill.toFixed(1)})`);
{ const qb = Number((await conn.getTokenAccountBalance(pool2.quoteAccount)).value.amount), bb = Number((await conn.getTokenAccountBalance(pool2.baseAccount)).value.amount);
  const supplyTokens = Number(liveSupply) / 1e6, baseTokens = bb / 1e6;
  const balanceOnly = (qb / 1e9) / baseTokens * supplyTokens, withVirtual = ((qb + Number(pool2.virtualQuoteReserves)) / 1e9) / baseTokens * supplyTokens;
  console.log(`   pool: ${(qb / 1e9).toFixed(3)} SOL + virtual ${(Number(pool2.virtualQuoteReserves) / 1e9).toFixed(3)} SOL against ${(baseTokens / 1e6).toFixed(1)}M tokens; balance-only cap would read ${balanceOnly.toFixed(1)} SOL`);
  ok(Math.abs(pc2.marketCapSol / withVirtual - 1) < 1e-9 && balanceOnly < pc2.marketCapSol * 0.9, "the PumpSwap price includes the pool's virtual quote reserves (balances alone read low)"); }
ok(pc2.marketCapSol > capAtFill * 0.9 && pc2.marketCapSol < capAtFill * 1.4, "the PumpSwap cap is in line with where the curve ended (no zero, no wild jump)");

// ── pump.fun changes its curve: new configs, old ones kept for their tokens ───────────────
console.log("\n── pump.fun changes its curve");
{ const f = `${DATA}/configs.json`; const st = JSON.parse(readFileSync(f, "utf8")); st.pump.virtualSol = st.pump.virtualSol + 1; writeFileSync(f, JSON.stringify(st)); }
const after = await ensureConfigs({ conn, platform, hookProgram: HOOK, dataDir: DATA, log: (m) => console.log("  ", m) });
ok(after.changed && Object.values(after.configs).every((c) => !Object.values(configs).some((o) => o.equals(c))), "when pump.fun's curve moves, a fresh set of configs is made");
ok(after.retired.length === 1 && Object.keys(after.retired[0].configs).length === 4 && after.all[configs[sizes[0]].toBase58()]?.retired === true, "the old configs are kept as retired, so their tokens are still recognised");
ok(JSON.stringify((await loadConfigState(DATA)).pump && Object.keys((await loadConfigState(DATA)).configs)) === JSON.stringify(Object.keys(after.configs)), "the API's view of the configs reloads from the same file");
ok((await bal(mintA, platform.publicKey)) === 0n, "the unsold window tokens were burned, not sold");
const platformDelta = BigInt(await lam(platform.publicKey)) - BigInt(platformBefore);
console.log(`   platform SOL: ${platformDelta >= 0n ? "+" : ""}${sol(platformDelta)} (its trading-fee share minus the holder pot, plus the unspent push reserve)`);
ok(platformDelta > 0n, "graduation cost the platform nothing out of pocket: the push was paid from the raise");
ok(db.prepare("SELECT COUNT(*) n FROM pending").get().n === 0, "no transaction left in flight in the ledger");
// running again does nothing
const sigsBefore = (await conn.getSignaturesForAddress(platform.publicKey, { limit: 1 }))[0].signature;
await g.tick();
ok((await conn.getSignaturesForAddress(platform.publicKey, { limit: 1 }))[0].signature === sigsBefore, "a further pass sends nothing");
// the hot wallet keeps only its float; the rest goes to the cold treasury
const { HOT_FLOAT } = await import("../lib/graduate.mjs");
const tBefore = BigInt(await lam(treasury.publicKey));
const swept = await g.sweep();
ok(swept > 0n && BigInt(await lam(treasury.publicKey)) - tBefore === swept, `idle sweep moved ${sol(swept)} SOL from the hot wallet to the treasury`);
const left = BigInt(await lam(platform.publicKey));
ok(left <= HOT_FLOAT && left > HOT_FLOAT - 10_000n, `the hot wallet kept only its ${sol(HOT_FLOAT)} SOL float`);
ok((await g.sweep()) === null, "a second sweep sends nothing");
{ // one coin per token: the platform's fees topped the raise up so holders' base share equals what they held
  const g = getLaunch(db, mintA.toBase58()), sj = JSON.parse(g.settle_json);
  const held = BigInt(sj.held), base = BigInt(sj.base), topUp = BigInt(sj.topUp), fees = BigInt(g.fees_claimed);
  console.log(`   held ${held}, base coins ${base}, top-up ${sol(topUp)} of ${sol(fees)} SOL in platform fees`);
  ok(topUp > 0n && (base * 10_000n >= held * 9_999n || topUp === fees), "holders got (at least) one pump.fun coin per window token, topped up from the platform's fees");
}
// ── the burn: a graduated coin's creator fees buy and burn $HOOKER (lib/flywheel.mjs) ──────────────
// launch C has no "creator fees to holders", so its pump.fun coin names the BURN wallet as creator. The coin
// itself stands in for $HOOKER here: trades on PumpSwap feed the burn wallet's creator vault, the keeper claims it,
// buys the coin and burns it, and the supply on chain goes down by exactly what it bought.
console.log("\n── the burn");
const { createFlywheel, assertSeparate } = await import("../lib/flywheel.mjs");
const { OnlinePumpAmmSdk, PUMP_AMM_SDK } = createRequire(import.meta.url)("@pump-fun/pump-swap-sdk");
const burnKp = Keypair.generate(), creatorC = Keypair.generate();
await fund(burnKp, creatorC);
// launch C and its coin take two keys from the pool; the ground …hook keys are spent, so two plain ones go in (the suffix is checked above)
for (let i = 0; i < 2; i++) { const k = Keypair.generate(); db.prepare("INSERT INTO vanity (pubkey, secret, created_at) VALUES (?, ?, ?)").run(k.publicKey.toBase58(), Buffer.from(k.secretKey).toString("base64"), 1 + i); }
let threw = null; try { assertSeparate(burnKp.publicKey, { hookerCreator: burnKp.publicKey }); } catch (e) { threw = e.message; }
ok(/HOOKER's creator/.test(threw ?? ""), "the keeper refuses a burn wallet that is $HOOKER's own creator (pump.fun would mix the fees)");
const { tx: txC, mint: mintKpC, pool: poolC } = await buildLaunchTx({ dbc, hookProgram: HOOK, config: new PublicKey(after.configs[Object.keys(after.configs).map(Number).sort((a, b) => a - b)[0]]), creator: creatorC.publicKey,
  name: "Burn Me", symbol: "BURNME", uri: IPFS_URI, rules: { ...DEFAULT_RULES, earlySecs: 0, earlyMaxWalletBps: 0 }, devBuyLamports: 100_000_000n, mint: hookKey(creatorC.publicKey), lut });
await send(txC, [creatorC, mintKpC]);
const mintC = mintKpC.publicKey;
{ const cfgC = new PublicKey(after.configs[Object.keys(after.configs).map(Number).sort((a, b) => a - b)[0]]);
  const thr = BigInt((await getConfig(dbc, cfgC)).migrationQuoteThreshold.toString());
  for (let i = 0; i < 40; i++) { const p = await getPool(dbc, poolC); if (BigInt(p.quoteReserve.toString()) >= thr) break; const w = Keypair.generate(); await fund(w); await swap(w, true, 3_000_000_000n, { cosign: false, pool: poolC, mint: mintC }); } }
const gC = new Graduator({ conn, db, platform, treasury: treasury.publicKey, hookProgram: HOOK, configs: Object.fromEntries(Object.entries(after.configs).map(([g, c]) => [g, new PublicKey(c)])), burnWallet: burnKp.publicKey, log: (...a) => console.log("   ·", ...a) });
await gC.discover();
for (let i = 0; i < 60 && getLaunch(db, mintC.toBase58()).status !== "done"; i++) { const b4 = getLaunch(db, mintC.toBase58()).status; await gC.tick(); db.prepare("UPDATE launches SET next_try = 0").run(); if (getLaunch(db, mintC.toBase58()).status === b4) await sleep(3000); }
const LC = getLaunch(db, mintC.toBase58());
ok(LC.status === "done" && LC.fee_to === "burn", "launch C graduated, with its coin's creator fees routed to the burn");
const pumpMintC = new PublicKey(LC.pump_mint);
ok((await pump.fetchBondingCurve(pumpMintC)).creator.equals(burnKp.publicKey), "on chain the pump.fun coin's creator IS the burn wallet (launch A's was its holders' rewards account)");
{ // the smallest size fills only part of pump.fun's curve: the whale buys the rest, then anyone migrates it to PumpSwap
  const bs = await pump.fetchBuyState(pumpMintC, whale.publicKey, TOKEN_2022_PROGRAM_ID);
  const restC = bs.bondingCurve.realTokenReserves;
  const supC = (await getMint(conn, pumpMintC, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  const costC = getBuySolAmountFromTokenAmount({ global: G2, feeConfig: FC, mintSupply: new BN(supC.toString()), bondingCurve: bs.bondingCurve, amount: restC, quoteMint: new PublicKey("So11111111111111111111111111111111111111112") });
  await send([...(await PUMP_SDK.buyInstructions({ global: G2, bondingCurveAccountInfo: bs.bondingCurveAccountInfo, bondingCurve: bs.bondingCurve, associatedUserAccountInfo: bs.associatedUserAccountInfo,
    mint: pumpMintC, user: whale.publicKey, amount: restC, solAmount: costC, slippage: 25, tokenProgram: TOKEN_2022_PROGRAM_ID }))], [whale]);
  ok((await pump.fetchBondingCurve(pumpMintC)).complete, "coin C's pump.fun curve filled"); }
await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), await PUMP_SDK.migrateInstruction({ withdrawAuthority: G2.withdrawAuthority, mint: pumpMintC, user: whale.publicKey, tokenProgram: TOKEN_2022_PROGRAM_ID })], [whale]);
// trades on PumpSwap: creator fees accrue to the burn wallet's vault
const amm = new OnlinePumpAmmSdk(conn);
const poolCKey = canonicalPumpPoolPda(pumpMintC);
for (let i = 0; i < 3; i++) { const st = await amm.swapSolanaState(poolCKey, whale.publicKey); await send(await PUMP_AMM_SDK.buyQuoteInput(st, new BN(2_000_000_000), 10), [whale]); }
const fw = createFlywheel({ conn, db, burn: burnKp, hookerMint: pumpMintC, platform: platform.publicKey, log: (...a) => console.log("   ·", ...a) });
const w0 = await fw.waiting();
ok(w0.lamports > 0n, `the burn wallet's creator vault holds ${sol(w0.lamports)} SOL of fees from the trades`);
const supplyBefore = (await getMint(conn, pumpMintC, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
const balBefore = BigInt(await lam(burnKp.publicKey));
await fw.tick();
const burnRows = db.prepare("SELECT * FROM burns WHERE dry = 0 ORDER BY id").all();
ok(burnRows.some((r) => r.kind === "claim") && BigInt(await lam(burnKp.publicKey)) !== balBefore, "the keeper claimed the vault into the burn wallet");
const burnRow = burnRows.find((r) => r.kind === "burn");
const supplyAfter = (await getMint(conn, pumpMintC, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
ok(!!burnRow && supplyBefore - supplyAfter === BigInt(burnRow.hooker_burned), `it bought ${Number(burnRow?.hooker_burned ?? 0) / 1e6} coins on PumpSwap and burned them: the supply fell by exactly that`);
ok((await bal(pumpMintC, burnKp.publicKey)) === 0n, "nothing of the coin is left in the burn wallet");
const dryFw = createFlywheel({ conn, db, burn: null, burnPubkey: burnKp.publicKey, hookerMint: pumpMintC, log: (...a) => console.log("   ·", ...a) });
for (let i = 0; i < 2; i++) { const st = await amm.swapSolanaState(poolCKey, whale.publicKey); await send(await PUMP_AMM_SDK.buyQuoteInput(st, new BN(1_000_000_000), 10), [whale]); }
const sigBefore = (await conn.getSignaturesForAddress(burnKp.publicKey, { limit: 1 }))[0].signature;
await dryFw.tick();
ok((await conn.getSignaturesForAddress(burnKp.publicKey, { limit: 1 }))[0].signature === sigBefore && db.prepare("SELECT COUNT(*) n FROM burns WHERE dry = 1").get().n > 0, "dry mode simulates the claim and the burn and sends nothing");
console.log(`\nALL ${checks} CHECKS PASSED`);
