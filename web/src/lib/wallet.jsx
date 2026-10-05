/**
 * Wallet connection for both chains: Solana wallets through Wallet Standard, EVM wallets (Robinhood Chain,
 * for launches that graduate into Pons) through EIP-6963. One Connect button, one picker listing both.
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
import { startDiscovery, subscribe, legacyProvider } from "./eip6963.js";

const Ctx = createContext(null);
export const useWallet = () => useContext(Ctx);

const CHAIN = import.meta.env.VITE_CHAIN || "solana:mainnet";
const usable = (w) => Boolean(w.features["standard:connect"] && w.features["solana:signTransaction"] && w.features["solana:signMessage"] && (w.chains || []).some((c) => c.startsWith("solana:")));
const LAST = "hooker:last-wallet";
const LAST_EVM = "hooker:last-evm-wallet";
const kv = (k) => ({
  get: () => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
});
const store = kv(LAST), storeEvm = kv(LAST_EVM);
/** Robinhood Chain, for a wallet that has never seen it (wallet_addEthereumChain). */
const RHC = { chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"], blockExplorerUrls: ["https://robinhoodchain.blockscout.com"] };
const hex = (n) => "0x" + BigInt(n).toString(16);
const sameAddr = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
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
  // "any" (the Connect button), "sol" (a Solana action is waiting), "evm" (a Robinhood Chain action is waiting)
  const [mode, setMode] = useState("any");
  const [evmProviders, setEvmProviders] = useState([]);
  const [evm, setEvm] = useState(null); // { detail, address }
  const evmAddress = evm?.address ?? null;

  useEffect(() => { startDiscovery(); return subscribe(setEvmProviders); }, []);
  const evmList = evmProviders.length ? evmProviders : [legacyProvider()].filter(Boolean);

  // quietly reattach the EVM wallet picked last time (eth_accounts never prompts)
  useEffect(() => {
    if (evm) return;
    const rdns = storeEvm.get();
    const d = rdns && evmList.find((x) => x.info.rdns === rdns);
    if (!d) return;
    d.provider.request({ method: "eth_accounts" }).then((a) => { if (a?.[0]) setEvm({ detail: d, address: a[0] }); }).catch(() => {});
  }, [evmList, evm]);

  useEffect(() => {
    const p = evm?.detail?.provider;
    if (!p?.on) return;
    const onAccounts = (a) => setEvm((cur) => (a?.[0] ? { ...cur, address: a[0] } : null));
    p.on("accountsChanged", onAccounts);
    return () => p.removeListener?.("accountsChanged", onAccounts);
  }, [evm?.detail]);

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
      if (pending.current?.mode === "evm") pending.current.reject(Object.assign(new Error("closed"), { code: 4001 }));
      else pending.current?.resolve({ w, acct });
      return { w, acct };
    } catch (e) {
      setError(cancelled(e) ? "Connection was cancelled in the wallet." : e.message);
      pending.current?.reject(e);
      throw e;
    } finally {
      pending.current = null;
    }
  }, []);

  const connect = useCallback((m = "sol") => {
    if (m === "sol" && active && account) return Promise.resolve({ w: active, acct: account });
    if (m === "evm" && evm) return Promise.resolve(evm);
    setMode(m);
    setPicker(true);
    return new Promise((resolve, reject) => { pending.current = { resolve, reject, mode: m }; });
  }, [active, account, evm]);

  const connectEvmWith = useCallback(async (d) => {
    setError(null);
    try {
      const a = await d.provider.request({ method: "eth_requestAccounts" });
      if (!a?.[0]) throw new Error("The wallet returned no account.");
      const v = { detail: d, address: a[0] };
      setEvm(v); storeEvm.set(d.info.rdns); setPicker(false);
      if (pending.current?.mode === "evm" || pending.current?.mode === "any") pending.current.resolve(v);
      else pending.current?.reject(Object.assign(new Error("closed"), { code: 4001 }));
      return v;
    } catch (e) {
      setError(cancelled(e) ? "Connection was cancelled in the wallet." : e.message);
      pending.current?.reject(e);
      throw e;
    } finally {
      pending.current = null;
    }
  }, []);

  /**
   * Sends one Robinhood Chain transaction ({chainId, to, data, value} from the API) from the EVM wallet and
   * waits until it lands. The wallet is moved to the right chain first (and taught it, if it never saw it).
   */
  const sendEvm = useCallback(async (tx, { onSent } = {}) => {
    const v = await connect("evm");
    const p = v.detail.provider;
    const want = hex(tx.chainId);
    if ((await p.request({ method: "eth_chainId" })) !== want) {
      try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] }); }
      catch (e) {
        if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
        await p.request({ method: "wallet_addEthereumChain", params: [{ chainId: want, ...RHC }] });
      }
    }
    const [from] = await p.request({ method: "eth_accounts" });
    if (!sameAddr(from, v.address)) throw new Error("Your wallet switched accounts. Try again.");
    const hash = await p.request({ method: "eth_sendTransaction", params: [{ from, to: tx.to, data: tx.data, value: hex(tx.value ?? 0) }] });
    onSent?.(hash);
    // up to ten minutes: Robinhood Chain lands a transaction in seconds, but a lagging RPC must never make a
    // launch look failed (a second attempt would mint a second token, and a Pons launch cannot be undone)
    for (let i = 0; i < 310; i++) {
      await new Promise((r) => setTimeout(r, i < 10 ? 700 : 2000));
      const r = await fetch(`/api/evm/receipt/${hash}`).then((x) => x.json()).catch(() => null);
      if (r?.status === "success") return { hash, token: r.token };
      if (r?.status === "reverted") throw new Error(r.error);
    }
    throw new Error(`The transaction was sent but has not landed yet (${hash}). Check it on Blockscout before trying again: https://robinhoodchain.blockscout.com/tx/${hash}`);
  }, [connect]);

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
    setEvm(null); storeEvm.set(null);
    try { await evm?.detail?.provider?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch {}
    try { await active?.features["standard:disconnect"]?.disconnect(); } catch {}
  }, [active, evm]);

  const closePicker = useCallback(() => {
    setPicker(false);
    pending.current?.reject(Object.assign(new Error("closed"), { code: 4001 }));
    pending.current = null;
  }, []);

  const value = useMemo(() => ({ providers, address, picker, mode, error, setError, connect, connectWith, disconnect, closePicker, signTransaction, signTransactions, signMessage, evmProviders: evmList, evmAddress, connectEvmWith, sendEvm }),
    [providers, address, picker, mode, error, connect, connectWith, disconnect, closePicker, signTransaction, signTransactions, signMessage, evmList, evmAddress, connectEvmWith, sendEvm]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function WalletPicker() {
  const { providers, picker, mode, connectWith, closePicker, error, evmProviders, connectEvmWith } = useWallet();
  // no Cancel button: a tap outside the box or Escape closes it
  useEffect(() => {
    if (!picker) return;
    const onKey = (e) => { if (e.key === "Escape") closePicker(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picker, closePicker]);
  if (!picker) return null;
  const sol = mode !== "evm", ev = mode !== "sol";
  return (
    <div className="modal" onClick={closePicker}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Connect wallet</h3>
        {sol && (
          <>
            {ev && <div className="wallets-head">Solana · Pumpfun launches</div>}
            {providers.length === 0 && <p className="muted">No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then reload.</p>}
            <div className="wallets">
              {providers.map((w) => (
                <button key={w.name} className="wallet-btn" onClick={() => { connectWith(w).catch(() => {}); }}>
                  {w.icon && <img src={w.icon} alt="" />} {w.name}
                </button>
              ))}
            </div>
          </>
        )}
        {ev && (
          <>
            {sol && <div className="wallets-head">Robinhood Chain · Pons launches</div>}
            {evmProviders.length === 0 && <p className="muted">No EVM wallet found in this browser. Install MetaMask or Rabby, then reload.</p>}
            <div className="wallets">
              {evmProviders.map((d) => (
                <button key={d.info.uuid} className="wallet-btn" onClick={() => { connectEvmWith(d).catch(() => {}); }}>
                  {d.info.icon && <img src={d.info.icon} alt="" />} {d.info.name}
                </button>
              ))}
            </div>
          </>
        )}
        {error && <p className="err">{error}</p>}
      </div>
    </div>
  );
}
