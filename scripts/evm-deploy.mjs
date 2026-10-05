// Deploys the Hooker launchpad on Robinhood Chain, from the graduation wallet (keys/evm-graduator.key).
// The owner and the treasury are only named in the constructor: their keys are never needed here.
//
//   node scripts/evm-deploy.mjs <owner> <treasury>          REHEARSAL on a fork of live RHC (nothing real is sent)
//   node scripts/evm-deploy.mjs <owner> <treasury> --live   the real deploy (asks you to type "deploy")
//
// After a live deploy it reads everything back from chain (code, owner, treasury, token factory, Pons) and writes
// data/evm-mainnet.env with EVM_LAUNCHPAD and EVM_DEPLOY_BLOCK for the box.
// ⛔ A rehearsal never touches the real chain: it forks it into anvil on :8547 and deploys there.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { createWalletClient, createTestClient, http, encodeDeployData, formatEther, getAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { evmClient, rhc, LAUNCHPAD_ABI, LAUNCHPAD_BYTECODE, PONS_FACTORY, PONS_DISTRIBUTORS } from "../lib/evm.mjs";
import { readEvmKey } from "../server/evm-graduator.mjs";

const argv = process.argv.slice(2);
const quoteIdx = argv.indexOf("--quote");
const quoteArg = quoteIdx >= 0 ? argv[quoteIdx + 1] : null;
const positional = argv.filter((a, i) => !a.startsWith("--") && (quoteIdx < 0 || i !== quoteIdx + 1));
const [ownerArg, treasuryArg, recipientArg] = positional;
const live = argv.includes("--live");
// --quote <asset address>: a launchpad priced in one of Pons's pair assets (USDG 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168); default ETH
const quote = quoteArg ? getAddress(quoteArg) : "0x0000000000000000000000000000000000000000";
if (!ownerArg || !treasuryArg) { console.error("usage: node scripts/evm-deploy.mjs <owner> <treasury> [--live]"); process.exit(1); }
const owner = getAddress(ownerArg), treasury = getAddress(treasuryArg);
// the burn side: graduated coins' Pons creator fees go here (default: the graduation wallet itself, which claims and bridges them)
const recipient = recipientArg ? getAddress(recipientArg) : null;
const account = privateKeyToAccount(readEvmKey(process.env.EVM_KEY_FILE || new URL("../keys/evm-graduator.key", import.meta.url).pathname));
if ([owner, treasury].includes(account.address)) { console.error("the graduation wallet must be a third wallet, not the owner or the treasury"); process.exit(1); }

const MAINNET = "https://rpc.mainnet.chain.robinhood.com";
const procs = [];
let url = MAINNET;
if (!live) {
  const up = async (u) => { try { return (await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })).ok; } catch { return false; } };
  if (!(await up("http://127.0.0.1:8899"))) { procs.push(spawn("node", [new URL("../evm/scripts/rpc-proxy.mjs", import.meta.url).pathname], { stdio: "ignore" })); await new Promise((r) => setTimeout(r, 800)); }
  url = "http://127.0.0.1:8547";
  if (await up(url)) { console.error(":8547 is busy (a stale anvil?)"); process.exit(1); }
  procs.push(spawn("anvil", ["--fork-url", "http://127.0.0.1:8899", "--port", "8547", "--chain-id", "4663", "--retries", "10", "--timeout", "45000", "--silent"], { stdio: "ignore" }));
  for (let i = 0; i < 60 && !(await up(url)); i++) await new Promise((r) => setTimeout(r, 500));
}
const done = (code) => { procs.forEach((p) => p.kill()); process.exit(code); };
const client = evmClient(url, 4663, { timeout: 120_000 });
const wallet = createWalletClient({ account, chain: rhc(4663, url), transport: http(url, { fetchOptions: { headers: { "User-Agent": "Mozilla/5.0 Chrome/140.0.0.0" } }, timeout: 120_000 }) });

console.log(`${live ? "LIVE DEPLOY on Robinhood Chain" : "REHEARSAL on a fork of Robinhood Chain (nothing real is sent)"}
  from (graduation wallet)  ${account.address}
  owner                     ${owner}
  treasury                  ${treasury}
  fee recipient (burn side) ${recipient ?? account.address + " (the graduation wallet)"}`);
