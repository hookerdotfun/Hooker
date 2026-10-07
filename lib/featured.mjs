// Coins shown on hooker.fun that were launched straight on pump.fun, not through Hooker: our own
// $HOOKER. They sit in the lists and get a token page like every launch, priced from pump.fun, but
// nothing Hooker-specific is claimed for them (no Hooker curve, no rules, no holders paid).
// The list is featured.json in the repo, so adding one is an edit + deploy.
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";

const FILE = new URL("../featured.json", import.meta.url);

/** The featured coins, validated. A malformed entry is a startup error, not a quiet omission. */
export function loadFeatured(file = FILE) {
  const { coins = [] } = JSON.parse(readFileSync(file, "utf8"));
  return coins.map((c) => {
    for (const k of ["mint", "creator", "name", "symbol", "image", "createdAt"]) if (c[k] == null || c[k] === "") throw new Error(`featured.json: ${c.mint ?? "?"} is missing ${k}`);
    new PublicKey(c.mint); new PublicKey(c.creator);
    if (!/^\/[\w./-]+$/.test(c.image)) throw new Error(`featured.json: ${c.mint} image must be a path on the site`);
    // quote: { mint, decimals } when the coin trades against a custom pair instead of SOL (detected by scripts/set-ca.mjs)
    return { mint: c.mint, creator: c.creator, name: c.name, symbol: c.symbol, image: c.image, createdAt: Number(c.createdAt), description: c.description ?? null, twitter: c.twitter ?? null, telegram: c.telegram ?? null, website: c.website ?? null, quote: c.quote ?? null, review: !!c.review };
  });
}

/**
 * Robinhood Chain coins launched outside Hooker (our own Pons token): featured.json `evmCoins`, validated the same way.
 * Shown like a Hooker launch that graduated into Pons (scripts/set-ca-pons.mjs writes them).
 */
export function loadFeaturedEvm(file = FILE) {
  const { evmCoins = [] } = JSON.parse(readFileSync(file, "utf8"));
  return evmCoins.map((c) => {
    for (const k of ["token", "creator", "name", "symbol", "image", "createdAt"]) if (c[k] == null || c[k] === "") throw new Error(`featured.json: ${c.token ?? "?"} is missing ${k}`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(c.token) || !/^0x[0-9a-fA-F]{40}$/.test(c.creator)) throw new Error(`featured.json: ${c.token} needs 0x addresses`);
    if (!/^\/[\w./-]+$/.test(c.image)) throw new Error(`featured.json: ${c.token} image must be a path on the site`);
    return { token: c.token, creator: c.creator, name: c.name, symbol: c.symbol, image: c.image, createdAt: Number(c.createdAt), description: c.description ?? null, twitter: c.twitter ?? null, telegram: c.telegram ?? null, website: c.website ?? null, review: !!c.review };
  });
}

/**
 * Launches created before this unix time are hidden from the SITE (the 4 Oct test launches: the
 * site starts fresh). ⛔ Display only: the API's lists and pages use it, the graduator never reads it,
 * so a hidden launch that is still graduating still gets every holder paid.
 */
export function loadHideBefore(file = FILE) {
  const v = JSON.parse(readFileSync(file, "utf8")).hideLaunchesBefore ?? 0;
  if (!Number.isFinite(v)) throw new Error("featured.json: hideLaunchesBefore must be a unix time");
  return v;
}

/** One featured coin in the same shape the site gets for a launch, with `native: true`. */
export function featuredSummary(f, cap, solUsd) {
  const marketCapSol = cap?.marketCapSol ?? null;
  return {
    mint: f.mint, pool: null, creator: f.creator, name: f.name, symbol: f.symbol, gradSol: null,
    // shown EXACTLY like a launch that graduated from Hooker (operator, 4 Oct 2026): status done, on Pumpfun or
    // PumpSwap. `native` keeps the three things that never happened to it off its page (holders paid, rules, fee claims).
    createdAt: f.createdAt, status: "done", native: true, venue: cap?.venue ?? "pump.fun",
    progress: 1, raisedSol: null, targetSol: null,
    marketCapSol, marketCapUsd: marketCapSol != null && solUsd ? marketCapSol * solUsd : null, solUsd,
    pumpUrl: `https://pump.fun/coin/${f.mint}`, graduated: { status: "done", pumpMint: f.mint, pumpUrl: `https://pump.fun/coin/${f.mint}`, settled: null },
    meta: { name: f.name, symbol: f.symbol, image: f.image, description: f.description, twitter: f.twitter, telegram: f.telegram, website: f.website, complete: true },
  };
}
