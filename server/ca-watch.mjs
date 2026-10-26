// Watches for the platform coin's launch and puts it on hooker.fun the moment it exists: its CA in the home page's CA line,
// pinned first in every list, with its own logo. One job, then it exits (the service does not restart a clean exit).
//   CA_WATCH_MINT=<mint> node server/ca-watch.mjs
// ⭐ The mint key is ours (ground, never used), so nobody else can create this account: "the account exists" is the
// launch. That is a plain getAccountInfo every CA_WATCH_SECS (default 4) on Solana's public RPC: no indexed reads, no
// paid credits. Once it exists the pump.fun curve, metadata and launch time are read once, data/featured.json is written
// (the API re-reads it within 5 s) and the live API is asked until it serves the coin first.
import { Connection, PublicKey } from "@solana/web3.js";
import { getTokenMetadata, getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { env } from "../lib/env.mjs";
import { featuredPath, loadFeatured } from "../lib/featured.mjs";
import { deliver } from "../lib/alert.mjs";
const { OnlinePumpSdk, bondingCurvePda, holderRewardsPda } = createRequire(import.meta.url)("@pump-fun/pump-sdk");

const log = (...a) => console.log(new Date().toISOString(), ...a);
if (!process.env.CA_WATCH_MINT) { log("CA_WATCH_MINT is not set"); process.exit(1); }
const MINT = new PublicKey(process.env.CA_WATCH_MINT);
const CREATOR = process.env.CA_WATCH_CREATOR || "hookXkHBi86pLTAPxShbvXiQsAPuyDmnanfXDs38p8n";
const EVERY_MS = Math.max(3, Math.min(5, Number(process.env.CA_WATCH_SECS || 4))) * 1000;
const pub = new Connection(process.env.CA_WATCH_RPC || "https://api.mainnet-beta.solana.com", "confirmed");
// the one-off reads after the launch fall back to our own RPC if the public one refuses
const own = new Connection(env.rpcUrl, "confirmed");
const both = async (f) => { try { return await f(pub); } catch (e) { log(`public RPC: ${e.message}; trying ours`); return f(own); } };
const API = `http://127.0.0.1:${env.apiPort}`;
const GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.filebase.io/ipfs/", "https://pump.mypinata.cloud/ipfs/"];
const cidOf = (u) => (typeof u === "string" ? (/^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(u.trim()) ?? /\/ipfs\/([^?#]+)/i.exec(u))?.[1] ?? null : null);
const CID_RE = /^[A-Za-z0-9]{46,100}$/;

if (loadFeatured(featuredPath(env.dataDir)).some((f) => f.mint === MINT.toBase58())) { log(`${MINT.toBase58()} is already on the site: nothing to do`); process.exit(0); }
log(`watching ${MINT.toBase58()} every ${EVERY_MS / 1000} s (expected creator ${CREATOR})`);

// ── 1. wait for the account ──────────────────────────────────────────────────────────────────
let info = null, fails = 0;
for (;;) {
  try { info = await pub.getAccountInfo(MINT, { commitment: "confirmed", dataSlice: { offset: 0, length: 0 } }); fails = 0; }
  catch (e) { if (++fails % 15 === 1) log(`read failed (${fails} in a row): ${e.message}`); }
  if (info) break;
  await new Promise((r) => setTimeout(r, EVERY_MS));
}
log(`LAUNCHED: ${MINT.toBase58()} exists (owner ${info.owner.toBase58()})`);

// ── 2. what it is: pump.fun curve, name, ticker, logo, pair, launch time ────────────────────────
const sdk = (c) => new OnlinePumpSdk(c);
let curve = null;
for (let i = 0; i < 30 && !curve; i++) {
  curve = await both((c) => sdk(c).fetchBondingCurve(MINT)).catch(() => null);
  if (!curve) await new Promise((r) => setTimeout(r, 2_000));
}
if (!curve) log("⚠ no pump.fun curve readable after 60 s: featuring it anyway (priced once the curve is readable)");
const creator = curve?.creator?.toBase58() ?? null;
if (creator && creator !== CREATOR && creator !== holderRewardsPda(MINT).toBase58()) log(`⚠ the curve's creator is ${creator}, not ${CREATOR}`);
const prog = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
const meta = prog.equals(TOKEN_2022_PROGRAM_ID) ? await both((c) => getTokenMetadata(c, MINT, "confirmed", TOKEN_2022_PROGRAM_ID)).catch(() => null) : null;
let json = null;
const metaCid = cidOf(meta?.uri);
if (metaCid) for (const g of GATEWAYS) {
  try { json = await (await fetch(g + metaCid, { signal: AbortSignal.timeout(8_000) })).json(); break; } catch {}
}
const imgCid = cidOf(json?.image);
const image = imgCid && CID_RE.test(imgCid) ? `/api/img/${imgCid}` : "/hooker-token.png";
let quote = null;
const qm = curve?.quoteMint;
if (qm && !qm.equals(PublicKey.default) && !qm.equals(NATIVE_MINT)) {
  const qInfo = await both((c) => c.getAccountInfo(qm));
  quote = { mint: qm.toBase58(), decimals: (await both((c) => getMint(c, qm, "confirmed", qInfo.owner))).decimals };
}
const sigs = await both((c) => c.getSignaturesForAddress(bondingCurvePda(MINT), { limit: 1000 })).catch(() => []);
const createdAt = sigs.at(-1)?.blockTime ?? Math.floor(Date.now() / 1000);
const entry = { mint: MINT.toBase58(), creator: creator ?? CREATOR, name: meta?.name || json?.name || "Hooker", symbol: meta?.symbol || json?.symbol || "HOOKER", image, createdAt,
  ...(json?.description ? { description: String(json.description).slice(0, 1000) } : {}),
  ...(/^https:\/\//.test(json?.twitter ?? "") ? { twitter: json.twitter } : {}), ...(/^https:\/\//.test(json?.telegram ?? "") ? { telegram: json.telegram } : {}),
  ...(/^https:\/\//.test(json?.website ?? "") ? { website: json.website } : {}), ...(quote ? { quote } : {}) };
log(`featuring $${entry.symbol} "${entry.name}", logo ${image}, launched ${new Date(createdAt * 1000).toISOString()}${quote ? `, paired with ${quote.mint}` : ""}`);

// ── 3. on the site: data/featured.json (a deploy never touches data/), then wait for the API to serve it ─
const src = featuredPath(env.dataDir), out = `${env.dataDir.replace(/\/$/, "")}/featured.json`;
const doc = existsSync(src) ? JSON.parse(readFileSync(src, "utf8")) : {};
doc.coins = [entry];
writeFileSync(`${out}.tmp`, JSON.stringify(doc, null, 2) + "\n", { mode: 0o644 });
loadFeatured(`${out}.tmp`); // the API's own check: a bad entry stops here, before the live file is replaced
renameSync(`${out}.tmp`, out);
let live = false;
for (let i = 0; i < 30 && !live; i++) {
  await new Promise((r) => setTimeout(r, 1_000));
  live = await fetch(`${API}/api/launches`).then((r) => r.json()).then((j) => j.launches?.[0]?.mint === entry.mint).catch(() => false);
}
const line = live ? `✅ $${entry.symbol} is LIVE on hooker.fun: CA ${entry.mint}` : `⚠ $${entry.symbol} written to ${out} but the API did not serve it within 30 s: journalctl -u hooker-api`;
log(line);
await deliver(line, { log }).catch(() => {});
writeFileSync(`${env.dataDir.replace(/\/$/, "")}/ca-watch.json`, JSON.stringify({ mint: entry.mint, featuredAt: Math.floor(Date.now() / 1000), live }) + "\n");
process.exit(live ? 0 : 1);
