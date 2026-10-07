import { Link } from "react-router-dom";
import { rulesFor } from "../lib/catalog.js";
import { useMode } from "../lib/mode.jsx";

// line icons, one per rule (24px grid, stroked)
const ICONS = {
  antiSnipe: <><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
  allowlist: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="m16 11 2 2 4-4" /></>,
  blocklist: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="m17 8 5 5M22 8l-5 5" /></>,
  ramp: <><path d="M22 7 13.5 15.5l-5-5L2 17" /><path d="M16 7h6v6" /></>,
  tradeGuard: <path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z" />,
  snipe: <path d="M4 14a1 1 0 0 1-.8-1.6l9.9-10.2a.5.5 0 0 1 .9.5l-1.9 6A1 1 0 0 0 13 10h7a1 1 0 0 1 .8 1.6l-9.9 10.2a.5.5 0 0 1-.9-.5l1.9-6A1 1 0 0 0 11 14z" />,
  bundle: <><path d="m12 2 10 5-10 5L2 7z" /><path d="m2 17 10 5 10-5M2 12l10 5 10-5" /></>,
  hours: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18M12 14v3l2 1" /></>,
  maxWallet: <><path d="M19 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v3h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-1" /><path d="M3 6v13a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" /></>,
  window: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2.5M10 2h4" /></>,
  venueLock: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  fomoOnly: <><rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="M11 18h2" /></>,
  fee: <><path d="M3 3v18h18" /><path d="M7 16v-3M12 16V9M17 16V5" /></>,
  burn: <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3a2.5 2.5 0 0 0 2.5 2.5z" />,
  share: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>,
  // ── v3 hooks ──
  // plague: a biohazard mark
  plague: <><circle cx="12" cy="11.9" r="2" /><path d="M6.7 3.4c-.9 2.5 0 5.2 2.2 6.7C6.5 9 3.7 9.6 2 11.6" /><path d="m8.9 10.1 1.4.8" /><path d="M17.3 3.4c.9 2.5 0 5.2-2.2 6.7 2.4-1.2 5.2-.6 6.9 1.5" /><path d="m15.1 10.1-1.4.8" /><path d="M16.7 20.8c-2.6-.4-4.6-2.6-4.7-5.3-.2 2.6-2.1 4.8-4.7 5.2" /><path d="M12 13.9v1.6" /><path d="M13.5 5.4c-1-.2-2-.2-3 0" /><path d="M17 16.4c.7-.7 1.2-1.6 1.5-2.5" /><path d="M5.5 13.9c.3.9.8 1.8 1.5 2.5" /></>,
  // anti-dump: a cap on each side (max per buy, max per sell)
  antiDump: <><path d="M4 3h16M4 21h16" /><path d="m8 8 4-4 4 4M8 16l4 4 4-4" /><path d="M12 4v16" /></>,
  // graduated sell caps: bars that shrink as the bag grows
  sellScale: <><path d="M5 20V5" /><path d="M10 20v-11" /><path d="M15 20v-6" /><path d="M20 20v-2" /></>,
  // chapters: an open book
  chapters: <><path d="M12 7v14" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" /></>,
  // US market hours: the exchange building
  market: <><path d="M3 22h18" /><path d="M6 18v-7M10 18v-7M14 18v-7M18 18v-7" /><path d="M11.12 2.2a2 2 0 0 1 1.76 0l7.87 3.85c.47.23.31.95-.22.95H3.47c-.53 0-.7-.72-.22-.95z" /></>,
  // DEX-only: every move is a trade with the curve, both ways
  dexOnly: <><path d="M8 3 4 7l4 4" /><path d="M4 7h16" /><path d="m16 21 4-4-4-4" /><path d="M20 17H4" /></>,
  // P2P-only: wallet to wallet, hand to hand
  p2pOnly: <><circle cx="5" cy="7" r="2.5" /><circle cx="19" cy="7" r="2.5" /><path d="M2 20v-2a3 3 0 0 1 3-3h1M22 20v-2a3 3 0 0 0-3-3h-1" /><path d="M9 13h6" /><path d="m13 11 2 2-2 2" /></>,
  // hot potato: a thermometer running hot
  potato: <><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" /><path d="M12 9v8" /></>,
  // ping pong: two paddles and the ball going back and forth (turns)
  ping: <><path d="M4 7v10M20 7v10" /><circle cx="15.5" cy="12" r="2" /><path d="M7.5 12h1.5M10.5 12h1.5" /></>,
  // King of the Hill: the crown
  king: <><path d="M11.56 3.27a.5.5 0 0 1 .88 0l2.95 5.6a1 1 0 0 0 1.52.3l4.27-3.67a.5.5 0 0 1 .8.52l-2.83 10.24a1 1 0 0 1-.96.74H5.81a1 1 0 0 1-.96-.74L2.02 6.02a.5.5 0 0 1 .8-.52l4.27 3.66a1 1 0 0 0 1.52-.29z" /><path d="M5 21h14" /></>,
  // breathing cap: a steady sine
  breath: <path d="M2 12c1.25-3.5 3.75-3.5 5 0s3.75 3.5 5 0 3.75-3.5 5 0 3.75 3.5 5 0" />,
  // momentum: a kick, then a swing that settles
  momentum: <path d="M2 12h2.5l2.5-8 3 16 2.5-11 2.2 7 1.8-4.5 1.5 2.5H22" />,
  // resonance: waves building outward from the beat
  resonance: <><circle cx="12" cy="12" r="2" /><path d="M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4" /><path d="M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2" /></>,
  // coupled resonator: two pendulums joined by a spring
  coupled: <><path d="M6 3v10M18 3v10" /><circle cx="6" cy="16" r="3" /><circle cx="18" cy="16" r="3" /><path d="M9 16h1l1-2 2 4 1-2h1" /></>,
  holderRewards: <><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" /><path d="M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5" /></>,
};

export function Icon({ id, color }) {
  return (
    <span className="bicon" style={{ "--rc": color }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{ICONS[id]}</svg>
    </span>
  );
}

/** Every rule a token can carry, as a row of blocks. Each opens the launch form with it switched on. */
export default function Blocks({ info }) {
  const { mode, ponsV3 } = useMode();
  const blocks = [
    ...rulesFor(info, mode, ponsV3).map((r) => ({ id: r.id, color: r.color, t: r.t, s: r.s })),
  ];
  return (
    <div className="blocks">
      {blocks.map((b) => {
        const inner = (
          <>
            <Icon id={b.id} color={b.color} />
            <h3>{b.t}</h3>
            <p>{b.s}</p>
          </>
        );
        return b.built
          ? <div key={b.id} className="block built" style={{ "--rc": b.color }}>{inner}</div>
          : <Link key={b.id} to={`/launch?rule=${b.id}`} className="block" style={{ "--rc": b.color }}>{inner}</Link>;
      })}
    </div>
  );
}
