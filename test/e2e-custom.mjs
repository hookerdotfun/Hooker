// Custom graduation caps on the local validator (scripts/validator.sh, mainnet Meteora + pump.fun bytecode):
// a config made per launch and paid by the creator, a launch on it before the config is readable by the SDK,
// the no-migration curve refusing to ever fill, and a custom cap filling + revoking the hook like the fixed sizes.
//   LOCAL_RPC=http://127.0.0.1:8897 node test/e2e-custom.mjs
import { Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { connect } from "../lib/env.mjs";
import { dbcClient, getPool, getConfig } from "../lib/chain.mjs";
import { openDb } from "../lib/db.mjs";
import { buildLaunchTx, buildSwapTx } from "../lib/launch.mjs";
import { DEFAULT_RULES } from "../lib/rules.mjs";
import { pumpParams, NO_MIGRATION_THRESHOLD } from "../lib/curve.mjs";
import { issueCustomConfig, checkCustomConfig, customConfig, customPoolCandidates } from "../lib/custom-configs.mjs";
import { createRequire } from "node:module";
const { OnlinePumpSdk } = createRequire(import.meta.url)("@pump-fun/pump-sdk");

const conn = connect(process.env.LOCAL_RPC || "http://127.0.0.1:8997", 0);
const dbc = dbcClient(conn);
const HOOK = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL("../keys/hooker-hook-keypair.json", import.meta.url))))).publicKey;
let checks = 0;
const ok = (c, m) => { if (!c) { console.error("❌ FAIL:", m); process.exit(1); } checks++; console.log("✅", m); };
const send = (tx, signers) => sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
const fund = async (k, sol) => conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL), "confirmed");
const db = openDb(":memory:");
const p = pumpParams(await new OnlinePumpSdk(conn).fetchGlobal());
const platform = Keypair.generate(), creator = Keypair.generate(), whale = Keypair.generate();
await fund(creator, 50); for (let i = 0; i < 4; i++) await fund(whale, 500); await fund(platform, 1);
// on mainnet Meteora keeps the DBC pool authority funded (flash rent for migration); a clone starts it at 0
await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: whale.publicKey, toPubkey: new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"), lamports: 2 * LAMPORTS_PER_SOL })), [whale]);

/** The API's flow: config tx (creator pays, config key signs) then the launch built from the in-memory params. */
async function launchCustom(name, choice, { antiSnipe = false, devBuy = 50_000_000n } = {}) {
  const mint = Keypair.generate();
  const { tx: ctx, config, configKey, curve } = await issueCustomConfig({ db, dbc, p, platform: platform.publicKey, hookProgram: HOOK, creator: creator.publicKey, mint: mint.publicKey.toBase58(), choice, antiSnipe });
  // the launch is built BEFORE the config exists, the way the API builds both for one wallet prompt
  const { tx: ltx, pool } = await buildLaunchTx({ dbc, hookProgram: HOOK, config, creator: creator.publicKey, name, symbol: name.slice(0, 6).toUpperCase(),
    uri: "https://example.com/t.json", rules: { ...DEFAULT_RULES }, devBuyLamports: devBuy, mint, configParams: curve.params });
  const before = await conn.getBalance(creator.publicKey);
  ctx.feePayer = creator.publicKey; ctx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  await send(ctx, [creator, configKey]);
  const rent = (before - await conn.getBalance(creator.publicKey)) / 1e9;
  ltx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  await send(ltx, [creator, mint]);
  return { mint: mint.publicKey, pool, config, curve, rent };
}

