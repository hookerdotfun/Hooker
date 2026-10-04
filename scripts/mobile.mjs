// Phone-width check: MEASURES every page instead of screenshotting it (a screenshot hides sideways
// panning when something up the tree clips). Lists elements wider than the screen and tap targets under
// 32px. Headless, from a script (no browser window). Adapted from ~/ponsi/web/scripts/mobile.mjs.
//   node scripts/mobile.mjs [baseUrl] [--width=390] [token mint ...]
import { createRequire } from "node:module";
const PW = process.env.PLAYWRIGHT_FROM ?? "playwright"; // or the path to any installed Playwright's index.js
const { chromium } = createRequire(import.meta.url)(PW);

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--") && a.startsWith("http")) ?? "http://localhost:5311").replace(/\/+$/, "");
const WIDTH = Number(args.find((a) => a.startsWith("--width="))?.split("=")[1] ?? 390);
const mints = args.filter((a) => !a.startsWith("--") && !a.startsWith("http"));
// "launch-all": the launch form with EVERY hook switched on, so every settings panel is measured too
const PAGES = [["home", "/"], ["explore", "/explore"], ["docs", "/docs"], ["launch", "/launch"], ["launch-all", "/launch"], ["wallet", "/me"], ...mints.map((m, i) => [`token${i + 1}`, `/t/${m}`])];

const MEASURE = () => {
  const vw = window.innerWidth, wide = [], small = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect(), st = getComputedStyle(el);
    if ((r.width === 0 && r.height === 0) || st.display === "none" || st.visibility === "hidden" || st.position === "fixed") continue;
    let inScroller = false;
    for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll") { inScroller = true; break; } }
    if (inScroller) continue;
    const label = `${el.tagName.toLowerCase()}${typeof el.className === "string" && el.className ? "." + el.className.split(/\s+/).slice(0, 2).join(".") : ""}`;
    const over = Math.max(r.right - vw, r.width - vw, -r.left);
    if (over > 1) wide.push({ el: label, over: Math.round(over), text: (el.textContent ?? "").trim().slice(0, 30) });
    const tag = el.tagName.toLowerCase();
    const pressable = st.pointerEvents !== "none" && Number(st.opacity) !== 0 && (tag === "button" || (tag === "a" && el.getAttribute("href")) || (tag === "input" && el.type !== "hidden" && el.type !== "file"));
    if (pressable && !el.closest("p") && (r.height < 32 || r.width < 32)) small.push({ el: label, w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24) });
  }
  return { docWidth: document.documentElement.scrollWidth, vw, wide, small };
};

const browser = await chromium.launch();
let bad = 0;
for (const [name, path] of PAGES) {
  // a fresh context per page: touch emulation never leaks or drops between routes
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(base + path, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(1500);
  if (name === "launch-all") { for (const c of await page.$$(".rcard:not(.on)")) await c.click().catch(() => {}); await page.waitForTimeout(500); }
  const m = await page.evaluate(MEASURE);
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  const pans = m.docWidth > m.vw + 1;
  if (pans || m.wide.length) bad++;
  console.log(`${pans || m.wide.length ? "❌" : "✅"} ${name.padEnd(8)} page ${m.docWidth}px of ${m.vw}px${coarse ? "" : " (⚠ touch NOT emulated)"} · ${m.wide.length} too wide · ${m.small.length} small tap targets`);
  for (const w of m.wide.slice(0, 8)) console.log(`     wide: ${w.el} +${w.over}px "${w.text}"`);
  for (const s of m.small.slice(0, 8)) console.log(`     small: ${s.el} ${s.w}x${s.h} "${s.text}"`);
  await page.screenshot({ path: `${process.env.SHOTS ?? "/tmp"}/mobile-${name}.png` });
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
