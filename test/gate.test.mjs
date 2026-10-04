import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createGate, hashPassword, verifyPassword, issueCookie, verifyCookie, COOKIE } from "../server/gate.mjs";

const secret = "a".repeat(64), pw = "correct horse battery staple!";
let server, base;
before(async () => {
  server = createGate({ user: "admin", hash: hashPassword(pw), secret, attemptsPerMinute: 3 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const get = (path, headers = {}) => fetch(base + path, { headers, redirect: "manual" });
const login = (username, password, next = "/launch") => fetch(base + "/gate/login", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "9.9.9.9" }, body: new URLSearchParams({ username, password, next }) });

test("passwords hash and verify; a wrong one fails", () => {
  const h = hashPassword(pw);
  assert.ok(h.startsWith("scrypt:") && verifyPassword(pw, h) && !verifyPassword(pw + "x", h) && !verifyPassword("", h));
});

test("cookies are signed, time-limited and tamper-proof", () => {
  const c = issueCookie(secret, "admin", 1000);
  assert.equal(verifyCookie(secret, c, { now: 1000 + 86_400 }), "admin");
  assert.equal(verifyCookie(secret, c, { now: 1000 + 40 * 86_400 }), null);           // expired
  assert.equal(verifyCookie("b".repeat(64), c, { now: 1000 }), null);                 // other secret
  assert.equal(verifyCookie(secret, c.replace("admin", "root"), { now: 1000 }), null); // tampered
  assert.equal(verifyCookie(secret, "", {}), null);
});

test("without a cookie every request is sent to the login page, keeping where it was going", async () => {
  const r = await get("/gate/check", { "x-forwarded-uri": "/t/abc" });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/gate?next=%2Ft%2Fabc");
  assert.equal(r.headers.get("vary"), "Cookie");
  const api = await get("/gate/check", { "x-forwarded-uri": "/api/launches" });
  assert.equal(api.status, 302);
});

test("a wrong password gets no cookie; the right one does, and then everything is allowed", async () => {
  const bad = await login("admin", "nope");
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("set-cookie"), null);
  const wrongUser = await login("root", pw);
  assert.equal(wrongUser.status, 401);
  const good = await login("admin", pw, "/launch");
  assert.equal(good.status, 303);
  assert.equal(good.headers.get("location"), "/launch");
  const cookie = good.headers.get("set-cookie");
  assert.match(cookie, new RegExp(`^${COOKIE}=.*HttpOnly; Secure; SameSite=Lax`));
  const value = cookie.split(";")[0];
  const ok = await get("/gate/check", { cookie: value, "x-forwarded-uri": "/api/launches" });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("x-gate-user"), "admin");
  const tampered = await get("/gate/check", { cookie: value.slice(0, -2) + "zz" });
  assert.equal(tampered.status, 302);
});

test("a malformed cookie is not a login and not a crash", async () => {
  const r = await get("/gate/check", { cookie: "hooker_gate=%", "x-forwarded-uri": "/" });
  assert.equal(r.status, 302);
  assert.equal((await get("/gate/check", { cookie: "hooker_gate=%E0%A4%A", "x-forwarded-uri": "/" })).status, 302);
});

test("the login page never redirects off-site", async () => {
  const r = await login("admin", pw, "https://evil.example/");
  assert.equal(r.headers.get("location"), "/");
  const r2 = await login("admin", pw, "//evil.example");
  assert.equal(r2.headers.get("location"), "/");
  const r3 = await login("admin", pw, "/\\evil.example");
  assert.equal(r3.headers.get("location"), "/");
});

test("guessing is rate limited per address", async () => {
  const hit = () => fetch(base + "/gate/login", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "1.2.3.4" }, body: new URLSearchParams({ username: "admin", password: "x" }) });
  for (let i = 0; i < 3; i++) assert.equal((await hit()).status, 401);
  assert.equal((await hit()).status, 429);
});
