import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { useWallet, cancelled } from "../lib/wallet.jsx";
import { describeRules, sol, eth, amt, usd, pct, tzText } from "../lib/format.js";
import { parseWallets, fillList } from "../lib/lists.js";
import { rulesFor } from "../lib/catalog.js";
import { useMode } from "../lib/mode.jsx";
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
// a Pons launch (Robinhood Chain): no message to sign, one transaction from the EVM wallet
const PONS_STEPS = [
  ["Upload to IPFS", "Image and token details, stored permanently."],
  ["Approve the launch", "One transaction: your token, its rules, its curve and your buy."],
  ["Listed on Hooker", "On Robinhood Chain. It graduates into a Pons coin."],
];
const PONS_LIST_STEP = ["Fill the list", "One approval per 500 wallets, right after the launch."];
/** The v3 rules (Solana only), all off: what switching to Pons resets. */
const V3_UI_OFF = { dumpOn: false, gsOn: false, chOn: false, plagueOn: false, dexOnly: false, p2pOnly: false, potatoOn: false, pingOn: false, kingOn: false, osc: 0, hoursDst: 0, hoursSells: false, hoursHolidays: false };
const OSC_IDS = ["", "breath", "momentum", "resonance", "coupled"];
/** Picked rules with nothing to set. */
const NO_SETTINGS = new Set(["antiSnipe", "fomoOnly", "holderRewards", "dexOnly", "p2pOnly"]);
/** Each oscillator's starting settings: period (s), base cap (%), floor (%), swing or buy energy (%), damping (%/s), coupling (%). */
const OSC_DEFAULTS = {
  1: { oscPeriod: 300, oscBase: 1, oscFloor: 0.1, oscAmp: 60, oscDamp: 0, oscCoupling: 0 },
  2: { oscPeriod: 120, oscBase: 1, oscFloor: 0.25, oscAmp: 40, oscDamp: 8, oscCoupling: 0 },
  3: { oscPeriod: 60, oscBase: 1, oscFloor: 0.25, oscAmp: 40, oscDamp: 1, oscCoupling: 0 },
  4: { oscPeriod: 180, oscBase: 1, oscFloor: 0.25, oscAmp: 40, oscDamp: 1, oscCoupling: 20 },
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const toMin = (hm) => { const [h, m] = String(hm).split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const MY_TZ = -new Date().getTimezoneOffset();
const TZS = Array.from({ length: (840 + 720) / 30 + 1 }, (_, i) => -720 + i * 30);

export default function Launch() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { address, evmAddress, connect, signTransaction, signTransactions, signMessage, sendEvm } = useWallet();
  const [info, setInfo] = useState(null);
  const [evmInfo, setEvmInfo] = useState(null);
  // the header switch decides the venue: Pumpfun (Solana) or Pons (Robinhood Chain); ?on=pons moves it
  const { mode, pons, ponsV3 } = useMode();
  const [f, setF] = useState({ name: "", symbol: "", description: "", twitter: "", website: "", gradSol: null, capUsd: "", devBuy: "0.5", feeTier: 0, pair: null, pumpFee: "", ethSize: 1, devBuyEth: "0.02", quote: "ETH" });
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
        antiSnipe: false, venueLock: false, hoursOn: false, hoursDays: 62, hoursOpen: "09:30", hoursClose: "16:00", tz: MY_TZ, snipeMins: 0, snipeCu: 100_000, snipeTip: 0.0001, bundleMax: 0,
        ...V3_UI_OFF, dumpBuy: 1, dumpSell: 0.25, gsSmall: 1, gsFloor: 0.1, gsBag: 3, chStart: 1, chVolume: 10, plagueDose: 1,
        potatoMin: 0.01, potatoCold: 0, pingMin: 0.01, pingFree: 10, kingMin: 0.1, kingBeat: 5, kingDecayUnit: 2, kingDecayN: 6, kingDevCan: false, ...OSC_DEFAULTS[2] };
      setR(withRule(base, picked.current, i, true));
    }).catch((e) => setErr(e.message));
    api.evmInfo().then(setEvmInfo).catch(() => {});
  }, []);
  // on Pons the Solana-only rules are off, however the form got there (the switch, ?on=pons or ?rule=fomoOnly)
  useEffect(() => {
    if (!pons) return;
    // FOMO-only and the sniper-fee cap never exist on Pons; the v3 hooks do once the launchpad takes them (v6+)
    const v3On = (cur) => !ponsV3 && Object.entries(V3_UI_OFF).some(([k, v]) => cur[k] !== v);
    setR((cur) => (cur && (cur.fomoOnly || cur.snipeMins > 0 || v3On(cur)) ? { ...cur, fomoOnly: false, snipeMins: 0, ...(ponsV3 ? {} : V3_UI_OFF) } : cur));
  }, [pons, r, ponsV3]);

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
  // ⭐ custom graduation caps (10 Oct 2026): f.gradSol "custom" (any market cap) or "none" (never migrates)
  const customOn = f.gradSol === "custom", noMig = f.gradSol === "none";
  const capSol = customOn && Number(f.capUsd) > 0 ? (info?.solUsd ? Number(f.capUsd) / info.solUsd : Number(f.capUsd)) : null;
  // the SOL in the curve when it reaches that cap, on Pumpfun's curve shape (from the start and Pumpfun's own graduation)
  const raiseFor = (cap) => { const p = info?.pumpfun; if (!p || !(cap > 0)) return null; const vS = p.graduationSol / (Math.sqrt(p.graduationCapSol / p.startCapSol) - 1); return vS * (Math.sqrt(cap / p.startCapSol) - 1); };
  const customRaise = raiseFor(capSol);
  const capProblem = customOn && info?.custom ? (!capSol ? "Enter the market cap it graduates at." : capSol < info.custom.minCapSol * 0.999 ? `At least ${money(info.custom.minCapSol)}.` : capSol > info.custom.maxCapSol ? `At most ${money(info.custom.maxCapSol)}.` : null) : null;
  const pastPump = customOn && capSol > (info?.custom?.pumpfunCapSol ?? Infinity);
  /** hooks paid out at graduation: a token that never migrates cannot have them (the API refuses them too) */
  const gradOnly = (x) => [x?.holderShareBps > 0 && "Holder share", x?.burnBps > 0 && "Auto burn", (x?.feeCapBps > 0 || x?.feeBaseBps > 0) && "Dynamic fee", x?.holderRewards && "Creator fees to holders", x?.kingOn && "King of the Hill"].filter(Boolean);
  // the Pons pair asset: ETH or one of Pons's pair assets, each its own launchpad with its own sizes
  const pair = evmInfo?.pairs?.find((p) => p.symbol === f.quote) ?? evmInfo?.pairs?.[0] ?? null;
  const unit = pair?.symbol ?? "ETH";
  const quoteUsd = pair?.usd ?? (unit === "ETH" ? evmInfo?.ethUsd : null);
  const moneyEth = (cap) => (quoteUsd ? usd(cap * quoteUsd) : amt(cap, unit, 2));
  const ponsSizes = pair?.sizes ?? evmInfo?.sizes ?? [];
  const ponsSize = ponsSizes[Number(f.ethSize)] ?? null;
  const ponsTier = (pair?.feeTiers ?? evmInfo?.feeTiers)?.[Number(f.feeTier)] ?? evmInfo?.feeTiers?.[0] ?? null;
  // sensible first-buy amounts: about 0.5% to 5% of a full Pons graduation in that asset
  const devQuick = unit === "ETH" ? ["0.01", "0.02", "0.05", "0.1"] : (() => { const g = pair?.ponsGraduation ?? 0; const r = (x) => String(Number((g * x).toPrecision(2))); return [r(0.003), r(0.006), r(0.012), r(0.025)]; })();

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
    // v3 (Solana): see lib/rules.mjs V3_OFF for units
    maxBuyBps: r.dumpOn ? bpsInput(r.dumpBuy) : 0, maxSellBps: r.dumpOn ? bpsInput(r.dumpSell) : 0,
    sellSmallBps: r.gsOn ? bpsInput(r.gsSmall) : 0, sellFloorBps: r.gsOn ? bpsInput(r.gsFloor) : 0, sellBagBps: r.gsOn ? bpsInput(r.gsBag) : 0,
    plagueDose: r.plagueOn ? Math.round(Number(r.plagueDose) * 1e6) : 0,
    dexOnly: r.dexOnly, p2pOnly: r.p2pOnly,
    potatoOn: r.potatoOn, potatoMinBps: r.potatoOn ? bpsInput(r.potatoMin) : 0, potatoColdSecs: r.potatoOn ? Math.round(Number(r.potatoCold) * 60) : 0,
    pingOn: r.pingOn, pingMinBps: r.pingOn ? bpsInput(r.pingMin) : 0, pingFreeSecs: r.pingOn ? Math.round(Number(r.pingFree) * 60) : 0,
    chapterStartBps: r.chOn ? bpsInput(r.chStart) : 0, chapterVolume: r.chOn ? Math.round(Number(r.chVolume) * 1e12) : 0, // millions of tokens → base units
    oscKind: r.osc, oscPeriod: r.osc ? Math.round(r.oscPeriod) : 0, oscBaseBps: r.osc ? bpsInput(r.oscBase) : 0, oscFloorBps: r.osc ? bpsInput(r.oscFloor) : 0,
    oscAmpPct: r.osc ? Math.round(r.oscAmp) : 0, oscDampPermille: r.osc >= 2 ? Math.round(Number(r.oscDamp) * 10) : 0, oscCouplingPct: r.osc === 4 ? Math.round(r.oscCoupling) : 0,
    kingOn: r.kingOn, kingMinLamports: r.kingOn ? Math.round(Number(r.kingMin) * 1e9) : 0, kingBeatPct: r.kingOn ? Math.round(r.kingBeat) : 0,
    kingDecayUnit: r.kingOn ? Number(r.kingDecayUnit) : 0, kingDecayN: r.kingOn && Number(r.kingDecayUnit) ? Math.round(r.kingDecayN) : 0, kingDevCan: r.kingOn && !!r.kingDevCan,
    hoursDst: r.hoursOn ? Number(r.hoursDst) : 0, hoursSells: r.hoursOn && !!r.hoursSells, hoursHolidays: r.hoursOn && !!r.hoursHolidays,
  }), [r]);
  const listed = useMemo(() => (r && (r.allowlist || r.blocklist) ? parseWallets(r.listText, pons ? "rhc" : "sol") : null), [r, pons]);
  /** The v3 hooks for a Pons launch (the token's `Ext`): the same settings, amounts in whole tokens, the King's minimum in the asset. */
  const ponsExt = useMemo(() => (rules ? {
    maxBuyBps: rules.maxBuyBps, maxSellBps: rules.maxSellBps, sellSmallBps: rules.sellSmallBps, sellFloorBps: rules.sellFloorBps, sellBagBps: rules.sellBagBps,
    plagueTokens: r.plagueOn ? Number(r.plagueDose) : 0, dexOnly: !!rules.dexOnly, p2pOnly: !!rules.p2pOnly,
    potatoOn: !!rules.potatoOn, potatoMinBps: rules.potatoMinBps, potatoColdSecs: rules.potatoColdSecs,
    pingOn: !!rules.pingOn, pingMinBps: rules.pingMinBps, pingFreeSecs: rules.pingFreeSecs,
    chapterStartBps: rules.chapterStartBps, chapterTokens: r.chOn ? Number(r.chVolume) * 1e6 : 0,
    oscKind: rules.oscKind, oscPeriod: rules.oscPeriod, oscBaseBps: rules.oscBaseBps, oscFloorBps: rules.oscFloorBps, oscAmpPct: rules.oscAmpPct,
    oscDampPermille: rules.oscDampPermille, oscCouplingPct: rules.oscCouplingPct,
    kingOn: !!rules.kingOn, kingMin: r.kingOn ? String(Number(r.kingMin)) : "0", kingBeatPct: rules.kingBeatPct, kingDecayUnit: rules.kingDecayUnit, kingDecayN: rules.kingDecayN, kingDevCan: !!rules.kingDevCan,
    hoursSells: !!rules.hoursSells, hoursHolidays: !!rules.hoursHolidays, hoursDst: rules.hoursDst,
  } : {}), [rules, r]);

  /** A Pons launch: upload, then ONE transaction from the EVM wallet (token + rules + curve + your buy). */
  async function submitPons() {
    setErr(null);
    try {
      if (!image) throw new Error("Add an image.");
      if (!f.name.trim() || !f.symbol.trim()) throw new Error("Name and ticker are required.");
      const v = await connect("evm");
      setPhase(0); setStep("Uploading the image to IPFS…");
      const form = new FormData();
      form.append("file", image);
      for (const k of ["name", "symbol", "description", "twitter", "website"]) if (f[k].trim()) form.append(k, f[k].trim());
      const { metadata } = await api.upload(form);
      const cid = /ipfs\/([A-Za-z0-9]+)/.exec(String(metadata?.image ?? ""))?.[1];
      if (!cid) throw new Error("The image upload returned no IPFS address. Try again.");
      setPhase(1); setStep("Preparing the launch…");
      // a pair asset is pulled from the wallet by the launchpad: approve the first buy first (one extra approval)
      if (unit !== "ETH" && Number(f.devBuyEth) > 0) {
        setStep(`Approve ${unit} for the launchpad in your wallet…`);
        await sendEvm(await api.evmApproveTx({ quote: unit, amount: String(Number(f.devBuyEth)) }));
      }
      const { maxWalletBps, earlySecs, earlyMaxWalletBps, rampStartBps, rampSecs, tradeGuardBps, allowlist, blocklist, hoursOn, hoursDays, hoursOpenMin, hoursCloseMin, tzOffsetMin, bundleMax, feeBaseBps, feePerSolBps, feeCapBps, burnBps, holderShareBps, holderRewards } = rules;
      const tx = await api.evmLaunchTx({ from: v.address, name: f.name.trim(), symbol: f.symbol.trim(), image: `ipfs://${cid}`, description: f.description.trim(), twitter: f.twitter.trim(), website: f.website.trim(),
        size: Number(f.ethSize), tier: Number(f.feeTier) || 0, antiSnipe: !!r.antiSnipe, devBuyEth: String(Number(f.devBuyEth || 0)), quote: unit,
        rules: { maxWalletBps, earlySecs, earlyMaxWalletBps, rampStartBps, rampSecs, tradeGuardBps, allowlist, blocklist, hoursOn, hoursDays, hoursOpenMin, hoursCloseMin, tzOffsetMin, bundleMax, feeBaseBps, feePerEthBps: feePerSolBps, feeCapBps, burnBps, holderShareBps, holderRewards },
        ...(ponsV3 ? { ext: ponsExt } : {}) });
      setStep("Approve the launch in your wallet…");
      const { token } = await sendEvm(tx, { onSent: () => setStep("Launching…") });
      if (!token) throw new Error("The launch landed but its token was not found. Check your wallet's activity.");
      setPhase(2);
      if (listed && (listed.wallets.length || r.seal)) {
        setPhase(3);
        try {
          for (let i = 0; i < listed.wallets.length; i += 500) {
            setStep(`Approve the list in your wallet (${Math.min(i + 500, listed.wallets.length)} of ${listed.wallets.length})…`);
            await sendEvm(await api.evmListTx({ token, wallets: listed.wallets.slice(i, i + 500) }));
          }
          if (r.seal) { setStep("Approve sealing the list…"); await sendEvm(await api.evmSealTx({ token })); }
        } catch {
          nav(`/t/${token}?launched=1&list=unfinished`, { state: { image: imageUrl } });
          return;
        }
      }
      nav(`/t/${token}?launched=1`, { state: { image: imageUrl } });
    } catch (e2) {
      setErr(cancelled(e2) ? "Cancelled in the wallet." : e2.message);
      setPhase(-1);
    } finally {
      setStep(null);
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (pons) return submitPons();
    setErr(null);
    try {
      if (!image) throw new Error("Add an image.");
      if (!f.name.trim() || !f.symbol.trim()) throw new Error("Name and ticker are required.");
      const pumpFee = f.pair && String(f.pumpFee).trim() !== "" ? Math.round(Number(f.pumpFee) * 100) : 0;
      if (f.pair && String(f.pumpFee).trim() !== "" && !(pumpFee >= 1 && pumpFee <= 300)) throw new Error("The Pumpfun creator fee must be between 0.01% and 3%.");
      if (capProblem) throw new Error(capProblem);
      if (noMig && gradOnly(rules).length) throw new Error(`${gradOnly(rules).join(", ")} ${gradOnly(rules).length === 1 ? "pays" : "pay"} out at graduation. Turn ${gradOnly(rules).length === 1 ? "it" : "them"} off for a token that never migrates.`);
      const pairOk = f.pair && !noMig && !pastPump;
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
      const grad = noMig ? { custom: { kind: "none" } } : customOn ? { custom: { kind: "cap", capSol } } : { gradSol: Number(f.gradSol) };
      const built = await api.launchTx({ creator: acct.address, ...grad, name: f.name.trim(), symbol: f.symbol.trim(), uri, rules, antiSnipe: !!r.antiSnipe, feeTier: Number(f.feeTier) || 0, pair: pairOk ? f.pair.mint : null, pumpCreatorFeeBps: pairOk ? pumpFee : null, devBuySol: Number(f.devBuy || 0), nonce, signature });
      if (built.configTx) {
        // its own graduation config goes first: a separate approval, so the wallet's check of the launch sees the config there
        setStep(`Approve your token's ${noMig ? "curve" : "graduation cap"} in your wallet (1 of 2)…`);
        await api.send(await signTransaction(built.configTx, acct.address));
      }
      setStep(built.configTx ? "Approve the launch in your wallet (2 of 2)…" : "Approve the launch in your wallet…");
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
  if (pons && !evmInfo) return <div className="empty" style={{ marginTop: 60 }}>Loading Pons…</div>;
  if (!pons && !info.sizes.length) return <div className="empty" style={{ marginTop: 60 }}>Launching on Pumpfun is paused right now. Trading and graduations carry on as normal.</div>;
  const preview = pons
    ? describeRules({ ...rules, ...ponsExt, plagueDose: ponsExt.plagueTokens, chapterVolume: ponsExt.chapterTokens, dev: evmAddress }, { gradSol: ponsSize?.eth, antiSnipe: !!r?.antiSnipe, fees: ponsTier, chain: "rhc", unit })
    : describeRules({ ...rules, dev: address }, { gradSol: noMig ? null : customOn ? customRaise : f.gradSol, noMigration: noMig, antiSnipe: !!r?.antiSnipe, fees: tierNow, pair: f.pair && !noMig && !pastPump ? { symbol: f.pair.symbol, creatorFeeBps: Math.round(Number(f.pumpFee || 0) * 100), toHolders: !!r?.holderRewards } : null });
  const catalog = rulesFor(info, mode, ponsV3);
  const on = isOn(r);
  const chosen = catalog.filter((x) => on[x.id]);
  const groups = [...new Set(catalog.map((x) => x.group))];
  const sym = f.symbol.trim() || "TICKER";
  // a custom cap or no migration: its own config is a second approval, before the launch
  const solSteps = customOn || noMig ? STEPS.map((x, i) => (i === 2 ? ["Approve the launch", "Two approvals: your curve's own config, then your token, its rules and your buy."] : x)) : STEPS;
  const steps = pons ? (listed ? [...PONS_STEPS.slice(0, 2), PONS_LIST_STEP, PONS_STEPS[2]] : PONS_STEPS) : listed ? [...solSteps.slice(0, 3), LIST_STEP, solSteps[3]] : solSteps;
  // phase 4 is the list, shown before "Listed on Hooker" (phase 3 on Pons)
  const stepState = (i) => {
    if (pons) {
      if (!listed) return phase > i ? "done" : phase === i ? "now" : "";
      const at = phase === 3 ? 2 : phase === 2 ? 3 : phase;
      return at > i ? "done" : at === i ? "now" : "";
    }
    if (!listed) return phase > i ? "done" : phase === i ? "now" : "";
    const at = phase === 4 ? 3 : phase === 3 ? 4 : phase;
    return at > i ? "done" : at === i ? "now" : "";
  };

  return (
    <form className="launch" onSubmit={submit}>
      <div className="page-head center">
        <div className="eyebrow">Launch a token</div>
        <h1 className="launch-h"><span className="grad">Hook</span> it</h1>
        <p className="lede">{pons ? "Launch a token on Robinhood Chain with rules built into it. It graduates into a Pons coin." : "Launch a token on Solana with rules built into it. It graduates into a Pumpfun coin."}</p>
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
            <p className="hint" style={{ margin: "2px 0 0" }}>Name, ticker and image carry over to the {pons ? "Pons" : "Pumpfun"} coin at graduation and can never be changed.</p>
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
                  <Field label={`+% per ${pons ? "ETH" : "SOL"}`}><input type="number" min="0" step="0.1" value={r.feePerSol} onChange={(e) => setRule("feePerSol", Number(e.target.value))} /></Field>
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
                  hint={`Paste addresses, one per line or separated by commas. You sign one approval per ${pons ? 500 : 300} wallets right after the launch. For a day you can still add more from the token page, unless you seal it.`}>
                  <textarea rows={5} className="mono-area" value={r.listText} onChange={(e) => setRule("listText", e.target.value)} placeholder={pons ? "0x3f2a…91c4\n0x8b10…e7d2" : "7xKp…q2Lm\nFz9d…Wa1c"} />
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
            {on.market && (
              <div className="setting">
                <span className="label" style={{ marginBottom: 8 }}>Market hours</span>
                <p className="hint" style={{ margin: "0 0 8px" }}>Monday to Friday, 09:30 to 16:00 New York time, following daylight saving, closed on US stock market holidays.</p>
                <label className="check"><input type="checkbox" checked={!r.hoursSells} onChange={(e) => setRule("hoursSells", !e.target.checked)} /> Sells stay open around the clock</label>
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
                {info?.v3Rules ? (<>
                <div className="two">
                  <Field label="Daylight saving">
                    <select value={r.hoursDst} onChange={(e) => setRule("hoursDst", Number(e.target.value))}>
                      <option value={0}>None: a fixed offset</option>
                      <option value={1}>US rules (+1 h from March to November)</option>
                      <option value={2}>European rules (+1 h from March to October)</option>
                    </select>
                  </Field>
                  <Field label="Outside the hours">
                    <select value={r.hoursSells ? 1 : 0} onChange={(e) => setRule("hoursSells", e.target.value === "1")}>
                      <option value={0}>Buys closed, sells stay open</option>
                      <option value={1}>Buys and sells closed</option>
                    </select>
                  </Field>
                </div>
                <p className="hint" style={{ margin: 0 }}>Pick the time zone's standard offset; daylight saving adds the hour on chain. Closing before opening runs overnight. Sending between wallets always works.</p>
                </>) : <p className="hint" style={{ margin: 0 }}>A fixed offset: it does not follow daylight saving. Closing before opening runs overnight.</p>}
              </div>
            )}
            {on.antiDump && (
              <div className="setting">
                <div className="two">
                  <Field label="Max per buy (% of supply)" hint="0 = no cap on buys. Your launch buy is exempt."><input type="number" min="0" max="100" step="0.05" value={r.dumpBuy} onChange={(e) => setRule("dumpBuy", Number(e.target.value))} /></Field>
                  <Field label="Max per sell (% of supply)" hint="Tighter than the buy cap for anti-dump. Your sells too."><input type="number" min="0" max="100" step="0.05" value={r.dumpSell} onChange={(e) => setRule("dumpSell", Number(e.target.value))} /></Field>
                </div>
              </div>
            )}
            {on.sellScale && (
              <div className="setting">
                <div className="three">
                  <Field label="Small holders sell up to (%)"><input type="number" min="0.02" max="100" step="0.05" value={r.gsSmall} onChange={(e) => setRule("gsSmall", Number(e.target.value))} /></Field>
                  <Field label="Biggest bags sell up to (%)"><input type="number" min="0.01" max="100" step="0.01" value={r.gsFloor} onChange={(e) => setRule("gsFloor", Number(e.target.value))} /></Field>
                  <Field label="From a bag of (%)"><input type="number" min="0.1" max="100" step="0.5" value={r.gsBag} onChange={(e) => setRule("gsBag", Number(e.target.value))} /></Field>
                </div>
                <p className="hint" style={{ margin: 0 }}>Between the two, the cap shrinks evenly as the bag grows. It applies to your sells too.</p>
              </div>
            )}
            {on.chapters && (
              <div className="setting">
                <div className="two">
                  <Field label="Max per wallet in chapter 1 (%)"><input type="number" min="0.1" max="100" step="0.1" value={r.chStart} onChange={(e) => setRule("chStart", Number(e.target.value))} /></Field>
                  <Field label="Volume per chapter (million tokens)" hint="The cap doubles every time this much more trades."><input type="number" min="0.001" step="1" value={r.chVolume} onChange={(e) => setRule("chVolume", Number(e.target.value))} /></Field>
                </div>
              </div>
            )}
            {on.plague && (
              <div className="setting">
                <Field label="Infection dose (tokens)" hint="A wallet must hold this many to buy. Send at least this much to infect someone. Your launch buy gives you the first tokens to hand out.">
                  <input type="number" min="0.000001" step="1" value={r.plagueDose} onChange={(e) => setRule("plagueDose", Number(e.target.value))} />
                </Field>
              </div>
            )}
            {on.potato && (
              <div className="setting">
                <div className="two">
                  <Field label="Smallest buy that passes it (% of supply)" hint="Smaller buys go through but do not pass the potato."><input type="number" min="0" max="1" step="0.01" value={r.potatoMin} onChange={(e) => setRule("potatoMin", Number(e.target.value))} /></Field>
                  <Field label="Goes cold after (minutes)" hint="If nobody buys this long, the holder can sell. 0 = never."><input type="number" min="0" max="1440" step="1" value={r.potatoCold} onChange={(e) => setRule("potatoCold", Number(e.target.value))} /></Field>
                </div>
              </div>
            )}
            {on.ping && (
              <div className="setting">
                <div className="two">
                  <Field label="Smallest trade that takes the turn (% of supply)" hint="Smaller trades go through on their own turn."><input type="number" min="0" max="1" step="0.01" value={r.pingMin} onChange={(e) => setRule("pingMin", Number(e.target.value))} /></Field>
                  <Field label="Turn frees up after (minutes)" hint="If nobody takes the turn, either side can go. 0 = never."><input type="number" min="0" max="1440" step="1" value={r.pingFree} onChange={(e) => setRule("pingFree", Number(e.target.value))} /></Field>
                </div>
              </div>
            )}
            {on.king && (
              <div className="setting">
                <div className="two">
                  <Field label={`Smallest buy that takes the crown (${pons ? unit : "SOL"})`} hint={pons && pair ? `Between ${Number((pair.ponsGraduation / 4200).toPrecision(2))} and ${pair.ponsGraduation} ${unit}.` : undefined}>
                    <input type="number" min={pons && pair ? pair.ponsGraduation / 4200 : 0.01} max={pons && pair ? pair.ponsGraduation : 10} step={pons ? "any" : "0.01"} value={r.kingMin} onChange={(e) => setRule("kingMin", Number(e.target.value))} />
                  </Field>
                  <Field label="A challenger must beat the King by (%)"><input type="number" min="0" max="50" step="1" value={r.kingBeat} onChange={(e) => setRule("kingBeat", Number(e.target.value))} /></Field>
                </div>
                <div className="two">
                  <Field label="The bar halves every">
                    <select value={r.kingDecayUnit} onChange={(e) => setRule("kingDecayUnit", Number(e.target.value))}>
                      <option value={1}>Minutes</option><option value={2}>Hours</option><option value={3}>Days</option><option value={0}>Never (it only rises)</option>
                    </select>
                  </Field>
                  {Number(r.kingDecayUnit) > 0 && <Field label="How many"><input type="number" min="1" max="60" step="1" value={r.kingDecayN} onChange={(e) => setRule("kingDecayN", Number(e.target.value))} /></Field>}
                </div>
                <label className="check"><input type="checkbox" checked={!!r.kingDevCan} onChange={(e) => setRule("kingDevCan", e.target.checked)} /> Your own wallet can be King</label>
                <p className="hint" style={{ margin: 0 }}>The King earns 0.3% of every trade's value while they reign, paid in {pons ? unit : "SOL"} from Hooker's share of the fees, not yours.</p>
              </div>
            )}
            {r.osc > 0 && (
              <div className="setting">
                <span className="label" style={{ marginBottom: 8 }}>{["", "Breathing cap", "Momentum", "Resonance", "Coupled resonator"][r.osc]}</span>
                <div className="three">
                  <Field label={r.osc === 1 ? "Cycle (seconds)" : r.osc === 3 ? "The beat (seconds)" : "Natural period (seconds)"}><input type="number" min={r.osc === 1 ? 30 : 20} max={r.osc === 1 ? 3600 : 1200} step="1" value={r.oscPeriod} onChange={(e) => setRule("oscPeriod", Number(e.target.value))} /></Field>
                  <Field label="Base cap per buy (%)"><input type="number" min="0.1" max="100" step="0.1" value={r.oscBase} onChange={(e) => setRule("oscBase", Number(e.target.value))} /></Field>
                  <Field label="Never below (%)"><input type="number" min="0.01" max="100" step="0.05" value={r.oscFloor} onChange={(e) => setRule("oscFloor", Number(e.target.value))} /></Field>
                </div>
                <div className="three">
                  <Field label={r.osc === 1 ? "Swing (% of the base)" : "Buy energy (%)"}><input type="number" min={r.osc === 1 ? 10 : 5} max="100" step="1" value={r.oscAmp} onChange={(e) => setRule("oscAmp", Number(e.target.value))} /></Field>
                  {r.osc >= 2 && <Field label="Damping (% per second)"><input type="number" min="1" max="40" step="0.5" value={r.oscDamp} onChange={(e) => setRule("oscDamp", Number(e.target.value))} /></Field>}
                  {r.osc === 4 && <Field label="Coupling (%)"><input type="number" min="1" max="60" step="1" value={r.oscCoupling} onChange={(e) => setRule("oscCoupling", Number(e.target.value))} /></Field>}
                </div>
                <p className="hint" style={{ margin: 0 }}>{r.osc === 1 ? "The cap swings above and below the base on the cycle, forever." : "A buy the size of the base cap kicks the cap up by the buy energy, then it swings back and settles."} Sells and sends are never capped; your wallet is exempt.</p>
              </div>
            )}
            {chosen.length > 0 && !chosen.some((x) => !NO_SETTINGS.has(x.id)) && (
              <p className="sec-lede" style={{ margin: 0 }}>The rules you picked have nothing to set.</p>
            )}
          </Sec>

          {pons && (
          <Sec n="4" title="Curve">
            {/* the pair asset: Pons's own curve for that asset, so the coin graduates paired with it, no swap in between */}
            {(evmInfo.pairs?.length ?? 0) > 1 && (
              <>
                <Field label="Paired asset" hint={unit === "ETH" ? "The Pons coin trades against ETH, like most Pons coins." : `Your curve takes ${unit}, and at graduation the Pons coin is paired with ${unit}. Buyers approve ${unit} once before buying.${pair?.bridgeable ? "" : ` ${unit} creator fees are collected as ${unit} and converted for the burn by hand.`}`}>
                  <select value={unit} onChange={(e) => { const p = evmInfo.pairs.find((x) => x.symbol === e.target.value); const g = p?.ponsGraduation ?? 0; setF({ ...f, quote: e.target.value, devBuyEth: e.target.value === "ETH" ? "0.02" : String(Number((g * 0.006).toPrecision(2))) }); }}>
                    {evmInfo.pairs.map((p) => <option key={p.symbol} value={p.symbol}>{p.symbol}{p.usd == null && p.symbol !== "ETH" ? " (no price yet)" : ""}</option>)}
                  </select>
                </Field>
              </>
            )}
            <div className="sizes">
              {ponsSizes.map((s) => (
                <button type="button" key={s.index} className={`size ${Number(f.ethSize) === s.index ? "on" : ""}`} onClick={() => setF({ ...f, ethSize: s.index })}>
                  <b>{amt(s.eth, unit, 2)}</b><span>{`graduates at ${moneyEth(s.endCapEth)}`}</span>
                </button>
              ))}
            </div>
            <div className="caps">
              <div><span className="k">Starting market cap</span><b>{ponsSizes[0] ? moneyEth(ponsSizes[0].startCapEth) : "…"}</b><span className="hint">same as every Pons coin in {unit}</span></div>
              <div><span className="k">Graduation market cap</span><b>{ponsSize ? moneyEth(ponsSize.endCapEth) : "…"}</b><span className="hint">at most {ponsSizes.length ? moneyEth(ponsSizes[ponsSizes.length - 1].endCapEth) : "…"}, where Pons's own curve fills</span></div>
            </div>
            <span className="label" style={{ display: "block", margin: "6px 0 8px" }}>Your fee per trade</span>
            <div className="sizes">
              {(pair?.feeTiers ?? evmInfo.feeTiers).map((t) => (
                <button type="button" key={t.index} className={`size ${Number(f.feeTier) === t.index ? "on" : ""}`} onClick={() => setF({ ...f, feeTier: t.index })}>
                  <b>{t.index === 0 ? pct2(t.creatorPct) : pct2(Math.round(t.creatorPct))}</b><span>{t.index === 0 ? "default · " : ""}buyers pay {pct2(t.totalPct)}</span>
                </button>
              ))}
            </div>
            <Field label="Your buy at launch" hint={r?.antiSnipe ? "It is the only trade that skips the anti-snipe fee, so it has to be yours, inside the launch itself." : "It is made inside the launch itself so nobody can buy before you."}>
              <div className="amount"><input type="number" min="0" step="any" value={f.devBuyEth} onChange={set("devBuyEth")} /><span>{unit}</span></div>
              <div className="quick">{devQuick.map((v) => <button type="button" key={v} className={f.devBuyEth === v ? "on" : ""} onClick={() => setF({ ...f, devBuyEth: v })}>{v} {unit}</button>)}</div>
            </Field>
          </Sec>
          )}
          {!pons && (
          <Sec n="4" title="Curve">
            <div className="sizes">
              {info.sizes.map((s) => (
                <button type="button" key={s.sol} className={`size ${Number(f.gradSol) === s.sol ? "on" : ""}`} onClick={() => setF({ ...f, gradSol: s.sol })}>
                  <b>{s.sol} SOL</b><span>{`graduates at ${money(s.endCapSol)}`}</span>
                </button>
              ))}
            </div>
            {info.custom && (
              <div className="sizes sizes-2">
                <>
                  <button type="button" className={`size ${customOn ? "on" : ""}`} onClick={() => setF({ ...f, gradSol: "custom" })}>
                    <b>Custom</b><span>any graduation cap</span>
                  </button>
                  <button type="button" className={`size ${noMig ? "on" : ""}`} onClick={() => setF({ ...f, gradSol: "none" })}>
                    <b>No migration</b><span>stays on Meteora</span>
                  </button>
                </>
              </div>
            )}
            {customOn && (
              <Field label="Graduation market cap" hint={capProblem && f.capUsd ? capProblem
                : `${customRaise ? `About ${customRaise.toLocaleString("en-US", { maximumFractionDigits: customRaise < 10 ? 2 : 1 })} SOL in the curve. ` : ""}${pastPump ? "Past Pumpfun's own graduation: at graduation the coin fills Pumpfun's curve and the rest of the raise buys it on PumpSwap. " : ""}Your curve gets its own Meteora config, about ${info.custom.configRentSol.toFixed(2)} SOL, approved before the launch.`}>
                <div className="amount"><input type="number" min="0" step="any" placeholder={info.solUsd ? "100000" : "500"} value={f.capUsd} onChange={set("capUsd")} /><span>{info.solUsd ? "USD" : "SOL"}</span></div>
                <div className="quick">{(info.solUsd ? ["25000", "250000", "1000000", "5000000"] : ["100", "1000", "5000", "20000"]).map((v) => <button type="button" key={v} className={f.capUsd === v ? "on" : ""} onClick={() => setF({ ...f, capUsd: v })}>{info.solUsd ? usd(Number(v)) : `${v} SOL`}</button>)}</div>
              </Field>
            )}
            {noMig && (
              <p className="hint" style={{ margin: "0 0 14px" }}>
                The curve never fills, so the token never leaves Meteora and every hook stays on for good. Hooks that pay out at graduation (holder share, auto burn, dynamic fee, creator fees to holders, King of the Hill) are not available. Your curve gets its own Meteora config, about {info.custom.configRentSol.toFixed(2)} SOL, approved before the launch.
                {gradOnly(rules).length ? <span className="err" style={{ display: "block", marginTop: 6 }}>Turn off: {gradOnly(rules).join(", ")}.</span> : null}
              </p>
            )}
            <div className="caps">
              <div><span className="k">Starting market cap</span><b>{money(info.pumpfun.startCapSol)}</b><span className="hint">same as every Pumpfun coin</span></div>
              <div><span className="k">Graduation market cap</span><b>{noMig ? "Never" : customOn ? (capSol && !capProblem ? money(capSol) : "…") : size ? money(size.endCapSol) : "…"}</b>
                <span className="hint">{noMig ? "it stays on Meteora" : customOn ? `${money(info.custom.minCapSol)} to ${money(info.custom.maxCapSol)}` : `at most ${money(info.pumpfun.graduationCapSol)}, where Pumpfun's curve fills`}</span></div>
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
            {!noMig && !pastPump && <>
            <span className="label" style={{ display: "block", margin: "6px 0 8px" }}>Pair on Pumpfun</span>
            <PairPicker value={f.pair} onChange={(p) => setF((x) => ({ ...x, pair: p, pumpFee: p ? x.pumpFee : "" }))} />
            <p className="hint" style={{ margin: "8px 0 14px" }}>{f.pair ? `At graduation the curve's SOL is swapped into ${f.pair.symbol} and the Pumpfun coin trades against it.` : "The Pumpfun coin trades against SOL, like most Pumpfun coins."}</p>
            {f.pair && (
              <Field label={<>Pumpfun creator fee (%) <span className="muted" style={{ fontWeight: 400 }}>(Optional)</span></>}
                hint={r?.holderRewards ? "Paid on every Pumpfun trade after graduation. Creator fees to holders is on, so it goes to holders." : "Paid on every Pumpfun trade after graduation, to you."}>
                <input type="number" min="0.01" max="3" step="0.01" placeholder="0.01-3" value={f.pumpFee} onChange={set("pumpFee")} />
              </Field>
            )}
            </>}
            <Field label="Your buy at launch" hint={r?.antiSnipe ? "At least 0.01 SOL. It is the only trade that skips the anti-snipe fee, so it has to be yours, inside the launch itself." : "At least 0.01 SOL. It is made inside the launch itself so nobody can buy before you."}>
              <div className="amount"><input type="number" min="0.01" step="0.1" value={f.devBuy} onChange={set("devBuy")} /><span>SOL</span></div>
              <div className="quick">{["0.1", "0.5", "1", "2"].map((v) => <button type="button" key={v} className={f.devBuy === v ? "on" : ""} onClick={() => setF({ ...f, devBuy: v })}>{v} SOL</button>)}</div>
            </Field>
          </Sec>
          )}

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
            <div className="ptok-foot">{pons ? <><span>{ponsSize ? amt(ponsSize.eth, unit, 2) : ""} curve · Robinhood Chain</span><span>then Pons</span></> : noMig ? <><span>Meteora DBC curve</span><span>no migration</span></> : <><span>{customOn ? (capSol && !capProblem ? `${money(capSol)} cap` : "Custom") : `${f.gradSol} SOL`} curve · Meteora DBC</span><span>then Pumpfun</span></>}</div>
          </section>

          <section className="panel checklist">
            {steps.map(([t, d], i) => (
              <div key={t} className={`cl ${stepState(i)}`}>
                <span className="cl-dot" />
                <div><b>{t}</b><span>{stepState(i) === "now" && step ? step : d}</span></div>
              </div>
            ))}
            {err && <p className="err">{err}</p>}
            <button className="btn green big" disabled={!!step}>{step ? "Launching…" : (pons ? evmAddress : address) ? "Launch" : "Connect and launch"}</button>
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
    snipe: r.snipeMins > 0, bundle: r.bundleMax > 0, hours: !!r.hoursOn && !isMarket(r),
    antiDump: !!r.dumpOn, sellScale: !!r.gsOn, chapters: !!r.chOn, plague: !!r.plagueOn, market: isMarket(r), dexOnly: !!r.dexOnly, p2pOnly: !!r.p2pOnly,
    potato: !!r.potatoOn, ping: !!r.pingOn, king: !!r.kingOn, breath: r.osc === 1, momentum: r.osc === 2, resonance: r.osc === 3, coupled: r.osc === 4 };
}
/** Market hours is trading hours set like the New York stock market. */
const isMarket = (r) => !!r.hoursOn && Number(r.tz) === -300 && Number(r.hoursDst) === 1 && !!r.hoursHolidays && r.hoursDays === 62 && r.hoursOpen === "09:30" && r.hoursClose === "16:00";
/** Rules that cannot go together: switching one on switches these off (mirrors validateRules). */
const CLASH = {
  antiDump: ["tradeGuard", "sellScale"], tradeGuard: ["antiDump"], sellScale: ["antiDump"],
  chapters: ["maxWallet", "ramp"], maxWallet: ["chapters"], ramp: ["chapters"],
  plague: ["dexOnly", "p2pOnly"], dexOnly: ["plague", "p2pOnly"],
  p2pOnly: ["plague", "dexOnly", "fomoOnly", "snipe", "bundle", "hours", "market", "potato", "ping", "king", "antiDump", "sellScale", "breath", "momentum", "resonance", "coupled"],
  breath: ["momentum", "resonance", "coupled"], momentum: ["breath", "resonance", "coupled"], resonance: ["breath", "momentum", "coupled"], coupled: ["breath", "momentum", "resonance"],
  market: ["hours"], hours: ["market"],
};
for (const id of ["fomoOnly", "snipe", "bundle", "potato", "ping", "king", "breath", "momentum", "resonance", "coupled"]) (CLASH[id] ??= []).push("p2pOnly");

/** The rules with one switched on or off; switching on gives it a sensible starting value. */
function withRule(r, id, info, want) {
  if (!id) return r;
  let n = setRule1(r, id, info, want);
  if (want) for (const other of CLASH[id] ?? []) if (isOn(n)[other]) n = setRule1(n, other, info, false);
  return n;
}
function setRule1(r, id, info, want) {
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
  if (id === "hours") { n.hoursOn = want; if (want) { n.hoursHolidays = false; if (isMarket(n)) n.hoursDst = 0; } }
  if (id === "market") {
    n.hoursOn = want;
    if (want) Object.assign(n, { hoursDays: 62, hoursOpen: "09:30", hoursClose: "16:00", tz: -300, hoursDst: 1, hoursHolidays: true });
    else n.hoursHolidays = false;
  }
  if (id === "antiDump") n.dumpOn = want;
  if (id === "sellScale") n.gsOn = want;
  if (id === "chapters") n.chOn = want;
  if (id === "plague") n.plagueOn = want;
  if (id === "dexOnly") n.dexOnly = want;
  if (id === "p2pOnly") n.p2pOnly = want;
  if (id === "potato") n.potatoOn = want;
  if (id === "ping") n.pingOn = want;
  if (id === "king") n.kingOn = want;
  const k = OSC_IDS.indexOf(id);
  if (k > 0) { if (want) Object.assign(n, { osc: k, ...OSC_DEFAULTS[k] }); else if (n.osc === k) n.osc = 0; }
  return n;
}
