// Getting a signed transaction ONTO the chain, and a definite answer about it.
//
// ⛔ 4 Oct 2026, mainnet Test A: a buy was sent ONCE, never landed (the network had no record of it),
// and after 30 s the API answered "internal error" without knowing what happened. Solana drops
// transactions under load; wallets and terminals rebroadcast until one lands or provably cannot.
//
// Here: send once with preflight (so a refusal still comes back with its reason), then ONE shared loop
// for every transaction in flight: one getSignatureStatuses for all of them every POLL_MS, a rebroadcast
// of each still-unseen one every RESEND_MS, and a blockhash check every EXPIRY_MS. A transaction whose
// blockhash has expired can never land: that is the definite "dropped, nothing was spent" answer.
import bs58 from "bs58";
import { Transaction, VersionedTransaction } from "@solana/web3.js";

export const POLL_MS = 2_000, RESEND_MS = 4_000, EXPIRY_MS = 10_000;
/** Hard ceiling, in case the RPC never says the blockhash expired (a blockhash lives ~60–90 s). */
export const GIVE_UP_MS = 150_000;

/** The signature and recent blockhash of raw transaction bytes, legacy or v0. */
export function inspect(raw) {
  try { const v = VersionedTransaction.deserialize(raw); return { sig: bs58.encode(v.signatures[0]), blockhash: v.message.recentBlockhash }; }
  catch { const t = Transaction.from(raw); return { sig: bs58.encode(t.signature), blockhash: t.recentBlockhash }; }
}

export function createLander(conn, { log = () => {}, now = Date.now, pollMs = POLL_MS, resendMs = RESEND_MS, expiryMs = EXPIRY_MS, giveUpMs = GIVE_UP_MS } = {}) {
  const pending = new Map(); // sig → { raw, blockhash, since, lastSend, resolve }
  const blockhashChecked = new Map(); // blockhash → { at, valid }
  let timer = null;

  const finish = (sig, outcome) => { const p = pending.get(sig); if (!p) return; pending.delete(sig); p.resolve(outcome); };

  async function tick() {
    timer = null;
    if (!pending.size) return;
    const sigs = [...pending.keys()];
    try {
      for (let i = 0; i < sigs.length; i += 256) {
        const chunk = sigs.slice(i, i + 256);
        const st = (await conn.getSignatureStatuses(chunk)).value;
        st.forEach((s, j) => {
          if (!s) return;
          if (s.err) finish(chunk[j], { landed: true, err: s.err });
          else if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") finish(chunk[j], { landed: true, err: null });
        });
      }
    } catch (e) { log(`lander: status read failed: ${String(e.message).slice(0, 80)}`); }
    const t = now();
    for (const [sig, p] of pending) {
      if (t - p.since > giveUpMs) { finish(sig, { landed: false, why: "timeout" }); continue; }
      // a blockhash that is no longer valid can never land: the definite answer
      const bc = blockhashChecked.get(p.blockhash);
      if (!bc || t - bc.at > expiryMs) {
        let valid = true;
        try { valid = (await conn.isBlockhashValid(p.blockhash, { commitment: "processed" })).value; } catch {}
        blockhashChecked.set(p.blockhash, { at: t, valid });
        if (blockhashChecked.size > 1_000) blockhashChecked.clear();
      }
      if (blockhashChecked.get(p.blockhash)?.valid === false) {
        // one last look: it may have landed in the same moment
        const s = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true }).catch(() => ({ value: [null] }))).value[0];
        finish(sig, s ? { landed: true, err: s.err ?? null } : { landed: false, why: "expired" });
        continue;
      }
      if (t - p.lastSend >= resendMs) {
        p.lastSend = t;
        conn.sendRawTransaction(p.raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {}); // same signature: never a double spend
      }
    }
    if (pending.size) timer = setTimeout(tick, pollMs);
  }

  /**
   * Waits for a transaction ALREADY SENT once (with preflight) to land.
   * @returns { landed: true, err } | { landed: false, why: "expired" | "timeout" }
   */
  function track(raw) {
    const { sig, blockhash } = inspect(raw);
    return new Promise((resolve) => {
      const t = now();
      pending.set(sig, { raw, blockhash, since: t, lastSend: t, resolve });
      if (!timer) timer = setTimeout(tick, pollMs);
    });
  }

  return { track, inFlight: () => pending.size, _tick: tick };
}
