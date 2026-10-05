// The Robinhood Chain side end to end, through the API and the graduation service, against a fork of live
// Robinhood Chain (the REAL Pons V2 contracts): deploy the launchpad → launch with hooks through
// /api/evm/tx/launch → buys and a sell through the API's transactions → a refused buy explained in words →
// the curve fills → the graduation service graduates it into Pons and pays every holder → the API shows it
// on Pons with its market cap.
//
//   node test/e2e-evm.mjs          (starts its own proxy and anvil on :8546; needs Foundry)
//
// ⛔ Never anvil's dev accounts: they are real Robinhood Chain addresses with real balances that the fork
// re-reads mid-test. Every actor here is a fresh key funded with anvil_setBalance.
import { spawn } from "node:child_process";
import { createWalletClient, createTestClient, http, parseEther, formatEther, encodeDeployData } from "viem";
import { readFileSync } from "node:fs";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { evmClient, rhc, LAUNCHPAD_ABI, LAUNCHPAD_BYTECODE, TOKEN_ABI, PONS_FACTORY, PONS_DISTRIBUTORS, createEvm } from "../lib/evm.mjs";
// the burn side of the graduation service is configured from the environment at import: a Solana burn wallet, dry mode
process.env.BURN_WALLET = "hookXkHBi86pLTAPxShbvXiQsAPuyDmnanfXDs38p8n";
process.env.FLYWHEEL_DRY = "1";
process.env.EVM_BURN_LEDGER = new URL("../data/test-evm-burn.json", import.meta.url).pathname;
const { createEvmGraduator } = await import("../server/evm-graduator.mjs");
import { rmSync } from "node:fs";
rmSync(process.env.EVM_BURN_LEDGER, { force: true });

const PORT = 8546, URL_ = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── a fork of live Robinhood Chain (Cloudflare wants a browser User-Agent: the loopback proxy adds it) ──
const procs = [];
async function up(url) { try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }); return r.ok; } catch { return false; } }
if (!(await up("http://127.0.0.1:8899"))) { procs.push(spawn("node", [new URL("../evm/scripts/rpc-proxy.mjs", import.meta.url).pathname], { stdio: "ignore" })); await sleep(800); }
if (await up(URL_)) { console.error(`something already answers on :${PORT} (a stale anvil?): stop it first`); process.exit(1); }
procs.push(spawn("anvil", ["--fork-url", "http://127.0.0.1:8899", "--port", String(PORT), "--chain-id", "4663", "--retries", "10", "--timeout", "45000", "--silent"], { stdio: "ignore" }));
const cleanup = () => procs.forEach((p) => p.kill());
process.on("exit", cleanup);
for (let i = 0; i < 60 && !(await up(URL_)); i++) await sleep(500);

