// Keeps the …hook key pool stocked on the box: one grinder run per key, at the lowest CPU priority
// (the box serves other sites). Most keys come from a faster machine via deploy/push-vanity.sh;
// this is the trickle that keeps launches possible if nobody pushes.
//   GRIND_BIN=/usr/local/bin/hooker-grind VANITY_TARGET=20 node server/grind.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { env } from "../lib/env.mjs";
import { openDb } from "../lib/db.mjs";
import { initVanity, freshCount, importIncoming, incomingDir, SUFFIX } from "../lib/vanity.mjs";

const BIN = process.env.GRIND_BIN || "/usr/local/bin/hooker-grind";
const TARGET = Number(process.env.VANITY_TARGET || 20);
if (!existsSync(BIN)) { console.error(`no grinder at ${BIN}`); process.exit(1); }
const db = openDb(`${env.dataDir}/hooker.db`);
initVanity(db);
const dir = incomingDir(env.dataDir);
let stopping = false;
process.on("SIGTERM", () => (stopping = true));
const log = (m) => console.log(new Date().toISOString(), m);
log(`grinder up: target ${TARGET} fresh ${SUFFIX} keys, have ${freshCount(db)}`);
while (!stopping) {
  importIncoming(db, dir);
  if (freshCount(db) >= TARGET) { await new Promise((r) => setTimeout(r, 60_000)); continue; }
  const code = await new Promise((resolve) => spawn("nice", ["-n", "19", BIN, SUFFIX, "1", "1", dir], { stdio: "ignore" }).on("exit", resolve));
  const got = importIncoming(db, dir);
  if (code !== 0) { log(`grinder exited ${code}`); await new Promise((r) => setTimeout(r, 30_000)); }
  else if (got) log(`pool +${got} → ${freshCount(db)} fresh`);
}
