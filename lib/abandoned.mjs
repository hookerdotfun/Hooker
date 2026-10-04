// Platform fees of a curve that will never graduate. ⛔ The platform's fees normally stay in the pool
// until graduation, because that amount pays the holders' 1:1 top-up and holder share. So a manual
// claim is allowed only on a curve that is plainly abandoned, and never on one that could still fill.
export const ABANDONED_DAYS = Number(process.env.ABANDONED_DAYS ?? 30);

/** Why `launch` may NOT be claimed by hand, or null when it may. `pool` is the live pool state. */
export function abandonedReason({ launch, pool, threshold, now = Math.floor(Date.now() / 1000), days = ABANDONED_DAYS }) {
  if (!launch) return "not a Hooker launch";
  if (launch.status !== "trading") return `its status is ${launch.status}: graduation handles its fees`;
  if (!pool) return "the pool cannot be read";
  if (BigInt(pool.quoteReserve.toString()) >= BigInt(threshold.toString())) return "the curve is full: the graduator will claim its fees";
  const age = (now - launch.created_at) / 86_400;
  if (age < days) return `only ${age.toFixed(1)} days old: a curve counts as abandoned after ${days} days`;
  if (BigInt(pool.partnerQuoteFee.toString()) === 0n) return "no platform fees to claim";
  return null;
}
