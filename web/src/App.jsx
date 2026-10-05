import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation, Navigate } from "react-router-dom";
import { useWallet, WalletPicker } from "./lib/wallet.jsx";
import { short } from "./lib/format.js";
import Home from "./pages/Home.jsx";
import Launch from "./pages/Launch.jsx";
import Token from "./pages/Token.jsx";
import Me from "./pages/Me.jsx";
import How from "./pages/How.jsx";
import Explore from "./pages/Explore.jsx";

const X_URL = "https://x.com/hookerdotfun";
// the public repo (code only: no keys, data or ops; deploy/publish-repo.sh keeps it in sync)
const GITHUB_URL = "https://github.com/hookerdotfun/Hooker";
function GitHubIcon({ size = 15 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" /></svg>;
}
function XIcon({ size = 15 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>;
}

/** The mark. The header shows it alone; the footer keeps the name next to it. */
function Brand({ label = false }) {
  return <Link to="/" className="brand"><img src="/logo-v2-256.png" alt="Hooker" width="38" height="38" />{label && <span>Hooker</span>}</Link>;
}

function Nav({ className }) {
  const { address } = useWallet();
  return (
    <nav className={`navpills ${className ?? ""}`}>
      <NavLink to="/launch">Launch</NavLink>
      <NavLink to="/explore">Explore</NavLink>
      <NavLink to="/docs">Docs</NavLink>
      {address && <NavLink to="/me">My tokens</NavLink>}
    </nav>
  );
}

/** The connected wallet, top right: a pill that opens a small menu (address with copy, My tokens, Sign out). */
function WalletMenu({ address, evmAddress, disconnect, connect }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away); window.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); window.removeEventListener("keydown", esc); };
  }, [open]);
  const copy = async (a) => { try { await navigator.clipboard.writeText(a); setCopied(a); setTimeout(() => setCopied(false), 1200); } catch {} };
  const main = address ?? evmAddress;
  return (
    <div className="wmenu" ref={ref}>
      <button type="button" className={`wallet-pill ${open ? "open" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="dot on" />{short(main)}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="chev"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="wmenu-pop" role="menu">
          {address && <button type="button" className="wmenu-addr" onClick={() => copy(address)}><span className="wmenu-chain">Solana</span><span className="mono">{short(address)}</span><span className="wmenu-copy">{copied === address ? "Copied" : "Copy"}</span></button>}
          {evmAddress && <button type="button" className="wmenu-addr" onClick={() => copy(evmAddress)}><span className="wmenu-chain">Robinhood</span><span className="mono">{short(evmAddress)}</span><span className="wmenu-copy">{copied === evmAddress ? "Copied" : "Copy"}</span></button>}
          {!address && <button type="button" className="wmenu-item" onClick={() => { setOpen(false); connect("sol").catch(() => {}); }}>Add a Solana wallet</button>}
          {!evmAddress && <button type="button" className="wmenu-item" onClick={() => { setOpen(false); connect("evm").catch(() => {}); }}>Add an EVM wallet</button>}
          <Link to="/me" className="wmenu-item" onClick={() => setOpen(false)}>My tokens</Link>
          <button type="button" className="wmenu-item out" onClick={() => { setOpen(false); disconnect(); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { address, evmAddress, connect, disconnect } = useWallet();
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return (
    <>
      <div className="backdrop" />
      <div className="top-wrap">
        <header className="top">
          <Brand />
          <Nav />
          <div className="top-right">
            <a className="xbtn" href={X_URL} target="_blank" rel="noreferrer" aria-label="Hooker on X"><XIcon /></a>
            {address || evmAddress
              ? <WalletMenu address={address} evmAddress={evmAddress} disconnect={disconnect} connect={connect} />
              : <button className="btn small" onClick={() => { connect("any").catch(() => {}); }}>Connect</button>}
          </div>
        </header>
        <Nav className="mobile-nav" />
      </div>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/launch" element={<Launch />} />
          <Route path="/t/:mint" element={<Token />} />
          <Route path="/me" element={<Me />} />
          <Route path="/docs" element={<How />} />
          {/* the old address (until 4 Oct 2026) keeps working */}
          <Route path="/how" element={<Navigate to="/docs" replace />} />
          <Route path="/explore" element={<Explore />} />
          <Route path="*" element={<div className="empty" style={{ marginTop: 60 }}>Nothing here.<div><Link to="/" className="btn ghost small">Back to launches</Link></div></div>} />
        </Routes>
      </main>
      <footer className="pfoot-wrap">
        <div className="pfoot">
          <div className="pfoot-brand">
            <Brand label />
            <p>Rules are built into the token itself, through Solana Token-2022 transfer hooks and on Robinhood Chain. Every launch graduates into a normal Pumpfun or Pons token.</p>
          </div>
          <div className="pfoot-col">
            <h4>Site</h4>
            <Link to="/launch">Launch</Link>
            <Link to="/explore">Explore</Link>
            <Link to="/docs">Docs</Link>
            {address && <Link to="/me">My tokens</Link>}
          </div>
          <div className="pfoot-col">
            <h4>On chain</h4>
            <a href="https://solscan.io/account/GE5TW1AFehhNFLYiSiaAkmbTjnHTB3hdhw6ZZFBP5sLV" target="_blank" rel="noreferrer">Program</a>
            <a href="https://pump.fun" target="_blank" rel="noreferrer">Pumpfun</a>
            <a href="https://www.meteora.ag" target="_blank" rel="noreferrer">Meteora</a>
            <a href="https://www.ponsfamily.com" target="_blank" rel="noreferrer">Pons</a>
          </div>
          <div className="pfoot-col">
            <h4>Elsewhere</h4>
            <a href={X_URL} target="_blank" rel="noreferrer" className="xlink"><XIcon size={14} /> hookerdotfun</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="xlink"><GitHubIcon size={14} /> hookerdotfun</a>
          </div>
        </div>
      </footer>
      <WalletPicker />
    </>
  );
}
