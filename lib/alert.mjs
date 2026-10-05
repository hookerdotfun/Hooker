// Alerting: what is wrong right now, and telling a person once (not every two minutes).
//
// ⛔ Why: on 4 Oct 2026 a graduation sat at `burned` doing nothing, and it was only seen because
// someone happened to be watching the log. The watchdog (server/watchdog.mjs) runs from a systemd
// timer, OUTSIDE the graduator, so a graduator that died or hung is reported too.
//
// Delivery: ALERT_WEBHOOK (any JSON POST: Discord, Slack, …, the same variable pump.family and
// charity use) and/or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID. Neither set = log only.
// Pure functions here (checks → problems, problems + state → messages) so tests need no box.

export const GRADUATING = ["complete", "fee_withdrawn", "fees_claimed", "indexed", "launched", "settled", "burned", "pushed", "migrated"];

/** A problem still open after this long is sent again, so a muted first message is not the end of it. */
export const REPEAT_MS = Number(process.env.ALERT_REPEAT_MS ?? 6 * 3600_000);

/**
 * Everything wrong right now, as { key, text }. `key` is stable while the same thing stays wrong.
 * ⛔ An input that could not be READ (null) is not evidence of a problem and raises nothing here;
 * the API check covers an RPC that is down.
 */
export function findProblems({ nowSec, heartbeat, apiOk, apiWhy, gateExpected, gateOk, launches = [], hotLamports, hotLowLamports, newestBackupSec, hotWallet, evm = null }) {
  const out = [];
  if (heartbeat == null) out.push({ key: "graduator-down", text: "🛑 Graduator is NOT running (no ledger lock held). Graduations and the sweep are stopped. `systemctl status hooker-graduator`" });
  else if (nowSec - heartbeat > 180) out.push({ key: "graduator-down", text: `🛑 Graduator heartbeat is ${Math.round((nowSec - heartbeat) / 60)} min old: it is hung or dead. Graduations and the sweep are stopped. \`journalctl -u hooker-graduator -n 50\`` });
  if (apiOk === false) out.push({ key: "api-down", text: `🛑 hooker-api is not answering /api/health (${apiWhy ?? "no answer"}). The site cannot launch or trade.` });
  if (gateExpected && gateOk === false) out.push({ key: "gate-down", text: "🛑 hooker-gate is not answering: every request to hooker.fun fails while the gate is in Caddy." });
  for (const l of launches) {
    const name = `${l.symbol ? "$" + l.symbol + " " : ""}${l.mint}`;
    if (l.status === "stalled") out.push({ key: `stalled:${l.mint}`, text: `🛑 Graduation STALLED: ${name} stopped at ${l.stalled_from ?? "?"} after ${l.attempts} failures and needs a person. Last error: ${String(l.error ?? "").slice(0, 300)}` });
    else if (GRADUATING.includes(l.status) && l.attempts >= 5) out.push({ key: `retrying:${l.mint}`, text: `⚠ Graduation struggling: ${name} at ${l.status}, ${l.attempts} failed passes in a row (parks as stalled at 30). Last error: ${String(l.error ?? "").slice(0, 300)}` });
    else if (GRADUATING.includes(l.status) && l.updated_at && nowSec - l.updated_at > 1800) out.push({ key: `stuck:${l.mint}`, text: `⚠ Graduation not moving: ${name} has sat at ${l.status} for ${Math.round((nowSec - l.updated_at) / 60)} min with no error. A step may be finding nothing to do.` });
  }
  if (hotLamports != null && hotLowLamports != null && hotLamports < hotLowLamports)
    out.push({ key: "hot-low", text: `⚠ Hot wallet is LOW: ${(hotLamports / 1e9).toFixed(4)} SOL on ${hotWallet} (alert under ${hotLowLamports / 1e9}). It pays every graduation's fees and the lookup table; top it up.` });
  // Robinhood Chain (Pons): its own graduation service, its failures, and the ETH it pays gas with
  if (evm) {
    if (evm.status == null) out.push({ key: "evm-graduator-down", text: "🛑 Robinhood Chain graduator has never reported (no status file). Pons graduations are not running. `systemctl status hooker-evm-graduator`" });
    else if (nowSec - evm.status.at > 180) out.push({ key: "evm-graduator-down", text: `🛑 Robinhood Chain graduator last reported ${Math.round((nowSec - evm.status.at) / 60)} min ago: it is hung or dead. Pons graduations are stopped. \`journalctl -u hooker-evm-graduator -n 50\`` });
    for (const f of evm.status?.failing ?? []) {
      if (f.n >= 5) out.push({ key: `evm-failing:${f.token}`, text: `⚠ Pons graduation struggling: ${f.step} for ${f.token} failed ${f.n} times in a row. Last error: ${f.why}` });
    }
    if (evm.wei != null && evm.lowWei != null && evm.wei < evm.lowWei)
      out.push({ key: "evm-low", text: `⚠ Robinhood Chain graduation wallet is LOW: ${(Number(evm.wei) / 1e18).toFixed(5)} ETH on ${evm.wallet} (alert under ${Number(evm.lowWei) / 1e18}). It pays the gas for every Pons graduation; top it up.` });
  }
  if (newestBackupSec !== undefined && (newestBackupSec === null || nowSec - newestBackupSec > 3600))
    out.push({ key: "backup-stale", text: newestBackupSec === null ? "⚠ No ledger backups exist in the backups folder." : `⚠ Newest ledger backup is ${Math.round((nowSec - newestBackupSec) / 60)} min old (want ≤ 15). \`systemctl status hooker-backup.timer\`` });
  return out;
}