console.log("\n── no migration");
const N = await launchCustom("Forever", { kind: "none" });
ok(N.rent < 0.02, `the creator paid the config's rent: ${N.rent.toFixed(4)} SOL`);
const cN = await getConfig(dbc, N.config);
ok(checkCustomConfig(cN, customConfig(db, N.config), platform.publicKey) === null, "the config on chain is exactly the one issued (fee claimer, 99% fee, split, threshold, anti-snipe)");
ok(cN.migrationQuoteThreshold.toString() === NO_MIGRATION_THRESHOLD.toString(), "its graduation needs 1,000,000,000 SOL: it can never fill");
ok(checkCustomConfig(cN, { ...customConfig(db, N.config), threshold: "1" }, platform.publicKey) !== null, "a config whose threshold differs from the issued one is refused");
ok(checkCustomConfig(cN, customConfig(db, N.config), Keypair.generate().publicKey) === "the config pays someone else", "a config paying another wallet is refused");
for (let i = 0; i < 4; i++) await send(await buildSwapTx({ dbc, pool: N.pool, owner: whale.publicKey, buy: true, amountIn: 200_000_000_000n }), [whale]);
const pN = await getPool(dbc, N.pool);
ok(Number(pN.quoteReserve) / 1e9 > 790 && !pN.isMigrated && pN.migrationProgress === 0, `800 SOL bought into it (${(Number(pN.quoteReserve) / 1e9).toFixed(1)} SOL, past every pump.fun graduation) and it still trades, unmigrated`);
const hookOn = (await conn.getAccountInfo(N.mint)).data.length > 0 && !!(await getPool(dbc, N.pool));
const { getTransferHook, getMint, TOKEN_2022_PROGRAM_ID } = await import("@solana/spl-token");
const th = getTransferHook(await getMint(conn, N.mint, "confirmed", TOKEN_2022_PROGRAM_ID));
ok(hookOn && th?.programId.equals(HOOK), "the hook is still on the token after 800 SOL of buys");
const capN = Number((await import("@meteora-ag/dynamic-bonding-curve-sdk")).getPriceFromSqrtPrice(pN.sqrtPrice, 6, 9)) * 1e9;
console.log(`   market cap after 800 SOL: ${capN.toFixed(0)} SOL (pump.fun's curve shape would read ${p.capAt(800).toFixed(0)})`);
await send(await buildSwapTx({ dbc, pool: N.pool, owner: whale.publicKey, buy: false, amountIn: 10_000_000_000n }), [whale]);
ok(true, "selling back works");
ok(customPoolCandidates(db).some((c) => c.pool.equals(N.pool) && c.noMigration), "the graduator finds the pool from the issued config without a program scan");

console.log("\n── a small custom cap (40 SOL market cap) fills and graduates like a fixed size");
const S = await launchCustom("Small", { kind: "cap", capSol: 40 }, { antiSnipe: true });
const cS = await getConfig(dbc, S.config);
ok(checkCustomConfig(cS, customConfig(db, S.config), platform.publicKey) === null, `anti-snipe custom config matches (graduates at ${S.curve.raiseSol.toFixed(2)} SOL raised)`);
await new Promise((r) => setTimeout(r, 3000));
await send(await buildSwapTx({ dbc, pool: S.pool, owner: whale.publicKey, buy: true, amountIn: 20_000_000_000n }), [whale]);
const pS = await getPool(dbc, S.pool);
ok(BigInt(pS.quoteReserve.toString()) >= BigInt(cS.migrationQuoteThreshold.toString()), "a big buy fills it");
const th2 = getTransferHook(await getMint(conn, S.mint, "confirmed", TOKEN_2022_PROGRAM_ID));
ok(!th2 || th2.programId.equals(PublicKey.default), "filling revoked the hook, as on the fixed sizes");
const capS = Number((await import("@meteora-ag/dynamic-bonding-curve-sdk")).getPriceFromSqrtPrice(pS.sqrtPrice, 6, 9)) * 1e9;
ok(Math.abs(capS - 40) / 40 < 0.03, `it filled at a ${capS.toFixed(1)} SOL market cap (asked 40)`);

