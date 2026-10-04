// The rules a creator can pick, in plain words, with a few example trades each for the picker's demo.
// `id` is what /launch?rule=<id> switches on.
export const RULES = [
  {
    id: "allowlist", s: "Only wallets on your list can buy and hold it.", group: "Who can hold", color: "#4ade80", t: "Allowlist",
    d: "Only the wallets you list can buy it or be sent it. You add the list right after launch and seal it; in the first day you can keep adding. Sells always work.",
    chips: ["up to 5,000 wallets", "seal it for good", "works in every app"],
    demo: [
      { who: "On the list", a: "Buys 0.5 SOL", ok: true },
      { who: "Qm4d…Lk2s", a: "Buys 0.5 SOL", ok: false, why: "not on the allowlist" },
      { who: "On the list", a: "Sends to an unlisted wallet", ok: false, why: "not on the allowlist" },
      { who: "On the list", a: "Sells back to the curve", ok: true },
    ],
  },
  {
    id: "blocklist", s: "Named wallets can never receive the token.", group: "Who can hold", color: "#fb923c", t: "Blocklist",
    d: "The wallets you list can never buy it or be sent it, for the life of the curve. Known snipers and bundlers stay out. Anyone else trades as normal.",
    chips: ["up to 5,000 wallets", "seal it for good", "works in every app"],
    demo: [
      { who: "Bk7s…Pq1z", a: "Buys 0.5 SOL", ok: false, why: "on the blocklist" },
      { who: "Ny2c…Fd8w", a: "Buys 0.5 SOL", ok: true },
      { who: "Ny2c…Fd8w", a: "Sends to Bk7s…Pq1z", ok: false, why: "on the blocklist" },
    ],
  },
  {
    id: "maxWallet", s: "No wallet can hold more than a set share of supply.", group: "Fair launch", color: "#86efac", t: "Max per wallet",
    d: "No wallet can hold more than the share of supply you pick. A buy that would cross it never lands, so one wallet cannot take the curve.",
    chips: ["checked on every transfer", "creator exempt", "sells always work"],
    demo: [
      { who: "7xKp…q2Lm", a: "Buys 0.6% of supply", ok: true },
      { who: "Fz9d…Wa1c", a: "Buys 3.4% of supply", ok: false, why: "over the 3% wallet cap" },
      { who: "7xKp…q2Lm", a: "Sends 0.3% to a friend", ok: true },
      { who: "Fz9d…Wa1c", a: "Sells 1.1% back to the curve", ok: true },
    ],
  },
  {
    id: "window", s: "A tighter cap for the first minutes, against snipers.", group: "Fair launch", color: "#60a5fa", t: "Launch window",
    d: "For the first minutes after launch a tighter cap applies, so nobody can load up while the price is lowest. When the window ends the normal cap takes over.",
    chips: ["minutes to a day", "chain clock", "then the normal cap"],
    demo: [
      { who: "Bq3n…pR8s", a: "Buys 0.4% at 0:12", ok: true },
      { who: "Hm2v…Kx7t", a: "Buys 1.5% at 0:40", ok: false, why: "window cap is 0.5% for 5 minutes" },
      { who: "Hm2v…Kx7t", a: "Buys 1.5% at 5:02", ok: true },
    ],
  },
  {
    id: "ramp", s: "Max per wallet starts small and rises on a timer.", group: "Fair launch", color: "#c084fc", t: "Rising max per wallet",
    d: "The max per wallet starts at a small share of supply and rises evenly to the full cap over the time you pick, so early wallets cannot take a big piece.",
    chips: ["start and end cap", "minutes to a week", "chain clock"],
    demo: [
      { who: "Ea4m…Rt9c", a: "Holds 0.9% at minute 1", ok: false, why: "cap is 0.5% right now" },
      { who: "Ea4m…Rt9c", a: "Holds 0.9% at minute 20", ok: true, why: "cap has risen to 1.6%" },
    ],
  },
  {
    id: "tradeGuard", s: "No single trade can move more than a set share of supply.", group: "Fair launch", color: "#facc15", t: "Trade guard",
    d: "Any one buy or transfer can move at most the share of supply you pick. Big buyers have to split up, which keeps the chart honest. Sells are never limited.",
    chips: ["per transfer", "sells unlimited", "creator exempt"],
    demo: [
      { who: "Wh9a…Mk3d", a: "Buys 0.4% in one go", ok: true },
      { who: "Wh9a…Mk3d", a: "Buys 2% in one go", ok: false, why: "over the 1% trade guard" },
    ],
  },
  {
    id: "snipe", s: "Buys paying sniper-sized priority fees are refused at launch.", group: "Fair launch", color: "#f472b6", t: "Sniper-fee cap",
    d: "For the first minutes after launch, a buy is refused if its transaction pays a priority fee above your cap, or tips one of Jito's tip accounts more than your cap in the same transaction. It makes outbidding everyone expensive; a tip sent in a separate transaction or through another relay is not seen.",
    chips: ["priority fee cap", "Jito tips in the same transaction", "launch minutes only"],
    demo: [
      { who: "Normal buyer", a: "Buys with a normal fee", ok: true },
      { who: "Sn1p…Bot7", a: "Buys with a 0.01 SOL tip", ok: false, why: "above the tip cap" },
    ],
  },
  {
    id: "bundle", s: "Only a few buys per block, so bundlers can't sweep the launch.", group: "Fair launch", color: "#f87171", t: "Anti-bundle",
    d: "Only the number of buys you pick can land in one block. A bundle of twenty wallets buying in the same block gets one or two through, not twenty.",
    chips: ["buys per block", "counted on chain", "sells not counted"],
    demo: [
      { who: "Bundle 1/20", a: "Buys in block 301,442,118", ok: true },
      { who: "Bundle 2/20", a: "Buys in block 301,442,118", ok: false, why: "1 buy per block" },
      { who: "Bundle 2/20", a: "Buys in the next block", ok: true },
    ],
  },
  {
    // ⛔ 4 Oct 2026: a hook the creator picks, off by default. It is the token's Meteora config (a flat-fee
    // config otherwise), not a hook rule. "Curve only" (venueLock) was taken off the site the same day.
    id: "antiSnipe", s: "The trading fee starts at 50% and falls to 1% over two minutes.", group: "Fair launch", color: "#60a5fa", t: "Anti-snipe fee",
    d: "For the first two minutes after launch the trading fee starts at 50% and falls to the normal 1%, so sniping the launch is expensive. Your own buy inside the launch pays only 1%.",
    chips: ["first two minutes", "50% falling to 1%", "your buy pays 1%"],
    demo: [
      { who: "Snp4…x9Qa", a: "Buys in the first second", ok: true, why: "pays a fee of about 50%" },
      { who: "Cv8a…Lm4e", a: "Buys after two minutes", ok: true, why: "pays the normal 1%" },
    ],
  },
  {
    id: "fomoOnly", s: "Only the FOMO app can buy. Selling works anywhere.", group: "Where and when", color: "#facc15", t: "FOMO only", gated: true,
    d: "Only the FOMO app can buy, because only FOMO can co-sign its own trades. Selling works anywhere.",
    chips: ["FOMO co-signs", "sells anywhere", "creator exempt"],
    demo: [
      { who: "FOMO user", a: "Buys 0.5 SOL in FOMO", ok: true },
      { who: "Jr6w…Tz2q", a: "Buys 0.5 SOL from a bot", ok: false, why: "no FOMO signature" },
      { who: "Jr6w…Tz2q", a: "Sells anywhere", ok: true },
    ],
  },
  {
    id: "hours", s: "Trades only on the days and hours you set, in any time zone.", group: "Where and when", color: "#60a5fa", t: "Trading hours",
    d: "It can only be bought on the days and between the times you pick, in your time zone. Outside them, holders can still sell and send.",
    chips: ["days and times", "your time zone", "sells always work"],
    demo: [
      { who: "Mon 10:15", a: "Buys 0.5 SOL", ok: true },
      { who: "Sat 03:40", a: "Buys 0.5 SOL", ok: false, why: "outside trading hours" },
      { who: "Sat 03:40", a: "Sells", ok: true },
    ],
  },
  {
    id: "fee", s: "Bigger buys pay more, in tokens, to the treasury.", group: "At graduation", color: "#fb923c", t: "Size fee",
    d: "Bigger buys pay more. Each buy pays a base share plus a little per SOL, up to a cap, taken in coins when it graduates.",
    chips: ["base + per SOL", "capped", "from public history"],
    demo: [
      { who: "Pa1x…Dd3w", a: "Buys 0.2 SOL", ok: true, why: "pays 0.6%" },
      { who: "Ws5k…Rn9b", a: "Buys 4 SOL", ok: true, why: "pays 2.5%" },
      { who: "Ty7m…Ec1f", a: "Buys 12 SOL", ok: true, why: "pays the 5% cap" },
    ],
  },
  {
    id: "burn", s: "A share of every buy is burned on the Pumpfun coin.", group: "At graduation", color: "#f87171", t: "Auto burn",
    d: "A share of every buy is burned on the Pumpfun coin at graduation, so the supply holders share is smaller from day one.",
    chips: ["every buy", "burned on Pumpfun", "public tx"],
    demo: [
      { who: "Graduation", a: "2% of all buys", ok: true, why: "burned on the Pumpfun coin" },
    ],
  },
  {
    id: "share", s: "Part of the platform's trading fees buys extra coins for holders.", group: "At graduation", color: "#f472b6", t: "Holder share",
    d: "First, the platform's trading fees top every holder up to one Pumpfun coin per token they held. Part of what is left buys extra coins for holders, shared by how much they held and for how long.",
    chips: ["balance x time", "paid at graduation", "automatic"],
    demo: [
      { who: "Long holder", a: "Held 2% for the whole curve", ok: true, why: "biggest extra share" },
      { who: "Flipper", a: "Held 2% for a minute", ok: true, why: "a sliver" },
    ],
  },
  {
    id: "holderRewards", s: "Pumpfun's creator rewards go to holders.", group: "At graduation", color: "#4ade80", t: "Creator fees to holders",
    d: "After graduation, the Pumpfun coin's creator fees go to its holders instead of the creator, through Pumpfun's own holder rewards.",
    chips: ["Pumpfun holder rewards", "after graduation", "forever"],
    demo: [
      { who: "Pumpfun", a: "Creator fees on every trade", ok: true, why: "paid to holders" },
    ],
  },
];

export const rulesFor = (info) => RULES.filter((r) => !r.gated || info?.fomoOnly);
