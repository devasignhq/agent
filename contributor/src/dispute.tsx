// Dispute resolution — CONTRIBUTOR side. ⚠ PREVIEW SHELL ONLY (Phase E):
// this page renders the designed dispute experience against embedded demo
// data with local-state transitions. Nothing here calls the backend, and no
// bounty ever enters a DISPUTED state from this screen. Gated behind
// FLAGS.disputes; a visible ribbon says it isn't live.
// Ported from the design's c-dispute.jsx.
import React from "react";
import { Icon } from "./icons";
import { cmoney } from "./model.ts";

// ── Embedded demo case (from the design's mock data) ─────────────────────────
type DemoCriterion = { n: number; status: "met" | "partial" | "unmet"; t: string; find: string };
const DEMO = {
  id: "DSP-27",
  bounty: "BNTY-184",
  repo: "acme/mobile",
  issue: 612,
  pr: 631,
  head: "4a91c7c",
  title: "Reconnect-storm fix — resolution",
  subtitle: "Fix WebSocket reconnect storm on flaky LTE",
  amount: 450,
  windowLeft: "2d 14h",
  aiSuggest: 60,
  confidence: 0.86,
  headline:
    "Your backoff fix is present and correct — cap, jitter, and the out-of-scope constraint all check out. The breaker recovery and the repro run are the two open points.",
  sponsor: { name: "acme", handle: "maya", av: "A" },
  proposal: { kind: "split", pct: 60, note: "acme proposes releasing 60% now and refunding the rest, citing the two open criteria." },
  criteria: [
    { n: 1, status: "met", t: "Exponential backoff, capped at 30s, with jitter", find: "Capped exponential backoff with jitter is present in nextDelay() — cap 30_000ms, jitter ≤ 30%." },
    { n: 2, status: "partial", t: "Circuit breaker opens after 5 consecutive 429s and recovers via a half-open probe", find: "The breaker opens at five 429s but is never reset, and no half-open probe exists. Once open, the socket stays silent." },
    { n: 3, status: "met", t: "Heartbeat interval left unchanged (out of scope)", find: "No changes to heartbeat.ts — the out-of-scope constraint is respected." },
    { n: 4, status: "unmet", t: "Repro scripts/repro/ws-storm.ts exits 0 — ≤ 5 reconnects in a 10s brownout", find: "Repro exits 1 in CI — 41 reconnect attempts in the brownout. You report it passes on your local runner." },
  ] as DemoCriterion[],
  timeline: [
    { time: "Apr 30", icon: "lock", cls: "cool", action: "Bounty funded", detail: "$450 USDC escrowed on Stellar. Acceptance criteria locked." },
    { time: "May 2", icon: "user", action: "Assigned to you" },
    { time: "May 7", icon: "git", action: "You submitted the work", detail: "Opened acme/mobile#631 — “cap backoff + add breaker.”" },
    { time: "May 8", icon: "spark", cls: "cool", action: "DevAsign review", detail: "Automated assessment — 2 of 4 met, 1 partial, 1 not met." },
    { time: "May 8", icon: "message", action: "acme requested changes", detail: "Asked for a breaker reset and a passing repro run before release." },
    { time: "May 9", icon: "message", action: "You responded", detail: "“Breaker trips at 5 as specified. The repro is flaky in CI, not on my local runs.”" },
    { time: "May 9", icon: "warn", cls: "warn", action: "Dispute opened", detail: "Escrow paused. Both parties invited to agree on an outcome." },
    { time: "May 10", icon: "coins", cls: "cool", action: "acme proposed a resolution", detail: "60 / 40 split — $270 to you, $180 refunded. Awaiting your response." },
  ],
};
const STATUS_LABEL: Record<string, string> = { met: "met", partial: "partial", unmet: "not met" };