/**
 * Which messages to send now, and the state to keep. A problem is sent when it first appears, again
 * every REPEAT_MS while it lasts, and a ✅ line when it clears. Only a problem that was actually SENT
 * gets a "resolved" line, so a blip shorter than one run stays quiet.
 */
export function plan(problems, state, nowMs, repeatMs = REPEAT_MS) {
  const next = {}, messages = [];
  for (const p of problems) {
    const prev = state[p.key];
    const since = prev?.since ?? nowMs;
    if (prev?.sentAt == null || nowMs - prev.sentAt >= repeatMs) {
      const again = prev?.sentAt != null ? ` (still, since ${new Date(since).toISOString().slice(0, 16).replace("T", " ")} UTC)` : "";
      messages.push({ key: p.key, text: p.text + again });
      next[p.key] = { since, sentAt: null, text: p.text, pendingSend: true, prevSentAt: prev?.sentAt ?? null };
    } else next[p.key] = { since, sentAt: prev.sentAt, text: p.text };
  }
  for (const [key, prev] of Object.entries(state)) {
    if (next[key] || key.startsWith("_")) continue;
    if (prev.sentAt != null) messages.push({ key, resolved: true, text: `✅ Resolved: ${prev.text.replace(/^\S+\s/, "").split(". ")[0]}` });
  }
  for (const [k, v] of Object.entries(state)) if (k.startsWith("_")) next[k] = v;
  return { messages, next };
}

/** After sending: a message that went out is marked sent; one that failed stays due for the next run. */
export function settle(next, results, nowMs) {
  for (const [key, v] of Object.entries(next)) {
    if (!v.pendingSend) continue;
    const ok = results.get(key);
    next[key] = { since: v.since, text: v.text, sentAt: ok ? nowMs : v.prevSentAt };
  }
  return next;
}

/** True when some channel is configured. */
export const channels = (e = process.env) => ({
  webhook: (e.ALERT_WEBHOOK ?? "").trim() || null,
  telegram: e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHAT_ID ? { token: e.TELEGRAM_BOT_TOKEN.trim(), chat: e.TELEGRAM_CHAT_ID.trim() } : null,
});

/** Sends one line to every configured channel. True if at least one accepted it. Never throws. */
export async function deliver(text, { ch = channels(), fetchImpl = fetch, log = console.log } = {}) {
  const body = `hooker.fun · ${text}`;
  let ok = false;
  if (ch.webhook) {
    try {
      const r = await fetchImpl(ch.webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: body, text: body }), signal: AbortSignal.timeout(8000) });
      if (r.ok) ok = true; else log(`alert webhook returned ${r.status}`);
    } catch (e) { log(`alert webhook failed: ${String(e).slice(0, 80)}`); }
  }
  if (ch.telegram) {
    try {
      const r = await fetchImpl(`https://api.telegram.org/bot${ch.telegram.token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: ch.telegram.chat, text: body, disable_web_page_preview: true }), signal: AbortSignal.timeout(8000) });
      if (r.ok) ok = true; else log(`telegram returned ${r.status}: ${(await r.text()).slice(0, 120)}`);
    } catch (e) { log(`telegram failed: ${String(e).replace(/bot\d+:[\w-]+/g, "bot…").slice(0, 80)}`); }
  }
  return ok;
}