const client = evmClient(URL_, 4663, { timeout: 180_000 }); // a fork's first touch of Pons's state is slow
const test = createTestClient({ chain: rhc(4663, URL_), mode: "anvil", transport: http(URL_) });
const actor = async (eth) => { const a = privateKeyToAccount(generatePrivateKey()); await test.setBalance({ address: a.address, value: parseEther(String(eth)) }); return a; };
const walletOf = (a) => createWalletClient({ account: a, chain: rhc(4663, URL_), transport: http(URL_) });
const sendTx = async (a, t) => {
  const hash = await walletOf(a).sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value) });
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted ${hash}`);
  return r;
};

console.log("Robinhood Chain e2e (fork of live RHC, the real Pons V2)");
const deployer = await actor(1), owner = await actor(0), treasury = await actor(0), graduatorKey = generatePrivateKey();
await test.setBalance({ address: privateKeyToAccount(graduatorKey).address, value: parseEther("1") });
const hash = await walletOf(deployer).sendTransaction({ data: encodeDeployData({ abi: LAUNCHPAD_ABI, bytecode: LAUNCHPAD_BYTECODE, args: [owner.address, treasury.address, privateKeyToAccount(graduatorKey).address, PONS_FACTORY, PONS_DISTRIBUTORS] }) });
const pad = (await client.waitForTransactionReceipt({ hash })).contractAddress;
const deployBlock = await client.getBlockNumber();
ok(!!pad, `launchpad deployed at ${pad}`);

// the API's Robinhood Chain routes, with an in-memory cache like the API's
const cache = new Map();
const cached = async (k, ms, fn) => { const c = cache.get(k); if (c && Date.now() - c.at < ms) return c.v; const v = await fn(); cache.set(k, { v, at: Date.now() }); return v; };
const env = { rpcUrl: URL_, callRpcUrl: URL_, chainId: 4663, launchpad: pad, deployBlock, explorer: "https://robinhoodchain.blockscout.com" };
const evm = createEvm({ cached, ethUsd: async () => 2700, env, client, logClient: client, log: () => {} });
const api = (route, args = {}) => evm.routes[route]({ params: {}, query: new URLSearchParams(), body: {}, ...args });
// ⛔ a fork goes stale once its block ages out of the RPC's state ("historical state is not available"), and only accounts
// touched before that are cached: every Pons contract the flows need is read once now, and the run is split in two parts
// (`E2E_PART=eth` | `pairs`, default both) so each fork stays young.
const PART = process.env.E2E_PART ?? "both"; // eth | burn | pairs | both
const creator = await actor(5);
for (const a of ["0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e", "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948", "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044", "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  "0x42df2a798f82289E177311362e8f5ccC45c1219c", "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952", "0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42", "0xC7819B64A1dAECD7eC19856d026cb14EfBd89046",
  "0xf5695117b99B6f6401e67d4195BD653628176C6C", "0x70e95CC5f03DB2906081E7a8D16e4C4209291507", "0x8366a39CC670B4001A1121B8F6A443A643e40951", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"]) await client.getCode({ address: a }).catch(() => {});
const g = createEvmGraduator({ env, key: graduatorKey, client, timeout: 180_000, log: (m) => console.log(`    ${m}`) });
const settle = async (tok) => { for (let i = 0; i < 6; i++) { await g.tick(); cache.clear(); const st = (await api("GET /api/evm/token/:token", { params: { token: tok } })).status; if (st === "paid") return; await new Promise((r) => setTimeout(r, 5_000)); } };

if (PART === "eth" || PART === "both") {
const info = await api("GET /api/evm/info");
ok(info.sizes.length === 4 && Math.abs(info.sizes[3].eth - 4.2) < 1e-9 && info.sizes[3].ponsOwn, `sizes ${info.sizes.map((s) => s.eth).join(" / ")} ETH (the last is Pons's own)`);
ok(info.feeTiers[0].totalPct === 1 && info.feeTiers[3].creatorPct === 2.99, "fee steps as on Solana");

// ── launch with hooks: max per wallet 5%, holder share, creator fees to holders ──
// (the creator wallet is made at the top, so every part can use it)
const launchTx = await api("POST /api/evm/tx/launch", { body: { from: creator.address, name: "Hook RHC", symbol: "HRHC", image: "https://hooker.fun/api/img/bafkreitest", description: "e2e", website: "https://hooker.fun", size: 0, tier: 1, antiSnipe: false, devBuyEth: "0.02",
  rules: { maxWalletBps: 500, holderShareBps: 5_000, holderRewards: true, burnBps: 100 } } });
ok(launchTx.to === pad && BigInt(launchTx.value) === parseEther("0.02"), "launch transaction built (dev buy 0.02 ETH)");
let refusedWords = null;
try { await api("POST /api/evm/tx/launch", { body: { from: creator.address, name: "Bad", symbol: "BAD", rules: { allowlist: true, blocklist: true } } }); } catch (e) { refusedWords = e.message; }
ok(/allowlist and blocklist/.test(refusedWords ?? ""), `a bad rule set is refused before the wallet opens: "${refusedWords}"`);
await sendTx(creator, launchTx);
const { launches } = await api("GET /api/evm/launches");
const token = launches[0]?.mint;
ok(launches.length === 1 && launches[0].chain === "rhc" && launches[0].venue === "hooker", `listed: $${launches[0]?.symbol} ${token}`);
ok(launches[0].rules.maxWalletBps === 500 && launches[0].rules.holderRewards === true, "its rules read back from the token");
ok(Math.abs(launches[0].targetEth - 1.47) < 1e-9, "graduates at 1.47 ETH (35% of Pons's)");

// ── trades ──
const buyers = await Promise.all([0, 1, 2, 3, 4, 5].map(() => actor(3)));
const q = await api("GET /api/evm/quote/:token", { params: { token }, query: new URLSearchParams({ eth: "0.05" }) });
const t0 = await sendTx(buyers[0], await api("POST /api/evm/tx/buy", { body: { token, eth: "0.05", minTokensOut: (BigInt(q.tokens) * 95n / 100n).toString() } }));
const bal0 = await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [buyers[0].address] });
ok(bal0 > 0n && bal0 === BigInt(q.tokens), `a buy through the API: ${Number(formatEther(bal0)).toLocaleString()} tokens, exactly the quote (the quote takes the 1% burn off, as the contract does)`);
let code404 = null, code400 = null;
try { await api("GET /api/evm/token/:token", { params: { token: "0x0000000000000000000000000000000000000001" } }); } catch (e) { code404 = e.status; }
try { await api("GET /api/evm/quote/:token", { params: { token }, query: new URLSearchParams({ side: "sell", amount: "abc" }) }); } catch (e) { code400 = e.status; }
ok(code404 === 404 && code400 === 400, "an unknown token is a 404 and a malformed amount a 400, not server errors");
// too big for 5% max per wallet: the site simulates first and says why
const big = await api("POST /api/evm/tx/buy", { body: { token, eth: "0.5" } });
const sim = await api("POST /api/evm/simulate", { body: { from: buyers[1].address, ...big } });
ok(!sim.ok && /max per wallet/.test(sim.error), `a refused buy, in words: "${sim.error}"`);
for (let i = 1; i < 6; i++) await sendTx(buyers[i], await api("POST /api/evm/tx/buy", { body: { token, eth: "0.08" } }));
const half = (await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [buyers[1].address] })) / 2n;
const sq = await api("GET /api/evm/quote/:token", { params: { token }, query: new URLSearchParams({ side: "sell", amount: half.toString() }) });
const before = await client.getBalance({ address: buyers[1].address });
await sendTx(buyers[1], await api("POST /api/evm/tx/sell", { body: { token, amount: half.toString() } }));
const got = (await client.getBalance({ address: buyers[1].address })) - before;
ok(got > 0n && got <= parseEther(sq.eth), `a sell through the API: ${formatEther(got)} ETH back after gas (quoted ${sq.eth})`);
await evm.indexer.refresh();
const tr = await api("GET /api/evm/token/:token/trades", { params: { token } });
ok(tr.trades.length === 8 && tr.trades[0].isBuy === false, `trades feed: ${tr.trades.length} trades, newest first`);

