// The API, driven the way the site drives it: ask for a transaction, sign it with the wallet, send
// it back. Needs the local validator and data/test/configs.json (run test/e2e.mjs once first).
import { Keypair, LAMPORTS_PER_SOL, Transaction, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { createRequire } from "node:module";
const nacl = createRequire(import.meta.url)("tweetnacl");
import { readFileSync } from "node:fs";
import { connect } from "../lib/env.mjs";
import { openDb } from "../lib/db.mjs";
import { createApi } from "../server/api.mjs";
import { Graduator } from "../lib/graduate.mjs";

const conn = connect(process.env.LOCAL_RPC || "http://127.0.0.1:8997", 0);
const DATA = new URL("../data/test/", import.meta.url).pathname;
const configs = Object.fromEntries(Object.entries(JSON.parse(readFileSync(`${DATA}/configs.json`, "utf8")).configs).map(([g, c]) => [g, new PublicKey(c)]));
const G0 = Math.min(...Object.keys(configs).map(Number));
const HOOK = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL("../keys/hooker-hook-keypair.json", import.meta.url))))).publicKey;
const db = openDb(`${DATA}/api.db`);
db.exec("DELETE FROM launches; DELETE FROM pushes; DELETE FROM pending;");
// IPFS upstream stand-in: records what was forwarded, answers like pump.fun
let forwarded = null;
const fetched = [];
const fakeFetch = async (url, init) => {
  fetched.push(String(url));
  if (String(url).includes("sol-price")) return new Response(JSON.stringify({ solPrice: 100 }), { status: 200 });
  if (String(url).includes("ipfs-upstream")) { forwarded = init.body; return new Response(JSON.stringify({ metadataUri: "https://ipfs.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", metadata: { name: "x" } }), { status: 200 }); }
  return new Response(JSON.stringify({ name: "x", symbol: "X", image: "https://ipfs.example/ipfs/QmT5NvUtoM5nWFfrQdVrFtvGfKFmG7AHE8P34isapyhCxX", website: "javascript:alert(1)", twitter: "https://x.com/hooker" }), { status: 200 });
};
process.env.IPFS_UPSTREAM = "http://ipfs-upstream/";
const { env } = await import("../lib/env.mjs");
env.ipfsUpstream = "http://ipfs-upstream/";
// one real …hook key for the API's launch
const { initVanity, addKey } = await import("../lib/vanity.mjs");
const { readdirSync, renameSync, mkdirSync } = await import("node:fs");
initVanity(db); db.exec("DELETE FROM vanity WHERE state IN ('fresh', 'issued')"); // a fresh start: earlier runs' reservations count against this IP's hourly limit
const VK = new URL("../keys/test-vanity/", import.meta.url).pathname; mkdirSync(`${VK}used`, { recursive: true });
const kfs = readdirSync(VK).filter((f) => f.endsWith("hook.json")).slice(0, 2); // two launches: the main one and the allowlist one
if (kfs.length < 2) { console.error("need two ground …hook keys in keys/test-vanity (tools/grind)"); process.exit(1); }
for (const kf of kfs) { addKey(db, Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(VK + kf, "utf8"))))); renameSync(VK + kf, `${VK}used/${kf}`); }
// configs.json is read like on the box: both the anti-snipe and the flat-fee sets (since 4 Oct 2026)
const server = createApi({ conn, db, hookProgram: HOOK, fetchImpl: fakeFetch, dataDir: DATA, vanityReserve: 0 });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let checks = 0;
const ok = (c, m) => { if (!c) { console.error("❌ FAIL:", m); server.close(); process.exit(1); } checks++; console.log("✅", m); };
/** What the site does before a launch: fetch a nonce and sign it with the creator's wallet. */
const signed = async (kp, body) => {
  const { nonce, message } = (await call("GET", `/api/launch-nonce/${kp.publicKey.toBase58()}`)).json;
  return { ...body, nonce, signature: bs58.encode(nacl.sign.detached(Buffer.from(message), kp.secretKey)) };
};
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};
/** What the site does: get a transaction, let the wallet sign it, hand it back. */
const signAndSend = async (txB64, wallet) => {
  const raw = Buffer.from(txB64, "base64");
  const v = VersionedTransaction.deserialize(raw);
  let signed;
  if (v.version === "legacy") { const tx = Transaction.from(raw); tx.partialSign(wallet); signed = tx.serialize(); }
  else { v.sign([wallet]); signed = v.serialize(); }
  return call("POST", "/api/send", { tx: Buffer.from(signed).toString("base64") });
};
const fund = async (k) => conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed");
// the lookup table the graduator would have made (launches come back as v0 transactions over it)
{
  const { ensureLut, pumpStaticKeys } = await import("../lib/lut.mjs");
  const { launchStaticKeys } = await import("../lib/launch.mjs");
  const { dbcClient } = await import("../lib/chain.mjs");
  const { OnlinePumpSdk } = createRequire(import.meta.url)("@pump-fun/pump-sdk");
  const platform = Keypair.generate(); await fund(platform);
  const pump = new OnlinePumpSdk(conn);
  const keys = [...await pumpStaticKeys({ global: await pump.fetchGlobal(), feeConfig: await pump.fetchFeeConfig() }), ...await launchStaticKeys({ dbc: dbcClient(conn), hookProgram: HOOK, configs: Object.values(configs) })];
  await ensureLut({ conn, payer: platform, keys, file: `${DATA}/lut.json` });
}

