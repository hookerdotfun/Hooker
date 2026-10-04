// The site gate. Caddy asks it about EVERY request (forward_auth) before serving anything: a valid
// signed cookie → allowed; anything else → the login page. The password is stored only as a scrypt
// hash and the cookie is an HMAC over its issue time, so nothing on disk logs anyone in by itself.
//
//   GATE_USER=… GATE_HASH=scrypt:<salt>:<hex> GATE_SECRET=<hex> node server/gate.mjs   (127.0.0.1:5312)
//   node server/gate.mjs --hash            reads a password on stdin, prints a GATE_HASH value
//
//   GET  /gate/check   204 with a valid cookie, else 302 → /gate?next=<the page asked for>
//   GET  /gate         the login page
//   POST /gate/login   username + password → cookie, redirect to `next`
//   GET  /gate/logout  clears the cookie
import http from "node:http";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export const COOKIE = "hooker_gate";
const DAY = 86_400;

const SCRYPT = { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return `scrypt:${salt}:${scryptSync(password.normalize("NFKC"), salt, 32, SCRYPT).toString("hex")}`;
}
export function verifyPassword(password, stored) {
  const [, salt, hex] = String(stored).split(":");
  if (!salt || !hex) return false;
  const want = Buffer.from(hex, "hex"), got = scryptSync(String(password).normalize("NFKC"), salt, want.length, SCRYPT);
  return want.length === got.length && timingSafeEqual(want, got);
}
const sign = (secret, body) => createHmac("sha256", secret).update(body).digest("hex");
export function issueCookie(secret, user, now = Math.floor(Date.now() / 1000)) {
  const body = `${user}.${now}`;
  return `${body}.${sign(secret, body)}`;
}
export function verifyCookie(secret, value, { maxAgeSecs = 30 * DAY, now = Math.floor(Date.now() / 1000) } = {}) {
  const parts = String(value ?? "").split(".");
  if (parts.length !== 3) return null;
  const [user, ts, mac] = parts;
  const want = Buffer.from(sign(secret, `${user}.${ts}`)), got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const issued = Number(ts);
  if (!Number.isFinite(issued) || now - issued > maxAgeSecs || issued > now + 60) return null;
  return user;
}

const ICON_USER = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;
const ICON_LOCK = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
const ICON_EYE = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const page = (hasAssets, { error = "", next = "/" } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Hooker</title><meta name="robots" content="noindex,nofollow">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Hooker">
<meta property="og:url" content="https://hooker.fun/">
<meta property="og:title" content="Hooker">
<meta property="og:description" content="Launch a Pumpfun token with rules built into the token itself.">
<meta property="og:image" content="https://hooker.fun/og-v4.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Hooker">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@hookerdotfun">
<meta name="twitter:title" content="Hooker">
<meta name="twitter:description" content="Launch a Pumpfun token with rules built into the token itself.">
<meta name="twitter:image" content="https://hooker.fun/og-v4.png">
${hasAssets ? `<link rel="icon" href="/gate/favicon-v4.png" type="image/png"><link rel="apple-touch-icon" href="/gate/apple-touch-icon-v3.png">` : ""}
<meta name="theme-color" content="#0b0b0e">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0b0b0e;--panel:#131316;--line:#2f2f35;--text:#e4e4e7;--muted:#a1a1aa;--accent:#86efac;--accent-2:#bbf7d0;--bad:#f87171}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);font:16px/1.5 "Geist",system-ui,sans-serif;-webkit-font-smoothing:antialiased;
  background-image:radial-gradient(70% 55% at 50% 35%,rgba(134,239,172,.13) 0%,rgba(134,239,172,0) 70%)}