// ── Counter-proposal split slider ────────────────────────────────────────────
const SplitSlider = ({ pct, setPct, amount, aiMark }: { pct: number; setPct: (n: number) => void; amount: number; aiMark: number }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const dragging = React.useRef(false);
  const fromX = (clientX: number) => {
    const el = ref.current;
    if (!el) return pct;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(100, Math.round(((clientX - r.left) / r.width) * 100)));
  };
  const down = (e: React.PointerEvent) => { dragging.current = true; ref.current!.setPointerCapture(e.pointerId); setPct(fromX(e.clientX)); };
  const move = (e: React.PointerEvent) => { if (dragging.current) setPct(fromX(e.clientX)); };
  const up = (e: React.PointerEvent) => { dragging.current = false; try { ref.current!.releasePointerCapture(e.pointerId); } catch {} };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") { setPct(Math.max(0, pct - 1)); e.preventDefault(); }
    if (e.key === "ArrowRight") { setPct(Math.min(100, pct + 1)); e.preventDefault(); }
  };
  const you = (amount * pct) / 100;
  return (
    <div>
      <div className="dsp-split-nums">
        <div className="dsp-split-side dev"><div className="k">you receive</div><div className="v">{cmoney(you)}</div><div className="dsp-split-pct">{pct}% of escrow</div></div>
        <div className="dsp-split-side refund"><div className="k">sponsor refunded</div><div className="v">{cmoney(amount - you)}</div><div className="dsp-split-pct">{100 - pct}% returned</div></div>
      </div>
      <div className="dsp-slider" ref={ref} tabIndex={0} role="slider" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Your proposed share"
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onKeyDown={key}>
        <div className="dsp-slider-mark" style={{ left: aiMark + "%" }}><span className="dsp-slider-mark-lbl">offer · {aiMark}%</span></div>
        <div className="dsp-slider-track"><div className="dsp-slider-fill" style={{ width: pct + "%" }}></div></div>
        <div className="dsp-slider-handle" style={{ left: pct + "%" }}></div>
      </div>
      <div className="dsp-presets">
        <button className={`dsp-preset ${pct === aiMark ? "on" : ""}`} onClick={() => setPct(aiMark)}><span className="pip"></span> their offer · {aiMark}%</button>
        <button className={`dsp-preset ${pct === 80 ? "on" : ""}`} onClick={() => setPct(80)}>80 / 20</button>
        <button className={`dsp-preset ${pct === 100 ? "on" : ""}`} onClick={() => setPct(100)}>full · 100%</button>
      </div>
    </div>
  );
};

// ── Contributor response panel (local demo transitions only) ─────────────────
const MOVES = [
  { key: "accept", icon: "check", lbl: "Accept the proposal", hint: "Take the split the sponsor offered" },
  { key: "counter", icon: "scale", lbl: "Counter-propose a split", hint: "Suggest a different share" },
  { key: "rebut", icon: "message", lbl: "Submit a rebuttal", hint: "Add evidence for the open criteria" },
  { key: "arbiter", icon: "gavel", lbl: "Escalate to an arbiter", hint: "A neutral DevAsign arbiter decides" },
] as const;

