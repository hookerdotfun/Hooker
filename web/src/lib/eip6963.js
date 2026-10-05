/**
 * EIP-6963: EVM wallets announce themselves (name, icon, rdns), so the picker can list each one.
 * ⛔ Never `window.ethereum` first: with two extensions installed it is whichever loaded last, and it picks
 * a wallet FOR the user. The global is only a fallback when nothing announced.
 * (A port of the picker every Pons site here shares: ~/fees/web/src/lib/eip6963.ts.)
 */
const detected = new Map();
const listeners = new Set();
let started = false;
const emit = () => { const list = [...detected.values()]; listeners.forEach((fn) => fn(list)); };

export function startDiscovery() {
  if (started || typeof window === "undefined") return;
  started = true;
  // listen BEFORE asking, or wallets that answer synchronously are missed
  window.addEventListener("eip6963:announceProvider", (event) => {
    const d = event.detail;
    if (!d?.info?.uuid) return;
    detected.set(d.info.uuid, d);
    emit();
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  setTimeout(() => window.dispatchEvent(new Event("eip6963:requestProvider")), 300);
  setTimeout(() => window.dispatchEvent(new Event("eip6963:requestProvider")), 1200);
}

export function subscribe(fn) {
  listeners.add(fn);
  fn([...detected.values()]);
  return () => listeners.delete(fn);
}

/** A wallet that only injects the old global, used only when nothing announced. */
export function legacyProvider() {
  const eth = typeof window !== "undefined" ? window.ethereum : null;
  return eth ? { info: { uuid: "legacy-injected", name: "Browser wallet", icon: "", rdns: "legacy.injected" }, provider: eth } : null;
}