const creator = Keypair.generate(), buyer = Keypair.generate();
await fund(creator); await fund(buyer);

const info = (await call("GET", "/api/info")).json;
ok(info.sizes.length === 4 && info.hookProgram === HOOK.toBase58() && info.appOnly === null && info.sizes.at(-1).pumpfunOwn && info.pumpfun.graduationSol > 0, "info lists the four graduation sizes (the largest being pump.fun's own), the hook, and keeps app-only off");

// metadata upload
// a WHOLE image: since 4 Oct a header-only or corrupt file is refused (see test/image.test.mjs)
const png = readFileSync(new URL("../web/public/favicon-v2-64.png", import.meta.url));
const form = new FormData();
form.append("file", new Blob([png], { type: "image/png" }), "a.png");
form.append("name", "Api Test"); form.append("symbol", "APIT"); form.append("evil", "dropped");
const up = await fetch(`${base}/api/ipfs`, { method: "POST", body: form }).then(async (r) => ({ status: r.status, json: await r.json() }));
ok(up.status === 200 && up.json.uri === "https://ipfs.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" && forwarded.get("name") === "Api Test" && !forwarded.get("evil"), "image upload is forwarded to IPFS with only the known fields");
const svg = new FormData(); svg.append("file", new Blob(["<svg onload=alert(1)>"], { type: "image/svg+xml" }), "a.svg");
await new Promise((r) => setTimeout(r, 5_100)); // one upload per IP per 5 s
ok((await fetch(`${base}/api/ipfs`, { method: "POST", body: svg })).status === 415, "an SVG (a script) is refused as an image");

// launch through the API
{ const unsigned = await call("POST", "/api/tx/launch", { creator: creator.publicKey.toBase58(), gradSol: G0, name: "X", symbol: "X", uri: "https://ipfs.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", devBuySol: 0.1 });
  ok(unsigned.status === 401, "a launch without the wallet's signature gets no key (nobody can drain the pool by naming rich wallets)");
  const forged = await call("POST", "/api/tx/launch", { ...(await signed(buyer, { creator: creator.publicKey.toBase58(), gradSol: G0, name: "X", symbol: "X", uri: "https://ipfs.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", devBuySol: 0.1 })), creator: creator.publicKey.toBase58() });
  ok(forged.status === 401, "a signature from another wallet is refused"); }