console.log("\n── a cap above pump.fun's own graduation (2,000 SOL market cap)");
const B = await launchCustom("Big", { kind: "cap", capSol: 2000 });
ok(B.curve.raiseSol > p.completionSol, `graduates at ${B.curve.raiseSol.toFixed(1)} SOL raised, past pump.fun's ${p.completionSol.toFixed(1)}`);
for (let i = 0; i < 2; i++) await send(await buildSwapTx({ dbc, pool: B.pool, owner: whale.publicKey, buy: true, amountIn: 150_000_000_000n }), [whale]);
const pB = await getPool(dbc, B.pool), cB = await getConfig(dbc, B.config);
ok(BigInt(pB.quoteReserve.toString()) >= BigInt(cB.migrationQuoteThreshold.toString()), "it fills");
const capB = Number((await import("@meteora-ag/dynamic-bonding-curve-sdk")).getPriceFromSqrtPrice(pB.sqrtPrice, 6, 9)) * 1e9;
ok(Math.abs(capB - 2000) / 2000 < 0.03, `at a ${capB.toFixed(0)} SOL market cap (asked 2,000)`);

console.log("\n── the graduation service takes both filled custom caps to pump.fun");
const { Graduator } = await import("../lib/graduate.mjs");
const { getLaunch } = await import("../lib/db.mjs");
const treasury = Keypair.generate();
await fund(platform, 5);
const g = new Graduator({ conn, db, platform, treasury: treasury.publicKey, hookProgram: HOOK, configs: [], log: (...a) => console.log("   ·", ...a) });
for (let i = 0; i < 4; i++) { const k = Keypair.generate(); db.prepare("INSERT INTO vanity (pubkey, secret, created_at) VALUES (?, ?, ?)").run(k.publicKey.toBase58(), Buffer.from(k.secretKey).toString("base64"), 1 + i); }
await g.discover();
const LN = getLaunch(db, N.mint.toBase58()), LS = getLaunch(db, S.mint.toBase58()), LB = getLaunch(db, B.mint.toBase58());
ok(LN?.no_migration === 1 && LS?.cap_sol > 39 && LB?.cap_sol > 1999, "discovery registered all three from their own configs (no program scan), the no-migration one marked so");
for (let i = 0; i < 80 && [S, B].some((t) => getLaunch(db, t.mint.toBase58()).status !== "done"); i++) {
  const b4 = [S, B].map((t) => getLaunch(db, t.mint.toBase58()).status).join();
  await g.tick(); db.prepare("UPDATE launches SET next_try = 0").run();
  if ([S, B].map((t) => getLaunch(db, t.mint.toBase58()).status).join() === b4) await new Promise((r) => setTimeout(r, 2000));
}
for (const [t, name] of [[S, "40 SOL cap"], [B, "2,000 SOL cap"]]) { const l = getLaunch(db, t.mint.toBase58()); ok(l.status === "done", `${name}: graduated to done (${l.status}${l.error ? ": " + l.error.slice(0, 200) : ""})`); }
ok(getLaunch(db, N.mint.toBase58()).status === "trading", "the no-migration token is still trading: the service never touches it");
const lb = getLaunch(db, B.mint.toBase58());
ok(BigInt(lb.pump_extra) > 0n && BigInt(lb.pump_bought) > BigInt(lb.pump_curve_bought), `2,000 SOL cap: pump.fun's curve filled (${Number(lb.pump_curve_bought) / 1e6}M coins), then ${(Number(lb.pump_extra) / 1e9).toFixed(1)} SOL bought ${(Number(BigInt(lb.pump_bought) - BigInt(lb.pump_curve_bought)) / 1e12).toFixed(1)}M more on PumpSwap`);
const pm = new PublicKey(lb.pump_mint);
const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
const coins = async (o) => { const a = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(pm, o, true, TOKEN_2022_PROGRAM_ID), "confirmed").catch(() => null); return a ? BigInt(a.value.amount) : 0n; };
const [cw, cc, cp] = [await coins(whale.publicKey), await coins(creator.publicKey), await coins(platform.publicKey)];
ok(cw > 0n && cc > 0n && cp === 0n, `holders hold the coin (whale ${(Number(cw) / 1e12).toFixed(1)}M, creator ${(Number(cc) / 1e12).toFixed(3)}M), the platform none`);
const { pumpMarketCap } = await import("../lib/pumpprice.mjs");
const pc = await pumpMarketCap(conn, lb.pump_mint);
console.log(`   the pump.fun coin's market cap after graduation: ${pc?.marketCapSol?.toFixed(0)} SOL on ${pc?.venue} (the token graduated at ${lb.cap_sol.toFixed(0)})`);
ok(pc?.venue && pc.marketCapSol > 1000, "the coin is live on PumpSwap at a cap in the same range as the token's");

