/**
 * Solana wallet connection through Wallet Standard.
 *
 * ⛔ Wallets announce themselves (Phantom, Solflare, Backpack, …); never a `window.solana` global,
 *    which with two extensions installed is whichever loaded last and picks a wallet FOR the user.
 * ⭐ The server builds every transaction; the wallet only signs (`solana:signTransaction`), and the
 *    signed bytes go back to the server to send. The browser holds no RPC key and no Solana library.
 * ⛔ Base58 is case-sensitive: addresses are compared exactly, never lowercased.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getWallets } from "@wallet-standard/app";
import bs58 from "bs58";

const Ctx = createContext(null);
export const useWallet = () => useContext(Ctx);

const CHAIN = import.meta.env.VITE_CHAIN || "solana:mainnet";
const usable = (w) => Boolean(w.features["standard:connect"] && w.features["solana:signTransaction"] && w.features["solana:signMessage"] && (w.chains || []).some((c) => c.startsWith("solana:")));
const LAST = "hooker:last-wallet";
const store = {
  get: () => { try { return localStorage.getItem(LAST); } catch { return null; } },
  set: (v) => { try { v ? localStorage.setItem(LAST, v) : localStorage.removeItem(LAST); } catch {} },
};
export const cancelled = (e) => e?.code === 4001 || /reject|cancel|denied|closed/i.test(e?.message || "");

const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
const toB64 = (u8) => { let s = ""; for (const c of u8) s += String.fromCharCode(c); return btoa(s); };

export function WalletProvider({ children }) {
  const [providers, setProviders] = useState([]);
  const [active, setActive] = useState(null);
  const [account, setAccount] = useState(null);
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState(null);
  const pending = useRef(null);
  const address = account?.address || null;

  useEffect(() => {
    const reg = getWallets();
    const sync = () => setProviders(reg.get().filter(usable));
    sync();
    const offs = [reg.on("register", sync), reg.on("unregister", sync)];
    return () => { offs.forEach((off) => off()); };
  }, []);

  // Quietly reattach the wallet the user picked last time, without a prompt.
  useEffect(() => {
    if (active) return;
    const name = store.get();
    const w = name && providers.find((x) => x.name === name);
    if (!w) return;
    w.features["standard:connect"].connect({ silent: true }).then(({ accounts }) => {
      if (accounts?.[0]) { setActive(w); setAccount(accounts[0]); }
    }).catch(() => {});
  }, [providers, active]);

  useEffect(() => {
    const ev = active?.features["standard:events"];
    if (!ev) return;
    return ev.on("change", ({ accounts }) => { if (accounts) setAccount(accounts[0] || null); });
  }, [active]);

  const connectWith = useCallback(async (w) => {
    setError(null);
    try {
      const { accounts } = await w.features["standard:connect"].connect();
      const acct = accounts?.[0];
      if (!acct) throw new Error("The wallet returned no account.");
      setActive(w); setAccount(acct); store.set(w.name); setPicker(false);
      pending.current?.resolve({ w, acct });
      return { w, acct };
    } catch (e) {
      setError(cancelled(e) ? "Connection was cancelled in the wallet." : e.message);
      pending.current?.reject(e);
      throw e;
    } finally {
      pending.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (active && account) return Promise.resolve({ w: active, acct: account });
    setPicker(true);
    return new Promise((resolve, reject) => { pending.current = { resolve, reject }; });
  }, [active, account]);

  /** Signs one base64 transaction (built by the server for `expected`) and returns it signed, base64. */
  const signTransaction = useCallback(async (b64, expected) => {
    const { w, acct } = await connect();
    if (expected && acct.address !== expected) throw new Error("Your wallet switched accounts. Try again.");
    const [out] = await w.features["solana:signTransaction"].signTransaction({ account: acct, transaction: fromB64(b64), chain: CHAIN });
    return toB64(out.signedTransaction);
  }, [connect]);

  /** Signs several base64 transactions in ONE wallet approval; returns them signed, base64, in order. */
  const signTransactions = useCallback(async (b64s, expected) => {
    const { w, acct } = await connect();
    if (expected && acct.address !== expected) throw new Error("Your wallet switched accounts. Try again.");
    const outs = await w.features["solana:signTransaction"].signTransaction(...b64s.map((b) => ({ account: acct, transaction: fromB64(b), chain: CHAIN })));
    if (outs.length !== b64s.length) throw new Error("The wallet signed only some of the transactions. Try again.");
    return outs.map((o) => toB64(o.signedTransaction));
  }, [connect]);

  /** Signs a short text with the connected wallet; returns base58. Proves the wallet is the user's. */
  const signMessage = useCallback(async (text, expected) => {
    const { w, acct } = await connect();
    if (expected && acct.address !== expected) throw new Error("Your wallet switched accounts. Try again.");
    const f = w.features["solana:signMessage"];
    if (!f) throw new Error("This wallet cannot sign messages here. Try Phantom, Solflare or Backpack.");
    const [out] = await f.signMessage({ account: acct, message: new TextEncoder().encode(text) });
    return bs58.encode(out.signature);
  }, [connect]);

  const disconnect = useCallback(async () => {
    setAccount(null); setActive(null); store.set(null);
    try { await active?.features["standard:disconnect"]?.disconnect(); } catch {}
  }, [active]);

  const closePicker = useCallback(() => {
    setPicker(false);
    pending.current?.reject(Object.assign(new Error("closed"), { code: 4001 }));
    pending.current = null;
  }, []);

  const value = useMemo(() => ({ providers, address, picker, error, setError, connect, connectWith, disconnect, closePicker, signTransaction, signTransactions, signMessage }),
    [providers, address, picker, error, connect, connectWith, disconnect, closePicker, signTransaction, signTransactions, signMessage]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function WalletPicker() {
  const { providers, picker, connectWith, closePicker, error } = useWallet();
  // no Cancel button: a tap outside the box or Escape closes it
  useEffect(() => {
    if (!picker) return;
    const onKey = (e) => { if (e.key === "Escape") closePicker(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picker, closePicker]);
  if (!picker) return null;
  return (
    <div className="modal" onClick={closePicker}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Connect wallet</h3>
        {providers.length === 0 && <p className="muted">No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then reload.</p>}
        <div className="wallets">
          {providers.map((w) => (
            <button key={w.name} className="wallet-btn" onClick={() => { connectWith(w).catch(() => {}); }}>
              {w.icon && <img src={w.icon} alt="" />} {w.name}
            </button>
          ))}
        </div>
        {error && <p className="err">{error}</p>}
      </div>
    </div>
  );
}