let bal = await client.getBalance({ address: account.address });
console.log(`  graduation wallet holds  ${formatEther(bal)} ETH${live ? "" : " on mainnet"}`);
if (!live) {
  // the rehearsal funds the fork's copy of the wallet so it can run before the real one is funded
  await createTestClient({ chain: rhc(4663, url), mode: "anvil", transport: http(url) }).setBalance({ address: account.address, value: parseEther("1") });
  bal = parseEther("1");
  console.log("  (rehearsal: the fork's copy of it was given test ETH; a fork prices gas far above mainnet)");
}
const data = encodeDeployData({ abi: LAUNCHPAD_ABI, bytecode: LAUNCHPAD_BYTECODE, args: [owner, treasury, recipient ?? account.address, quote, PONS_FACTORY, PONS_DISTRIBUTORS] });
const gas = await client.estimateGas({ account: account.address, data });
const fee = await client.getGasPrice();
const maxFee = fee * 2n; // Robinhood Chain charges the base fee and refunds the rest; this only caps it
const cost = ((gas * 13n) / 10n) * maxFee;
console.log(`  deploy: ${gas.toLocaleString()} gas × ${Number(fee) / 1e9} gwei ≈ ${formatEther(cost)} ETH at most`);
if (bal < cost) { console.error(`  ⛔ the graduation wallet needs at least ${formatEther(cost)} ETH`); done(1); }
if (live) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question('  type "deploy" to deploy for real: ');
  rl.close();
  if (a.trim() !== "deploy") { console.log("  not deployed"); done(1); }
}
const hash = await wallet.sendTransaction({ data, gas: (gas * 13n) / 10n, maxFeePerGas: maxFee, maxPriorityFeePerGas: 0n });
console.log(`  sent ${hash}`);
const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
if (r.status !== "success" || !r.contractAddress) { console.error("  ⛔ the deploy reverted"); done(1); }
const pad = r.contractAddress;

// read it all back: a deploy is only done when the chain says so
const read = (fn) => client.readContract({ address: pad, abi: LAUNCHPAD_ABI, functionName: fn });
const code = await client.getCode({ address: pad });
const [o, t, p, d, f, fr, qq, grad] = await Promise.all([read("owner"), read("treasury"), read("pons"), read("distributors"), read("tokenFactory"), read("feeRecipient"), read("quote"), read("ponsGraduationEth")]);
const fcode = await client.getCode({ address: f });
const checks = [
  [code && code.length > 2, `launchpad code at ${pad} (${(code.length - 2) / 2} bytes)`],
  [o === owner, `owner ${o}`],
  [t === treasury, `treasury ${t}`],
  [fr === (recipient ?? account.address), `graduated coins' Pons fees go to ${fr}`],
  [qq.toLowerCase() === quote.toLowerCase(), `priced in ${qq === "0x0000000000000000000000000000000000000000" ? "ETH" : qq}, Pons graduation ${grad}`],
  [p === PONS_FACTORY && d === PONS_DISTRIBUTORS, "Pons V2 factory and holder-fee registry"],
  [fcode && fcode.length > 2, `token factory ${f}`],
];
for (const [ok, m] of checks) console.log(`  ${ok ? "✓" : "✗"} ${m}`);
if (checks.some(([ok]) => !ok)) done(1);
console.log(`  deployed in block ${r.blockNumber}, cost ${formatEther(r.gasUsed * r.effectiveGasPrice)} ETH`);
if (live) {
  mkdirSync(new URL("../data/", import.meta.url).pathname, { recursive: true });
  if (quote === "0x0000000000000000000000000000000000000000") {
    writeFileSync(new URL("../data/evm-mainnet.env", import.meta.url), `EVM_LAUNCHPAD=${pad}\nEVM_DEPLOY_BLOCK=${r.blockNumber}\n`);
    console.log("  wrote data/evm-mainnet.env");
  } else {
    // pair launchpads are appended: EVM_PAIR_LAUNCHPADS=0xpad@block,…
    const f = new URL("../data/evm-mainnet-pairs.env", import.meta.url);
    let cur = ""; try { cur = readFileSync(f, "utf8").trim().replace(/^EVM_PAIR_LAUNCHPADS=/, ""); } catch {}
    writeFileSync(f, `EVM_PAIR_LAUNCHPADS=${[cur, `${pad}@${r.blockNumber}`].filter(Boolean).join(",")}\n`);
    console.log("  wrote data/evm-mainnet-pairs.env");
  }
} else console.log("  rehearsal OK: run again with --live for the real one");
done(0);
