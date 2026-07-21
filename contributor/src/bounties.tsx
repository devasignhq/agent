// Dedicated "Bounties" page: a 3-column master–detail workspace.
//   Left   — filterable list of all my bounties (active / applied / completed)
//   Center — bounty detail: issue + escrow links, acceptance criteria,
//            DevAsign review (once submitted)
//   Right  — contextual call-to-action per bounty state + the timeline
// Ported from the design's c-bounty.jsx, wired to the real API.
import React from "react";
import { useNavigate } from "react-router-dom";
import { api } from "./api";
import type { ContributorBounty } from "./api";
import { useBounties } from "./data-context";
import { Icon } from "./icons";
import { ExtensionModal, SubmitModal, linkIcon, useBountyReview } from "./dashboard";
import {
  allCriteriaMet,
  bountyStage,
  cmoney,
  extensionState,
  fmtDate,
  mergedCriteria,
  reviewHeadline,
  timeAgo,
  timeLeft,
  timelineFromEvents,
} from "./model.ts";
import type { BountyStage } from "./model.ts";

// Display state per bounty (label + pill class), derived from the model stage.
type DisplayState = { key: BountyStage; label: string; cls: string };
const bpState = (b: ContributorBounty): DisplayState => {
  const stage = bountyStage(b);
  const map: Record<BountyStage, { label: string; cls: string }> = {
    applied: { label: "under review", cls: "" },
    shortlist: { label: "shortlisted", cls: "info" },
    awarded: { label: "awarded to you", cls: "success" },
    progress: { label: "in progress", cls: "" },
    review: { label: "in review", cls: "info" },
    ready: { label: "ready for payout", cls: "success" },
    rejected: { label: "rejected", cls: "danger" },
    paid: { label: "paid", cls: "success" },
    closed: { label: "closed", cls: "" },
    lost: { label: "not selected", cls: "" },
  };
  return { key: stage, ...map[stage] };
};

const bpPill = (st: DisplayState) => (
  <span className={`pill ${st.cls}`}><i className="dot"></i> {st.label}</span>
);

// Which list-filter category a stage belongs to.
const categoryOf = (stage: BountyStage): "active" | "applied" | "completed" | "closed" =>
  stage === "progress" || stage === "review" || stage === "ready" || stage === "rejected" ? "active"
  : stage === "applied" || stage === "awarded" ? "applied"
  : stage === "paid" ? "completed"
  : "closed";

// Timeline: every captured lifecycle activity, mapped by the pure
// timelineFromEvents (model.ts) — real dates from the append-only event log,
// with a coarse timestamp synthesis as the legacy-row fallback.

