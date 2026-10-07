import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "./api.js";

/**
 * The site's mode: Pumpfun (Solana launches that graduate into Pumpfun) or Pons (Robinhood Chain launches that
 * graduate into Pons). Every page shows only its mode's tokens, wallet, hooks, copy and links.
 * Set by the header switch, remembered per visitor, and moved by links: `?on=pons|pumpfun`, or a token page whose
 * token lives on the other chain.
 */
const KEY = "hooker.mode";
const MODES = ["pumpfun", "pons"];
const ModeCtx = createContext(null);

const fromSearch = (search) => { const v = new URLSearchParams(search).get("on"); return MODES.includes(v) ? v : null; };
const stored = () => { try { const v = localStorage.getItem(KEY); return MODES.includes(v) ? v : null; } catch { return null; } };

export function ModeProvider({ children }) {
  const { search } = useLocation();
  const [mode, setRaw] = useState(() => fromSearch(window.location.search) ?? stored() ?? "pumpfun");
  const setMode = useCallback((m) => {
    if (!MODES.includes(m)) return;
    setRaw(m);
    try { localStorage.setItem(KEY, m); } catch {}
  }, []);
  // a link that names a mode (?on=pons) moves the switch
  useEffect(() => { const m = fromSearch(search); if (m) setMode(m); }, [search, setMode]);
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
    // the tab's icon follows the mode too: the glass hook on Pons, the green one on Pumpfun
    const pons = mode === "pons";
    for (const [size, sol, rhc] of [["32x32", "/favicon-v4-32.png", "/favicon-pons-32.png"], ["64x64", "/favicon-v4-64.png", "/favicon-pons-64.png"]]) {
      const link = document.querySelector(`link[rel="icon"][sizes="${size}"]`);
      if (link) link.href = pons ? rhc : sol;
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", pons ? "#0b0b0b" : "#0b0b0e");
  }, [mode]);
  // whether the Pons launchpad takes the newer hooks (a v6+ launchpad); read once
  const [ponsV3, setPonsV3] = useState(false);
  useEffect(() => { api.evmInfo().then((i) => setPonsV3(!!i?.v3)).catch(() => {}); }, []);
  const value = useMemo(() => {
    const pons = mode === "pons";
    return {
      mode, setMode, pons, ponsV3,
      /** the chain the mode lives on: "sol" or "rhc" (what /api rows carry in `chain`) */
      chain: pons ? "rhc" : "sol",
      /** the wallet kind connect() takes */
      walletKind: pons ? "evm" : "sol",
      venue: pons ? "Pons" : "Pumpfun",
      /** the mark for this mode: the glass hook on Pons, the green hook on Pumpfun */
      logo: pons ? "/logo-pons-256.png" : "/logo-v2-256.png",
      logoFull: pons ? "/logo-pons-full.png" : "/logo-full.png",
      unit: pons ? "ETH" : "SOL",
      chainName: pons ? "Robinhood Chain" : "Solana",
    };
  }, [mode, setMode, ponsV3]);
  return <ModeCtx.Provider value={value}>{children}</ModeCtx.Provider>;
}

export const useMode = () => useContext(ModeCtx);

/** Does an /api row (a launch or a trade) belong to this mode? Rows without `chain` are Solana's. */
export const inMode = (row, chain) => (row?.chain === "rhc" ? "rhc" : "sol") === chain;
