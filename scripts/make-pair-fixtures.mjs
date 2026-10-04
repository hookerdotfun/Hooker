// Local-test fixtures for custom pairs: two REAL pair tokens from pump.fun's list, copied from mainnet
// with their mint authority swapped for a test key (so the local tests can mint them), and pump.fun's
// quote-control list itself. scripts/validator.sh loads them. Re-run to refresh.
//   node scripts/make-pair-fixtures.mjs
// WBTC = a classic SPL token (8 decimals); SPYx = a Token-2022 xStock with extensions (8 decimals).
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";

export const PAIR_TESTS = [
  { symbol: "WBTC", mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh" },
  { symbol: "SPYx", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W" },
];
export const QUOTE_CONTROL = "6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP";

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL("../", import.meta.url).pathname;
  mkdirSync(`${root}fixtures`, { recursive: true });
  const authPath = `${root}keys/test-pair-authority.json`;
  if (!existsSync(authPath)) writeFileSync(authPath, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
  const auth = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(authPath, "utf8"))));
  const conn = new Connection(process.env.CLONE_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const dump = (addr, info, data) => ({ pubkey: addr, account: { lamports: info.lamports, data: [Buffer.from(data).toString("base64"), "base64"], owner: info.owner.toBase58(), executable: false, rentEpoch: 0, space: data.length } });
  for (const t of PAIR_TESTS) {
    const info = await conn.getAccountInfo(new PublicKey(t.mint));
    const data = Buffer.from(info.data);
    // Mint layout (SPL and Token-2022 alike): COption<Pubkey> mint_authority at 0 (u32 tag + 32 bytes)
    data.writeUInt32LE(1, 0); auth.publicKey.toBuffer().copy(data, 4);
    writeFileSync(`${root}fixtures/pair-${t.symbol}-mint.json`, JSON.stringify(dump(t.mint, info, data)));
    console.log(`${t.symbol} ${t.mint} (${info.owner.toBase58().startsWith("Tokenz") ? "Token-2022" : "SPL"}, ${data.length} bytes): mint authority → ${auth.publicKey.toBase58()}`);
  }
  console.log(`quote-control ${QUOTE_CONTROL} is cloned as is by scripts/validator.sh`);
}
