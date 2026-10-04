// A token's allow- or blocklist on the site: parse what the creator pasted, sort it the way the
// program stores it (raw bytes, ascending), and fill the list on chain in sorted chunks.
import bs58 from "bs58";
import { api } from "./api.js";

/** Wallet addresses from free text (lines, commas, spaces). Unique, with anything unreadable reported. */
export function parseWallets(text) {
  const valid = new Map(), invalid = [];
  for (const raw of String(text ?? "").split(/[\s,;]+/)) {
    const w = raw.trim();
    if (!w) continue;
    try { const b = bs58.decode(w); if (b.length !== 32) throw new Error(); valid.set(w, b); } catch { invalid.push(w); }
  }
  const sorted = [...valid.entries()].sort((a, b) => cmp(a[1], b[1])).map(([w]) => w);
  return { wallets: sorted, invalid };
}
const cmp = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

// ⚠ one approval signs a chunk's transactions against one blockhash, which expires after about a
// minute: 300 wallets is 13 transactions, sent one after another well inside that
const CHUNK = 300;

/**
 * Puts `wallets` (already sorted by parseWallets) on the token's list and, with `seal`, seals it.
 * Each chunk is one wallet approval; its transactions are sent in order, since the program only ever
 * appends above the last listed wallet.
 */
export async function fillList({ mint, creator, wallets, seal, signTransactions, onProgress = () => {} }) {
  const chunks = [];
  for (let i = 0; i < wallets.length; i += CHUNK) chunks.push(wallets.slice(i, i + CHUNK));
  if (!chunks.length) chunks.push([]);
  let done = 0, tooLate = [];
  for (let c = 0; c < chunks.length; c++) {
    const last = c === chunks.length - 1;
    const built = await api.listTx({ mint, creator, wallets: chunks[c], seal: seal && last });
    tooLate = tooLate.concat(built.tooLate ?? []);
    if (!built.txs.length) continue;
    onProgress(`Approve ${built.txs.length} list transaction${built.txs.length === 1 ? "" : "s"} in your wallet…`);
    const signed = await signTransactions(built.txs, creator);
    for (let i = 0; i < signed.length; i++) {
      onProgress(`Filling the list: ${Math.min(wallets.length, done + (i + 1) * 24)} of ${wallets.length}…`);
      await api.send(signed[i]);
    }
    done += chunks[c].length;
  }
  return { tooLate };
}
