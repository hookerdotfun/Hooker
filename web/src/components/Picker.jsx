import { useState } from "react";
import { Link } from "react-router-dom";
import { rulesFor } from "../lib/catalog.js";
import { Row } from "./Feed.jsx";

// ── the rule picker ───────────────────────────────────────────────────────────────────────────
export default function Picker({ info }) {
  const rules = rulesFor(info);
  const [id, setId] = useState(rules[0].id);
  const r = rules.find((x) => x.id === id) ?? rules[0];
  const groups = [...new Set(rules.map((x) => x.group))];
  return (
    <div className="picker">
      <div className="panel picker-list">
        {groups.map((g) => (
          <div key={g} style={{ display: "contents" }}>
            <div className="picker-group">{g}</div>
            {rules.filter((x) => x.group === g).map((x) => (
              <button key={x.id} className={`picker-item ${x.id === r.id ? "on" : ""}`} style={{ "--rc": x.color }} onClick={() => setId(x.id)}>
                <span className="rdot" style={{ background: x.color, color: x.color }} />{x.t}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="panel picker-detail" key={r.id} style={{ "--rc": r.color }}>
        <div className="head">
          <div className="ptitle"><span className="rbadge"><span className="rdot" style={{ background: r.color, color: r.color }} /></span><h3>{r.t}</h3></div>
          <div className="row">
            <span className="chip green">{r.group === "At graduation" ? "Settled on chain" : "Enforced by the token"}</span>
            <span className="chip">{r.group}</span>
          </div>
        </div>
        <p>{r.d}</p>
        <div className="demo">
          <div className="feed-head"><span>Example</span></div>
          {r.demo.map((d, i) => <Row key={`${r.id}${i}`} r={d} />)}
        </div>
        <div className="row">{r.chips.map((c) => <span key={c} className="chip mono">{c}</span>)}</div>
        <div className="pkfoot">
          <span className="mono dim" style={{ fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase" }}>Fixed at launch, nobody can change it</span>
          <Link to={`/launch?rule=${r.id}`} className="btn green small">Launch with this rule <span className="arrow">→</span></Link>
        </div>
      </div>
    </div>
  );
}