const bad = await call("POST", "/api/tx/launch", await signed(creator, { creator: creator.publicKey.toBase58(), gradSol: G0, name: "X", symbol: "X", uri: "https://ipfs.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", rules: { burnBps: 5000 } }));
ok(bad.status === 400 && /Burn/.test(bad.json.error), `invalid rules are refused before anything is signed ("${bad.json.error}")`);
ok((await call("POST", "/api/tx/launch", await signed(creator, { creator: creator.publicKey.toBase58(), gradSol: G0, name: "X", symbol: "X", uri: "https://ipfs.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", rules: { fomoOnly: true } }))).status === 400, "FOMO-only without a dev buy is refused (FOMO lists a token only after it trades)");
ok((await call("POST", "/api/tx/launch", await signed(creator, { creator: creator.publicKey.toBase58(), gradSol: G0, name: "X", symbol: "X", uri: "https://ipfs.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", rules: { appOnly: true } }))).status === 400, "app-only is refused while the Pump app cannot trade hooked curves");
const L = await call("POST", "/api/tx/launch", await signed(creator, { creator: creator.publicKey.toBase58(), gradSol: G0, name: "Api Test", symbol: "APIT", uri: "https://ipfs.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  rules: { maxWalletBps: 1_000, earlySecs: 0, earlyMaxWalletBps: 0, burnBps: 100 }, devBuySol: 0.2 }));
ok(L.status === 200 && L.json.mint?.endsWith("hook"), `the API built a launch transaction, already signed by its new …hook mint (${L.json.mint?.slice(-8)})`);
{ const again = await call("POST", "/api/tx/launch", await signed(creator, { creator: creator.publicKey.toBase58(), gradSol: G0, name: "Api Test", symbol: "APIT", uri: "https://ipfs.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", rules: { maxWalletBps: 1_000, earlySecs: 0, earlyMaxWalletBps: 0, burnBps: 100 }, devBuySol: 0.2 }));
  ok(again.json.mint === L.json.mint, "asking again gives the same creator the same key (retries cannot drain the pool)"); }
{ const poor = Keypair.generate();
  const r = await call("POST", "/api/tx/launch", await signed(poor, { creator: poor.publicKey.toBase58(), gradSol: G0, name: "X", symbol: "X", uri: "https://ipfs.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", devBuySol: 0.1 }));
  ok(r.status === 400 && /needs at least/.test(r.json.error), "an empty wallet cannot take a hook address (each one handed out is burned)"); }
const sent = await signAndSend(L.json.tx, creator);
if (sent.status !== 200) console.log("   send →", sent.status, JSON.stringify(sent.json).slice(0, 400));
ok(sent.status === 200 && sent.json.signature, "the creator's wallet signed it and the API sent it");
ok((await call("POST", "/api/register", { mint: L.json.mint })).json.ok, "the launch is listed");
ok((await call("POST", "/api/register", { mint: Keypair.generate().publicKey.toBase58() })).status === 404, "a mint that is not a Hooker launch cannot be listed");
const t = (await call("GET", `/api/token/${L.json.mint}`)).json;
ok(t.symbol === "APIT" && t.rules.maxWalletBps === 1_000 && t.rules.burnBps === 100 && t.rules.dev === creator.publicKey.toBase58() && t.progress > 0, `the token page has its rules and progress (${(t.progress * 100).toFixed(1)}%, cap ${t.marketCapSol.toFixed(1)} SOL)`);
ok(t.solUsd === 100 && Math.abs(t.marketCapUsd - t.marketCapSol * 100) < 1e-6 && (await call("GET", "/api/info")).json.solUsd === 100, `market caps come in dollars too ($${t.marketCapUsd.toFixed(0)} at $100/SOL)`);
ok(t.meta?.website === null && t.meta?.twitter === "https://x.com/hooker", "a javascript: link in the metadata is dropped (XSS), an https link is kept");
const PRICE_FEEDS = /sol-price|jup\.ag|coingecko\.com/; // fixed URLs in our code, never creator-supplied
ok(fetched.filter((u) => !u.includes("ipfs-upstream") && !PRICE_FEEDS.test(u)).every((u) => /^https:\/\/(pump\.mypinata\.cloud|gateway\.pinata\.cloud|ipfs\.filebase\.io|ipfs\.io)\/ipfs\//.test(u)), "the server only fetches IPFS content through public gateways (no SSRF into the box)");
ok(t.meta?.image === "/api/img/QmT5NvUtoM5nWFfrQdVrFtvGfKFmG7AHE8P34isapyhCxX", "the token page reads the image from the metadata and serves it from hooker.fun itself");

// trading through the API
const b = await call("POST", "/api/tx/swap", { mint: L.json.mint, owner: buyer.publicKey.toBase58(), side: "buy", amount: String(LAMPORTS_PER_SOL) });
if (!b.json.tx) console.error("swap refused:", b.status, b.json);
ok((await signAndSend(b.json.tx, buyer)).status === 200, "a buy built by the API and signed by the buyer lands");
const tooBig = await call("POST", "/api/tx/swap", { mint: L.json.mint, owner: buyer.publicKey.toBase58(), side: "buy", amount: String(20 * LAMPORTS_PER_SOL) });
const refused = await signAndSend(tooBig.json.tx, buyer);
ok(refused.status === 400 && /max per wallet/.test(refused.json.error), `a hook refusal comes back in plain words ("${refused.json.error}")`);
const ataBal = async () => BigInt((await conn.getTokenAccountsByOwner(buyer.publicKey, { mint: new PublicKey(L.json.mint) })).value.length ? (await conn.getParsedTokenAccountsByOwner(buyer.publicKey, { mint: new PublicKey(L.json.mint) })).value[0].account.data.parsed.info.tokenAmount.amount : 0);
const s = await call("POST", "/api/tx/swap", { mint: L.json.mint, owner: buyer.publicKey.toBase58(), side: "sell", amount: String((await ataBal()) / 2n) });
ok((await signAndSend(s.json.tx, buyer)).status === 200, "a sell lands");
{ // not an open relay
  const { SystemProgram } = await import("@solana/web3.js");
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: creator.publicKey, lamports: 1 }));
  tx.feePayer = buyer.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(buyer);
  const r = await call("POST", "/api/send", { tx: tx.serialize().toString("base64") });
  ok(r.status === 400 && /not a Hooker transaction/.test(r.json.error), "/api/send refuses a transaction that is not a Hooker trade (no open relay)");
}
ok((await call("POST", "/api/tx/launch", await signed(creator, { creator: creator.publicKey.toBase58(), gradSol: G0, name: "X", symbol: "X", uri: "http://127.0.0.1:5300/api/stats" }))).status === 400, "a launch whose metadata is not on IPFS is refused");
const unsigned = await call("POST", "/api/tx/swap", { mint: L.json.mint, owner: buyer.publicKey.toBase58(), side: "buy", amount: "1000" });
ok((await call("POST", "/api/send", { tx: unsigned.json.tx })).status === 400, "an unsigned transaction is refused");

ok((await call("POST", "/api/tx/launch", await signed(creator, { creator: creator.publicKey.toBase58(), gradSol: G0, name: "X", symbol: "X", uri: "https://ipfs.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/" + "x".repeat(70), devBuySol: 0.1 }))).status === 400, "a metadata link longer than our uploads make (120 chars) is refused: the launch would not fit one transaction");

// creator fees
const c = await call("POST", "/api/tx/claim", { mint: L.json.mint, creator: creator.publicKey.toBase58() });
const before = await conn.getBalance(creator.publicKey);
ok((await signAndSend(c.json.tx, creator)).status === 200 && (await conn.getBalance(creator.publicKey)) > before, "the creator claimed their share of the trading fees");
ok((await call("POST", "/api/tx/claim", { mint: L.json.mint, creator: buyer.publicKey.toBase58() })).status === 403, "nobody else can claim them");

// allowlists, the way the site fills one right after a launch
{
  const s3 = createApi({ conn, db, hookProgram: HOOK, fetchImpl: fakeFetch, dataDir: DATA, vanityReserve: 0, launchesPerIpPerHour: 100 });
  await new Promise((r) => s3.listen(0, "127.0.0.1", r));
  const b3 = `http://127.0.0.1:${s3.address().port}`;
  const c3 = async (method, path, body) => { const r = await fetch(b3 + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  const send3 = async (b64, kp) => {
    const raw = Buffer.from(b64, "base64"); const v = VersionedTransaction.deserialize(raw); let signed;
    if (v.version === "legacy") { const tx = Transaction.from(raw); tx.partialSign(kp); signed = tx.serialize(); } else { v.sign([kp]); signed = v.serialize(); }
    return c3("POST", "/api/send", { tx: Buffer.from(signed).toString("base64") });
  };
  // its own creator: a creator who asks again within minutes is handed the same reserved …hook key
  const creator = Keypair.generate(); await fund(creator);
  const nonce = await c3("GET", `/api/launch-nonce/${creator.publicKey.toBase58()}`);
  const body = { creator: creator.publicKey.toBase58(), gradSol: G0, name: "Listed", symbol: "LIST", uri: "https://ipfs.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    rules: { allowlist: true, maxWalletBps: 0, earlySecs: 0, earlyMaxWalletBps: 0 }, devBuySol: 0.1,
    nonce: nonce.json.nonce, signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(nonce.json.message), creator.secretKey)) };
  const La = await c3("POST", "/api/tx/launch", body);
  const Ls = La.status === 200 ? await send3(La.json.tx, creator) : null;
  if (La.status !== 200 || Ls?.status !== 200) {
    console.log("   launch:", La.status, La.status !== 200 ? JSON.stringify(La.json) : "");
    if (La.status === 200) { const tx = Transaction.from(Buffer.from(La.json.tx, "base64")); tx.partialSign(creator); const sim = await conn.simulateTransaction(tx); console.log("   sim:", JSON.stringify(sim.value.err), (sim.value.logs ?? []).slice(-6).join(" | ")); }
  }
  ok(La.status === 200 && Ls.status === 200, "a launch with an allowlist goes through the API");
  await c3("POST", "/api/register", { mint: La.json.mint });
  const outsider = Keypair.generate(); await fund(outsider);
  const wallets = [buyer.publicKey.toBase58(), ...Array.from({ length: 40 }, () => Keypair.generate().publicKey.toBase58())];
  ok((await c3("POST", "/api/tx/list", { mint: La.json.mint, creator: buyer.publicKey.toBase58(), wallets })).status === 403, "only the creator can get list transactions");
  const lt = await c3("POST", "/api/tx/list", { mint: La.json.mint, creator: creator.publicKey.toBase58(), wallets, seal: true });
  ok(lt.status === 200 && lt.json.txs.length === 2 && lt.json.added === 41, "41 wallets come back as two transactions (24 per transaction), sealed in the last");
  for (const t of lt.json.txs) {
    const r = await send3(t, creator);
    if (r.status !== 200) { const tx = Transaction.from(Buffer.from(t, "base64")); tx.partialSign(creator); const sim = await conn.simulateTransaction(tx); console.log("   list tx:", JSON.stringify(r.json), JSON.stringify(sim.value.err), (sim.value.logs ?? []).slice(-8).join(" | ")); }
    ok(r.status === 200, "a list transaction signed by the creator lands");
  }
  const tok = (await c3("GET", `/api/token/${La.json.mint}`)).json;
  ok(tok.list?.kind === "allow" && tok.list.count === 41 && tok.list.sealed, "the token reports its allowlist: 41 wallets, sealed");
  ok((await c3("GET", `/api/token/${La.json.mint}/listed/${buyer.publicKey.toBase58()}`)).json.listed === true
    && (await c3("GET", `/api/token/${La.json.mint}/listed/${outsider.publicKey.toBase58()}`)).json.listed === false, "a buyer can see whether they are on it");
  const ob = await c3("POST", "/api/tx/swap", { mint: La.json.mint, owner: outsider.publicKey.toBase58(), side: "buy", amount: "50000000" });
  const refusedOut = await send3(ob.json.tx, outsider);
  ok(refusedOut.status === 400 && /allowlist/.test(refusedOut.json.error), `an unlisted wallet's buy is refused with a plain reason ("${refusedOut.json.error}")`);
  const ib = await c3("POST", "/api/tx/swap", { mint: La.json.mint, owner: buyer.publicKey.toBase58(), side: "buy", amount: "50000000" });
  ok((await send3(ib.json.tx, buyer)).status === 200, "a listed wallet's buy lands");
  ok((await c3("POST", "/api/tx/list", { mint: La.json.mint, creator: creator.publicKey.toBase58(), wallets: [outsider.publicKey.toBase58()] })).status === 400, "a sealed list cannot be added to");
  s3.close();
}

// lists
const list = (await call("GET", "/api/launches")).json.launches;
ok(list.some((x) => x.mint === L.json.mint && x.meta?.symbol === "APIT"), "the launch shows on the launches list");
ok((await call("GET", `/api/wallet/${creator.publicKey.toBase58()}`)).json.created.includes(L.json.mint), "the creator's wallet page lists it");
ok((await call("POST", "/api/tx/swap", { mint: L.json.mint, owner: buyer.publicKey.toBase58(), side: "buy", amount: "1e9" })).status === 400
  && (await call("POST", "/api/tx/launch", await signed(creator, { creator: creator.publicKey.toBase58(), gradSol: G0, name: "X", symbol: "X", uri: "https://ipfs.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", devBuySol: "lots" }))).status === 400
  && (await call("POST", "/api/send", { tx: "AAAA" })).status === 400, "malformed amounts and transactions get a clean 400, not a crash");
ok((await call("GET", "/api/token/not-a-key")).status === 400 && (await call("GET", "/api/nope")).status === 404, "bad input and unknown routes answer cleanly");
ok((await call("GET", "/api/token/%E0")).status === 400 && (await call("GET", "/api/health")).status === 200, "a malformed path is a 400, not a crash (the server still answers)");

// many visitors at once → one RPC read (the cache shares the flight)
let calls = 0;
const orig = conn._rpcRequest.bind(conn);
conn._rpcRequest = (m, a) => { if (m === "getMultipleAccounts") calls++; return orig(m, a); };
await new Promise((r) => setTimeout(r, 5_100));
await Promise.all(Array.from({ length: 30 }, () => call("GET", "/api/launches")));
conn._rpcRequest = orig;
ok(calls === 1, `30 simultaneous visitors cost ${calls} curve read (shared, not one each)`);

// the graduated token from the end-to-end run: priced on PumpSwap, linked to pump.fun
{
  const e2eDb = openDb(`${DATA}/hooker.db`);
  const done = e2eDb.prepare("SELECT mint, pump_mint FROM launches WHERE status = 'done' LIMIT 1").get();
  // that run may predate featured.json's hideLaunchesBefore: this server shows everything
  const s2 = createApi({ conn, db: e2eDb, dataDir: DATA, hookProgram: HOOK, fetchImpl: fakeFetch, hideBefore: 0 });
  await new Promise((r) => s2.listen(0, "127.0.0.1", r));
  const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/token/${done.mint}`).then((x) => x.json());
  // and one that hides everything before now: the launch is gone from the site, the ledger untouched
  const s3 = createApi({ conn, db: e2eDb, dataDir: DATA, hookProgram: HOOK, fetchImpl: fakeFetch, hideBefore: Math.floor(Date.now() / 1000) + 60 });
  await new Promise((r3) => s3.listen(0, "127.0.0.1", r3));
  const base3 = `http://127.0.0.1:${s3.address().port}`;
  const hidPage = await fetch(`${base3}/api/token/${done.mint}`).then((x) => x.status);
  const hidList = (await fetch(`${base3}/api/launches`).then((x) => x.json())).launches.some((l) => l.mint === done.mint);
  ok(hidPage === 404 && !hidList && !!e2eDb.prepare("SELECT 1 FROM launches WHERE mint = ?").get(done.mint), "a launch before hideLaunchesBefore is off the site (404, not listed) but still in the ledger");
  s3.close();
  ok(r.venue === "PumpSwap" && r.marketCapSol > 0 && r.graduated?.pumpUrl === `https://pump.fun/coin/${done.pump_mint}` && r.gradSol > 0, `a graduated token's page says where it trades (${r.venue}), its live cap (${r.marketCapSol?.toFixed(1)} SOL) and links to pump.fun`);
  const list = await fetch(`http://127.0.0.1:${s2.address().port}/api/launches`).then((x) => x.json());
  ok(list.launches.find((l) => l.mint === done.mint)?.venue === "PumpSwap", "the launches list carries the venue too");
  s2.close();
}
server.close();
console.log(`\nALL ${checks} API CHECKS PASSED`);
