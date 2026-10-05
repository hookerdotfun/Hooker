// Hooker's API. Builds every transaction server-side so the browser needs no RPC (and never sees the
// RPC key): the wallet only signs, and /api/send forwards the signed bytes.
//
//   GET  /api/health
//   GET  /api/info                       graduation sizes, economics, defaults, program ids
//   GET  /api/launches                   newest first, with live progress
//   GET  /api/token/:mint                one launch: rules, progress, graduation, pump.fun coin
//   GET  /api/token/:mint/balance/:owner a wallet's window-token and SOL balance
//   GET  /api/wallet/:owner              a wallet's launches and payouts
//   POST /api/ipfs                       image + fields → pump.fun-compatible metadata on IPFS
//   POST /api/tx/launch                  → base64 transaction, already signed by the new mint
//   POST /api/tx/swap                    → base64 transaction to sign
//   POST /api/tx/claim                   creator's share of trading fees
//   POST /api/send                       signed transaction → signature (confirmed)
//   POST /api/register                   list a launch right away (the graduator also finds it)
//
// ⛔ Reads are cached with in-flight sharing and stale-on-error: a launch's traffic must never
// turn into one RPC call per visitor (pump.family's launch-day stampede, see memory).
import http from "node:http";
import { PublicKey, Transaction, Keypair, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } from "@solana/web3.js";
import { loadLut } from "../lib/lut.mjs";
import { launchSize } from "../lib/launch.mjs";
import { getTokenMetadata, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { getPriceFromSqrtPrice, getCurrentPoint, SwapMode, deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import bs58 from "bs58";
import { env, connect } from "../lib/env.mjs";
import { dbcClient, getPool, getConfig, DBC_PROGRAM, DBC_POOL_AUTHORITY, withPriority, priorityFee } from "../lib/chain.mjs";
import { buildLaunchTx, buildSwapTx, buildListTxs } from "../lib/launch.mjs";
import { isRelayable } from "../lib/relay.mjs";
import { DEFAULT_RULES, decodeRules, decodeList, validateRules, hookPdas, hookErrorFromLogs, HOOK_ERRORS, LIST_MAX, LIST_OPEN_SECS, PUMPFUN_LIMITS } from "../lib/rules.mjs";
import { ECONOMICS, pumpParams, FEE_TIERS, tierSplit } from "../lib/curve.mjs";
import { loadConfigState, feeIsFlat, startFeePct, configFor } from "../lib/configs.mjs";
import { pumpMarketCap } from "../lib/pumpprice.mjs";
import { createLander } from "../lib/lander.mjs";
import { listPairs, pairMemo, MAX_CREATOR_FEE_BPS } from "../lib/pairs.mjs";
import { loadFeatured, featuredSummary, loadHideBefore } from "../lib/featured.mjs";
import { createRequire } from "node:module";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { wholeImage, imageType } from "../lib/image.mjs";
const require = createRequire(import.meta.url);
const { OnlinePumpSdk } = require("@pump-fun/pump-sdk");
const nacl = require("tweetnacl");
import { LAUNCHED_STATUSES } from "../lib/graduate.mjs";
import { openDb, listLaunches, getLaunch, registerLaunch, recordIntent } from "../lib/db.mjs";
import { createEvm } from "../lib/evm.mjs";
import { initVanity, issueForLaunch, issuedToIpSince, importIncoming, incomingDir, freshCount, RESERVATION_SECS, markLaunched } from "../lib/vanity.mjs";

const URI_MAX = 120;

export function createApi({ conn = connect(), dataDir = env.dataDir, db = openDb(`${dataDir}/hooker.db`), configs = null, hookProgram = env.hookProgram, fetchImpl = fetch, launchesPerIpPerHour = 5, vanityReserve, featured: featuredFixed = null, hideBefore: hideBeforeFixed = null, evm: evmOpt } = {}) {
  const dbc = dbcClient(conn);
  const pumpSdk = new OnlinePumpSdk(conn);
  // the configs new launches use, re-read every minute: the graduator replaces them when pump.fun
  // changes its curve. `all` also knows retired sets, so every token page can name its size.
  let state = { configs: configs ?? {}, flatConfigs: {}, tierConfigs: {}, pump: null, all: {} };
  const reload = () => { try { const s = loadConfigState(dataDir); if (s) state = s; } catch (e) { console.error("configs.json unreadable:", e.message); } };
  if (!configs) reload();
  setInterval(reload, 60_000).unref();
  const activeConfigs = () => state.configs;
  /** The custom pairs a creator may pick (lib/pairs.mjs): pump.fun's list, liquid, clean. Shared 10 min. */
  const pairsNow = () => cached("pairs", 600_000, () => listPairs(conn, { fetchImpl }));
  // a pair no longer on the list (thinner now, or delisted) still has a name and a price for its graduated coins
  const pairInfo = async (mint) => {
    if (!mint) return null;
    const listed = (await pairsNow().catch(() => [])).find((p) => p.mint === mint);
    if (listed) return listed;
    return cached(`pair1:${mint}`, 600_000, async () => {
      const t = (await (await fetchImpl(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`, { signal: AbortSignal.timeout(8_000) })).json()).find?.((x) => x.id === mint);
      return t ? { mint, symbol: String(t.symbol ?? "").slice(0, 16), name: String(t.name ?? "").slice(0, 48), icon: /^https:\/\//.test(t.icon ?? "") ? t.icon : null, decimals: Number(t.decimals), usdPrice: Number(t.usdPrice) || null } : { mint };
    }).catch(() => ({ mint }));
  };
  // every signed transaction we relay is rebroadcast until it lands or its blockhash expires (lib/lander.mjs)
  const lander = createLander(conn, { log: (m) => console.error(new Date().toISOString(), m) });
  // the pool of …hook mint keys: imported from the grinder / pushes every minute
  initVanity(db);
  const incoming = incomingDir(dataDir);
  importIncoming(db, incoming);
  setInterval(() => importIncoming(db, incoming), 60_000).unref();
  const sizeOf = (addr) => state.all[addr]?.sizeSol ?? Object.entries(activeConfigs()).find(([, c]) => c.toBase58() === addr)?.[0];
  /** SOL in dollars: pump.fun's own feed first (so our caps match theirs), then Jupiter, then CoinGecko.
   *  Cached a minute; on error the last price is kept (`cached` does that), so caps never blink to "–". */
  const PRICE_FEEDS = [
    ["https://frontend-api-v3.pump.fun/sol-price", (j) => j.solPrice],
    ["https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112", (j) => j.So11111111111111111111111111111111111111112?.usdPrice],
    ["https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", (j) => j.solana?.usd],
  ];
  const solUsd = () => cached("sol:usd", 60_000, async () => {
    for (const [url, pick] of PRICE_FEEDS) {
      try { const r = await fetchImpl(url, { signal: AbortSignal.timeout(4000) }); const v = Number(pick(await r.json())); if (v > 1 && v < 100_000) return v; } catch {}
    }
    throw new Error("no SOL price feed answered");
  });
  const ETH_FEEDS = [
    ["https://api.coinbase.com/v2/prices/ETH-USD/spot", (j) => j.data?.amount],
    ["https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", (j) => j.ethereum?.usd],
  ];
  const ethUsd = () => cached("eth:usd", 60_000, async () => {
    for (const [url, pick] of ETH_FEEDS) {
      try { const r = await fetchImpl(url, { signal: AbortSignal.timeout(4000) }); const v = Number(pick(await r.json())); if (v > 10 && v < 1_000_000) return v; } catch {}
    }
    throw new Error("no ETH price feed answered");
  });
  /** pump.fun's curve today, from its Global account (what new configs are made from) */
  const pumpLive = () => cached("pump:global", 600_000, async () => pumpParams(await pumpSdk.fetchGlobal()));

  // ── cache: one flight per key, stale value on error ─────────────────────────────────────────
  const cache = new Map();
  const CACHE_MAX = 5000;
  async function cached(key, ttlMs, fn) {
    if (cache.size > CACHE_MAX) { for (const k of [...cache.keys()].slice(0, CACHE_MAX / 2)) cache.delete(k); } // oldest half
    const hit = cache.get(key);
    const fresh = hit && Date.now() - hit.at < ttlMs;
    if (fresh) return hit.value;
    if (hit?.flight) return hit.flight;
    const flight = (async () => {
      try {
        const value = await fn();
        cache.set(key, { value, at: Date.now() });
        return value;
      } catch (e) {
        if (hit && "value" in hit) { cache.set(key, { ...hit, flight: null }); return hit.value; }
        cache.delete(key);
        throw e;
      }
    })();
    cache.set(key, { ...(hit ?? {}), flight });
    return flight;
  }

  const configState = (addr) => cached(`config:${addr}`, 3_600_000, () => getConfig(dbc, new PublicKey(addr)));
  const rulesOf = (mint) => cached(`rules:${mint}`, 3_600_000, async () => {
    const a = await conn.getAccountInfo(hookPdas(hookProgram, mint).cfg, "confirmed");
    if (!a || !a.owner.equals(hookProgram)) return null;
    const r = decodeRules(a.data);
    return { ...r, dev: r.dev.toBase58(), cosigner: r.cosigner.toBase58(), app: r.app.toBase58() };
  });
  // ⛔ ipfs.io (what pump.fun's upload returns) 403s / 429s real pump CIDs; pinata and filebase serve
  // them (memory: ipfs-gateways-that-serve-pons-logos). The on-chain URI stays as uploaded; reads
  // and images go through the gateways that answer.
  const GATEWAYS = ["https://pump.mypinata.cloud/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://ipfs.filebase.io/ipfs/", "https://ipfs.io/ipfs/"];
  const cidOf = (u) => (typeof u === "string" ? (/^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(u.trim()) ?? /\/ipfs\/([^?#]+)/i.exec(u))?.[1] ?? null : null);
  const viaGateway = (u) => { const c = cidOf(u); return c ? GATEWAYS[0] + c : u; };
  // ⛔ SSRF: a token's metadata URI is chosen by its creator. The server only ever fetches IPFS
  // content, and only through the public gateways above: never the URI's own host, which could be one
  // of the private services listening on this box.
  const CID_RE = /^[A-Za-z0-9]{46,100}(\/[A-Za-z0-9._-]{1,100})?$/;
  async function fetchJson(uri) {
    const c = cidOf(uri);
    if (!c || !CID_RE.test(c)) return null;
    for (const url of GATEWAYS.map((g) => g + c)) {
      try {
        const r = await fetchImpl(url, { signal: AbortSignal.timeout(4000), redirect: "error" });
        if (r.ok && Number(r.headers.get("content-length") ?? 0) <= 64 * 1024) { const j = await r.json(); if (j && typeof j === "object") return j; }
      } catch {}
    }
    return null;
  }
  const metaOf = (mint) => cached(`meta:${mint}`, 3_600_000, async () => {
    const m = await getTokenMetadata(conn, new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID);
    const json = await fetchJson(m.uri);
    if (!json) setTimeout(() => cache.delete(`meta:${mint}`), 60_000).unref?.(); // gateways down: retry in a minute, not an hour
    return { name: m.name, symbol: m.symbol, uri: m.uri, image: safeImage(json?.image), description: typeof json?.description === "string" ? json.description.slice(0, 1000) : null,
             twitter: safeLink(json?.twitter), telegram: safeLink(json?.telegram), website: safeLink(json?.website), complete: !!json };
  });
  /** Only http(s) links reach the page: a `javascript:` link would run on hooker.fun (XSS). */
  const safeLink = (u) => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.href.slice(0, 300) : null; } catch { return null; } };
  // ⛔ 4 Oct 2026: logos pointed visitors straight at an IPFS gateway, and a logo that did not load
  // showed a broken image. Now the page asks OUR server (/api/img/<cid>): it fetches from the first
  // gateway that answers, checks the bytes really are a whole image, and keeps them on disk. A visitor
  // never depends on a gateway (they rate-limit visitors), and never a creator's own host (it would see every visitor).
  const knownCids = new Set();
  const knowCid = (c) => { knownCids.add(c); if (knownCids.size > 50_000) knownCids.clear(); };
  const safeImage = (u) => { const c = cidOf(u); if (!c || !CID_RE.test(c)) return null; knowCid(c); return `/api/img/${c}`; };
  /** Metadata without ever holding a page up: whatever is cached, or nothing, after `ms`. */
  const metaQuick = (mint, ms = 1200) => Promise.race([metaOf(mint).catch(() => null), new Promise((r) => setTimeout(() => r(null), ms))]);

  /** Live curve state for many pools in one RPC call, shared by every visitor for 5 s. */
  const progressOf = (pools) => cached(`progress:${pools.join(",")}`, 5_000, async () => {
    const out = {};
    for (let i = 0; i < pools.length; i += 100) {
      const chunk = pools.slice(i, i + 100);
      const infos = await conn.getMultipleAccountsInfo(chunk.map((p) => new PublicKey(p)), "confirmed");
      infos.forEach((info, j) => {
        if (!info) return;
        let s;
        try { s = dbc.state.program.coder.accounts.decode("transferHookPool", info.data).poolState; } catch { return; }
        out[chunk[j]] = s;
      });
    }
    return out;
  });

  /**
   * A coin is priced by a different account in each phase, and only one is right at a time:
   * our curve while trading, pump.fun's curve after graduation, PumpSwap once that curve fills.
   * Mid-graduation (the hook is gone, the pump.fun coin not yet bought) nothing prices it: null.
   */
  async function summarize(l, pool) {
    const cfg = await configState(l.config);
    const threshold = BigInt(cfg.migrationQuoteThreshold.toString());
    const quote = pool ? BigInt(pool.quoteReserve.toString()) : 0n;
    let marketCapSol = null, venue = "graduating";
    if (l.status === "trading") {
      marketCapSol = pool ? Number(getPriceFromSqrtPrice(pool.sqrtPrice, 6, 9)) * 1e9 : null;
      venue = "hooker";
    } else if (l.pump_mint && LAUNCHED_STATUSES.has(l.status)) {
      // a coin paired with a custom pair is priced in the pair token: converted to SOL through both USD prices
      let quote = null;
      if (l.pair_state === "swapped") {
        const p = await pairInfo(l.pair_mint), u = await solUsd().catch(() => null);
        quote = { mint: l.pair_mint, decimals: p?.decimals, solPerUnit: p?.usdPrice && u ? p.usdPrice / u : null };
      }
      const pc = await cached(`pumpcap:${l.pump_mint}`, 60_000, () => pumpMarketCap(conn, l.pump_mint, quote ? { quote } : undefined));
      marketCapSol = pc?.marketCapSol ?? null;
      venue = pc?.venue ?? "pump.fun";
    }
    const usd = await solUsd().catch(() => null);
    return {
      mint: l.mint, pool: l.pool, creator: l.creator, name: l.name, symbol: l.symbol, gradSol: l.grad_sol ?? sizeOf(l.config),
      createdAt: l.created_at, status: l.status, venue,
      // read from the token's own config: whether its curve carries the anti-snipe fee
      antiSnipe: !feeIsFlat(cfg), antiSnipeStartPct: feeIsFlat(cfg) ? null : startFeePct(cfg),
      // the creator's fee step, from the config (configs made before 4 Oct 2026 are step 0)
      feeTier: state.all[l.config]?.tier ?? 0, fees: tierSplit(state.all[l.config]?.tier ?? 0),
      // the custom pair the pump.fun coin is (or will be) paired with; state "fallback" = graduated against SOL instead
      pair: l.pair_mint ? { ...(await pairInfo(l.pair_mint)), creatorFeeBps: l.pair_cfee ?? 0, state: l.pair_state, note: l.pair_note ?? null } : null,
      progress: Math.min(1, Number(quote) / Number(threshold)), raisedSol: Number(quote) / 1e9, targetSol: Number(threshold) / 1e9,
      marketCapSol, marketCapUsd: marketCapSol != null && usd ? marketCapSol * usd : null, solUsd: usd,
      // ⛔ the pump.fun mint is shown only once its launch has landed: before that, anyone who saw the
      // address could pre-create accounts at it and make pump.fun's create fail forever
      graduated: l.status !== "trading" ? { status: l.status, pumpMint: LAUNCHED_STATUSES.has(l.status) ? l.pump_mint : null, pumpUrl: LAUNCHED_STATUSES.has(l.status) && l.pump_mint ? `https://pump.fun/coin/${l.pump_mint}` : null, settled: l.settle_json ? JSON.parse(l.settle_json) : null } : null,
    };
  }

  /** A coin launched straight on pump.fun (featured.json), priced the way a graduated launch is. */
  // ⭐ featured.json is re-read every 5 s when it changed (scripts/set-ca.mjs writes it): a new CA is live in seconds,
  // no restart, no rebuild. A test passes `featured` / `hideBefore` and keeps them fixed.
  let featured = featuredFixed ?? loadFeatured(), hideBefore = hideBeforeFixed ?? loadHideBefore();
  let featuredByMint = new Map(featured.map((f) => [f.mint, f]));
  if (!featuredFixed) {
    const file = new URL("../featured.json", import.meta.url);
    let seen = 0;
    setInterval(() => {
      try {
        const m = statSync(file).mtimeMs;
        if (m === seen) return;
        const next = loadFeatured(); // a malformed file throws here and the last good list stays
        featured = next; featuredByMint = new Map(featured.map((f) => [f.mint, f]));
        if (hideBeforeFixed == null) hideBefore = loadHideBefore();
        seen = m;
      } catch (e) { console.error(new Date().toISOString(), "featured.json not reloaded:", e.message); }
    }, 5_000).unref();
  }
  /** ⛔ display only (see lib/featured.mjs): the graduator reads the ledger itself, never this */
  const shown = (l) => l && l.created_at >= hideBefore;
  const summarizeFeatured = async (f) => {
    const p = await pumpLive().catch(() => null);
    // a featured coin paired with a custom pair is priced in that pair, converted to SOL (lib/pumpprice.mjs)
    let quote = null;
    if (f.quote?.mint) { const q = await pairInfo(f.quote.mint), u = await solUsd().catch(() => null); quote = { mint: f.quote.mint, decimals: f.quote.decimals, solPerUnit: q?.usdPrice && u ? q.usdPrice / u : null }; }
    const cap = await cached(`pumpcap:${f.mint}`, 60_000, () => pumpMarketCap(conn, f.mint, { ...(p?.realTokens ? { initialRealTokens: p.realTokens } : {}), ...(quote ? { quote } : {}) })).catch(() => null);
    return featuredSummary(f, cap, await solUsd().catch(() => null));
  };

  /** One pool transaction as a trades-box row: who, buy/sell and SOL, landed or refused (with the hook's reason). */
  async function readTrade(s, l) {
    const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) return null;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    const signer = keys.get(0).toBase58();
    const tokenOf = (bals) => bals?.filter((b) => b.mint === l.mint && b.owner === signer).reduce((t, b) => t + BigInt(b.uiTokenAmount.amount), 0n) ?? 0n;
    const dTok = tokenOf(tx.meta.postTokenBalances) - tokenOf(tx.meta.preTokenBalances);
    // the SOL that entered or left the CURVE (its wSOL vault), not the wallet's change: a launch's dev buy also pays
    // account rent, which is not part of the trade
    const vault = (bals) => bals?.filter((x) => x.mint === NATIVE_MINT.toBase58() && x.owner === DBC_POOL_AUTHORITY.toBase58()).reduce((t, x) => t + Number(x.uiTokenAmount.amount), 0) ?? 0;
    const dSol = -(vault(tx.meta.postTokenBalances) - vault(tx.meta.preTokenBalances)) / 1e9;
    const base = { sig: s.signature, time: tx.blockTime ?? 0, mint: l.mint, symbol: l.symbol, who: `${signer.slice(0, 4)}…${signer.slice(-4)}` };
    if (tx.meta.err) {
      const code = hookErrorFromLogs(tx.meta.logMessages, hookProgram);
      return { ...base, ok: false, kind: "refused", why: code ? HOOK_ERRORS[code] : "refused on chain" };
    }
    if (dTok > 0n) return { ...base, ok: true, kind: "buy", sol: Math.max(0, -dSol) };
    if (dTok < 0n) return { ...base, ok: true, kind: "sell", sol: Math.max(0, dSol) };
    return null; // not a trade (a fee claim, a list fill, …)
  }

  /** The lookup table the graduator keeps (<dataDir>/lut.json), re-read every 5 min; null until it exists. */
  const lutFor = () => cached("lut", 300_000, () => loadLut(conn, `${dataDir}/lut.json`).catch(() => null));

  /** A token's list, read once per 5 s whoever asks (it can be 160 KB). */
  const listOf = (mint) => cached(`list:${mint}`, 5_000, async () => {
    const a = await conn.getAccountInfo(hookPdas(hookProgram, mint).list, "confirmed");
    const d = a ? decodeList(a.data) : null;
    return d && { ...d, set: new Set(d.wallets.map((w) => w.toBase58())) };
  });

  // ── handlers ────────────────────────────────────────────────────────────────────────────────
  const routes = {
    /** The burn ledger: what the burn wallet claimed and burned (lib/flywheel.mjs), for the site. */
    "GET /api/burns": async () => cached("burns", 10_000, async () => {
      if (!env.burnWallet) return { on: false };
      const rows = db.prepare("SELECT at, kind, sig, dry, lamports_in, lamports_spent, hooker_burned FROM burns ORDER BY id DESC LIMIT 50").all();
      const t = db.prepare("SELECT COALESCE(SUM(CAST(lamports_spent AS INTEGER)), 0) spent, COALESCE(SUM(CAST(hooker_burned AS INTEGER)), 0) burned, COALESCE(SUM(CAST(lamports_in AS INTEGER)), 0) claimed, COUNT(*) n FROM burns WHERE dry = 0 AND kind = 'burn'").get();
      const coins = db.prepare("SELECT COUNT(*) n FROM launches WHERE fee_to = 'burn' AND pump_mint IS NOT NULL").get().n;
      // what is waiting right now: the burn wallet's creator vault and its balance
      const [vault, bal] = await Promise.all([pumpSdk.getCreatorVaultQuoteBalances(env.burnWallet).catch(() => []), conn.getBalance(env.burnWallet, "confirmed").catch(() => 0)]);
      const waiting = Number(vault.find((b) => b.mint.equals(NATIVE_MINT))?.total?.toString() ?? 0) / 1e9 + bal / 1e9;
      const usd = await solUsd().catch(() => null);
      // the Robinhood Chain side's claims and bridges (server/evm-graduator.mjs writes data/evm-burn.json)
      let rhc = [];
      try { rhc = JSON.parse(readFileSync(`${dataDir}/evm-burn.json`, "utf8")).rows.map((r) => ({ at: r.at, kind: r.kind === "bridge" ? "bridge" : "claim-rhc", sig: r.hash, dry: !!r.dry, eth: Number(r.eth), sol: r.sol != null ? Number(r.sol) : null })); } catch {}
      const all = [...rows.map((r) => ({ at: r.at, kind: r.kind, sig: r.sig, dry: !!r.dry, solIn: r.lamports_in ? Number(r.lamports_in) / 1e9 : null, solSpent: r.lamports_spent ? Number(r.lamports_spent) / 1e9 : null, hookerBurned: r.hooker_burned ? Number(r.hooker_burned) / 1e6 : null })), ...rhc].sort((x, y) => y.at - x.at);
      const rhcCoins = evm ? (await evm.listAll().catch(() => [])).filter((l) => l.graduated?.ponsToken && !l.rules?.holderRewards).length : 0;
      return { on: true, wallet: env.burnWallet.toBase58(), hookerMint: env.hookerMint.toBase58(), coins: coins + rhcCoins, totals: { solSpent: Number(t.spent) / 1e9, hookerBurned: Number(t.burned) / 1e6, burns: t.n, usdSpent: usd ? (Number(t.spent) / 1e9) * usd : null }, waitingSol: waiting, rows: all.slice(0, 50) };
    }),

    "GET /api/health": async () => ({ ok: true, slot: await cached("slot", 2_000, () => conn.getSlot("confirmed")), hookKeys: freshCount(db) }),

    "GET /api/info": async () => {
      const p = state.pump ?? (await pumpLive());
      const live = await pumpLive();
      const flat = state.flatConfigs ?? {};
      // which fee steps are ready for a size (each step is its own set of configs: lib/curve.mjs FEE_TIERS)
      const tiersReady = (g) => Object.keys(FEE_TIERS).map(Number).filter((t) => configFor(state, { gradSol: g, antiSnipe: false, tier: t }) && configFor(state, { gradSol: g, antiSnipe: true, tier: t }));
      const sizes = Object.entries(activeConfigs()).map(([g, c]) => Number(g) > 0 && ({ sol: Number(g), config: c.toBase58(), flatConfig: flat[g]?.toBase58() ?? null, feeTiers: tiersReady(g), startCapSol: p.capAt(0), endCapSol: p.capAt(Number(g)), pumpfunOwn: Math.abs(Number(g) - Math.floor(p.completionSol * 10) / 10) < 1e-9 })).filter(Boolean).sort((a, b) => a.sol - b.sol);
      return {
        hookProgram: hookProgram.toBase58(),
        burnWallet: env.burnWallet?.toBase58() ?? null,
        solUsd: await solUsd().catch(() => null),
        fomoCosigner: env.fomoCosigner.toBase58(),
        appOnly: env.appOnlyEnabled ? { program: env.pumpAppProgram.toBase58() } : null,
        fomoOnly: env.fomoOnlyEnabled,
        economics: ECONOMICS,
        feeTiers: Object.entries(FEE_TIERS).map(([t, f]) => ({ tier: Number(t), label: f.label, ...tierSplit(Number(t)) })),
        defaults: DEFAULT_RULES,
        sizes,
        // pump.fun's curve as of now, and whether the configs still match it (the graduator re-makes them when not)
        pumpfun: { startCapSol: live.capAt(0), graduationSol: live.completionSol, graduationCapSol: live.capAt(live.completionSol),
                   configsCurrent: !state.pump || Math.abs(state.pump.completionSol - live.completionSol) < 1e-6 && Math.abs(state.pump.capAt(0) - live.capAt(0)) < 1e-6 },
      };
    },

    /**
     * The live trades box on /docs: REAL transactions on the tokens trading now (never simulated). Buys and sells
     * that landed, and refusals that landed as failed transactions (a bot or app that skips the dry run), with the
     * hook's reason. One read per token every 20 s at most, shared by every visitor; each transaction read once.
     */
    "GET /api/trades": async () => cached("trades", 10_000, async () => {
      const live = listLaunches(db, { limit: 50 }).filter((l) => shown(l) && l.status === "trading").slice(0, 10);
      const rows = [];
      let reads = 0;
      for (const l of live) {
        const sigs = await cached(`sigs:${l.pool}`, 20_000, () => conn.getSignaturesForAddress(new PublicKey(l.pool), { limit: 8 }, "confirmed")).catch(() => []);
        for (const s of sigs) {
          const k = `trade:${s.signature}`;
          if (!cache.has(k)) { if (reads >= 16) continue; reads++; }
          // a read that failed (RPC error, an odd transaction) is remembered as "nothing" for a minute, not retried every poll
          const row = await cached(k, cache.get(k)?.value?.failed ? 60_000 : 86_400_000, () => readTrade(s, l).catch(() => ({ failed: true })));
          if (row && !row.failed) rows.push(row);
        }
      }
      // Robinhood Chain trades (Pons launches) in the same feed
      if (evm) rows.push(...(await evm.recentTrades(12).catch(() => [])));
      rows.sort((a, b) => b.time - a.time);
      return { trades: rows.slice(0, 12), tokens: live.length + (evm ? (await evm.listAll().catch(() => [])).filter((l) => l.status === "trading").length : 0) };
    }),

    "GET /api/launches": async () => {
      const ls = listLaunches(db, { limit: 200 }).filter(shown);
      const prog = await progressOf(ls.map((l) => l.pool));
      const sol = await Promise.all(ls.map(async (l) => ({ chain: "sol", ...(await summarize(l, prog[l.pool])), meta: await metaQuick(l.mint) })));
      // Robinhood Chain launches (Pons) mixed in by launch time; a slow chain read never holds up the list
      const rhc = evm ? await Promise.race([evm.listAll().catch(() => []), new Promise((r) => setTimeout(() => r([]), 4_000))]) : [];
      const out = [...sol, ...rhc].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      // featured coins (our own $HOOKER) are pinned first
      return { launches: [...(await Promise.all(featured.map(summarizeFeatured))), ...out] };
    },

    "GET /api/token/:mint": async ({ params }) => {
      const mint = key(params.mint);
      if (featuredByMint.has(mint)) return summarizeFeatured(featuredByMint.get(mint));
      const l = getLaunch(db, mint);
      if (!shown(l)) throw status(404, "not a Hooker launch");
      const prog = await progressOf([l.pool]);
      const [rules, meta] = await Promise.all([rulesOf(mint), metaQuick(mint)]);
      const chainTime = await cached("time", 5_000, async () => conn.getBlockTime(await conn.getSlot("confirmed")));
      let list = null;
      if (rules?.allowlist || rules?.blocklist) {
        const d = await listOf(mint);
        list = { kind: rules.allowlist ? "allow" : "block", count: d?.count ?? 0, sealed: !!d?.sealed, openUntil: rules.launchTs + LIST_OPEN_SECS };
      }
      return { ...(await summarize(l, prog[l.pool])), meta, rules, list, chainTime, retrying: l.status !== "trading" && l.status !== "done" && !!l.error, stalled: l.status === "stalled" };
    },

    /** Whether a wallet is on a token's allow- or blocklist. */
    "GET /api/token/:mint/listed/:owner": async ({ params }) => {
      const mint = key(params.mint), owner = key(params.owner);
      const d = await listOf(mint);
      return { listed: !!d?.set.has(owner) };
    },

    "GET /api/token/:mint/balance/:owner": async ({ params }) => {
      const mint = key(params.mint), owner = key(params.owner);
      return cached(`bal:${mint}:${owner}`, 3_000, async () => {
        const a = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, TOKEN_2022_PROGRAM_ID), "confirmed").catch(() => null);
        return { amount: a ? a.value.amount : "0", decimals: 6, sol: (await conn.getBalance(new PublicKey(owner), "confirmed")) / 1e9 };
      });
    },

    "GET /api/wallet/:owner": async ({ params }) => {
      const owner = key(params.owner);
      const created = db.prepare("SELECT mint FROM launches WHERE creator = ? AND created_at >= ? ORDER BY created_at DESC").all(owner, hideBefore).map((r) => r.mint);
      created.unshift(...featured.filter((f) => f.creator === owner).map((f) => f.mint));
      const payouts = db.prepare("SELECT p.mint, p.amount, p.status, l.pump_mint, l.symbol FROM pushes p JOIN launches l ON l.mint = p.mint WHERE p.owner = ? AND l.created_at >= ?").all(owner, hideBefore);
      return { created, payouts };
    },

    "POST /api/ipfs": ({ req }) => ipfsUpload(req),

    /** Pump.fun custom pairs a launch may graduate into (≥ $1M liquidity), richest first. */
    "GET /api/pairs": async () => ({ pairs: await pairsNow(), maxCreatorFeeBps: MAX_CREATOR_FEE_BPS }),

    /** A token's logo, served from here (see safeImage). Content at a CID never changes: cached for good. */
    "GET /api/img/:cid": async ({ req, params }) => ({ __raw: await imageOf(params.cid, clientIp(req)) }),

    /** A nonce the creator's wallet signs to prove it is theirs; `…hook` keys are spent on issue. */
    "GET /api/launch-nonce/:creator": async ({ params }) => {
      const creator = key(params.creator);
      const nonce = randomBytes(16).toString("hex");
      nonces.set(nonce, { creator, at: Date.now() });
      // the oldest go first (a Map keeps insertion order): a flood of requests cannot wipe everyone's
      if (nonces.size > 10_000) for (const k of [...nonces.keys()].slice(0, nonces.size - 10_000)) nonces.delete(k);
      return { nonce, message: `Hooker launch ${nonce}` };
    },

    "POST /api/tx/launch": async ({ body, req }) => {
      const creator = new PublicKey(key(body.creator));
      {
        const n = nonces.get(String(body.nonce ?? ""));
        if (!n || n.creator !== creator.toBase58() || Date.now() - n.at > 10 * 60_000) throw status(401, "sign the launch message first (it expires after 10 minutes)");
        let sig; try { sig = bs58.decode(String(body.signature ?? "")); } catch { throw status(401, "invalid signature"); }
        if (!nacl.sign.detached.verify(Buffer.from(`Hooker launch ${body.nonce}`), sig, creator.toBytes())) throw status(401, "the signature does not match the wallet");
        nonces.delete(String(body.nonce));
      }
      const gradSol = Number(body.gradSol);
      const antiSnipe = body.antiSnipe === true;
      const feeTier = body.feeTier == null ? 0 : Number(body.feeTier);
      if (!FEE_TIERS[feeTier]) throw status(400, `fee step must be one of ${Object.keys(FEE_TIERS).join(", ")}`);
      if (!activeConfigs()[gradSol]) throw status(400, `graduation size must be one of ${Object.keys(activeConfigs()).join(", ")} SOL`);
      const config = configFor(state, { gradSol, antiSnipe, tier: feeTier });
      // a custom pair for the pump.fun coin, and the creator fee pump.fun allows only on such a coin
      let pair = null, pumpFeeBps = 0;
      if (body.pair) {
        pair = key(body.pair);
        if (!(await pairsNow()).some((p) => p.mint === pair)) throw status(400, "that pair is not on the list (pump.fun's custom pairs with at least $1M of liquidity)");
        pumpFeeBps = body.pumpCreatorFeeBps == null || body.pumpCreatorFeeBps === "" ? 0 : Number(body.pumpCreatorFeeBps);
        if (!Number.isInteger(pumpFeeBps) || pumpFeeBps < 0 || pumpFeeBps > MAX_CREATOR_FEE_BPS) throw status(400, "the Pumpfun creator fee must be 0.01% to 3%");
      } else if (body.pumpCreatorFeeBps) throw status(400, "a Pumpfun creator fee needs a custom pair (Pumpfun ignores it on SOL pairs)");
      if (!config) throw status(400, "that combination of size, fee and anti-snipe opens in a few minutes: try again shortly");
      const name = String(body.name ?? "").trim(), symbol = String(body.symbol ?? "").trim(), uri = String(body.uri ?? "").trim();
      if (!name || name.length > 32) throw status(400, "name: 1–32 characters");
      if (!symbol || symbol.length > 10) throw status(400, "symbol: 1–10 characters");
      // ⛔ 120, not pump.fun's 200: our own uploads are 80 characters, and the launch transaction (which
      // carries name, symbol and URI) only fits in 1,232 bytes with every rule on if the URI stays short
      if (!/^https:\/\//.test(uri) || uri.length > URI_MAX || !cidOf(uri) || !CID_RE.test(cidOf(uri))) throw status(400, "metadata must be uploaded to IPFS first (it is permanent on the Pumpfun token)");
      if (body.rules != null && (typeof body.rules !== "object" || Array.isArray(body.rules))) throw status(400, "rules must be an object");
      const r = { ...DEFAULT_RULES, ...pick(body.rules ?? {}, Object.keys(DEFAULT_RULES)), dev: creator };
      if (r.fomoOnly) { if (!env.fomoOnlyEnabled) throw status(400, "FOMO-only is not available yet"); r.cosigner = env.fomoCosigner; }
      if (r.appOnly) { if (!env.appOnlyEnabled) throw status(400, "app-only is not available yet: the Pump app cannot trade hooked curves"); r.app = env.pumpAppProgram; }
      const errs = validateRules(r);
      // "Curve only" is off the site (4 Oct 2026, operator): the hook still supports it, launches here cannot pick it
      if (r.venueLock) errs.push("Curve only is not available.");
      if (errs.length) throw status(400, errs.join(" "));
      const devBuySol = Number(body.devBuySol ?? 0);
      if (!Number.isFinite(devBuySol)) throw status(400, "dev buy must be a number of SOL");
      const devBuy = BigInt(Math.round(devBuySol * 1e9));
      // ⛔ Meteora charges the pool's FIRST swap the minimum fee instead of the 25% anti-snipe fee.
      // That first swap must be the creator's, inside the launch transaction, or a sniper gets it.
      if (devBuy < MIN_DEV_BUY) throw status(400, "a buy of at least 0.01 SOL at launch is required (it is the only trade that skips the anti-snipe fee)");
      if (devBuy > BigInt(Math.round(gradSol * 1e9)) / 5n) throw status(400, "dev buy: at most a fifth of the graduation size"); // sizes are fractional SOL
      // ⛔ every …hook key handed out is burned (see lib/vanity.mjs), so getting one must cost something:
      // the wallet must hold what the launch needs, and one IP gets a few per hour
      const need = devBuy + 50_000_000n;
      if (BigInt(await conn.getBalance(creator, "confirmed")) < need) throw status(400, `the wallet needs at least ${Number(need) / 1e9} SOL for this launch`);
      const ip = clientIp(req);
      const retry = db.prepare("SELECT 1 FROM vanity WHERE state = 'issued' AND holder = ? AND issued_at > ?").get(creator.toBase58(), Math.floor(Date.now() / 1000) - RESERVATION_SECS);
      if (!retry && issuedToIpSince(db, ip, Math.floor(Date.now() / 1000) - 3600) >= launchesPerIpPerHour) throw status(429, "too many launches from here this hour");
      let mintKp = issueForLaunch(db, creator.toBase58(), ip, vanityReserve);
      // the creator's reserved address may already carry their previous launch: then it is spent, issue another
      for (let i = 0; mintKp && i < 3 && (await conn.getAccountInfo(mintKp.publicKey, "confirmed")); i++) {
        markLaunched(db, mintKp.publicKey.toBase58());
        mintKp = issueForLaunch(db, creator.toBase58(), ip, vanityReserve);
      }
      if (!mintKp) throw status(503, "the next hook address is being made: try again in a few minutes");
      // ⛔ a config's fee split is fixed for good: never launch on one that does not match what the site says
      const cfgNow = await configState(config);
      if (cfgNow.creatorTradingFeePercentage !== (feeTier === 0 ? ECONOMICS.creatorTradingFeePct : FEE_TIERS[feeTier].creatorPct)) throw status(503, "launching is being updated to new fees: try again in a few minutes");
      const launchArgs = { dbc, hookProgram, config, creator, name, symbol, uri, rules: r, devBuyLamports: devBuy, mint: mintKp, lut: await lutFor(), priority: await priorityFee(conn) };
      let built = await buildLaunchTx({ ...launchArgs, memo: pair ? pairMemo(pair, pumpFeeBps) : null });
      // the pair note is the public copy of the choice; the ledger's is the one graduation uses, so a launch
      // that only overflows because of the note goes out without it rather than not at all
      if (pair && launchSize(built.tx) > 1232) built = await buildLaunchTx(launchArgs);
      const { tx, mint, pool } = built;
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      if (launchSize(tx) > 1232) throw status(503, "this launch does not fit in one transaction yet: try again in a few minutes"); // the table is being made
      // the pair choice, for the graduation service (the same choice is in the tx's memo, for everyone else)
      if (pair) recordIntent(db, mint.publicKey.toBase58(), pair, pumpFeeBps);
      else db.prepare("DELETE FROM launch_intents WHERE mint = ?").run(mint.publicKey.toBase58());
      if (tx instanceof VersionedTransaction) { tx.message.recentBlockhash = blockhash; tx.sign([mint]); } // the mint key signs here and is then forgotten
      else { tx.recentBlockhash = blockhash; tx.partialSign(mint); }
      return { tx: Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64"), mint: mint.publicKey.toBase58(), pool: pool.toBase58() };
    },

    "POST /api/tx/swap": async ({ body }) => {
      const mint = key(body.mint), owner = key(body.owner);
      const l = getLaunch(db, mint);
      if (!l) throw status(404, "not a Hooker launch");
      if (l.status !== "trading") throw status(400, "this token has graduated: trade it on Pumpfun");
      const buy = body.side === "buy";
      const rules = await rulesOf(mint);
      if (buy && rules?.fomoOnly) throw status(400, "this token can only be bought through FOMO");
      if (buy && rules?.appOnly) throw status(400, "this token can only be bought inside its app");
      if (!/^\d{1,20}$/.test(String(body.amount ?? ""))) throw status(400, "amount must be a whole number (lamports to buy, base units to sell)");
      const amount = BigInt(body.amount);
      if (amount <= 0n) throw status(400, "amount must be positive (lamports to buy, base units to sell)");
      // ⛔ never min-out 0: that invites a sandwich. Quote from the live curve, default 2% slippage.
      const slippageBps = Math.min(5_000, Math.max(10, Number(body.slippageBps ?? 200)));
      // ⛔ fresh, never the shared 5 s cache: a quote off a stale curve fails its own slippage check
      const [poolState, cfg] = [await getPool(dbc, new PublicKey(l.pool)), await configState(l.config)];
      if (!poolState) throw status(503, "could not read the curve, try again");
      let minOut;
      try {
        const q = dbc.pool.swapQuote2({ virtualPool: { poolState }, config: cfg, swapBaseForQuote: !buy, hasReferral: false, eligibleForFirstSwapWithMinFee: false,
          currentPoint: await getCurrentPoint(conn, cfg.activationType), slippageBps, swapMode: buy ? SwapMode.PartialFill : SwapMode.ExactIn, amountIn: new BN(amount.toString()) });
        minOut = BigInt(q.minimumAmountOut.toString());
      } catch (e) { throw status(400, `cannot quote that trade: ${String(e.message).slice(0, 120)}`); }
      // the live priority fee, but never above the token's own sniper-fee cap: our site must not trip it
      let priority = await priorityFee(conn);
      if (buy && rules?.snipeSecs > 0 && rules.snipeMaxCuPrice > 0) priority = Math.min(priority, Number(rules.snipeMaxCuPrice));
      const tx = await buildSwapTx({ dbc, pool: l.pool, owner, buy, amountIn: amount, minimumAmountOut: minOut, priority });
      tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
      return { tx: tx.serialize({ requireAllSignatures: false }).toString("base64") };
    },

    /**
     * The creator's list transactions: put `wallets` on the token's list (sorted, skipping any already
     * there) and, with `seal`, seal it in the last one. Each comes back for the creator's wallet to sign.
     */
    "POST /api/tx/list": async ({ body }) => {
      const mint = key(body.mint), creator = new PublicKey(key(body.creator));
      const l = getLaunch(db, mint);
      if (!l || l.creator !== creator.toBase58()) throw status(403, "only the creator can change the token's list");
      const rules = await rulesOf(mint);
      if (!rules?.allowlist && !rules?.blocklist) throw status(400, "this token has no list");
      const raw = Array.isArray(body.wallets) ? body.wallets : [];
      if (raw.length > LIST_MAX) throw status(400, `a list holds at most ${LIST_MAX} wallets`);
      const wallets = [];
      for (const w of raw) { try { wallets.push(new PublicKey(String(w).trim())); } catch { throw status(400, `not a wallet address: ${String(w).slice(0, 60)}`); } }
      const a = await conn.getAccountInfo(hookPdas(hookProgram, mint).list, "confirmed");
      const cur = a ? decodeList(a.data) : null;
      if (cur?.sealed) throw status(400, "the list is sealed");
      const now = await conn.getBlockTime(await conn.getSlot("confirmed"));
      if (wallets.length && now >= rules.launchTs + LIST_OPEN_SECS) throw status(400, "the list can only grow in the first day after launch");
      const { txs, added, tooLate } = buildListTxs({ hookProgram, dev: creator, mint: new PublicKey(mint), wallets, already: cur?.wallets ?? [], seal: !!body.seal });
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      return { added, tooLate: tooLate.map((w) => w.toBase58()), txs: txs.map((tx) => { tx.recentBlockhash = blockhash; return tx.serialize({ requireAllSignatures: false }).toString("base64"); }) };
    },

    /**
     * A creator's rewards, both venues: Meteora (their share of the trading fee on every Hooker curve they launched,
     * claimable while it trades and after it graduates) and pump.fun (the creator vault of their wallet: curve and
     * PumpSwap, in SOL and in any custom-pair token). Amounts in base units, plus a SOL value.
     */
    "GET /api/rewards/:creator": async ({ params }) => {
      const creator = key(params.creator);
      return cached(`rewards:${creator}`, 15_000, async () => {
        const mine = db.prepare("SELECT mint, pool, symbol FROM launches WHERE creator = ?").all(creator);
        const states = mine.length ? await progressOf(mine.map((l) => l.pool)) : {};
        const meteora = mine.map((l) => ({ mint: l.mint, symbol: l.symbol, lamports: BigInt(states[l.pool]?.creatorQuoteFee?.toString() ?? "0") })).filter((x) => x.lamports > 0n);
        const usd = await solUsd().catch(() => null);
        const vault = await pumpSdk.getCreatorVaultQuoteBalances(new PublicKey(creator)).catch(() => []);
        const pumpfun = [];
        for (const b of vault) {
          const amount = BigInt(b.total?.toString() ?? "0");
          if (amount <= 0n) continue;
          const m = b.mint.toBase58();
          if (m === NATIVE_MINT.toBase58()) { pumpfun.push({ quote: m, symbol: "SOL", amount, decimals: 9, sol: Number(amount) / 1e9 }); continue; }
          const p = await pairInfo(m);
          pumpfun.push({ quote: m, symbol: p?.symbol ?? `${m.slice(0, 4)}…`, amount, decimals: p?.decimals ?? null, sol: p?.usdPrice && usd && Number.isInteger(p?.decimals) ? (Number(amount) / 10 ** p.decimals) * p.usdPrice / usd : null });
        }
        const sum = (xs) => xs.reduce((t, x) => t + (x.sol ?? 0), 0);
        const meteoraOut = meteora.map((x) => ({ ...x, sol: Number(x.lamports) / 1e9 }));
        return { solUsd: usd, meteora: { items: meteoraOut, sol: sum(meteoraOut) }, pumpfun: { items: pumpfun, sol: sum(pumpfun) } };
      });
    },

    /**
     * Transactions that claim ALL of a creator's rewards on one venue ("meteora" | "pumpfun"), for the creator to sign.
     * Meteora: one claim per curve with fees. pump.fun: the SDK's collect-all (curve + PumpSwap, every quote), packed.
     */
    "POST /api/tx/claim-rewards": async ({ body }) => {
      const creator = new PublicKey(key(body.creator));
      const ixs = [];
      if (body.venue === "meteora") {
        const mine = db.prepare("SELECT pool FROM launches WHERE creator = ?").all(creator.toBase58());
        const states = mine.length ? await progressOf(mine.map((l) => l.pool)) : {};
        const max = new BN("18446744073709551615");
        for (const l of mine) {
          if (!(BigInt(states[l.pool]?.creatorQuoteFee?.toString() ?? "0") > 0n)) continue;
          const t = await dbc.creator.claimCreatorTradingFee2({ creator, payer: creator, receiver: creator, pool: new PublicKey(l.pool), maxBaseAmount: max, maxQuoteAmount: max });
          ixs.push(t.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)));
        }
      } else if (body.venue === "pumpfun") {
        // the SDK keeps each quote's instructions together; one group per quote
        const all = await pumpSdk.collectCoinCreatorFeeAllQuotesInstructions(creator, creator);
        let group = [];
        for (const ix of all) { group.push(ix); if (ix.programId.toBase58() !== "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL") { ixs.push(group); group = []; } }
        if (group.length) ixs.push(group);
      } else throw status(400, "venue must be meteora or pumpfun");
      if (!ixs.length) throw status(400, "nothing to claim right now");
      // pack the groups into as few transactions as fit (1,232 bytes each)
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      const priority = await priorityFee(conn);
      const txs = [];
      let cur = null;
      const fresh = () => { const t = new Transaction(); t.feePayer = creator; t.recentBlockhash = blockhash; return t; };
      for (const g of ixs) {
        const next = cur ?? fresh();
        const trial = fresh(); trial.add(...next.instructions, ...g); withPriority(trial, 400_000, priority);
        if (cur && trial.serialize({ requireAllSignatures: false, verifySignatures: false }).length > 1232) { withPriority(cur, 400_000, priority); txs.push(cur); cur = fresh().add(...g); }
        else { cur = fresh().add(...next.instructions, ...g); }
      }
      if (cur) { withPriority(cur, 400_000, priority); txs.push(cur); }
      return { txs: txs.map((t) => t.serialize({ requireAllSignatures: false }).toString("base64")) };
    },

    "POST /api/tx/claim": async ({ body }) => {
      const mint = key(body.mint), creator = new PublicKey(key(body.creator));
      const l = getLaunch(db, mint);
      if (!l || l.creator !== creator.toBase58()) throw status(403, "only the creator can claim");
      const max = new BN("18446744073709551615");
      const tx = await dbc.creator.claimCreatorTradingFee2({ creator, payer: creator, receiver: creator, pool: new PublicKey(l.pool), maxBaseAmount: max, maxQuoteAmount: max });
      withPriority(tx, 200_000);
      tx.feePayer = creator;
      tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
      return { tx: tx.serialize({ requireAllSignatures: false }).toString("base64") };
    },

    "POST /api/send": async ({ body }) => {
      const raw = Buffer.from(String(body.tx ?? ""), "base64");
      if (raw.length === 0 || raw.length > 1232) throw status(400, "not a transaction");
      // legacy (trades, claims, lists) or v0 over our lookup table (launches): both fully signed
      let instructions;
      try {
        const tx = VersionedTransaction.deserialize(raw);
        const msg = tx.message.serialize();
        const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
        if (tx.signatures.length !== signers.length || !signers.every((k, i) => nacl.sign.detached.verify(msg, tx.signatures[i], k.toBytes()))) throw status(400, "the transaction is not fully signed");
        if (tx.version === "legacy") instructions = Transaction.from(raw).instructions;
        else {
          const lut = await lutFor();
          if (!lut || !tx.message.addressTableLookups.every((l) => l.accountKey.equals(lut.key))) throw status(400, "not a Hooker transaction");
          instructions = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: [lut] }).instructions;
        }
      } catch (e) { if (e.status) throw e; throw status(400, "not a transaction"); }
      // not an open relay: trades and claims on our curves, and creators' list transactions (lib/relay.mjs)
      const rows = db.prepare("SELECT pool, mint FROM launches").all();
      const known = new Set([...rows.map((r) => r.pool), ...Object.values(activeConfigs()).map(String), ...Object.keys(state.all)]);
      if (!isRelayable({ instructions }, { known, mints: new Set(rows.map((r) => r.mint)), hookProgram })) throw status(400, "not a Hooker transaction");
      if (sendsInFlight >= 20) throw status(503, "busy, try again in a moment");
      sendsInFlight++;
      try {
      let sig;
      try { sig = await conn.sendRawTransaction(raw, { preflightCommitment: "confirmed" }); }
      catch (e) {
        const logs = e.transactionLogs ?? e.logs ?? [];
        console.error(new Date().toISOString(), "send refused:", String(e.message).slice(0, 160).replace(/\n/g, " "), "|", logs.slice(-8).join(" | ").slice(0, 900));
        const code = hookErrorFromLogs(logs, hookProgram);
        if (code) throw status(400, HOOK_ERRORS[code]);
        // otherwise Meteora's or the token program's own reason, never a raw dump
        const anchor = logs.map((l) => /Error Message: (.+?)\.?$/.exec(l)?.[1]).filter(Boolean).pop();
        const plain = anchor ?? logs.map((l) => /insufficient (funds|lamports)/i.test(l) ? "Not enough SOL in the wallet" : null).filter(Boolean).pop();
        throw status(400, plain ? `${plain}.` : "The network refused this transaction. Nothing was sent.");
      }
      // ⛔ never "internal error" on a slow network: a definite answer either way (lib/lander.mjs)
      const out = await lander.track(raw);
      if (out.landed && out.err) throw status(400, `failed on chain: ${JSON.stringify(out.err)}`);
      if (!out.landed) throw Object.assign(status(409, out.why === "expired"
        ? "The network dropped this transaction and it can no longer land. Nothing was spent: try again."
        : "This transaction has not landed yet. Check your wallet before trying again."), { signature: sig });
      return { signature: sig };
      } finally { sendsInFlight--; }
    },

    "POST /api/register": async ({ body }) => {
      const mint = key(body.mint);
      if (getLaunch(db, mint)) return { ok: true };
      // the pool address is a PDA of (quote, mint, config): check our configs directly, no program-wide scan
      const candidates = [...new Set([...Object.values(activeConfigs()).map(String), ...Object.keys(state.all)])].map((c) => deriveDbcPoolAddress(NATIVE_MINT, new PublicKey(mint), new PublicKey(c)));
      const found = (await progressOf(candidates.map((p) => p.toBase58())));
      const poolAddr = candidates.find((p) => found[p.toBase58()]);
      const ps = poolAddr && found[poolAddr.toBase58()];
      const gradSol = ps && sizeOf(ps.config.toBase58());
      if (!gradSol) throw status(404, "no pool on a Hooker config for this mint");
      const rules = await rulesOf(mint);
      if (!rules) throw status(400, "the token has no Hooker rules");
      if (!PublicKey.isOnCurve(new PublicKey(rules.dev).toBytes())) throw status(400, "the token's dev wallet is not a wallet");
      const meta = await metaOf(mint).catch(() => null);
      if (!meta?.name || !meta?.symbol || !meta?.uri) throw status(400, "the token has no metadata");
      if (meta.name.length > PUMPFUN_LIMITS.name || meta.symbol.length > PUMPFUN_LIMITS.symbol || meta.uri.length > PUMPFUN_LIMITS.uri) throw status(400, "the token's metadata is longer than Pumpfun allows");
      registerLaunch(db, { mint, pool: poolAddr.toBase58(), config: ps.config.toBase58(), creator: ps.creator.toBase58(), name: meta?.name, symbol: meta?.symbol, uri: meta?.uri, gradSol: Number(gradSol) });
      return { ok: true };
    },
  };

  // ── Robinhood Chain: launches that graduate into Pons V2 (lib/evm.mjs), on when EVM_LAUNCHPAD is set ─
  const evm = evmOpt === undefined ? createEvm({ cached, ethUsd, knowCid }) : evmOpt;
  if (evm) Object.assign(routes, evm.routes);

  // ── IPFS upload via pump.fun's route (it sends no CORS header, so the browser can't read it) ─
  const MIN_DEV_BUY = 10_000_000n;
  const MAX_UPLOAD = 4 * 1024 * 1024, UPLOAD_GAP_MS = 5_000, lastUpload = new Map();
  const FIELDS = ["name", "symbol", "description", "twitter", "telegram", "website"];
  /** One logo, by CID: from disk, else the first gateway that returns a whole image (then kept on disk). */
  const IMG_DIR = `${dataDir}/img`, IMG_MAX = 5 * 1024 * 1024, IMG_DISK_MAX = 1024 * 1024 * 1024, IMG_PARALLEL = 4;
  const imgMiss = new Map(); // CID → when every gateway last failed: not retried for 10 s
  // ⛔ the CID is any visitor's input. A CID this API never handed out (not a launch's or a featured coin's logo) is
  // fetched on a small per-visitor budget, a gateway body is read with a byte cap (never buffered whole first), only a
  // few gateway fetches run at once, and the disk cache is capped: one visitor cannot fill memory, disk or the gateways.
  const imgStrangers = new Map(); // ip → { n, at }: unknown CIDs asked for, per 10 minutes
  let imgInFlight = 0, imgWrites = 0;
  async function fetchCapped(url) {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(8_000), redirect: "follow" });
    if (!r.ok) { try { await r.body?.cancel(); } catch {} return null; }
    if (Number(r.headers.get("content-length") ?? 0) > IMG_MAX) { try { await r.body?.cancel(); } catch {} return null; }
    if (!r.body?.[Symbol.asyncIterator]) { const b = Buffer.from(await r.arrayBuffer()); return b.length > IMG_MAX ? null : b; }
    const chunks = []; let n = 0;
    for await (const c of r.body) { n += c.length; if (n > IMG_MAX) { try { await r.body.cancel(); } catch {} return null; } chunks.push(Buffer.from(c)); }
    return Buffer.concat(chunks);
  }
  /** Keeps the image folder under IMG_DISK_MAX by dropping the oldest files (checked every 50 writes). */
  function trimImages() {
    try {
      const files = readdirSync(IMG_DIR).map((f) => { const st = statSync(`${IMG_DIR}/${f}`); return { f, size: st.size, at: st.mtimeMs }; });
      let total = files.reduce((t, x) => t + x.size, 0);
      if (total <= IMG_DISK_MAX) return;
      for (const x of files.sort((p, q) => p.at - q.at)) { if (total <= IMG_DISK_MAX * 0.8) break; try { unlinkSync(`${IMG_DIR}/${x.f}`); total -= x.size; } catch {} }
    } catch {}
  }
  async function imageOf(cid, ip = "") {
    if (!CID_RE.test(cid)) throw status(400, "bad CID");
    const file = `${IMG_DIR}/${createHash("sha256").update(cid).digest("hex")}`;
    if (!existsSync(file)) {
      // a miss is remembered only 10 s: a just-launched token's image can reach the gateways seconds later
      if (Date.now() - (imgMiss.get(cid) ?? 0) < 10_000) throw status(404, "image not available");
      if (!knownCids.has(cid.split("/")[0])) {
        const w = imgStrangers.get(ip) ?? { n: 0, at: Date.now() };
        if (Date.now() - w.at > 600_000) { w.n = 0; w.at = Date.now(); }
        if (++w.n > 20) throw status(429, "too many unknown images");
        imgStrangers.set(ip, w);
        if (imgStrangers.size > 10_000) imgStrangers.clear();
      }
      // one fetch per CID however many visitors ask at once; only "it is on disk now" is cached
      await cached(`img:${cid}`, 1, async () => {
        for (let i = 0; imgInFlight >= IMG_PARALLEL && i < 50; i++) await new Promise((r) => setTimeout(r, 200));
        if (imgInFlight >= IMG_PARALLEL) throw status(503, "busy, try again");
        imgInFlight++;
        try {
          for (const g of GATEWAYS) {
            try {
              const b = await fetchCapped(g + cid);
              if (!b || !wholeImage(b)) continue; // too big, a gateway's error page, or a broken file
              mkdirSync(IMG_DIR, { recursive: true, mode: 0o700 });
              writeFileSync(`${file}.tmp`, b); renameSync(`${file}.tmp`, file);
              if (++imgWrites % 50 === 0) trimImages();
              return true;
            } catch {}
          }
        } finally { imgInFlight--; }
        imgMiss.set(cid, Date.now());
        if (imgMiss.size > 10_000) imgMiss.clear();
        throw status(404, "image not available");
      });
    }
    const bytes = readFileSync(file);
    return { type: imageType(bytes), bytes };
  }

  async function ipfsUpload(req) {
    const ip = clientIp(req);
    if (Date.now() - (lastUpload.get(ip) ?? 0) < UPLOAD_GAP_MS) throw status(429, "one upload every few seconds");
    lastUpload.set(ip, Date.now());
    if (lastUpload.size > 10_000) lastUpload.clear();
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_UPLOAD) { req.destroy(); throw status(413, "image too large (4 MB max)"); } chunks.push(c); }
    let form;
    try { form = await new Request("http://local/", { method: "POST", headers: { "content-type": req.headers["content-type"] ?? "" }, body: Buffer.concat(chunks) }).formData(); }
    catch { throw status(400, "expected multipart form data"); }
    const file = form.get("file");
    if (!file || typeof file === "string") throw status(400, "an image file is required");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!wholeImage(bytes)) throw status(415, "the image must be a complete PNG, JPEG, GIF or WebP file");
    const out = new FormData();
    out.append("file", new Blob([bytes], { type: file.type || "application/octet-stream" }), "image");
    for (const f of FIELDS) { const v = form.get(f); if (typeof v === "string" && v.length <= 1000) out.append(f, v); }
    out.append("showName", "true");
    const r = await fetchImpl(env.ipfsUpstream, { method: "POST", body: out });
    if (!r.ok) throw status(502, `metadata upload failed upstream (HTTP ${r.status})`);
    const j = await r.json();
    if (!j.metadataUri) throw status(502, "metadata upload returned no URI");
    return { uri: j.metadataUri, metadata: j.metadata ?? null };
  }

  // ── plumbing ────────────────────────────────────────────────────────────────────────────────
  const send = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  };
  const writeLimit = new Map(), readLimit = new Map(), nonces = new Map();
  let sendsInFlight = 0;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type" }); return res.end(); }
    let handler, params = {};
    for (const [route, h] of Object.entries(routes)) {
      const [m, path] = route.split(" ");
      if (m !== req.method) continue;
      const names = [];
      const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, n) => (names.push(n), "([^/]+)")) + "$");
      const match = re.exec(url.pathname);
      if (match) {
        handler = h;
        try { names.forEach((n, i) => (params[n] = decodeURIComponent(match[i + 1]))); } catch { return send(res, 400, { error: "bad path" }); }
        break;
      }
    }
    if (!handler) return send(res, 404, { error: "not found" });
    try {
      let body = {};
      if (req.method === "GET") { // a flood of cheap reads must not starve the paced RPC connection
        const ip = clientIp(req);
        const w = readLimit.get(ip) ?? { n: 0, at: Date.now() };
        if (Date.now() - w.at > 60_000) { w.n = 0; w.at = Date.now(); }
        if (++w.n > 240) return send(res, 429, { error: "too many requests" });
        readLimit.set(ip, w);
        if (readLimit.size > 10_000) readLimit.clear();
      }
      if (req.method === "POST") {
        const ip = clientIp(req);
        const w = writeLimit.get(ip) ?? { n: 0, at: Date.now() };
        if (Date.now() - w.at > 60_000) { w.n = 0; w.at = Date.now(); }
        if (++w.n > 60) return send(res, 429, { error: "too many requests" });
        writeLimit.set(ip, w);
        if (writeLimit.size > 10_000) writeLimit.clear();
        if (url.pathname !== "/api/ipfs") {
          const chunks = []; let n = 0;
          for await (const c of req) { n += c.length; if (n > 64 * 1024) return send(res, 413, { error: "body too large" }); chunks.push(c); }
          try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return send(res, 400, { error: "invalid JSON" }); }
        }
      }
      const out = await handler({ req, params, body, query: url.searchParams });
      if (out?.__raw) {
        res.writeHead(200, { "content-type": out.__raw.type, "content-length": out.__raw.bytes.length, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
        return res.end(out.__raw.bytes);
      }
      send(res, 200, out);
    } catch (e) {
      send(res, e.status ?? 500, { error: e.status ? e.message : "internal error" });
      if (!e.status) console.error(new Date().toISOString(), req.method, url.pathname, String(e?.stack ?? e).replace(/api-key=[^&\s"']+/g, "api-key=…"));
    }
  });
}

/** Caddy sets X-Forwarded-For itself; the LAST hop is the address Caddy saw. */
function clientIp(req) { return (req.headers["x-forwarded-for"] ?? "").split(",").pop().trim() || req.socket.remoteAddress; }
function status(code, message) { const e = new Error(message); e.status = code; return e; }
function key(v) { try { return new PublicKey(String(v)).toBase58(); } catch { throw status(400, `not an address: ${String(v).slice(0, 60)}`); } }
function pick(o, keys) { return Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])); }

process.on("uncaughtException", (e) => console.error(new Date().toISOString(), "api uncaught:", String(e?.stack ?? e).replace(/api-key=[^&\s"']+/g, "api-key=…")));
process.on("unhandledRejection", (e) => console.error(new Date().toISOString(), "api unhandled:", String(e?.stack ?? e).replace(/api-key=[^&\s"']+/g, "api-key=…")));

if (import.meta.url === `file://${process.argv[1]}`) {
  // the configs were made for one hook program: serving rules from another would be silently wrong
  const { existsSync, readFileSync } = await import("node:fs");
  const cf = `${env.dataDir}/configs.json`;
  if (existsSync(cf) && JSON.parse(readFileSync(cf, "utf8")).hookProgram !== env.hookProgram.toBase58()) {
    console.error(`HOOK_PROGRAM is ${env.hookProgram.toBase58()} but ${cf} was made for another hook: refusing to start`); process.exit(1);
  }
  const server = createApi();
  server.listen(env.apiPort, "127.0.0.1", () => console.log(`hooker api on :${env.apiPort} (rpc ${env.rpcUrl.replace(/api-key=[^&]+/, "api-key=…")})`));
}