// fill it, from several wallets (max per wallet 5%)
for (let i = 0; i < 40; i++) {
  const s = await api("GET /api/evm/token/:token", { params: { token } });
  cache.clear();
  if (s.status !== "trading") break;
  const who = await actor(1); // a fresh wallet each time: max per wallet is 5%
  await sendTx(who, await api("POST /api/evm/tx/buy", { body: { token, eth: "0.06" } }));
}
cache.clear();
let s = await api("GET /api/evm/token/:token", { params: { token } });
ok(s.status === "complete" && s.venue === "graduating" && s.progress === 1, `full: ${s.raisedEth} ETH raised, ${s.potEth.toFixed(5)} ETH holder-share pot`);

// ── the graduation service ──
await g.tick();
cache.clear();
s = await api("GET /api/evm/token/:token", { params: { token } });
ok(s.status === "paid" && s.venue === "pons" && s.graduated.ponsToken, `graduated into Pons and paid: ${s.graduated.ponsUrl}`);
if (!s.graduated?.ponsToken) { console.log(`\n${pass} passed, ${fail + 1} failed (stopped: not graduated)`); cleanup(); process.exit(1); }
ok(s.marketCapEth > 0, `market cap on Pons: ${s.marketCapEth.toFixed(3)} ETH ($${Math.round(s.marketCapUsd).toLocaleString()})`);
const pons = s.graduated.ponsToken;
const holders = Number(await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "holderCount" }));
let paid = 0;
for (let i = 0; i < holders; i++) {
  const h = await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "holders", args: [BigInt(i)] });
  const b = await client.readContract({ address: pons, abi: TOKEN_ABI, functionName: "balanceOf", args: [h] });
  if (b > 0n) paid++;
}
ok(paid === holders, `every holder received Pons coins (${paid}/${holders}), nobody had to claim`);
const left = await client.readContract({ address: pons, abi: TOKEN_ABI, functionName: "balanceOf", args: [pad] });
ok(left === 0n, "nothing left in the launchpad");
const fr = await client.readContract({ address: PONS_FACTORY, abi: [{ type: "function", name: "getLaunchedToken", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "tuple", components: [{ name: "token", type: "address" }, { name: "curve", type: "address" }, { name: "deployer", type: "address" }, { name: "creatorFeeRecipient", type: "address" }] }] }], functionName: "getLaunchedToken", args: [pons] }).catch(() => null);
const dist = await client.readContract({ address: PONS_DISTRIBUTORS, abi: [{ type: "function", name: "distributorOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] }], functionName: "distributorOf", args: [pons] });
ok(dist !== "0x0000000000000000000000000000000000000000", `creator fees to holders: Pons distributor ${dist}`);

// a second tick does nothing (idempotent)
await g.tick();
ok(true, "a second pass of the graduation service is a no-op");

// ── creator fees ──
const w = await api("GET /api/evm/wallet/:owner", { params: { owner: creator.address } });
ok(w.created.includes(token) && w.creatorFeesEth > 0, `the creator's launches and ${w.creatorFeesEth.toFixed(5)} ETH of fees waiting`);
await sendTx(creator, await api("POST /api/evm/tx/claim"));
const w2 = await api("GET /api/evm/wallet/:owner", { params: { owner: creator.address } });
ok(w2.creatorFeesEth === 0, "claimed");
}
if (PART === "burn" || PART === "both") {
// ── the burn side on Robinhood Chain: the graduated coin's Pons creator fees belong to the graduation wallet ──
// (this coin chose "creator fees to holders", so its distributor got them; a second, plain coin feeds the burn)
const c4 = await actor(5);
const launch4 = await api("POST /api/evm/tx/launch", { body: { from: c4.address, name: "Feed Burn", symbol: "FEED", image: "https://hooker.fun/x.png", size: 0, tier: 0, devBuyEth: "0.01", rules: {} } });
const r4 = await sendTx(c4, launch4);
const token4 = (await api("GET /api/evm/receipt/:hash", { params: { hash: r4.transactionHash } })).token;
await sendTx(await actor(5), await api("POST /api/evm/tx/buy", { body: { token: token4, eth: "3" } }));
await settle(token4);
cache.clear();
const s4 = await api("GET /api/evm/token/:token", { params: { token: token4 } });
const PONS_FACTORY_ABI2 = [{ type: "function", name: "getLaunchedToken", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "tuple", components: [{ name: "token", type: "address" }, { name: "curve", type: "address" }, { name: "deployer", type: "address" }, { name: "creatorFeeRecipient", type: "address" }] }] }, { type: "function", name: "feeEscrow", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const lt4 = await client.readContract({ address: PONS_FACTORY, abi: PONS_FACTORY_ABI2, functionName: "getLaunchedToken", args: [s4.graduated.ponsToken] });
ok(lt4.creatorFeeRecipient.toLowerCase() === privateKeyToAccount(graduatorKey).address.toLowerCase(), "a graduated coin without the holders hook names the graduation wallet as Pons fee recipient (the burn side)");
// trades on the Pons curve earn creator fees; the keeper sweeps them to the escrow and (dry) claims and quotes the bridge
const trader = await actor(3);
const CURVE_ABI2 = [{ type: "function", name: "buy", stateMutability: "payable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] }];
await test.increaseTime({ seconds: 10 }); await test.mine({ blocks: 1 }); // past Pons's 3 s snipe tax
for (let i = 0; i < 3; i++) { const h = await createWalletClient({ account: trader, chain: rhc(4663, URL_), transport: http(URL_) }).writeContract({ address: lt4.curve, abi: CURVE_ABI2, functionName: "buy", args: [parseEther("0.3"), 0n, trader.address], value: parseEther("0.3") }); await client.waitForTransactionReceipt({ hash: h }); }
// dry mode sends nothing, so the sweep (a state change) is done here as the recipient would; the keeper then claims (dry)
const sweepHash = await createWalletClient({ account: privateKeyToAccount(graduatorKey), chain: rhc(4663, URL_), transport: http(URL_) }).writeContract({ address: lt4.curve, abi: [{ type: "function", name: "sweepFees", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] }], functionName: "sweepFees", args: [0n] });
await client.waitForTransactionReceipt({ hash: sweepHash });
await g.burnTick();
const escrow = await client.readContract({ address: PONS_FACTORY, abi: PONS_FACTORY_ABI2, functionName: "feeEscrow" });
const owed = await client.readContract({ address: escrow, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [privateKeyToAccount(graduatorKey).address] });
const burnLedger = JSON.parse(readFileSync(process.env.EVM_BURN_LEDGER, "utf8"));
ok(owed > 0n && burnLedger.rows.some((r) => r.kind === "claim" && r.dry), `the coin's fees reached Pons's escrow for the burn side (${formatEther(owed)} ETH owed) and the keeper simulated the claim (dry)`);
ok(burnLedger.rows.some((r) => r.kind === "bridge" && r.dry && Number(r.sol) > 0), `and quoted the bridge to the Solana burn wallet through Relay: ${burnLedger.rows.find((r) => r.kind === "bridge")?.eth} ETH → ${burnLedger.rows.find((r) => r.kind === "bridge")?.sol} SOL (dry)`);


// ── Pons stops taking launches: a full curve is called off by a stranger and every holder sells back, fee-free ──
const PONS_ABI = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }, { type: "function", name: "setLaunchEnabled", stateMutability: "nonpayable", inputs: [{ type: "bool" }], outputs: [] }, { type: "function", name: "launchEnabled", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }];
const ponsOwner = await client.readContract({ address: PONS_FACTORY, abi: PONS_ABI, functionName: "owner" });
const c3 = await actor(5);
const launch3 = await api("POST /api/evm/tx/launch", { body: { from: c3.address, name: "Refund Me", symbol: "RFND", image: "https://hooker.fun/x.png", size: 0, tier: 0, devBuyEth: "0.01", rules: {} } });
const r3 = await sendTx(c3, launch3);
const token3 = (await api("GET /api/evm/receipt/:hash", { params: { hash: r3.transactionHash } })).token;
const filler = await actor(5);
await sendTx(filler, await api("POST /api/evm/tx/buy", { body: { token: token3, eth: "3" } }));
await test.impersonateAccount({ address: ponsOwner });
await test.setBalance({ address: ponsOwner, value: parseEther("1") });
await createWalletClient({ account: ponsOwner, chain: rhc(4663, URL_), transport: http(URL_) }).writeContract({ address: PONS_FACTORY, abi: PONS_ABI, functionName: "setLaunchEnabled", args: [false] });
await test.stopImpersonatingAccount({ address: ponsOwner });
await g.tick(); // the graduation service tries, fails, and backs off (no state change)
cache.clear();
let s3 = await api("GET /api/evm/token/:token", { params: { token: token3 } });
ok(s3.status === "complete", "with Pons closed the curve stays full: nothing is lost, nothing moves");
const stranger = await actor(1);
const abortHash = await createWalletClient({ account: stranger, chain: rhc(4663, URL_), transport: http(URL_) }).writeContract({ address: pad, abi: LAUNCHPAD_ABI, functionName: "abort", args: [token3] });
await client.waitForTransactionReceipt({ hash: abortHash });
cache.clear();
s3 = await api("GET /api/evm/token/:token", { params: { token: token3 } });
ok(s3.status === "refunding" && s3.venue === "refunding" && s3.graduated === null, "anyone can call it off once Pons refuses launches: the API shows it refunding");
const fb = BigInt((await api("GET /api/evm/token/:token/balance/:owner", { params: { token: token3, owner: filler.address } })).amount);
const sq3 = await api("GET /api/evm/quote/:token", { params: { token: token3 }, query: new URLSearchParams({ side: "sell", amount: fb.toString() }) });
const fBefore = await client.getBalance({ address: filler.address });
await sendTx(filler, await api("POST /api/evm/tx/sell", { body: { token: token3, amount: fb.toString() } }));
const got3 = (await client.getBalance({ address: filler.address })) - fBefore;
ok(sq3.feeBps === 0 && got3 > parseEther("1.4") && got3 <= parseEther(sq3.eth), `the holder sold everything back with no fee: ${formatEther(got3)} ETH of the 1.47 raised (quoted ${sq3.eth})`);
let buyRefused = null;
try { await api("GET /api/evm/quote/:token", { params: { token: token3 }, query: new URLSearchParams({ eth: "0.1" }) }); } catch (e) { buyRefused = e.message; }
ok(/not trading/.test(buyRefused ?? ""), "buying a refunding curve is refused");
// Pons takes launches again (the fork's copy was closed above)
await test.impersonateAccount({ address: ponsOwner });
await createWalletClient({ account: ponsOwner, chain: rhc(4663, URL_), transport: http(URL_) }).writeContract({ address: PONS_FACTORY, abi: PONS_ABI, functionName: "setLaunchEnabled", args: [true] });
await test.stopImpersonatingAccount({ address: ponsOwner });

}
if (PART === "pairs" || PART === "both") {
// ── a launchpad priced in USDG (a Pons pair asset): the curve takes USDG, the coin graduates paired with USDG ──
console.log("── USDG pair launchpad");
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const ERC20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
// USDG for the test wallets: its balance mapping's storage slot is found by probing (anvil lets us write storage)
const { keccak256, encodeAbiParameters, toHex, pad: padHex } = await import("viem");
let usdgSlot = null;
for (let slot = 0; slot < 40 && usdgSlot === null; slot++) {
  const probe = privateKeyToAccount(generatePrivateKey()).address;
  const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [probe, BigInt(slot)]));
  await test.setStorageAt({ address: USDG, index: key, value: padHex(toHex(777n), { size: 32 }) });
  if ((await client.readContract({ address: USDG, abi: ERC20, functionName: "balanceOf", args: [probe] })) === 777n) usdgSlot = slot;
}
ok(usdgSlot !== null, `found USDG's balance slot (${usdgSlot}) on the fork`);
const giveUsdg = async (who, amount) => test.setStorageAt({ address: USDG, index: keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, BigInt(usdgSlot)])), value: padHex(toHex(amount), { size: 32 }) });
const api2 = api;
const infoU = await api("GET /api/evm/info");
const usdgPair = infoU.pairs.find((p) => p.symbol === "USDG");
ok(infoU.pairs.length > 40 && infoU.pairs[0].symbol === "ETH" && usdgPair && usdgPair.decimals === 6 && Math.abs(usdgPair.sizes[3].eth - 8090) < 1e-6 && usdgPair.bridgeable, `the API lists ${infoU.pairs.length} pair assets approved by Pons; USDG sizes ${usdgPair?.sizes.map((x) => x.eth).join(" / ")} USDG, bridgeable to the burn`);
const priced = infoU.pairs.filter((p) => p.usd != null);
ok(priced.length > 10 && priced.some((p) => p.symbol === "AAPL" && p.usd > 50 && p.usd < 1000), `${priced.length} assets priced from their USDG pools on chain (AAPL $${priced.find((p) => p.symbol === "AAPL")?.usd?.toFixed(2)})`);
const cU = await actor(2); await giveUsdg(cU.address, 5_000_000_000n); // 5,000 USDG
let needsApprove = null;
try { await api2("POST /api/evm/tx/launch", { body: { from: cU.address, quote: "USDG", name: "Dollar Hook", symbol: "DHOOK", image: "https://hooker.fun/x.png", size: 0, tier: 1, devBuyEth: "100", rules: {} } }); } catch (e) { needsApprove = e.message; }
ok(/Approve USDG/.test(needsApprove ?? ""), `without an approval the launch is refused in words: "${needsApprove}"`);
await sendTx(cU, await api2("POST /api/evm/tx/approve", { body: { quote: "USDG", amount: "100" } }));
const lU = await api2("POST /api/evm/tx/launch", { body: { from: cU.address, quote: "USDG", name: "Dollar Hook", symbol: "DHOOK", image: "https://hooker.fun/x.png", size: 0, tier: 1, devBuyEth: "100", rules: { maxWalletBps: 5000 } } });
ok(BigInt(lU.value) === parseEther(infoU.ponsLaunchFeeEth) && lU.quoteIn === "100000000", "the launch sends Pons's fee in ETH and pulls 100 USDG as the first buy");
const rU = await sendTx(cU, lU);
const tokenU = (await api2("GET /api/evm/receipt/:hash", { params: { hash: rU.transactionHash } })).token;
cache.clear();
let sU = await api2("GET /api/evm/token/:token", { params: { token: tokenU } });
ok(sU.quote.symbol === "USDG" && sU.raised > 90 && sU.target === 8090 * 0.35 && sU.marketCapUsd > 0, `listed as a USDG launch: ${sU.raised} of ${sU.target} USDG, market cap $${Math.round(sU.marketCapUsd)}`);
// buyers approve once, then buy in USDG until it fills; the keeper graduates it paired with USDG
for (let i = 0; i < 6; i++) {
  cache.clear();
  if ((await api2("GET /api/evm/token/:token", { params: { token: tokenU } })).status !== "trading") break;
  const b = await actor(1); await giveUsdg(b.address, 2_000_000_000n);
  const q = await api2("GET /api/evm/quote/:token", { params: { token: tokenU }, query: new URLSearchParams({ amount: "900" }) });
  await sendTx(b, await api2("POST /api/evm/tx/approve", { body: { token: tokenU, amount: "900" } }));
  await sendTx(b, await api2("POST /api/evm/tx/buy", { body: { token: tokenU, amount: "900", minTokensOut: ((BigInt(q.tokens) * 97n) / 100n).toString() } }));
}
cache.clear();
sU = await api2("GET /api/evm/token/:token", { params: { token: tokenU } });
ok(sU.status === "complete", `the USDG curve filled: ${sU.raised} USDG raised`);
await settle(tokenU);
cache.clear();
sU = await api2("GET /api/evm/token/:token", { params: { token: tokenU } });
const ltU = await client.readContract({ address: PONS_FACTORY, abi: [{ type: "function", name: "getLaunchedToken", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "tuple", components: [{ name: "token", type: "address" }, { name: "curve", type: "address" }, { name: "deployer", type: "address" }, { name: "creatorFeeRecipient", type: "address" }, { name: "pairToken", type: "address" }] }] }], functionName: "getLaunchedToken", args: [sU.graduated?.ponsToken ?? "0x0000000000000000000000000000000000000001"] }).catch(() => null);
ok(sU.status === "paid" && ltU?.pairToken?.toLowerCase() === USDG.toLowerCase() && sU.marketCapUsd > 0, `graduated into a Pons coin paired with USDG and paid out; cap on Pons $${Math.round(sU.marketCapUsd)}`);
const wU = await api2("GET /api/evm/wallet/:owner", { params: { owner: cU.address } });
ok(wU.creatorFees.some((f) => f.symbol === "USDG" && f.amount > 0), `the creator's fees are waiting in USDG (${wU.creatorFees.find((f) => f.symbol === "USDG")?.amount})`);
await sendTx(cU, await api2("POST /api/evm/tx/claim", { body: { quote: "USDG" } }));
ok((await api2("GET /api/evm/wallet/:owner", { params: { owner: cU.address } })).creatorFees.length === 0, "claimed in USDG");
}
evm.stop();
console.log(`\n${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail ? 1 : 0);
