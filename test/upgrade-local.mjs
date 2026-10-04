// Rehearses the mainnet hook upgrade on the local validator: v1 deployed exactly sized (as on
// mainnet), a buffer with the new build handed to a separate "cold" key, then ExtendProgramChecked and
// Upgrade signed by that key alone, a slot apart. Run: node test/upgrade-local.mjs <v1.so>
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { extendIx, upgradeIx, programDataOf, extendNeeded, sameProgram } from "../lib/upgrade.mjs";

const RPC = process.env.LOCAL_RPC || "http://127.0.0.1:8997";
const CLI = `${process.env.HOME}/.local/share/solana/install/releases/4.0.0/solana-release/bin/solana`;
const conn = new Connection(RPC, "confirmed");
const V1 = readFileSync(process.argv[2]), V2 = readFileSync(new URL("../fixtures/hooker_hook.so", import.meta.url));
const dir = mkdtempSync(`${tmpdir()}/hook-upgrade-`);
const keyfile = (kp, name) => { const f = `${dir}/${name}.json`; writeFileSync(f, JSON.stringify([...kp.secretKey])); return f; };
const program = Keypair.generate(), cold = Keypair.generate(), deployer = Keypair.generate();
const [pf, cf, df] = [keyfile(program, "program"), keyfile(cold, "cold"), keyfile(deployer, "deployer")];
writeFileSync(`${dir}/v1.so`, V1);
let checks = 0;
const ok = (c, m) => { if (!c) { console.error("❌ FAIL:", m); process.exit(1); } checks++; console.log("✅", m); };
for (const k of [cold, deployer]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 20 * LAMPORTS_PER_SOL), "confirmed");
const cli = (...a) => execFileSync(CLI, ["-u", RPC, ...a]).toString();

cli("program", "deploy", "-k", df, "--program-id", pf, "--upgrade-authority", cf, `${dir}/v1.so`);
const pd = programDataOf(program.publicKey);
ok(sameProgram((await conn.getAccountInfo(pd)).data, V1), `v1 is deployed (program account ${(await conn.getAccountInfo(pd)).data.length} bytes, as tight as on mainnet)`);
const buffer = /Buffer: (\w+)/.exec(cli("program", "write-buffer", "-k", df, "--buffer-authority", df, new URL("../fixtures/hooker_hook.so", import.meta.url).pathname))[1];
cli("program", "set-buffer-authority", "-k", df, buffer, "--new-buffer-authority", cold.publicKey.toBase58());
ok(!!buffer, "the new build is in a buffer, handed to the cold key");

const extra = extendNeeded((await conn.getAccountInfo(pd)).data.length, V2.length, 8 * 1024);
ok(extra > 0, `the program account must grow by ${extra.toLocaleString()} bytes`);
const sendAs = (ixs) => sendAndConfirmTransaction(conn, new Transaction({ feePayer: cold.publicKey }).add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }), ...ixs), [cold], { commitment: "confirmed" });
// a stranger cannot do either step
const stranger = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL), "confirmed");
let why = "passed";
try { await sendAndConfirmTransaction(conn, new Transaction({ feePayer: stranger.publicKey }).add(extendIx({ program: program.publicKey, authority: stranger.publicKey, bytes: extra })), [stranger]); }
catch (e) { why = (e.transactionLogs ?? []).join(" ") || String(e.message); }
ok(/Incorrect upgrade authority|IncorrectAuthority|incorrect authority/i.test(why), "nobody but the upgrade authority can extend the program (refused for the authority, not for anything else)");
await sendAs([extendIx({ program: program.publicKey, authority: cold.publicKey, bytes: extra })]);
ok((await conn.getAccountInfo(pd)).data.length === 45 + V2.length + 8 * 1024, "the cold key extended the program account (it paid the rent)");
const s0 = await conn.getSlot("confirmed");
while ((await conn.getSlot("confirmed")) < s0 + 2) await new Promise((r) => setTimeout(r, 300));
const coldBefore = await conn.getBalance(cold.publicKey);
await sendAs([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), upgradeIx({ program: program.publicKey, buffer, authority: cold.publicKey })]);
ok(sameProgram((await conn.getAccountInfo(pd)).data, V2), "the cold key upgraded the program to the new build");
ok((await conn.getBalance(cold.publicKey)) > coldBefore, "the buffer's rent came back to the cold key");
ok(!(await conn.getAccountInfo(new PublicKey(buffer))), "the buffer is closed");
console.log(`\n${checks} checks passed`);
