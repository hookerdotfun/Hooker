import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { useWallet, cancelled } from "../lib/wallet.jsx";
import { describeRules, sol, usd, pct, tzText } from "../lib/format.js";
import { parseWallets, fillList } from "../lib/lists.js";
import { rulesFor } from "../lib/catalog.js";
import PairPicker from "../components/PairPicker.jsx";

const bpsInput = (v) => Math.round(Number(v) * 100);
/** 0.994 → "0.99%", 1.75 → "1.75%", 3 → "3%" */
const pct2 = (p) => `${Number(p.toFixed(2))}%`;

function Field({ label, value, hint, children }) {
  return (
    <label className="field">
      <span className="label">{label}{value != null && <b>{value}</b>}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

function Sec({ n, title, children, id }) {
  return (
    <section className="panel lsec" id={id}>
      <div className="lsec-title"><span className="num">{n}</span><h2>{title}</h2></div>
      {children}
    </section>
  );
}

// the launch, step by step, as the checklist on the right shows it
const STEPS = [
  ["Upload to IPFS", "Image and token details, stored permanently."],
  ["Prove it is your wallet", "Sign a message. No transaction, no fee."],
  ["Approve the launch", "One transaction: your token, its rules, its curve and your buy."],
  ["Listed on Hooker", "Its address ends in hook, like every token here."],
];
const LIST_STEP = ["Fill the list", "One approval per 300 wallets, right after the launch."];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const toMin = (hm) => { const [h, m] = String(hm).split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const MY_TZ = -new Date().getTimezoneOffset();
const TZS = Array.from({ length: (840 + 720) / 30 + 1 }, (_, i) => -720 + i * 30);

export default function Launch() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { address, connect, signTransaction, signTransactions, signMessage } = useWallet();
  const [info, setInfo] = useState(null);
  const [f, setF] = useState({ name: "", symbol: "", description: "", twitter: "", website: "", gradSol: null, devBuy: "0.5", feeTier: 0, pair: null, pumpFee: "" });
  const [r, setR] = useState(null);
  const [image, setImage] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [step, setStep] = useState(null);
  const [phase, setPhase] = useState(-1); // index into STEPS while launching
  const [err, setErr] = useState(null);
  const picked = useRef(params.get("rule"));

  useEffect(() => {
    api.info().then((i) => {
      setInfo(i);
      setF((f) => ({ ...f, gradSol: i.sizes[1]?.sol ?? i.sizes[0]?.sol ?? null }));
      const d = i.defaults;
      const base = { ...d, maxWallet: d.maxWalletBps / 100, earlyMins: d.earlySecs / 60, earlyCap: d.earlyMaxWalletBps / 100,
        feeOn: d.feeCapBps > 0, feeBase: d.feeBaseBps / 100 || 0.5, feePerSol: d.feePerSolBps / 100 || 0.5, feeCap: d.feeCapBps / 100 || 5,
        burnOn: d.burnBps > 0, burn: d.burnBps / 100 || 2, share: d.holderShareBps / 100,
        allowlist: false, blocklist: false, listText: "", seal: true, tradeGuard: 0, rampStart: 0.5, rampMins: 0,
        antiSnipe: false, venueLock: false, hoursOn: false, hoursDays: 62, hoursOpen: "09:30", hoursClose: "16:00", tz: MY_TZ, snipeMins: 0, snipeCu: 100_000, snipeTip: 0.0001, bundleMax: 0 };
      setR(withRule(base, picked.current, i, true));
    }).catch((e) => setErr(e.message));
  }, []);

  // arriving from the rule picker: scroll to the rules and flash the one that was picked
  useEffect(() => {
    const want = picked.current;
    if (!r || !want) return;
    picked.current = null;
    const el = document.getElementById(`rule-${want}`);
    if (el) { el.classList.add("flash"); setTimeout(() => { el.scrollIntoView({ behavior: "smooth", block: "center" }); }, 250); }
  }, [r]);

  // ⛔ 4 Oct 2026: the preview was a blob: URL, which the site's CSP (img-src 'self' https: data:) blocks, so every
  // upload showed a broken image. A data: URL is allowed and needs no CSP change.
  useEffect(() => {
    if (!image) { setImageUrl(null); return; }
    let live = true;
    const r = new FileReader();
    r.onload = () => { if (live) setImageUrl(String(r.result)); };
    r.onerror = () => { if (live) setImageUrl(null); };
    r.readAsDataURL(image);
    return () => { live = false; };
  }, [image]);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setRule = (k, v) => setR((cur) => ({ ...cur, [k]: v }));
  const size = info?.sizes.find((s) => s.sol === Number(f.gradSol));
  const tierNow = info?.feeTiers?.find((t) => t.tier === Number(f.feeTier)) ?? info?.feeTiers?.[0] ?? null;
  // a size whose fee step is not made yet falls back to the default step
  useEffect(() => { if (size && !(size.feeTiers ?? [0]).includes(Number(f.feeTier))) setF((x) => ({ ...x, feeTier: 0 })); }, [size, f.feeTier]);
  const money = (capSol) => (info?.solUsd ? usd(capSol * info.solUsd) : sol(capSol, 0));

  const rules = useMemo(() => r && ({
    fomoOnly: r.fomoOnly, appOnly: false, venueLock: false, holderRewards: r.holderRewards,
    maxWalletBps: r.maxWallet > 0 ? bpsInput(r.maxWallet) : 0,
    earlySecs: r.earlyMins > 0 ? Math.round(r.earlyMins * 60) : 0,
    earlyMaxWalletBps: r.earlyMins > 0 ? bpsInput(r.earlyCap) : 0,
    feeBaseBps: r.feeOn ? bpsInput(r.feeBase) : 0, feePerSolBps: r.feeOn ? bpsInput(r.feePerSol) : 0, feeCapBps: r.feeOn ? bpsInput(r.feeCap) : 0,
    burnBps: r.burnOn ? bpsInput(r.burn) : 0, holderShareBps: bpsInput(r.share),
    allowlist: r.allowlist, blocklist: r.blocklist,
    tradeGuardBps: r.tradeGuard > 0 ? bpsInput(r.tradeGuard) : 0,
    rampSecs: r.rampMins > 0 && r.maxWallet > 0 ? Math.round(r.rampMins * 60) : 0,
    rampStartBps: r.rampMins > 0 && r.maxWallet > 0 ? bpsInput(r.rampStart) : 0,
    hoursOn: r.hoursOn, hoursDays: r.hoursOn ? r.hoursDays : 0, hoursOpenMin: r.hoursOn ? toMin(r.hoursOpen) : 0,
    hoursCloseMin: r.hoursOn ? toMin(r.hoursClose) : 0, tzOffsetMin: r.hoursOn ? Number(r.tz) : 0,
    bundleMax: r.bundleMax > 0 ? Math.round(r.bundleMax) : 0,
    snipeSecs: r.snipeMins > 0 ? Math.round(r.snipeMins * 60) : 0,
    snipeMaxCuPrice: r.snipeMins > 0 ? Math.round(Number(r.snipeCu)) : 0,
    snipeMaxTip: r.snipeMins > 0 ? Math.round(Number(r.snipeTip) * 1e9) : 0,
  }), [r]);
  const listed = useMemo(() => (r && (r.allowlist || r.blocklist) ? parseWallets(r.listText) : null), [r]);

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    try {
      if (!image) throw new Error("Add an image.");
      if (!f.name.trim() || !f.symbol.trim()) throw new Error("Name and ticker are required.");
      const pumpFee = f.pair && String(f.pumpFee).trim() !== "" ? Math.round(Number(f.pumpFee) * 100) : 0;
      if (f.pair && String(f.pumpFee).trim() !== "" && !(pumpFee >= 1 && pumpFee <= 300)) throw new Error("The Pumpfun creator fee must be between 0.01% and 3%.");
      const { acct } = await connect();
      setPhase(0); setStep("Uploading the image and metadata to IPFS…");
      const form = new FormData();
      form.append("file", image);
      for (const k of ["name", "symbol", "description", "twitter", "website"]) if (f[k].trim()) form.append(k, f[k].trim());
      const { uri } = await api.upload(form);
      setPhase(1); setStep("Sign the message in your wallet to prove it is yours…");
      const { nonce, message } = await api.launchNonce(acct.address);
      const signature = await signMessage(message, acct.address);
      setPhase(2); setStep("Preparing the launch…");
      const built = await api.launchTx({ creator: acct.address, gradSol: Number(f.gradSol), name: f.name.trim(), symbol: f.symbol.trim(), uri, rules, antiSnipe: !!r.antiSnipe, feeTier: Number(f.feeTier) || 0, pair: f.pair?.mint ?? null, pumpCreatorFeeBps: f.pair ? pumpFee : null, devBuySol: Number(f.devBuy || 0), nonce, signature });
      setStep("Approve the launch in your wallet…");
      const signed = await signTransaction(built.tx, acct.address);
      setStep("Launching…");
      await api.send(signed);
      setPhase(3);
      await api.register(built.mint).catch(() => {}); // the graduation service also finds it on its own
      if (listed && (listed.wallets.length || r.seal)) {
        setPhase(4); setStep("Building the list…");
        try {
          await fillList({ mint: built.mint, creator: acct.address, wallets: listed.wallets, seal: r.seal, signTransactions, onProgress: setStep });
        } catch (e3) {
          // the token is live; the creator can finish the list from its page (it stays open for a day)
          nav(`/t/${built.mint}?launched=1&list=unfinished`, { state: { image: imageUrl } });
          return;
        }
      }
      // the token page greets the creator ("Your token is live"); the image just picked is shown until IPFS serves it
      nav(`/t/${built.mint}?launched=1`, { state: { image: imageUrl } });
    } catch (e2) {
      setErr(cancelled(e2) ? "Cancelled in the wallet." : e2.message);
      setPhase(-1);
    } finally {
      setStep(null);
    }
  }

  if (!info || !r) return <div className="empty" style={{ marginTop: 60 }}>{err ?? "Loading…"}</div>;
  if (!info.sizes.length) return <div className="empty" style={{ marginTop: 60 }}>Launching is paused right now. Trading and graduations carry on as normal.</div>;
  const preview = describeRules({ ...rules, dev: address }, { gradSol: f.gradSol, antiSnipe: !!r?.antiSnipe, fees: tierNow, pair: f.pair ? { symbol: f.pair.symbol, creatorFeeBps: Math.round(Number(f.pumpFee || 0) * 100), toHolders: !!r?.holderRewards } : null });
  const catalog = rulesFor(info);
  const on = isOn(r);
  const chosen = catalog.filter((x) => on[x.id]);
  const groups = [...new Set(catalog.map((x) => x.group))];
  const sym = f.symbol.trim() || "TICKER";
  const steps = listed ? [...STEPS.slice(0, 3), LIST_STEP, STEPS[3]] : STEPS;
  // phase 4 is the list, shown before "Listed on Hooker"
  const stepState = (i) => {
    if (!listed) return phase > i ? "done" : phase === i ? "now" : "";
    const at = phase === 4 ? 3 : phase === 3 ? 4 : phase;
    return at > i ? "done" : at === i ? "now" : "";
  };

  return (
    <form className="launch" onSubmit={submit}>
      <div className="page-head center">
        <div className="eyebrow">Launch a token</div>
        <h1 className="launch-h"><span className="grad">Hook</span> it</h1>
        <p className="lede">Launch a token with rules built into the token itself.</p>
      </div>

      {/* locked while launching: nothing changes under the wallet's approval */}
      <fieldset className="launch-lock" disabled={!!step}>
      <div className="launch-grid">
        <div className="lcol">
          <Sec n="1" title="Your token">
            <div className="two">
              <Field label="Name"><input value={f.name} onChange={set("name")} maxLength={32} placeholder="Hooked Cat" /></Field>
              <Field label="Ticker"><input className="mono-in" value={f.symbol} onChange={set("symbol")} maxLength={10} placeholder="HOOK" /></Field>
            </div>
            <div className="field">
              <span className="label">Image</span>
              <label className="drop">
                <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => setImage(e.target.files?.[0] ?? null)} />
                {imageUrl ? <img src={imageUrl} alt="" className="thumb" /> : <div className="thumb add">+</div>}
                <div>
                  <b>{image ? image.name : "Choose an image"}</b>
                  <span className="hint">PNG, JPEG, GIF or WebP, up to 4 MB. Stored on IPFS, permanent.</span>
                </div>
              </label>
            </div>
            <Field label="Description"><textarea value={f.description} onChange={set("description")} maxLength={500} rows={3} placeholder="What is it?" /></Field>
            {/* the same shape as Name / Ticker: a label above each, two equal columns */}
            <div className="two">
              <Field label="X"><input value={f.twitter} onChange={set("twitter")} placeholder="https://x.com/…" /></Field>
              <Field label="Website"><input value={f.website} onChange={set("website")} placeholder="https://…" /></Field>
            </div>
            <p className="hint" style={{ margin: "2px 0 0" }}>Name, ticker and image carry over to the Pumpfun coin at graduation and can never be changed.</p>
          </Sec>

          <Sec n="2" title="Hooks" id="rules">
            <p className="sec-lede">Hooks are fixed at launch. Launch with any combination of hooks.</p>
            {groups.map((g) => (
              <div key={g} className="rgroup">
                <div className="rgroup-k">{g}</div>
                <div className="rcards">
                  {catalog.filter((x) => x.group === g).map((x) => (
                    <button type="button" key={x.id} id={`rule-${x.id}`} className={`rcard ${on[x.id] ? "on" : ""}`} style={{ "--rc": x.color }}
                      onClick={() => setR((cur) => withRule(cur, x.id, info, !isOn(cur)[x.id]))} aria-pressed={on[x.id]}>
                      <span className="rcard-top"><span className="rdot" style={{ background: x.color, color: x.color }} /><b>{x.t}</b><span className="tick" /></span>
                      <span className="rcard-d">{x.s}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </Sec>

          <Sec n="3" title="Hook settings">
            {chosen.length === 0 && <p className="sec-lede" style={{ margin: 0 }}>Pick a rule above and its settings show up here.</p>}
            {on.maxWallet && (
              <div className="setting">
                <Field label="Max per wallet" value={pct(bpsInput(r.maxWallet))}>
                  <input type="range" min="0.5" max="20" step="0.5" value={r.maxWallet} onChange={(e) => setRule("maxWallet", Number(e.target.value))} />
                </Field>
              </div>
            )}
            {on.window && (
              <div className="setting">
                <div className="two">
                  <Field label="Launch window" value={`${r.earlyMins} min`}><input type="number" min="1" max="1440" value={r.earlyMins} onChange={(e) => setRule("earlyMins", Number(e.target.value))} /></Field>
                  <Field label="Cap in the window (%)"><input type="number" min="0.1" max="100" step="0.1" value={r.earlyCap} onChange={(e) => setRule("earlyCap", Number(e.target.value))} /></Field>
                </div>
              </div>
            )}
            {on.fee && (
              <div className="setting">
                <span className="label" style={{ marginBottom: 8 }}>Size fee</span>
                <div className="three">
                  <Field label="Base %"><input type="number" min="0" step="0.1" value={r.feeBase} onChange={(e) => setRule("feeBase", Number(e.target.value))} /></Field>
                  <Field label="+% per SOL"><input type="number" min="0" step="0.1" value={r.feePerSol} onChange={(e) => setRule("feePerSol", Number(e.target.value))} /></Field>
                  <Field label="Cap %"><input type="number" min="0" max="20" step="0.5" value={r.feeCap} onChange={(e) => setRule("feeCap", Number(e.target.value))} /></Field>
                </div>
              </div>
            )}
            {on.burn && (
              <div className="setting">
                <Field label="Auto burn" value={pct(bpsInput(r.burn))}><input type="range" min="0.1" max="20" step="0.1" value={r.burn} onChange={(e) => setRule("burn", Number(e.target.value))} /></Field>
              </div>
            )}
            {on.share && (
              <div className="setting">
                <Field label="Holder share of the platform's trading fees" value={pct(bpsInput(r.share))}>
                  <input type="range" min="5" max="100" step="5" value={r.share} onChange={(e) => setRule("share", Number(e.target.value))} />
                </Field>
              </div>
            )}
            {(on.allowlist || on.blocklist) && (
              <div className="setting">
                <Field label={on.allowlist ? "Wallets allowed to buy and hold it" : "Wallets that can never buy or hold it"}
                  value={listed ? `${listed.wallets.length} wallet${listed.wallets.length === 1 ? "" : "s"}` : null}
                  hint="Paste addresses, one per line or separated by commas. You sign one approval per 300 wallets right after the launch. For a day you can still add more from the token page, unless you seal it.">
                  <textarea rows={5} className="mono-area" value={r.listText} onChange={(e) => setRule("listText", e.target.value)} placeholder={"7xKp…q2Lm\nFz9d…Wa1c"} />
                </Field>
                {listed?.invalid.length > 0 && <p className="err" style={{ margin: "6px 0 0", fontSize: 13 }}>Not wallet addresses: {listed.invalid.slice(0, 3).join(", ")}{listed.invalid.length > 3 ? ` and ${listed.invalid.length - 3} more` : ""}</p>}
                <label className="check"><input type="checkbox" checked={r.seal} onChange={(e) => setRule("seal", e.target.checked)} /> Seal the list right after launch, so nobody can change it</label>
              </div>
            )}
            {on.ramp && (
              <div className="setting">
                <div className="two">
                  <Field label="Starts at (% of supply)" hint={`Rises to your max per wallet, ${r.maxWallet > 0 ? pct(bpsInput(r.maxWallet)) : "which must be on"}.`}><input type="number" min="0.1" step="0.1" value={r.rampStart} onChange={(e) => setRule("rampStart", Number(e.target.value))} /></Field>
                  <Field label="Rises over (minutes)" value={r.rampMins >= 60 ? `${(r.rampMins / 60).toFixed(r.rampMins % 60 ? 1 : 0)} h` : null}><input type="number" min="1" max="10080" value={r.rampMins} onChange={(e) => setRule("rampMins", Number(e.target.value))} /></Field>
                </div>
              </div>
            )}
            {on.tradeGuard && (
              <div className="setting">
                <Field label="Trade guard: most one trade can move" value={pct(bpsInput(r.tradeGuard))}>
                  <input type="range" min="0.1" max="5" step="0.1" value={r.tradeGuard} onChange={(e) => setRule("tradeGuard", Number(e.target.value))} />
                </Field>
              </div>
            )}
            {on.snipe && (
              <div className="setting">
                <div className="three">
                  <Field label="For the first (minutes)"><input type="number" min="1" max="1440" value={r.snipeMins} onChange={(e) => setRule("snipeMins", Number(e.target.value))} /></Field>
                  <Field label="Max priority fee (µL/CU)"><input type="number" min="0" step="1000" value={r.snipeCu} onChange={(e) => setRule("snipeCu", e.target.value)} /></Field>
                  <Field label="Max Jito tip (SOL)"><input type="number" min="0" step="0.0001" value={r.snipeTip} onChange={(e) => setRule("snipeTip", e.target.value)} /></Field>
                </div>
              </div>
            )}
            {on.bundle && (
              <div className="setting">
                <Field label="Anti-bundle: buys per block" value={r.bundleMax}>
                  <input type="range" min="1" max="10" step="1" value={r.bundleMax} onChange={(e) => setRule("bundleMax", Number(e.target.value))} />
                </Field>
              </div>
            )}
            {on.hours && (
              <div className="setting">
                <span className="label" style={{ marginBottom: 8 }}>Trading hours</span>
                <div className="days">
                  {DAY_NAMES.map((d, i) => (
                    <button type="button" key={d} className={r.hoursDays & (1 << i) ? "on" : ""} onClick={() => setRule("hoursDays", r.hoursDays ^ (1 << i))}>{d}</button>
                  ))}
                </div>
                <div className="three" style={{ marginTop: 12 }}>
                  <Field label="Opens"><input type="time" value={r.hoursOpen} onChange={(e) => setRule("hoursOpen", e.target.value)} /></Field>
                  <Field label="Closes"><input type="time" value={r.hoursClose} onChange={(e) => setRule("hoursClose", e.target.value)} /></Field>
                  <Field label="Time zone">
                    <select value={r.tz} onChange={(e) => setRule("tz", Number(e.target.value))}>
                      {TZS.map((z) => <option key={z} value={z}>{tzText(z)}{z === MY_TZ ? " (yours)" : ""}</option>)}
                    </select>
                  </Field>
                </div>
                <p className="hint" style={{ margin: 0 }}>A fixed offset: it does not follow daylight saving. Closing before opening runs overnight.</p>
              </div>
            )}
            {chosen.length > 0 && !on.maxWallet && !on.window && !on.fee && !on.burn && !on.share && !on.allowlist && !on.blocklist && !on.ramp && !on.tradeGuard && !on.snipe && !on.bundle && !on.hours && (
              <p className="sec-lede" style={{ margin: 0 }}>The rules you picked have nothing to set.</p>
            )}
          </Sec>

          <Sec n="4" title="Curve">
            <div className="sizes">
              {info.sizes.map((s) => (
                <button type="button" key={s.sol} className={`size ${Number(f.gradSol) === s.sol ? "on" : ""}`} onClick={() => setF({ ...f, gradSol: s.sol })}>
                  <b>{s.sol} SOL</b><span>{`graduates at ${money(s.endCapSol)}`}</span>
                </button>
              ))}
            </div>
            <div className="caps">
              <div><span className="k">Starting market cap</span><b>{money(info.pumpfun.startCapSol)}</b><span className="hint">same as every Pumpfun coin</span></div>
              <div><span className="k">Graduation market cap</span><b>{size ? money(size.endCapSol) : "…"}</b><span className="hint">at most {money(info.pumpfun.graduationCapSol)}, where Pumpfun's curve fills</span></div>
            </div>
            {/* the creator's fee per trade: each step is its own set of Meteora configs (lib/curve.mjs FEE_TIERS) */}
            <span className="label" style={{ display: "block", margin: "6px 0 8px" }}>Your fee per trade</span>
            <div className="sizes">
              {(info.feeTiers ?? []).filter((t) => !size || (size.feeTiers ?? [0]).includes(t.tier)).map((t) => (
                <button type="button" key={t.tier} className={`size ${Number(f.feeTier) === t.tier ? "on" : ""}`} onClick={() => setF({ ...f, feeTier: t.tier })}>
                  <b>{t.tier === 0 ? `${pct2(t.creatorPct)}` : t.label}</b><span>{t.tier === 0 ? "default · " : ""}buyers pay {pct2(t.totalPct)}</span>
                </button>
              ))}
            </div>
            {/* the Pumpfun coin's pair (pump.fun's custom pairs, ≥ $1M liquidity) and the creator fee it allows */}
            <span className="label" style={{ display: "block", margin: "6px 0 8px" }}>Pair on Pumpfun</span>
            <PairPicker value={f.pair} onChange={(p) => setF((x) => ({ ...x, pair: p, pumpFee: p ? x.pumpFee : "" }))} />
            <p className="hint" style={{ margin: "8px 0 14px" }}>{f.pair ? `At graduation the curve's SOL is swapped into ${f.pair.symbol} and the Pumpfun coin trades against it.` : "The Pumpfun coin trades against SOL, like most Pumpfun coins."}</p>
            {f.pair && (
              <Field label={<>Pumpfun creator fee (%) <span className="muted" style={{ fontWeight: 400 }}>(Optional)</span></>}
                hint={r?.holderRewards ? "Paid on every Pumpfun trade after graduation. Creator fees to holders is on, so it goes to holders." : "Paid on every Pumpfun trade after graduation, to you."}>
                <input type="number" min="0.01" max="3" step="0.01" placeholder="0.01-3" value={f.pumpFee} onChange={set("pumpFee")} />
              </Field>
            )}
            <Field label="Your buy at launch" hint={r?.antiSnipe ? "At least 0.01 SOL. It is the only trade that skips the anti-snipe fee, so it has to be yours, inside the launch itself." : "At least 0.01 SOL. It is made inside the launch itself so nobody can buy before you."}>
              <div className="amount"><input type="number" min="0.01" step="0.1" value={f.devBuy} onChange={set("devBuy")} /><span>SOL</span></div>
              <div className="quick">{["0.1", "0.5", "1", "2"].map((v) => <button type="button" key={v} className={f.devBuy === v ? "on" : ""} onClick={() => setF({ ...f, devBuy: v })}>{v} SOL</button>)}</div>
            </Field>
          </Sec>

          <Sec n="5" title="What buyers will see">
            <ul className="rules">{preview.map((x) => <li key={x.t}><div><b>{x.t}</b>{x.d}</div></li>)}</ul>
          </Sec>
        </div>

        <aside className="sticky lside">
          <section className="panel ptok">
            <div className="ptok-head">
              {imageUrl ? <img src={imageUrl} alt="" className="ptok-img" /> : <div className="ptok-img orb" />}
              <div style={{ minWidth: 0 }}>
                <div className="ptok-name">{f.name.trim() || "Your token"}</div>
                <div className="ptok-sym">${sym} · 1,000,000,000 supply</div>
              </div>
            </div>
            <div className="ptok-rules">
              {chosen.length === 0 && <div className="prule dim"><span>No rules picked</span></div>}
              {chosen.map((x) => (
                <div className="prule" key={x.id}>
                  <span className="rdot" style={{ background: x.color, color: x.color }} />
                  <span className="prule-t">{x.t}</span>
                  <span className="prule-k">{x.id === "antiSnipe" ? "Trading fee" : x.group === "At graduation" ? "At graduation" : "Every transfer"}</span>
                </div>
              ))}
            </div>
            <div className="ptok-foot"><span>{f.gradSol} SOL curve · Meteora DBC</span><span>then Pumpfun</span></div>
          </section>

          <section className="panel checklist">
            {steps.map(([t, d], i) => (
              <div key={t} className={`cl ${stepState(i)}`}>
                <span className="cl-dot" />
                <div><b>{t}</b><span>{stepState(i) === "now" && step ? step : d}</span></div>
              </div>
            ))}
            {err && <p className="err">{err}</p>}
            <button className="btn green big" disabled={!!step}>{step ? "Launching…" : address ? "Launch" : "Connect and launch"}</button>
          </section>
        </aside>
      </div>
      </fieldset>
    </form>
  );
}

/** Which rules are on, by catalog id. */
function isOn(r) {
  return { antiSnipe: !!r.antiSnipe, maxWallet: r.maxWallet > 0, window: r.earlyMins > 0, fomoOnly: !!r.fomoOnly,
    fee: !!r.feeOn, burn: !!r.burnOn, share: r.share > 0, holderRewards: !!r.holderRewards,
    allowlist: !!r.allowlist, blocklist: !!r.blocklist, ramp: r.rampMins > 0, tradeGuard: r.tradeGuard > 0,
    snipe: r.snipeMins > 0, bundle: r.bundleMax > 0, hours: !!r.hoursOn };
}

/** The rules with one switched on or off; switching on gives it a sensible starting value. */
function withRule(r, id, info, want) {
  if (!id) return r;
  const n = { ...r };
  if (id === "maxWallet") n.maxWallet = want ? (r.maxWallet > 0 ? r.maxWallet : 3) : 0;
  if (id === "window") { n.earlyMins = want ? (r.earlyMins > 0 ? r.earlyMins : 5) : 0; if (want && !(n.earlyCap > 0)) n.earlyCap = 0.5; }
  if (id === "antiSnipe") n.antiSnipe = want;
  if (id === "fomoOnly") n.fomoOnly = want && !!info?.fomoOnly;
  if (id === "fee") n.feeOn = want;
  if (id === "burn") n.burnOn = want;
  if (id === "share") n.share = want ? (r.share > 0 ? r.share : 50) : 0;
  if (id === "holderRewards") n.holderRewards = want;
  if (id === "allowlist") { n.allowlist = want; if (want) n.blocklist = false; }
  if (id === "blocklist") { n.blocklist = want; if (want) n.allowlist = false; }
  if (id === "ramp") {
    n.rampMins = want ? (r.rampMins > 0 ? r.rampMins : 60) : 0;
    if (want && !(n.maxWallet > 0)) n.maxWallet = 3;
    if (want && !(n.rampStart > 0 && n.rampStart < n.maxWallet)) n.rampStart = Math.min(0.5, n.maxWallet / 2);
  }
  if (id === "tradeGuard") n.tradeGuard = want ? (r.tradeGuard > 0 ? r.tradeGuard : 1) : 0;
  if (id === "snipe") n.snipeMins = want ? (r.snipeMins > 0 ? r.snipeMins : 2) : 0;
  if (id === "bundle") n.bundleMax = want ? (r.bundleMax > 0 ? r.bundleMax : 2) : 0;
  if (id === "hours") n.hoursOn = want;
  return n;
}