.box{position:relative;width:100%;max-width:460px;background:var(--panel);border:1px solid var(--line);border-radius:24px;padding:48px 40px 36px;box-shadow:0 40px 100px rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.03)}
.x{position:absolute;top:16px;right:18px;width:32px;height:32px;display:grid;place-items:center;color:var(--muted);text-decoration:none;font-size:20px;border-radius:8px}
.x:hover{background:#232327;color:var(--text)}
.logo{display:block;width:160px;height:160px;margin:0 auto 34px;object-fit:contain;filter:drop-shadow(0 12px 32px rgba(134,239,172,.28))}
h1{margin:0 0 30px;text-align:center;font-size:30px;letter-spacing:-.02em;font-weight:700}
.field{position:relative;margin-bottom:12px}
input{width:100%;background:#1b1b1f;border:1px solid var(--line);border-radius:14px;color:var(--text);padding:15px 52px 15px 48px;font:inherit;font-size:16px;transition:border-color .15s,box-shadow .15s}
input::placeholder{color:#71717a}
input:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px rgba(134,239,172,.18)}
.ico{position:absolute;left:16px;top:50%;transform:translateY(-50%);color:var(--muted);display:flex}
.eye{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:0;color:var(--muted);cursor:pointer;padding:8px;border-radius:8px;display:flex}
.eye:hover{color:var(--text);background:#232327}
.row{display:flex;align-items:center;justify-content:center;margin-top:22px}
.btn{background:var(--accent);color:#052e16;border:0;border-radius:12px;padding:13px 32px;font:inherit;font-size:16px;font-weight:600;cursor:pointer;min-width:140px}
.btn:hover{background:var(--accent-2)}
.err{color:var(--bad);font-size:14px;margin:-14px 0 16px;text-align:center}
@media (max-width:480px){.box{padding:40px 24px 28px;border-radius:20px}.logo{width:120px;height:120px}h1{font-size:26px}}
</style></head><body>
<form class="box" method="post" action="/gate/login" autocomplete="on">
  <a class="x" href="/gate" aria-label="Close">×</a>
  ${hasAssets ? `<img class="logo" src="/gate/logo.png" alt="">` : ""}
  ${error ? `<p class="err">${error}</p>` : ""}
  <input type="hidden" name="next" value="${next.replace(/"/g, "&quot;")}">
  <div class="field"><span class="ico">${ICON_USER}</span><input name="username" placeholder="Username" autocomplete="username" required autofocus></div>
  <div class="field"><span class="ico">${ICON_LOCK}</span><input id="pw" name="password" type="password" placeholder="Password" autocomplete="current-password" required>
    <button class="eye" type="button" id="eye" aria-label="Show password">${ICON_EYE}</button></div>
  <div class="row"><button class="btn" type="submit">Login</button></div>
</form>
<script src="/gate/gate.js"></script>
</body></html>`;
// the show/hide toggle lives in a file: the site's Content-Security-Policy allows no inline scripts
const GATE_JS = `document.getElementById("eye").addEventListener("click",function(){var p=document.getElementById("pw");p.type=p.type==="password"?"text":"password";p.focus();});`;

export function createGate({ user, hash, secret, assetsDir, attemptsPerMinute = 5 } = {}) {
  if (!user || !hash || !secret || secret.length < 32) throw new Error("GATE_USER, GATE_HASH and a long GATE_SECRET are required");
  const asset = (f) => { try { return assetsDir ? readFileSync(`${assetsDir}/${f}`) : null; } catch { return null; } };
  // ⚠ X caches a card per image URL forever: a new image needs a NEW filename (og-v4.png), never a re-upload.
  // ⚠ new icon = new URL (browsers keep a favicon per URL): v3 since 4 Oct 2026
  const assets = { "/gate/logo.png": asset("logo-full.png"), "/gate/favicon-v4.png": asset("favicon-v4-64.png"), "/gate/apple-touch-icon-v3.png": asset("apple-touch-icon-v3.png"), "/og-v4.png": asset("og-v4.png") };
  const hasAssets = !!assets["/gate/logo.png"];
  const tries = new Map();
  const ip = (req) => (req.headers["x-forwarded-for"] ?? "").split(",").pop().trim() || req.socket.remoteAddress;
  const dec = (v) => { try { return decodeURIComponent(v); } catch { return ""; } }; // a malformed cookie is not a login, not a crash
  const cookies = (req) => Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, dec(v.join("="))]));
  const safeNext = (n) => (typeof n === "string" && /^\/(?![\/\\])[^\s\\]*$/.test(n) && !n.startsWith("/gate") ? n : "/"); // browsers read "/\x" as "//x"
  const html = (res, code, body, extra = {}) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", vary: "Cookie", ...extra }); res.end(body); };
  const setCookie = (value, maxAge) => `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

  return http.createServer(async (req, res) => {
    try {
    const url = new URL(req.url, "http://local");
    const logged = verifyCookie(secret, cookies(req)[COOKIE]);
    if (url.pathname === "/gate/check") {
      if (logged) { res.writeHead(204, { "x-gate-user": logged, "cache-control": "no-store", vary: "Cookie" }); return res.end(); }
      const asked = req.headers["x-forwarded-uri"] ?? "/";
      res.writeHead(302, { location: `/gate?next=${encodeURIComponent(safeNext(asked))}`, "cache-control": "no-store", vary: "Cookie" });
      return res.end();
    }
    if (assets[url.pathname]) { res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }); return res.end(assets[url.pathname]); }
    if (url.pathname === "/gate/gate.js") { res.writeHead(200, { "content-type": "application/javascript", "cache-control": "public, max-age=86400" }); return res.end(GATE_JS); }
    if (url.pathname === "/gate/logout") { res.writeHead(302, { location: "/gate", "set-cookie": setCookie("", 0), "cache-control": "no-store" }); return res.end(); }
    if (url.pathname === "/gate" && req.method === "GET") {
      if (logged) { res.writeHead(302, { location: safeNext(url.searchParams.get("next")), "cache-control": "no-store", vary: "Cookie" }); return res.end(); }
      return html(res, 200, page(hasAssets, { next: safeNext(url.searchParams.get("next")) }));
    }
    if (url.pathname === "/gate/login" && req.method === "POST") {
      const who = ip(req), now = Date.now();
      const t = tries.get(who) ?? { n: 0, at: now };
      if (now - t.at > 60_000) { t.n = 0; t.at = now; }
      if (t.n >= attemptsPerMinute) return html(res, 429, page(hasAssets, { error: "Too many attempts. Wait a minute." }));
      t.n++; tries.set(who, t);
      if (tries.size > 10_000) tries.clear();
      let body = "";
      for await (const c of req) { body += c; if (body.length > 4096) { res.writeHead(413); return res.end(); } }
      const f = new URLSearchParams(body);
      const next = safeNext(f.get("next"));
      const okUser = Buffer.from(String(f.get("username") ?? "")).length === Buffer.from(user).length && timingSafeEqual(Buffer.from(String(f.get("username") ?? "")), Buffer.from(user));
      if (!okUser || !verifyPassword(f.get("password") ?? "", hash)) return html(res, 401, page(hasAssets, { error: "Wrong username or password.", next }));
      tries.delete(who);
      res.writeHead(303, { location: next, "set-cookie": setCookie(issueCookie(secret, user), 30 * DAY), "cache-control": "no-store", vary: "Cookie" });
      return res.end();
    }
    res.writeHead(404, { "content-type": "text/plain" }); res.end("not found");
    } catch (e) {
      console.error(new Date().toISOString(), "gate:", e?.message);
      if (!res.headersSent) res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad request");
    }
  });
}
// one request must never take the gate down (Caddy would then refuse every visitor)
process.on("uncaughtException", (e) => console.error(new Date().toISOString(), "gate uncaught:", e?.stack ?? e));
process.on("unhandledRejection", (e) => console.error(new Date().toISOString(), "gate unhandled:", e?.stack ?? e));

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "--hash") {
    const pw = readFileSync(0, "utf8").replace(/\r?\n$/, "");
    if (pw.length < 12) { console.error("password too short"); process.exit(1); }
    console.log(hashPassword(pw));
  } else {
    const port = Number(process.env.GATE_PORT || 5312);
    createGate({ user: process.env.GATE_USER, hash: process.env.GATE_HASH, secret: process.env.GATE_SECRET, assetsDir: process.env.GATE_ASSETS || new URL("../web/public", import.meta.url).pathname })
      .listen(port, "127.0.0.1", () => console.log(`hooker gate on :${port} for user ${process.env.GATE_USER}`));
  }
}
