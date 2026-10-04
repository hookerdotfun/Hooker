import { useEffect, useState } from "react";

/**
 * A token's logo. If it does not load (gone from IPFS, a broken file), `blank` is shown instead: never the
 * browser's broken-image icon. A failed load is retried three times, 12 s apart (a just-launched token's image can take a few
 * seconds to reach the gateways); `fallback` (e.g. the image the creator just picked) is shown meanwhile.
 */
export default function Logo({ src, className, blank = null, lazy = true, fallback = null }) {
  const [state, setState] = useState({ src, tries: 0, bad: false });
  useEffect(() => { setState({ src, tries: 0, bad: false }); }, [src]);
  useEffect(() => {
    if (!state.bad || state.tries >= 3) return;
    const t = setTimeout(() => setState((s) => ({ ...s, bad: false, tries: s.tries + 1 })), 12_000);
    return () => clearTimeout(t);
  }, [state.bad, state.tries]);
  if (!src || state.bad) return fallback ? <img src={fallback} alt="" className={className} /> : blank;
  const url = state.tries ? `${src}${src.includes("?") ? "&" : "?"}r=${state.tries}` : src;
  return <img src={url} alt="" className={className} loading={lazy ? "lazy" : undefined} onError={() => setState((s) => ({ ...s, bad: true }))} />;
}
