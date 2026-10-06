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
    id: "plague", s: "Nobody can buy until a holder infects them by sending some.", group: "Who can hold", color: "#a3e635", t: "Plague",
    d: "A wallet can only buy once it already holds the dose you pick. It starts with you: send tokens to the first wallets, and each of them can buy and infect others by sending tokens on. Sell or send away everything and you have to be infected again. Selling is never restricted.",
    chips: ["spreads by sends", "you start it", "sells always work"],
    demo: [
      { who: "Fresh wallet", a: "Buys 0.5 SOL", ok: false, why: "not infected" },
      { who: "Creator", a: "Sends 10 tokens to it", ok: true },
      { who: "Now infected", a: "Buys 0.5 SOL", ok: true },
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
    id: "antiDump", s: "Separate caps on one buy and one sell, so nobody dumps a bag at once.", group: "Fair launch", color: "#fde047", t: "Anti-dump caps",
    d: "The hook tells buys from sells and caps each side on its own: buyers can come in freely while no single sell can unload a big bag. The sell cap holds for the creator too.",
    chips: ["buy cap", "sell cap", "creator's sells too"],
    demo: [
      { who: "Ka3e…Wq9d", a: "Buys 1.5% in one go", ok: true },
      { who: "Ka3e…Wq9d", a: "Sells 1.5% in one go", ok: false, why: "over the 0.25% sell cap" },
      { who: "Ka3e…Wq9d", a: "Sells 0.2%", ok: true },
    ],
  },
  {
    id: "sellScale", s: "The bigger the bag, the smaller one sell can be.", group: "Fair launch", color: "#fbbf24", t: "Graduated sell caps",
    d: "Small holders sell freely. As a bag grows, the most it can sell in one go shrinks, down to a floor, so a whale can build a position but has to leave in small pieces. The hook reads the bag from the sell itself.",
    chips: ["by bag size", "down to a floor", "creator too"],
    demo: [
      { who: "Small bag 0.2%", a: "Sells all of it", ok: true },
      { who: "Whale 3%", a: "Sells 1%", ok: false, why: "a 3% bag sells 0.1% at a time" },
      { who: "Whale 3%", a: "Sells 0.1%", ok: true },
    ],
  },
  {
    id: "chapters", s: "Max per wallet starts small and doubles every chapter of volume.", group: "Fair launch", color: "#a3e635", t: "Chapters",
    d: "A max per wallet that grows with the token. It starts at the share you pick and doubles every time another chapter of volume trades, so the token opens up as it earns it. Selling always works.",
    chips: ["doubles per chapter", "volume counted on chain", "sells always work"],
    demo: [
      { who: "Chapter 1", a: "Holds 0.8% (cap 0.5%)", ok: false, why: "chapter 1 cap is 0.5%" },
      { who: "Chapter 2", a: "Holds 0.8% (cap 1%)", ok: true, why: "the cap doubled" },
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
    id: "market", s: "Trades like a stock: weekdays 9:30 to 16:00 New York time.", group: "Where and when", color: "#22d3ee", t: "Market hours",
    d: "Trades only Monday to Friday, 9:30 to 16:00 in New York, following daylight saving on chain, and closed on US stock market holidays. You choose whether sells stay open around the clock. Wallet-to-wallet sends always work.",
    chips: ["New York time", "daylight saving on chain", "market holidays"],
    demo: [
      { who: "Tue 10:15 NY", a: "Buys 0.5 SOL", ok: true },
      { who: "Sat 11:00 NY", a: "Buys 0.5 SOL", ok: false, why: "market closed" },
      { who: "Thanksgiving", a: "Buys 0.5 SOL", ok: false, why: "market holiday" },
    ],
  },
  {
    id: "dexOnly", s: "No wallet-to-wallet sends: every move is a trade.", group: "Where and when", color: "#94a3b8", t: "DEX-only",
    d: "It only moves when it is bought from or sold to its curve. A plain wallet-to-wallet send is refused, yours included, so nobody can pass tokens around off the market.",
    chips: ["trades only", "no sends", "creator too"],
    demo: [
      { who: "Dx2a…Mm7c", a: "Buys 0.5 SOL", ok: true },
      { who: "Dx2a…Mm7c", a: "Sends to a friend", ok: false, why: "DEX-only" },
      { who: "Dx2a…Mm7c", a: "Sells", ok: true },
    ],
  },
  {
    id: "p2pOnly", s: "Only you buy from the curve; it moves wallet to wallet.", group: "Where and when", color: "#e879f9", t: "P2P-only",
    d: "Nobody can buy or sell it on a market. Only you can buy from the curve, even all of it, and hand tokens out; holders pass them wallet to wallet. When the curve fills it graduates like any other.",
    chips: ["you fill the curve", "wallet to wallet", "nobody sells to the curve"],
    demo: [
      { who: "Creator", a: "Buys 2 SOL from the curve", ok: true },
      { who: "Gx4b…Ra8d", a: "Buys 0.5 SOL", ok: false, why: "only the creator buys" },
      { who: "Creator", a: "Sends 1% to Gx4b…Ra8d", ok: true },
      { who: "Gx4b…Ra8d", a: "Sells to the curve", ok: false, why: "P2P-only" },
    ],
  },
  {
    id: "potato", s: "Whoever bought last cannot sell until someone else buys.", group: "Games", color: "#fb923c", t: "Hot potato",
    d: "The last buyer holds the hot potato: they cannot sell or send until a different wallet buys after them. Everyone else trades freely and buys are never blocked. A buy has to reach your minimum to pass it on, and you can let it go cold after a while. Nobody is exempt, you included.",
    chips: ["last buyer is stuck", "minimum to pass it", "goes cold if you want"],
    demo: [
      { who: "Hp1a…Nn4e", a: "Buys 0.3%", ok: true, why: "now holds the potato" },
      { who: "Hp1a…Nn4e", a: "Sells", ok: false, why: "holding the potato" },
      { who: "Zr8c…Ty2b", a: "Buys 0.2%", ok: true, why: "takes the potato" },
      { who: "Hp1a…Nn4e", a: "Sells", ok: true },
    ],
  },
  {
    id: "ping", s: "Buys and sells take turns.", group: "Games", color: "#38bdf8", t: "Ping pong",
    d: "After a buy the next trade must be a sell, and after a sell a buy, for everyone, the creator included. Trades under your minimum go through on their own turn without handing it over, one transaction cannot take both turns, and if nobody takes the turn for a while either side can go.",
    chips: ["no two turns in one transaction", "dust cannot game it", "sends always work"],
    demo: [
      { who: "Pq2m…Lx8a", a: "Buys 0.2%", ok: true, why: "sellers next" },
      { who: "Rt6b…Hc1d", a: "Buys 0.1%", ok: false, why: "it is the sellers' turn" },
      { who: "Ws3k…Pd9e", a: "Sells 0.1%", ok: true, why: "buyers next" },
    ],
  },
  {
    id: "king", s: "The biggest buy wears the crown and earns from every trade.", group: "Games", color: "#facc15", t: "King of the Hill",
    d: "The largest buy holds the crown. Beat the King's winning buy in one buy and you take it; the bar slowly halves, so the throne never becomes unreachable. While they reign the King earns 0.3% of every trade's value, paid in SOL from Hooker's share of the fees. Selling or sending any tokens gives the crown up.",
    chips: ["0.3% of every trade", "paid in SOL", "bar halves over time"],
    demo: [
      { who: "Kg5a…Vb2x", a: "Buys 0.5 SOL", ok: true, why: "takes the crown" },
      { who: "Qm7c…Ju4w", a: "Buys 0.52 SOL", ok: true, why: "not 10% more: no crown" },
      { who: "Qm7c…Ju4w", a: "Buys 0.6 SOL", ok: true, why: "the new King" },
      { who: "Kg5a…Vb2x", a: "Earned while reigning", ok: true, why: "0.3% of the trades, in SOL" },
    ],
  },
  {
    id: "breath", s: "The buy cap breathes in and out on a fixed cycle.", group: "Physics", color: "#2dd4bf", t: "Breathing cap",
    d: "An oscillator in the hook swings the most one buy can take up and down on a fixed cycle, forever: wide open at the peaks, tight at the troughs. You pick the cycle, the base cap and the swing. Sells and sends are never capped.",
    chips: ["fixed cycle", "base and swing", "sells never capped"],
    demo: [
      { who: "At the peak", a: "Buys 1.5%", ok: true, why: "cap is 1.6%" },
      { who: "At the trough", a: "Buys 1.5%", ok: false, why: "cap is 0.4%" },
    ],
  },
  {
    id: "momentum", s: "Every buy kicks the buy cap up; it swings back when trading goes quiet.", group: "Physics", color: "#818cf8", t: "Momentum",
    d: "A damped oscillator that starts at rest. Every buy kicks it, so a run of buying opens room for bigger buys; then it swings back and settles when trading goes quiet. Sells and sends are never capped.",
    chips: ["buys kick it", "settles when quiet", "sells never capped"],
    demo: [
      { who: "At rest", a: "Buys 1.2%", ok: false, why: "cap is 1%" },
      { who: "After a run of buys", a: "Buys 1.2%", ok: true, why: "cap swung up to 1.5%" },
    ],
  },
  {
    id: "resonance", s: "Buys on the beat swing the cap furthest.", group: "Physics", color: "#c084fc", t: "Resonance",
    d: "Momentum tuned for rhythm: buys that land in step with the natural period pile energy on and swing the cap far wider than scattered buys. A community buying on the beat unlocks the biggest buys. Sells and sends are never capped.",
    chips: ["on the beat", "low damping", "sells never capped"],
    demo: [
      { who: "Scattered buys", a: "Swing the cap a little", ok: true },
      { who: "Buys every 60 s", a: "Swing the cap twice as far", ok: true, why: "in step with the beat" },
    ],
  },
  {
    id: "coupled", s: "Two coupled oscillators: the buy cap swells and fades in beats.", group: "Physics", color: "#f472b6", t: "Coupled resonator",
    d: "Two oscillators in the hook, coupled. Buys energise the first, which sets the cap, and the coupling pours that energy into the second and back, so the cap swells and fades in beats. Sells and sends are never capped.",
    chips: ["two oscillators", "beats", "sells never capped"],
    demo: [
      { who: "Right after a buy", a: "Cap swings wide", ok: true },
      { who: "Half a beat later", a: "Cap near its base", ok: true, why: "the energy moved over" },
    ],
  },
  {
    id: "fee", s: "Bigger buys pay more, in tokens, to the treasury.", group: "At graduation", color: "#fb923c", t: "Size fee",
    d: "Bigger buys pay more. Each buy pays a base share plus a little per SOL or ETH, up to a cap, taken in tokens.",
    chips: ["base + per SOL or ETH", "capped", "from public history"],
    demo: [
      { who: "Pa1x…Dd3w", a: "Buys 0.2 SOL", ok: true, why: "pays 0.6%" },
      { who: "Ws5k…Rn9b", a: "Buys 4 SOL", ok: true, why: "pays 2.5%" },
      { who: "Ty7m…Ec1f", a: "Buys 12 SOL", ok: true, why: "pays the 5% cap" },
    ],
  },
  {
    id: "burn", s: "A share of every buy is burned.", group: "At graduation", color: "#f87171", t: "Auto burn",
    d: "A share of every buy is burned, so the supply holders share is smaller from day one.",
    chips: ["every buy", "burned", "public tx"],
    demo: [
      { who: "Graduation", a: "2% of all buys", ok: true, why: "burned" },
    ],
  },
  {
    id: "share", s: "Part of the platform's trading fees buys extra coins for holders.", group: "At graduation", color: "#f472b6", t: "Holder share",
    d: "Part of the platform's trading fees buys extra coins for holders at graduation, shared by how much they held and for how long. On Pumpfun, the fees first top every holder up to one coin per token they held.",
    chips: ["balance x time", "paid at graduation", "automatic"],
    demo: [
      { who: "Long holder", a: "Held 2% for the whole curve", ok: true, why: "biggest extra share" },
      { who: "Flipper", a: "Held 2% for a minute", ok: true, why: "a sliver" },
    ],
  },
  {
    id: "holderRewards", s: "The coin's creator fees go to its holders instead of the $HOOKER burn.", group: "At graduation", color: "#4ade80", t: "Creator fees to holders",
    d: "After graduation, the coin's creator fees go to its holders, through Pumpfun's holder rewards or Pons's holder fee sharing. Without this hook they buy and burn $HOOKER.",
    chips: ["holder rewards", "after graduation", "forever"],
    demo: [
      { who: "Pumpfun or Pons", a: "Creator fees on every trade", ok: true, why: "paid to holders" },
    ],
  },
];

/** The v3 hook rules: shown only once the upgraded hook is live (GET /api/info `v3Rules`). */
const V3_IDS = new Set(["antiDump", "sellScale", "chapters", "plague", "market", "dexOnly", "p2pOnly", "potato", "ping", "king", "breath", "momentum", "resonance", "coupled"]);
export const rulesFor = (info) => RULES.filter((r) => (!r.gated || info?.fomoOnly) && (!V3_IDS.has(r.id) || info?.v3Rules));