console.log("\n── the API, driven the way the site drives it");
{
  const bs58 = (await import("bs58")).default;
  const nacl = createRequire(import.meta.url)("tweetnacl");
  const { VersionedTransaction } = await import("@solana/web3.js");
  const { createApi } = await import("../server/api.mjs");
  const { mkdirSync, rmSync } = await import("node:fs");
  const { ensureLut, pumpStaticKeys } = await import("../lib/lut.mjs");
  const { launchStaticKeys } = await import("../lib/launch.mjs");
  const DATA = new URL("../data/test-custom/", import.meta.url).pathname;
  rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
  const pump = new OnlinePumpSdk(conn);
  // the lookup table the graduator keeps (pump.fun's fixed accounts + a launch's); custom configs are NOT in it
  await ensureLut({ conn, payer: platform, keys: [...await pumpStaticKeys({ global: await pump.fetchGlobal(), feeConfig: await pump.fetchFeeConfig() }), ...await launchStaticKeys({ dbc, hookProgram: HOOK, configs: [N.config] })], file: `${DATA}/lut.json` });
  for (let i = 0; i < 6; i++) { const k = Keypair.generate(); db.prepare("INSERT INTO vanity (pubkey, secret, created_at) VALUES (?, ?, ?)").run(k.publicKey.toBase58(), Buffer.from(k.secretKey).toString("base64"), 100 + i); }
  const fakeFetch = async (url) => String(url).includes("sol-price") ? new Response(JSON.stringify({ solPrice: 100 }), { status: 200 }) : new Response("[]", { status: 200 });
  const api = createApi({ conn, db, dataDir: DATA, configs: {}, hookProgram: HOOK, fetchImpl: fakeFetch, vanityReserve: 0, platform: platform.publicKey, launchesPerIpPerHour: 50 });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${api.address().port}`;
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  const signed = async (kp, body) => { const { nonce, message } = (await call("GET", `/api/launch-nonce/${kp.publicKey.toBase58()}`)).json; return { ...body, nonce, signature: bs58.encode(nacl.sign.detached(Buffer.from(message), kp.secretKey)) }; };
  const signAndSend = async (b64, wallet) => {
    const raw = Buffer.from(b64, "base64"), v = VersionedTransaction.deserialize(raw);
    let out; if (v.version === "legacy") { const t = Transaction.from(raw); t.partialSign(wallet); out = t.serialize(); } else { v.sign([wallet]); out = v.serialize(); }
    return call("POST", "/api/send", { tx: Buffer.from(out).toString("base64") });
  };
  const URI = "https://ipfs.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const launchBody = (extra) => ({ creator: creator.publicKey.toBase58(), name: "Custom", symbol: "CUST", uri: URI, devBuySol: 0.1, ...extra });

  const info = (await call("GET", "/api/info")).json;
  ok(info.custom && info.custom.minCapSol > 30 && info.custom.maxCapSol === 100_000 && info.custom.noMigration && info.custom.pumpfunCapSol > 400, `info offers custom caps ${info.custom?.minCapSol?.toFixed(1)}..${info.custom?.maxCapSol} SOL and no migration`);
  ok((await call("POST", "/api/tx/launch", await signed(creator, launchBody({ custom: { kind: "cap", capSol: 10 } })))).status === 400, "a cap under the minimum is refused");
  ok((await call("POST", "/api/tx/launch", await signed(creator, launchBody({ custom: { kind: "cap", capSol: 1e9 } })))).status === 400, "a cap over the maximum is refused");
  ok((await call("POST", "/api/tx/launch", await signed(creator, launchBody({ custom: { kind: "moon" } })))).status === 400, "an unknown kind is refused");
  const hs = await call("POST", "/api/tx/launch", await signed(creator, launchBody({ custom: { kind: "none" }, rules: { holderShareBps: 5000 } })));
  ok(hs.status === 400 && /Holder share/.test(hs.json.error), `no migration refuses a hook paid at graduation: "${hs.json.error}"`);
  const ab = await call("POST", "/api/tx/launch", await signed(creator, launchBody({ custom: { kind: "none" }, rules: { burnBps: 100 } })));
  ok(ab.status === 400 && /Auto burn/.test(ab.json.error), "…and auto burn");

  // a stranger's own config transaction is not relayed (only configs the API issued are)
  { const k = Keypair.generate(); const t = await dbc.partner.createConfigWithTransferHook({ ...S.curve.params, config: k.publicKey, feeClaimer: creator.publicKey, leftoverReceiver: creator.publicKey, quoteMint: (await import("@solana/spl-token")).NATIVE_MINT, payer: creator.publicKey, transferHookProgram: HOOK });
    t.feePayer = creator.publicKey; t.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; t.sign(creator, k);
    const r = await call("POST", "/api/send", { tx: t.serialize().toString("base64") });
    ok(r.status === 400, "a config the API did not issue is not relayed"); }

  for (const [label, custom, rules] of [["60 SOL cap", { kind: "cap", capSol: 60 }, { maxWalletBps: 500 }], ["no migration", { kind: "none" }, { maxWalletBps: 300, allowlist: false }]]) {
    const L = await call("POST", "/api/tx/launch", await signed(creator, launchBody({ custom, rules, antiSnipe: label === "60 SOL cap" })));
    ok(L.status === 200 && L.json.configTx && L.json.tx && L.json.config, `${label}: the API returns the config transaction and the launch (${L.status} ${L.json.error ?? ""})`);
    const lsize = VersionedTransaction.deserialize(Buffer.from(L.json.tx, "base64")).serialize().length;
    ok(lsize <= 1232, `${label}: the launch fits one transaction with its own config outside the lookup table (${lsize} bytes)`);
    const c1 = await signAndSend(L.json.configTx, creator);
    ok(c1.status === 200, `${label}: the creator's wallet signs the config and the API relays it (${c1.json.error ?? c1.json.signature?.slice(0, 12)})`);
    const l1 = await signAndSend(L.json.tx, creator);
    ok(l1.status === 200, `${label}: then the launch lands on it (${l1.json.error ?? l1.json.signature?.slice(0, 12)})`);
    ok((await call("POST", "/api/register", { mint: L.json.mint })).status === 200, `${label}: registered`);
    const t = (await call("GET", `/api/token/${L.json.mint}`)).json;
    if (custom.kind === "cap") ok(t.customCap && Math.abs(t.capSol - 60) < 0.5 && t.gradSol > 5 && t.progress > 0 && !t.noMigration && t.antiSnipe, `${label}: its page shows a ${t.capSol?.toFixed(1)} SOL cap, ${t.gradSol?.toFixed(2)} SOL to raise, ${(t.progress * 100).toFixed(1)}% there, anti-snipe on`);
    else ok(t.noMigration && t.progress === null && t.gradSol === null && t.targetSol === null && t.marketCapSol > 0 && t.status === "trading", `${label}: its page says it never migrates (no progress bar, no target), market cap ${t.marketCapSol?.toFixed(1)} SOL`);
  }
  api.close();
}
console.log(`\n${checks} checks passed`);