const ResponsePanel = () => {
  const d = DEMO;
  const theirPct = d.proposal.pct;
  const [choice, setChoice] = React.useState<string>("counter");
  const [pct, setPct] = React.useState(80);
  const [note, setNote] = React.useState("");
  const [outcome, setOutcome] = React.useState<string | null>(null);

  const you = (d.amount * pct) / 100;
  const theirAmt = Math.round((d.amount * theirPct) / 100);

  if (outcome) {
    const cfg: Record<string, { mark: string; cls: string; title: React.ReactNode; body: React.ReactNode }> = {
      accept: { mark: "check", cls: "", title: "Split accepted", body: <>You accepted the {theirPct}/{100 - theirPct} split. <b>{cmoney(theirAmt)}</b> would release to your wallet; the rest refunded.</> },
      counter: { mark: "send", cls: "you", title: "Counter sent", body: <><b>{pct}% · {cmoney(you)} to you.</b> The sponsor has 48h to accept or reply. Escrow stays paused meanwhile.</> },
      rebut: { mark: "send", cls: "you", title: "Rebuttal sent", body: <>Your note was shared with the sponsor. They'll revisit the open criteria while the escrow stays paused.</> },
      arbiter: { mark: "gavel", cls: "cool", title: "Sent to arbitration", body: <>A neutral DevAsign arbiter reviews the locked criteria and your submission, then sets a binding outcome — usually within 3 business days.</> },
    };
    const c = cfg[outcome];
    return (
      <div className="dsp-card">
        <div className="dsp-sent">
          <div className={`dsp-sent-mark ${c.cls}`}><Icon name={c.mark} size={20} /></div>
          <div className="dsp-sent-title">{c.title}</div>
          <div className="dsp-sent-body">{c.body}</div>
          <button className="btn ghost sm" onClick={() => setOutcome(null)} style={{ margin: "0 auto" }}>
            <Icon name="x" size={11} /> {outcome === "accept" ? "Undo" : "Withdraw response"}
          </button>
        </div>
      </div>
    );
  }

  const ctaLabel =
    choice === "accept" ? `Accept · release ${cmoney(theirAmt)} to me`
    : choice === "counter" ? `Send counter · ${cmoney(you)} to me`
    : choice === "rebut" ? "Send rebuttal"
    : "Escalate to an arbiter";

  return (
    <div className="dsp-card">
      <div className="c-resp-head">
        <div className="c-resp-title"><Icon name="scale" size={15} /> Your response</div>
        <div className="c-resp-sub">The sponsor's proposal isn't final — it only settles if you accept. You can counter, add evidence, or ask for a neutral arbiter.</div>
      </div>

      <div className="c-resp-choices">
        {MOVES.map((m) => (
          <button key={m.key} className={`c-resp-choice ${m.key} ${choice === m.key ? "on" : ""}`} onClick={() => setChoice(m.key)}>
            <span className="ic"><Icon name={m.icon} size={15} /></span>
            <span style={{ minWidth: 0 }}><span className="lbl">{m.lbl}</span><div className="hint">{m.hint}</div></span>
            <span className="radio"></span>
          </button>
        ))}
      </div>

      <div className="c-resp-detail">
        {choice === "accept" && (
          <div className="c-resp-line">
            Accept the <b>{theirPct}/{100 - theirPct} split</b>: <b>{cmoney(theirAmt)}</b> releases to your wallet and {cmoney(d.amount - theirAmt)} is refunded. The dispute closes.
          </div>
        )}
        {choice === "counter" && (
          <>
            <div className="c-resp-line">The automated read leans <b>{d.aiSuggest}% to you</b>. Propose the share you think is fair; the sponsor can accept or reply.</div>
            <SplitSlider pct={pct} setPct={setPct} amount={d.amount} aiMark={theirPct} />
          </>
        )}
        {choice === "rebut" && (
          <div className="c-rebut">
            <div className="c-resp-line" style={{ paddingBottom: 2 }}>Make your case on the open criteria. Attach the run that proves it — the sponsor sees this before deciding.</div>
            <textarea className="input textarea" placeholder="e.g. The breaker trips at 5 as specified. The CI failure is a known flaky container…" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        )}
        {choice === "arbiter" && (
          <div className="c-resp-line">
            Hand the decision to a neutral DevAsign arbiter. They review the <b>locked criteria</b> and your submission — not the back-and-forth — and set the payout. Binding on both sides.
          </div>
        )}
      </div>

      <div className="c-resp-foot">
        <button className="btn primary dsp-send" style={{ width: "100%", justifyContent: "center", height: 40 }}
          onClick={() => setOutcome(choice)} disabled={choice === "rebut" && !note.trim()}>
          <Icon name={choice === "accept" ? "check" : choice === "arbiter" ? "gavel" : "send"} size={13} /> {ctaLabel}
        </button>
      </div>
    </div>
  );
};

// ── Full contributor dispute page (preview) ──────────────────────────────────
export function DisputePage() {
  const d = DEMO;
  const theirAmt = Math.round((d.amount * d.proposal.pct) / 100);
  return (
    <div style={{ flex: 1, overflow: "auto", minHeight: 0, background: "radial-gradient(1100px 380px at 82% -8%, oklch(0.72 0.06 250 / 0.05), transparent 60%), var(--bg)" }}>
      <div className="dsp-wrap">
        {/* Preview ribbon */}
        <div className="card" style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", marginBottom: 16,
          border: "1px solid var(--warn)", background: "color-mix(in oklab, var(--warn) 8%, var(--bg-1))",
        }}>
          <Icon name="warn" size={14} color="var(--warn)" />
          <span className="mono" style={{ fontSize: 11.5, color: "var(--fg)" }}>
            Preview — disputes aren't live yet. This walkthrough uses example data; nothing here affects a real bounty.
          </span>
        </div>

        {/* Hero */}
        <div className="dsp-hero" style={{ flexDirection: "column" }}>
          <div style={{ minWidth: 0 }}>
            <h1 className="dsp-h1">{d.title}</h1>
            <div className="dsp-h1-sub">
              <span>{d.bounty}</span>
              <span className="sep">/</span>
              <span><Icon name="github" size={12} /> {d.repo}#{d.pr}</span>
              <span className="sep">·</span>
              <span>{d.subtitle}</span>
            </div>
          </div>
        </div>

        <div className="dsp-grid">
          <div className="dsp-col">
            {/* Locked criteria */}
            <div className="dsp-card">
              <div className="dsp-card-head"><div className="t"><Icon name="lock" size={13} /> Acceptance criteria</div><span className="dsp-lockbadge"><Icon name="lock" size={10} /> locked</span></div>
              <div className="dsp-card-body">
                <div className="dsp-locklist">
                  {d.criteria.map((c) => <div key={c.n} className="dsp-lockrow"><span className="n">0{c.n}</span><span className="c">{c.t}</span></div>)}
                </div>
                <div className="dsp-lock-foot"><Icon name="shield" size={12} /> Agreed by both parties when escrow was funded. Frozen for the dispute — neither side can edit them now.</div>
              </div>
            </div>

            {/* DevAsign review */}
            <div className="dsp-card">
              <div className="dsp-card-head"><div className="t"><Icon name="spark" size={13} /> DevAsign review</div><span className="mono mute" style={{ fontSize: 10.5 }}>automated · advisory</span></div>
              <div className="dsp-card-body">
                <div className="dsp-verdict-top">
                  <div className="dsp-verdict-mark"><Icon name="spark" size={18} /></div>
                  <div style={{ minWidth: 0 }}>
                    <div className="dsp-verdict-headline">{d.headline}</div>
                    <div className="dsp-verdict-meta">
                      <span>PR #{d.pr} · head <span style={{ color: "var(--fg-dim)" }}>{d.head}</span></span>
                      <span className="sep">·</span>
                      <span className="dsp-conf">confidence<span className="dsp-conf-track"><span className="dsp-conf-fill" style={{ right: (100 - d.confidence * 100) + "%" }}></span></span>{d.confidence.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
                {d.criteria.map((c) => (
                  <div key={c.n} className={`dsp-crit ${c.status}`}>
                    <span className="dsp-crit-dot"></span>
                    <div style={{ minWidth: 0 }}>
                      <div className="dsp-crit-title"><span className="txt">{c.t}</span><span className="dsp-crit-status">{STATUS_LABEL[c.status]}</span></div>
                      <div className="dsp-crit-finding">{c.find}</div>
                    </div>
                  </div>
                ))}
                <div className="dsp-verdict-neutral"><Icon name="scale" size={13} /> This describes the code as submitted. It doesn't assign fault or decide who is paid — that's for both parties to settle.</div>
              </div>
            </div>

            {/* Timeline */}
            <div className="dsp-card">
              <div className="dsp-card-head"><div className="t"><Icon name="clock" size={13} /> What happened</div></div>
              <div className="dsp-card-body">
                <div style={{ margin: "-4px 0" }}>
                  <div className="timeline dsp-tl" style={{ padding: 0 }}>
                    {d.timeline.map((e, i) => (
                      <div key={i} className="tl-event" style={{ gridTemplateColumns: "52px 22px 1fr" }}>
                        <div className="tl-time">{e.time}</div>
                        <div className={`tl-icon ${(e as any).cls || ""}`}><Icon name={e.icon} size={11} /></div>
                        <div className="tl-body"><div className="tl-head"><span className="tl-action">{e.action}</span></div>{(e as any).detail && <div className="tl-detail">{(e as any).detail}</div>}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="dsp-tl-now"><span className="live"></span> Awaiting your response · window closes in {d.windowLeft}</div>
              </div>
            </div>
          </div>

          {/* Response rail */}
          <div className="dsp-rail">
            <div className="c-proposal">
              <div className="c-proposal-head">
                <span className="dsp-party-av" style={{ width: 24, height: 24, fontSize: 11 }}>{d.sponsor.av}</span>
                <span className="who">sponsor proposed</span>
                <span className="clock"><Icon name="clock" size={11} /> {d.windowLeft}</span>
              </div>
              <div className="c-proposal-body">
                <div className="c-proposal-kind">{d.proposal.pct} / {100 - d.proposal.pct} split</div>
                <div className="c-proposal-amt"><span className="big">{cmoney(theirAmt)}</span><span className="of">to you · {cmoney(d.amount - theirAmt)} refunded</span></div>
                <div className="c-proposal-split">
                  <span className="you" style={{ width: d.proposal.pct + "%" }}></span>
                  <span className="them" style={{ width: (100 - d.proposal.pct) + "%" }}></span>
                </div>
                <div className="c-proposal-splitlbl"><span className="you">you · {d.proposal.pct}%</span><span>sponsor · {100 - d.proposal.pct}%</span></div>
                <div className="c-proposal-desc" style={{ marginTop: 10 }}>{d.proposal.note}</div>
              </div>
            </div>

            <ResponsePanel />
          </div>
        </div>
      </div>
    </div>
  );
}
