async function req(method, path, body, isForm) {
  const r = await fetch(path, {
    method,
    headers: body && !isForm ? { "content-type": "application/json" } : undefined,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}

export const api = {
  info: () => req("GET", "/api/info"),
  launches: () => req("GET", "/api/launches"),
  token: (mint) => req("GET", `/api/token/${mint}`),
  balance: (mint, owner) => req("GET", `/api/token/${mint}/balance/${owner}`),
  wallet: (owner) => req("GET", `/api/wallet/${owner}`),
  upload: (form) => req("POST", "/api/ipfs", form, true),
  launchNonce: (creator) => req("GET", `/api/launch-nonce/${creator}`),
  launchTx: (body) => req("POST", "/api/tx/launch", body),
  swapTx: (body) => req("POST", "/api/tx/swap", body),
  claimTx: (body) => req("POST", "/api/tx/claim", body),
  listTx: (body) => req("POST", "/api/tx/list", body),
  listed: (mint, owner) => req("GET", `/api/token/${mint}/listed/${owner}`),
  send: (tx) => req("POST", "/api/send", { tx }),
  register: (mint) => req("POST", "/api/register", { mint }),
  pairs: () => req("GET", "/api/pairs"),
  trades: () => req("GET", "/api/trades"),
  rewards: (creator) => req("GET", `/api/rewards/${creator}`),
  claimRewards: (body) => req("POST", "/api/tx/claim-rewards", body),
};
