import { useState } from "react";

export default function Copy({ text, label = "Copy" }) {
  const [done, setDone] = useState(false);
  async function go(e) {
    e.preventDefault();
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); } catch {}
  }
  return <button type="button" className="copy" onClick={(e) => { go(e); }}>{done ? "Copied" : label}</button>;
}