// ══ CENTER — bounty detail ═══════════════════════════════════════════════════
const BountyDetail = ({ b, st }: { b: ContributorBounty; st: DisplayState }) => {
  const { explorerBase } = useBounties();
  const review = useBountyReview(b);
  const submitted = !!b.prNumber || !!b.submittedAt;
  const hasReview = submitted && !!review && review.counts.pending < review.counts.total;
  const crits = mergedCriteria(b.acceptance, review);
  const met = review?.counts.met ?? 0;
  const prUrl = b.prNumber ? `https://github.com/${b.repo}/pull/${b.prNumber}` : null;

  return (
    <div className="c-bp-center">
      <div className="c-bp-hero">
        <div className="c-bp-hero-eyebrow">
          <a href={b.issueUrl} target="_blank" rel="noopener noreferrer"><Icon name="github" size={13} /> {b.repo}#{b.issueNumber}</a>
          <span className="sep">·</span>
          {bpPill(st)}
        </div>
        <div className="c-bp-hero-row">
          <h1 className="c-bp-hero-title">{b.title}</h1>
          <div className="c-bp-hero-reward">
            <div className="c-bp-hero-reward-v">{b.amountUsdc.toLocaleString()}<span className="u">USDC</span></div>
            <div className="c-bp-hero-reward-k"><span className="pip" style={{ background: "#7e54d6" }}></span>{st.key === "paid" ? "paid out" : st.key === "closed" ? "refunded" : "in escrow"}</div>
          </div>
        </div>
      </div>

      {/* Resources */}
      <div className="c-sec">
        <div className="c-sec-h"><Icon name="external" size={12} /> resources</div>
        <div className="c-links">
          <a className="c-link" href={b.issueUrl} target="_blank" rel="noopener noreferrer">
            <span className="ic"><Icon name="github" size={13} /></span>
            <div className="body"><div className="k">GitHub issue</div><div className="v">github.com/{b.repo}/issues/{b.issueNumber}</div></div>
            <Icon name="external" size={12} color="var(--fg-mute)" />
          </a>
          {(b.escrowContract || b.escrowTxHash) && (
            <a className="c-link"
              href={b.escrowContract ? `${explorerBase}/contract/${b.escrowContract}` : `${explorerBase}/tx/${b.escrowTxHash}`}
              target="_blank" rel="noopener noreferrer">
              <span className="ic" style={{ color: "var(--accent)" }}><Icon name="coins" size={13} /></span>
              <div className="body">
                <div className="k">Escrow account · Stellar</div>
                <div className="v">
                  {b.escrowContract
                    ? `${b.escrowContract.slice(0, 8)}…${b.escrowContract.slice(-8)}`
                    : `funding tx ${b.escrowTxHash!.slice(0, 8)}…${b.escrowTxHash!.slice(-8)}`}
                </div>
              </div>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--info)", display: "inline-flex", alignItems: "center", gap: 5 }}>Explorer <Icon name="external" size={11} /></span>
            </a>
          )}
        </div>
      </div>

      {/* Acceptance criteria + submission */}
      <div className={submitted ? "c-bp-cols" : ""}>
        <div className="c-sec">
          <div className="c-sec-h"><Icon name="lock" size={12} /> acceptance criteria · locked{hasReview ? ` · ${met}/${crits.length} met` : ""}</div>
          {hasReview ? (
            <div className="c-crit-rows">
              {crits.map((c) => (
                <div key={c.n} className={`c-crit-row ${c.status === "pending" ? "partial" : c.status}`}>
                  <span className="dot"></span>
                  <div className="body"><div className="txt">{c.text}</div>{c.finding && <div className="find">{c.finding}</div>}</div>
                  <span className="st">{c.status === "pending" ? "pending" : c.status === "met" ? "met" : "not met"}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="c-check-rows">
              {b.acceptance.map((c, i) => (
                <div key={i} className={`c-check-row ${st.key === "paid" ? "met" : ""}`}>
                  <span className="box">{st.key === "paid" && <Icon name="check" size={9} />}</span>
                  <div className="txt">{c}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {submitted && (
          <div className="c-sec">
            <div className="c-sec-h"><Icon name="pr" size={12} /> your submission</div>
            <div className="c-pr-row">
              <span className="gh"><Icon name="github" size={16} /></span>
              <div className="c-pr-info">
                <div className="c-pr-title">{review?.prTitle ?? b.review?.prTitle ?? `PR #${b.prNumber ?? "—"}`}</div>
                <div className="c-pr-meta">
                  <span>{b.repo}#{b.prNumber ?? "—"}</span>
                  {review && review.additions != null && <>
                    <span className="add">+{review.additions}</span>
                    <span className="del">−{review.deletions}</span>
                    <span>{review.changedFiles} files</span>
                  </>}
                </div>
              </div>
              {prUrl && <a className="btn sm ghost" href={prUrl} target="_blank" rel="noopener noreferrer"><Icon name="external" size={11} /> View</a>}
            </div>
            {b.supportingLinks.length > 0 && (
              <div className="c-links" style={{ marginTop: 8 }}>
                {b.supportingLinks.map((l, i) => (
                  <a key={i} className="c-link" href={l.url} target="_blank" rel="noopener noreferrer">
                    <span className="ic"><Icon name={linkIcon(l.type)} size={13} /></span>
                    <div className="body"><div className="k">{l.type}</div><div className="v">{l.url}</div></div>
                    <Icon name="external" size={12} color="var(--fg-mute)" />
                  </a>
                ))}
              </div>
            )}

            {hasReview && (
              <div className="c-review-head" style={{ marginTop: 12 }}>
                <div className="c-review-mark"><Icon name="spark" size={17} /></div>
                <div style={{ minWidth: 0 }}>
                  <div className="c-review-line">{review!.summary || reviewHeadline(review)}</div>
                  <div className="c-review-meta">
                    <span>PR #{review!.prNumber} · head <span style={{ color: "var(--fg-dim)" }}>{review!.headSha.slice(0, 7)}</span></span>
                    <span>·</span>
                    <span>{reviewHeadline(review)}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// Timeline card (right column, under the CTA).
const BountyTimeline = ({ b }: { b: ContributorBounty }) => {
  const tl = timelineFromEvents(b);
  return (
    <div className="c-bp-cta-card" style={{ marginTop: 45, padding: "14px 16px" }}>
      <div className="c-bp-cta-title" style={{ fontSize: 12.5, marginBottom: 12 }}><Icon name="clock" size={13} style={{ verticalAlign: -2, marginRight: 6 }} />Timeline</div>
      <div className="timeline dsp-tl" style={{ padding: 0 }}>
        {tl.map((e, i) => (
          <div key={i} className="tl-event" style={{ gridTemplateColumns: "22px 1fr" }}>
            <div className={`tl-icon ${e.cls || ""}`}><Icon name={e.icon} size={11} /></div>
            <div className="tl-body">
              <div className="tl-time" style={{ textAlign: "left", marginBottom: 3 }}>{e.at != null ? fmtDate(e.at) : e.timeLabel}</div>
              <div className="tl-head"><span className="tl-action">{e.action}</span></div>
              {e.detail && <div className="tl-detail">{e.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ══ RIGHT — contextual call-to-action ════════════════════════════════════════
const BountyCTA = ({ b, st }: { b: ContributorBounty; st: DisplayState }) => {
  const navigate = useNavigate();
  const { reload } = useBounties();
  const review = useBountyReview(b);
  const [submitOpen, setSubmitOpen] = React.useState(false);
  const [linksOnly, setLinksOnly] = React.useState(false);
  const [extOpen, setExtOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => { setSubmitOpen(false); setExtOpen(false); setBusy(false); }, [b.id]);

  const prUrl = b.prNumber ? `https://github.com/${b.repo}/pull/${b.prNumber}` : null;
  const payoutRequested = !!b.payoutRequestedAt;
  const ready = allCriteriaMet(review);

  const requestPayout = async () => {
    setBusy(true);
    try { await api.requestPayout(b.id); await reload(); } catch (err) { console.warn(err); }
    setBusy(false);
  };
  const acceptVerdict = async () => {
    if (!window.confirm(`Accept the rejection? The ${cmoney(b.amountUsdc)} escrow returns to the sponsor and this bounty closes.`)) return;
    setBusy(true);
    try { await api.acceptRejection(b.id); await reload(); } catch (err) { console.warn(err); }
    setBusy(false);
  };

  const card = (title: React.ReactNode, desc: React.ReactNode, actions: React.ReactNode, meta?: React.ReactNode) => (
    <div className="c-bp-cta-card">
      <div className="c-bp-cta-title">{title}</div>
      <div className="c-bp-cta-desc">{desc}</div>
      <div className="c-bp-cta-actions">{actions}</div>
      {meta && <div className="c-bp-cta-meta">{meta}</div>}
    </div>
  );

  // In progress — no submission yet.
  if (st.key === "progress") {
    const extState = extensionState(b);
    const pastDue = !!b.deadlineAt && b.deadlineAt < Date.now();
    return (
      <>
        {card("Ready to submit?", "Link your pull request and any supporting material — a demo video, a recording, notes. DevAsign reviews it against the criteria.",
          <>
            <button className="btn primary" onClick={() => { setLinksOnly(false); setSubmitOpen(true); }}><Icon name="pr" size={13} /> Make a submission</button>
            {extState === "can_request" && (
              <button className="btn ghost" onClick={() => setExtOpen(true)}><Icon name="clock" size={12} /> Request extension</button>
            )}
            {extState === "pending" && (
              <button className="btn ghost" disabled><Icon name="clock" size={12} /> Extension requested</button>
            )}
          </>,
          <><Icon name="clock" size={11} /> {b.acceptedAt ? `accepted ${fmtDate(b.acceptedAt)}` : "accepted"}
            {b.deadlineAt ? ` · ${timeLeft(b.deadlineAt)}` : ""}
            {extState === "pending" ? ` · ${b.extension!.days}-day extension pending${pastDue ? " — refund on hold" : ""}` : ""}
            {extState === "approved" ? ` · extended +${b.extension!.days}d` : ""}</>)}
        {submitOpen && <SubmitModal b={b} linksOnly={linksOnly} onClose={() => setSubmitOpen(false)} onDone={() => void reload()} />}
        {extOpen && <ExtensionModal b={b} onClose={() => setExtOpen(false)} onDone={() => void reload()} />}
      </>
    );
  }

  // In review (incl. ready-for-payout).
  if (st.key === "review" || st.key === "ready") {
    // The delivery window keeps running through review — if it closes before the
    // sponsor releases, the escrow returns to them. This stage used to show no
    // clock at all, hiding the one risk the contributor can't act on directly.
    const dueMeta = b.deadlineAt ? <> · {timeLeft(b.deadlineAt)}</> : null;
    if (payoutRequested) {
      return card("In review", "Payout requested — the sponsor has been notified. On approval (or merge), the escrow releases to your wallet.",
        <button className="btn ghost" disabled><Icon name="check" size={12} /> Payout requested</button>,
        <><Icon name="shield" size={11} /> pays directly to your USDC wallet{dueMeta}</>);
    }
    if (ready || st.key === "ready") {
      return card("All criteria met", "This submission is ready. Request payout and the escrow releases on approval.",
        <button className="btn primary" disabled={busy} onClick={() => void requestPayout()}><Icon name="coins" size={13} /> {busy ? "Requesting…" : `Request payout · ${cmoney(b.amountUsdc)}`}</button>,
        <><Icon name="shield" size={11} /> pays to your saved address{dueMeta}</>);
    }
    return (
      <>
        {card("In review", review && review.counts.unmet > 0
          ? `${review.counts.unmet} criteri${review.counts.unmet === 1 ? "on" : "a"} still open. Push a fix to your PR and DevAsign re-checks automatically.`
          : "DevAsign is checking your PR against the locked criteria. Findings appear in the centre shortly.",
          <>
            {prUrl && <a className="btn ghost" href={prUrl} target="_blank" rel="noopener noreferrer"><Icon name="external" size={12} /> View PR</a>}
            <button className="btn ghost" onClick={() => { setLinksOnly(true); setSubmitOpen(true); }}><Icon name="plus" size={12} /> Add / update links</button>
          </>,
          <><Icon name="shield" size={11} /> pays directly to your USDC wallet{dueMeta}</>)}
        {submitOpen && <SubmitModal b={b} linksOnly={linksOnly} onClose={() => setSubmitOpen(false)} onDone={() => void reload()} />}
      </>
    );
  }

  // Rejected.
  if (st.key === "rejected") {
    return (
      <>
        <div className="c-reject-banner" style={{ border: "1px solid oklch(0.63 0.2 15 / 0.35)", marginBottom: 12 }}>
          <span className="ic"><Icon name="x" size={16} /></span>
          <div><div className="t">{b.rejection!.byLogin} rejected this · {fmtDate(b.rejection!.at)}</div><div className="d">{b.rejection!.reason}</div></div>
        </div>
        {card("Rework or close",
          "You can rework and resubmit your PR, or accept the verdict to close the bounty.",
          <>
            <button className="btn ghost" disabled={busy} onClick={() => void acceptVerdict()}><Icon name="check" size={12} /> Accept verdict</button>
          </>)}
      </>
    );
  }

  // Awarded — accept happens on the dashboard.
  if (st.key === "awarded") {
    return card("You were picked", "Accept the award and confirm your payout wallet — the delivery clock starts when you do.",
      <button className="btn primary" onClick={() => navigate("/dashboard")}><Icon name="check" size={13} /> Accept on dashboard</button>,
      <><Icon name="clock" size={11} /> {b.deliveryDays} days once accepted</>);
  }

  // Applied — the design's CTA is "Withdraw application".
  if (st.key === "applied") {
    const withdraw = async () => {
      if (!window.confirm("Withdraw your application? You can re-apply while the bounty stays open.")) return;
      setBusy(true);
      try { await api.withdrawApplication(b.id); await reload(); } catch (err) { console.warn(err); }
      setBusy(false);
    };
    return card("Application under review",
      `You're one of ${b.applicantCount} applicant${b.applicantCount === 1 ? "" : "s"}. The maintainer reviews GitHub profiles, then assigns one contributor.`,
      <button className="btn ghost" disabled={busy} onClick={() => void withdraw()}><Icon name="x" size={12} /> {busy ? "Withdrawing…" : "Withdraw application"}</button>,
      <><Icon name="clock" size={11} /> applied {b.myApplication ? timeAgo(b.myApplication.appliedAt) : ""}</>);
  }

  // Paid.
  if (st.key === "paid") {
    return card("Paid & complete", <>Approved and paid{b.paidAt ? ` on ${fmtDate(b.paidAt)}` : ""}. {cmoney(b.amountUsdc)} USDC landed in your wallet.</>,
      <>
        {prUrl && <a className="btn ghost" href={prUrl} target="_blank" rel="noopener noreferrer"><Icon name="external" size={12} /> View merged PR</a>}
        <button className="btn primary" onClick={() => navigate("/wallet")}><Icon name="coins" size={13} /> Go to wallet</button>
      </>,
      b.payoutTxHash ? <><Icon name="check" size={11} color="var(--success)" /> tx {b.payoutTxHash.slice(0, 8)}</> : undefined);
  }

  // Closed / lost.
  return card(st.key === "lost" ? "Not selected" : "Closed",
    st.key === "lost" ? "The maintainer went with another applicant this time." : "This bounty is closed.",
    <a className="btn ghost" href={b.issueUrl} target="_blank" rel="noopener noreferrer"><Icon name="external" size={12} /> View the issue</a>);
};

// ══ PAGE ═════════════════════════════════════════════════════════════════════
export function BountiesPage() {
  const { bounties, loading } = useBounties();
  const [filter, setFilter] = React.useState<"all" | "active" | "applied" | "completed">("all");
  const [selId, setSelId] = React.useState<string | null>(null);

  const withCat = bounties.map((b) => ({ b, st: bpState(b), cat: categoryOf(bountyStage(b)) }));
  const list = filter === "all" ? withCat : withCat.filter((x) => x.cat === filter);
  const sel = withCat.find((x) => x.b.id === selId) ?? list[0] ?? withCat[0] ?? null;

  const FILTERS = [
    { k: "all", l: "All" }, { k: "active", l: "Active" }, { k: "applied", l: "Applied" }, { k: "completed", l: "Completed" },
  ] as const;

  if (loading) {
    return <div style={{ display: "grid", placeItems: "center", minHeight: "50vh" }}><span className="mono mute" style={{ fontSize: 12 }}>loading…</span></div>;
  }
  if (withCat.length === 0) {
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: "50vh" }}>
        <div style={{ textAlign: "center" }}>
          <div className="mono" style={{ fontSize: 13, color: "var(--fg)" }}>No bounties yet</div>
          <div className="mono mute" style={{ fontSize: 11, marginTop: 8 }}>Apply to a DevAsign bounty on GitHub and it shows up here.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="c-bpage">
      {/* Left — list */}
      <div className="c-bp-left">
        <div className="c-bp-filters">
          <div className="c-bp-filters-h">bounties</div>
          <div className="c-bp-ftabs">
            {FILTERS.map((f) => (
              <div key={f.k} className={`c-bp-ftab ${filter === f.k ? "on" : ""}`} onClick={() => setFilter(f.k)}>
                {f.l}
              </div>
            ))}
          </div>
        </div>
        {list.map(({ b, st }) => (
          <div key={b.id} className={`c-bp-item st-${st.key} ${sel && sel.b.id === b.id ? "sel" : ""}`} onClick={() => setSelId(b.id)}>
            <div className="c-bp-item-top">
              <span className="c-bp-item-repo">{b.repo}#{b.issueNumber}</span>
              <span className="c-bp-item-amt">{b.amountUsdc.toLocaleString()}<span className="u">USDC</span></span>
            </div>
            <div className="c-bp-item-title">{b.title}</div>
            {bpPill(st)}
          </div>
        ))}
      </div>

      {/* Center + right */}
      <div className="c-bp-work">
        <div className="c-bp-detail-wrap">
          {sel ? <BountyDetail b={sel.b} st={sel.st} /> : <div className="c-bp-empty">Select a bounty</div>}
        </div>
        <div className="c-bp-side">
          {sel && <div className="c-bp-cta-sticky"><BountyCTA key={sel.b.id} b={sel.b} st={sel.st} /></div>}
          {sel && <BountyTimeline b={sel.b} />}
        </div>
      </div>
    </div>
  );
}
