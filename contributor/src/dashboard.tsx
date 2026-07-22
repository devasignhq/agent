// Contributor dashboard — stats, the active-bounty workspace accordion (submit
// PR → review vs criteria → request payout / handle rejection), and the applied
// / completed lists. Delegation is now one sponsor click, so there is no
// award-accept step here. Ported from the design's c-dashboard.jsx.
import React from "react";
import { useNavigate } from "react-router-dom";
import { api } from "./api";
import type { BountyReview, ContributorBounty, SupportingLink } from "./api";
import { useAuth } from "./auth-context";
import { useBounties } from "./data-context";
import { Icon } from "./icons";
import {
  acceptanceRate,
  allCriteriaMet,
  bountyStage,
  cmoney,
  EXTENSION_AUTO_APPROVE_HOURS,
  EXTENSION_MAX_DAYS,
  EXTENSION_PRESETS,
  extensionState,
  fmtDate,
  groupBounties,
  isValidExtensionDays,
  mergedCriteria,
  parsePrUrl,
  reviewHeadline,
  timeAgo,
  timeLeft,
} from "./model.ts";

// ═══ SUBMIT-WORK MODAL — PR URL + supporting links ═══════════════════════════
const LINK_TYPES = ["Demo video", "Screen recording", "Design / Figma", "Doc / write-up", "Other"];
export const linkIcon = (type: string): string => {
  if (/video|record/i.test(type)) return "play";
  if (/figma|design/i.test(type)) return "image";
  if (/doc|write/i.test(type)) return "doc";
  return "external";
};

export const SubmitModal = ({
  b,
  linksOnly,
  onClose,
  onDone,
}: {
  b: ContributorBounty;
  linksOnly?: boolean; // already submitted — just add/update links
  onClose: () => void;
  onDone: () => void;
}) => {
  const [pr, setPr] = React.useState(b.prNumber ? `https://github.com/${b.repo}/pull/${b.prNumber}` : "");
  const [links, setLinks] = React.useState<Array<{ type: string; url: string }>>(
    b.supportingLinks.length
      ? b.supportingLinks.map((l) => ({ type: l.type, url: l.url }))
      : [{ type: "Demo video", url: "" }]
  );
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") (confirming ? setConfirming(false) : onClose()); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, confirming]);

  const parsed = parsePrUrl(pr);
  const prOk = !!parsed && parsed.repo.toLowerCase() === b.repo.toLowerCase();
  const setLink = (i: number, patch: Partial<{ type: string; url: string }>) =>
    setLinks((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLink = () => setLinks((ls) => [...ls, { type: "Other", url: "" }]);
  const rmLink = (i: number) => setLinks((ls) => ls.filter((_, j) => j !== i));
  const extraLinks = links.filter((l) => l.url.trim());

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (linksOnly) {
        await api.updateLinks(b.id, extraLinks);
      } else {
        await api.submitWork(b.id, pr.trim(), extraLinks);
      }
      onDone();
      onClose();
    } catch (err: any) {
      const code = (err?.body as any)?.error || "submit_failed";
      setError(
        code === "pr_not_found" ? "Couldn't find that PR on GitHub — check the URL." :
        code === "pr_author_mismatch" ? "That PR isn't authored by your GitHub account." :
        code === "wrong_repo" ? `The PR must live in ${b.repo}.` :
        code === "invalid_pr_url" ? "Enter a full GitHub pull-request URL (…/pull/123)." :
        "Couldn't submit — try again."
      );
      setConfirming(false);
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal c-submit" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><Icon name="x" size={13} /></button>
        <div className="c-accept-head">
          <div className="c-accept-eyebrow"><Icon name="pr" size={11} style={{ verticalAlign: -1, marginRight: 5 }} />{linksOnly ? "update your submission" : "submit your work"}</div>
          <h2 className="c-accept-title">{linksOnly ? "Add / update links" : "Make a submission"}</h2>
          <div className="c-accept-sub">
            Link the pull request for <span className="mono" style={{ color: "var(--fg-dim)" }}>{b.repo}#{b.issueNumber}</span>, plus anything that helps the review — a demo video, a screen recording, notes.
          </div>
        </div>

        <div className="c-accept-body">
          <label className="label">Pull request URL <span style={{ color: "var(--danger)" }}>*</span></label>
          <input className="input mono" placeholder={`https://github.com/${b.repo}/pull/…`} value={pr}
            onChange={(e) => setPr(e.target.value)} style={{ height: 40, fontSize: 12 }} disabled={linksOnly && !!b.prNumber} />
          {pr && !prOk && <div className="mono" style={{ color: "var(--danger)", fontSize: 11, marginTop: 6 }}>
            {parsed && parsed.repo.toLowerCase() !== b.repo.toLowerCase()
              ? `The PR must live in ${b.repo}.`
              : "Enter a full GitHub pull-request URL (…/pull/123)."}
          </div>}

          <label className="label" style={{ marginTop: 18 }}>Supporting links <span className="mute" style={{ textTransform: "none", letterSpacing: 0 }}>· optional</span></label>
          {links.map((l, i) => (
            <div key={i} className="c-submit-linkrow">
              <select className="input type" value={l.type} onChange={(e) => setLink(i, { type: e.target.value })}>
                {LINK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <input className="input mono url" placeholder="https://…" value={l.url} onChange={(e) => setLink(i, { url: e.target.value })} />
              <button className="rm" onClick={() => rmLink(i)} aria-label="Remove link" disabled={links.length === 1 && !l.url}><Icon name="x" size={12} /></button>
            </div>
          ))}
          <button className="c-submit-addlink" onClick={addLink}><Icon name="plus" size={12} /> Add another link</button>
          <div className="c-submit-help">Once submitted, DevAsign reviews your PR against the locked criteria and posts findings here.</div>
          {error && <div className="mono" style={{ color: "var(--danger)", fontSize: 11, marginTop: 10 }}>{error}</div>}
        </div>

        <div className="c-accept-foot" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          {confirming ? (
            <>
              <div className="c-submit-confirm">
                <Icon name="pr" size={13} style={{ verticalAlign: -2, marginRight: 6, color: "var(--accent)" }} />
                You're submitting this for review — DevAsign checks it against the locked criteria and notifies the maintainer. Sure you're ready?
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="btn ghost" onClick={() => setConfirming(false)}>Not yet</button>
                <button className="btn primary" disabled={busy} onClick={() => void submit()}>
                  <Icon name="check" size={13} /> {busy ? "Submitting…" : "Yes, submit"}
                </button>
              </div>
            </>
          ) : (
            <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              {linksOnly ? (
                <button className="btn primary" disabled={busy} onClick={() => void submit()}>
                  <Icon name="check" size={13} /> {busy ? "Saving…" : "Save links"}
                </button>
              ) : (
                <button className="btn primary" disabled={!prOk} onClick={() => setConfirming(true)}><Icon name="send" size={13} /> Submit work</button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ═══ REQUEST-EXTENSION MODAL — more delivery time, sponsor must approve ══════
export const ExtensionModal = ({
  b,
  onClose,
  onDone,
}: {
  b: ContributorBounty;
  onClose: () => void;
  onDone: () => void;
}) => {
  const [preset, setPreset] = React.useState<number | "custom">(EXTENSION_PRESETS[0]);
  const [customVal, setCustomVal] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") (confirming ? setConfirming(false) : onClose()); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, confirming]);

  const days = preset === "custom" ? Number(customVal) : preset;
  const daysOk = isValidExtensionDays(days);
  const ready = daysOk && !!reason.trim();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.requestExtension(b.id, days, reason.trim());
      onDone();
      onClose();
    } catch (err: any) {
      const code = (err?.body as any)?.error || "request_failed";
      setError(
        code === "already_pending" ? "You already have a pending extension request on this bounty." :
        code === "already_extended" ? "This bounty's timeline was already extended once — that's the limit." :
        code === "invalid_days" ? `Choose between 1 and ${EXTENSION_MAX_DAYS} days.` :
        code === "missing_reason" ? "Tell the sponsor why you need more time." :
        code.startsWith("bad_status") ? "Extensions can only be requested before you submit your work." :
        "Couldn't send the request — try again."
      );
      setConfirming(false);
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal c-submit" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><Icon name="x" size={13} /></button>
        <div className="c-accept-head">
          <div className="c-accept-eyebrow"><Icon name="clock" size={11} style={{ verticalAlign: -1, marginRight: 5 }} />more time on the clock</div>
          <h2 className="c-accept-title">Request extension</h2>
          <div className="c-accept-sub">
            Ask the sponsor for extra delivery time on <span className="mono" style={{ color: "var(--fg-dim)" }}>{b.repo}#{b.issueNumber}</span>.
            {b.deadlineAt ? <> Current deadline: {fmtDate(b.deadlineAt)} · {timeLeft(b.deadlineAt)}.</> : null} If they don't respond within {EXTENSION_AUTO_APPROVE_HOURS}h it's approved automatically.
          </div>
        </div>

        <div className="c-accept-body">
          <label className="label">How many extra days? <span style={{ color: "var(--danger)" }}>*</span></label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {EXTENSION_PRESETS.map((d) => (
              <button key={d} className={`btn ${preset === d ? "primary" : "ghost"}`} onClick={() => setPreset(d)}>
                {d} day{d === 1 ? "" : "s"}
              </button>
            ))}
            <button className={`btn ${preset === "custom" ? "primary" : "ghost"}`} onClick={() => setPreset("custom")}>Custom</button>
            {preset === "custom" && (
              <input
                className="input mono" type="number" min={1} max={EXTENSION_MAX_DAYS} placeholder="days" autoFocus
                value={customVal} onChange={(e) => setCustomVal(e.target.value)}
                style={{ width: 90, height: 34, fontSize: 12 }}
              />
            )}
          </div>
          {preset === "custom" && customVal && !daysOk && (
            <div className="mono" style={{ color: "var(--danger)", fontSize: 11, marginTop: 6 }}>
              Whole days only, 1 to {EXTENSION_MAX_DAYS}.
            </div>
          )}

          <label className="label" style={{ marginTop: 18 }}>Why do you need more time? <span style={{ color: "var(--danger)" }}>*</span></label>
          <textarea
            className="input" rows={3} maxLength={500}
            placeholder="e.g. The upstream API change landed late — the integration tests need another pass."
            value={reason} onChange={(e) => setReason(e.target.value)}
            style={{ height: "auto", minHeight: 84, padding: "10px 12px", fontSize: 12, lineHeight: 1.5, resize: "vertical", fontFamily: "inherit" }}
          />
          <div className="c-submit-help">The sponsor sees your reason and approves or declines. While the request is pending, your bounty won't be refunded — even past the current deadline.</div>
          {error && <div className="mono" style={{ color: "var(--danger)", fontSize: 11, marginTop: 10 }}>{error}</div>}
        </div>

        <div className="c-accept-foot" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          {confirming ? (
            <>
              <div className="c-submit-confirm">
                <Icon name="clock" size={13} style={{ verticalAlign: -2, marginRight: 6, color: "var(--accent)" }} />
                Ask the sponsor for {days} more day{days === 1 ? "" : "s"}? They have {EXTENSION_AUTO_APPROVE_HOURS}h to respond — after that it's approved automatically. Keep working meanwhile.
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="btn ghost" onClick={() => setConfirming(false)}>Not yet</button>
                <button className="btn primary" disabled={busy} onClick={() => void submit()}>
                  <Icon name="send" size={13} /> {busy ? "Sending…" : "Yes, send request"}
                </button>
              </div>
            </>
          ) : (
            <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={!ready} onClick={() => setConfirming(true)}>
                <Icon name="clock" size={13} /> Request {daysOk ? `${days}-day ` : ""}extension
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ═══ ACTIVE BOUNTY WORKSPACE ═════════════════════════════════════════════════
const WS_STAGES = [
  { k: "applied", l: "Applied" }, { k: "accepted", l: "Accepted" },
  { k: "progress", l: "In progress" }, { k: "review", l: "In review" },
  { k: "approved", l: "Approved" }, { k: "paid", l: "Paid" },
];

// Fetch the AI review for a submitted bounty. 404 (no_review) = still queued.
export function useBountyReview(b: ContributorBounty): BountyReview | null {
  const [review, setReview] = React.useState<BountyReview | null>(null);
  const submitted = !!b.prNumber || !!b.submittedAt;
  React.useEffect(() => {
    if (!submitted) return;
    let alive = true;
    api.bountyReview(b.id)
      .then((d) => { if (alive) setReview(d.review); })
      .catch(() => { /* no review yet — render "queued" */ });
    return () => { alive = false; };
  }, [b.id, b.updatedAt, submitted]);
  return review;
}

export const Workspace = ({
  b,
  expanded,
  onToggle,
}: {
  b: ContributorBounty;
  expanded: boolean;
  onToggle: () => void;
}) => {
  const { reload } = useBounties();
  const [submitOpen, setSubmitOpen] = React.useState(false);
  const [linksOnly, setLinksOnly] = React.useState(false);
  const [extOpen, setExtOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const review = useBountyReview(b);
  const extState = extensionState(b);

  const submitted = !!b.prNumber || !!b.submittedAt;
  const reviewed = !!review && review.counts.pending < review.counts.total;
  const rejected = !!b.rejection;
  const payoutRequested = !!b.payoutRequestedAt;
  const closedRejected = b.status === "CANCELLED" && b.cancelReason === "rejected";

  const crits = mergedCriteria(b.acceptance, review);
  const total = review?.counts.total || b.acceptance.length;
  const met = review?.counts.met || 0;
  const allMet = allCriteriaMet(review);
  const pct = total ? Math.round((met / total) * 100) : 0;

  const curStage = payoutRequested ? "approved"
    : submitted ? "review"
    : "progress";
  const curIdx = WS_STAGES.findIndex((s) => s.k === curStage);

  const prUrl = b.prNumber ? `https://github.com/${b.repo}/pull/${b.prNumber}` : null;

  // Rejection outranks an earlier payout request — a sponsor can reject AFTER
  // the contributor asked for payout, and the header must tell the truth.
  const status = closedRejected ? { cls: "none", label: "closed · verdict accepted" }
    : rejected ? { cls: "danger", label: "rejected" }
    : payoutRequested ? { cls: "ok", label: "payout requested" }
    : !submitted ? { cls: "none", label: "no submission yet" }
    : reviewed && allMet ? { cls: "ok", label: "ready for payout" }
    : reviewed ? { cls: "info", label: "in review" }
    : { cls: "info", label: "submitted · review queued" };

  const requestPayout = async () => {
    setBusy(true);
    try {
      await api.requestPayout(b.id);
      await reload();
    } catch (err) {
      console.warn("[workspace] request payout failed:", err);
    } finally {
      setBusy(false);
    }
  };

  const acceptVerdict = async () => {
    if (!window.confirm(`Accept the rejection? The ${cmoney(b.amountUsdc)} escrow returns to the sponsor and this bounty closes.`)) return;
    setBusy(true);
    try {
      await api.acceptRejection(b.id);
      await reload();
    } catch (err: any) {
      console.warn("[workspace] accept rejection failed:", err);
    } finally {
      setBusy(false);
    }
  };

  const deadlineText = b.deadlineAt ? timeLeft(b.deadlineAt) : `${b.deliveryDays}-day window`;

  // The window keeps running through review — if it closes before the sponsor
  // releases, the escrow goes back to them (see expiredBounties on the backend).
  // The submitted footers used to render no clock at all, which hid precisely the
  // risk the contributor can least do anything about.
  const overdue = !!b.deadlineAt && b.deadlineAt < Date.now();
  const deadlineNote = b.deadlineAt ? (
    <span style={overdue ? { color: "var(--danger)" } : undefined}>
      <Icon name="clock" size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
      {overdue
        ? "Past due — the escrow can return to the sponsor at any time."
        : `${deadlineText} — the escrow returns to the sponsor if it isn't released in time.`}
    </span>
  ) : null;

  return (
    <div className={`c-ws ${expanded ? "" : "collapsed"}`}>
      <div className="c-ws-head toggle" onClick={onToggle}>
        <div className="c-ws-headmain">
          <div style={{ minWidth: 0 }}>
            <div className="c-ws-eyebrow">
              <span>active bounty</span>
              <span className={`c-ws-statuspill ${status.cls}`}>{status.label}</span>
              <span className="c-ws-mini-chev" aria-label={expanded ? "Collapse" : "Expand"}><Icon name="chevron-r" size={11} /></span>
            </div>
            <h2 className="c-ws-title">{b.title}</h2>
            <div className="c-ws-sub">
              {prUrl
                ? <a href={prUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}><Icon name="github" size={12} /> {b.repo}#{b.prNumber}</a>
                : <a href={b.issueUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}><Icon name="github" size={12} /> {b.repo}</a>}
              <span className="sep">·</span>
              <a href={b.issueUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>issue #{b.issueNumber}</a>
              <span className="sep">·</span>
              <span><Icon name="clock" size={11} style={{ verticalAlign: -1, marginRight: 3 }} />{deadlineText}</span>
            </div>
          </div>
        </div>
        <div className="c-ws-reward">
          <div className="c-ws-reward-v">{b.amountUsdc.toLocaleString()}<span className="u">USDC</span></div>
          <div className="c-ws-reward-k"><span className="pip" style={{ background: "#7e54d6" }}></span>in escrow · Stellar</div>
        </div>
      </div>

      {expanded && <>
        {/* Progress */}
        <div className="c-ws-progress">
          <div className="c-ws-progress-top">
            <span className="c-ws-progress-lbl">{reviewed ? "criteria met" : "acceptance criteria"}</span>
            <span className="c-ws-progress-val">
              {reviewed
                ? <><b>{met}</b> of {total} met{allMet ? " · ready for payout" : ` · ${total - met} to go`}</>
                : <>0 of {total} · {submitted ? "review queued" : "not submitted"}</>}
            </span>
          </div>
          <div className="c-ws-bar"><div className={`c-ws-bar-fill ${allMet ? "" : "warn"}`} style={{ width: pct + "%" }}></div></div>
        </div>

        {/* Lifecycle stage rail */}
        <div className="c-ws-stages">
          {WS_STAGES.map((s, i) => (
            <div key={s.k} className={`c-ws-stage ${i < curIdx ? "done" : ""} ${i === curIdx ? "current" : ""}`}>
              <span className="c-ws-stage-dot">{i < curIdx ? <Icon name="check" size={11} /> : i + 1}</span>
              <span className="c-ws-stage-lbl">{s.l}</span>
            </div>
          ))}
        </div>

        <div className="c-ws-body">
          {/* Your submission */}
          {submitted && (
            <div className="c-ws-sec">
              <div className="c-ws-sec-h"><Icon name="pr" size={12} /> your submission <span className="right">{b.submittedAt ? `linked ${fmtDate(b.submittedAt)}` : "linked via GitHub"}</span></div>
              <div className="c-pr-row">
                <span className="gh"><Icon name="github" size={16} /></span>
                <div className="c-pr-info">
                  <div className="c-pr-title">{review?.prTitle ?? b.review?.prTitle ?? `PR #${b.prNumber}`}</div>
                  <div className="c-pr-meta">
                    <span>{b.repo}#{b.prNumber}</span>
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
                <div className="c-links">
                  {b.supportingLinks.map((l: SupportingLink, i: number) => (
                    <a key={i} className="c-link" href={l.url} target="_blank" rel="noopener noreferrer">
                      <span className="ic"><Icon name={linkIcon(l.type)} size={13} /></span>
                      <div className="body"><div className="k">{l.type}</div><div className="v">{l.url}</div></div>
                      <Icon name="external" size={12} color="var(--fg-mute)" />
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Criteria — reviewed vs pending checklist */}
          {reviewed ? (
            <div className="c-ws-sec">
              <div className="c-ws-sec-h"><Icon name="spark" size={12} /> DevAsign review <span className="right">automated · vs locked criteria</span></div>
              <div className="c-review-head">
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
              <div className="c-crit-rows">
                {crits.map((c) => (
                  <div key={c.n} className={`c-crit-row ${c.status === "pending" ? "partial" : c.status}`}>
                    <span className="dot"></span>
                    <div className="body"><div className="txt">{c.text}</div>{c.finding && <div className="find">{c.finding}</div>}</div>
                    <span className="st">{c.status === "pending" ? "pending" : c.status === "met" ? "met" : "not met"}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="c-ws-sec">
              <div className="c-ws-sec-h"><Icon name="lock" size={12} /> what you need to deliver <span className="right">locked criteria</span></div>
              {submitted && (
                <div className="c-payout-ready" style={{ margin: "0 0 12px", borderColor: "var(--line-2)", background: "var(--bg)" }}>
                  <span className="ic" style={{ color: "var(--info)" }}><Icon name="spark" size={17} /></span>
                  <div><div className="t">Submitted — DevAsign review queued</div><div className="d">We're checking your PR against these criteria. Findings post here shortly.</div></div>
                </div>
              )}
              <div className="c-check-rows">
                {b.acceptance.map((c, i) => (
                  <div key={i} className="c-check-row"><span className="box"></span><div className="txt">{c}</div></div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {closedRejected ? (
          <div className="c-payout-ready" style={{ margin: 0, borderTop: "1px solid var(--line)", borderColor: "var(--line)", background: "var(--bg)" }}>
            <span className="ic" style={{ color: "var(--fg-mute)" }}><Icon name="check" size={18} /></span>
            <div><div className="t">Verdict accepted — bounty closed</div><div className="d">The {cmoney(b.amountUsdc)} escrow was returned to the sponsor. Nothing further is owed on either side.</div></div>
          </div>
        ) : !submitted ? (
          <>
            {extState === "pending" && (
              <div className="c-payout-ready" style={{ margin: 0, borderTop: "1px solid var(--line)" }}>
                <span className="ic"><Icon name="clock" size={18} /></span>
                <div>
                  <div className="t">Extension requested — {b.extension!.days} day{b.extension!.days === 1 ? "" : "s"}</div>
                  <div className="d">The sponsor has been notified and has {EXTENSION_AUTO_APPROVE_HOURS}h to respond — after that it's approved automatically. Your deadline holds meanwhile{b.deadlineAt && b.deadlineAt < Date.now() ? ", and no refund can happen while it's pending" : ""}.</div>
                </div>
              </div>
            )}
            <div className="c-ws-foot">
              <div className="grow hint"><Icon name="clock" size={11} style={{ verticalAlign: -1, marginRight: 4 }} />{b.acceptedAt ? `Accepted ${fmtDate(b.acceptedAt)} · ${deadlineText}.` : deadlineText + "."} Submit whenever you're ready.</div>
              {extState === "can_request" && (
                <button className="btn ghost" onClick={() => setExtOpen(true)}><Icon name="clock" size={12} /> Request extension</button>
              )}
              <button className="btn primary" onClick={() => { setLinksOnly(false); setSubmitOpen(true); }}><Icon name="pr" size={13} /> Make a submission</button>
            </div>
          </>
        ) : rejected ? (
          <>
            <div className="c-reject-banner">
              <span className="ic"><Icon name="x" size={16} /></span>
              <div><div className="t">{b.rejection!.byLogin} rejected this submission · {fmtDate(b.rejection!.at)}</div><div className="d">{b.rejection!.reason}</div></div>
            </div>
            <div className="c-ws-foot">
              <div className="grow hint"><Icon name="scale" size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
                You can rework and resubmit your PR, or accept the verdict to close it out.
              </div>
              <button className="btn ghost" disabled={busy} onClick={() => void acceptVerdict()}><Icon name="check" size={12} /> Accept verdict</button>
            </div>
          </>
        ) : payoutRequested ? (
          <div className="c-payout-ready" style={{ margin: 0, borderTop: "1px solid var(--line)" }}>
            <span className="ic"><Icon name="check" size={18} /></span>
            <div><div className="t">Payout requested</div><div className="d">The sponsor has been notified. On approval (or merge), {cmoney(b.amountUsdc)} releases to your wallet on Stellar. {deadlineNote}</div></div>
          </div>
        ) : allMet ? (
          <>
            <div className="c-payout-ready">
              <span className="ic"><Icon name="coins" size={18} /></span>
              <div><div className="t">All criteria met — ready for payout</div><div className="d">Request payout to notify the sponsor. Escrow releases on approval.</div></div>
            </div>
            <div className="c-ws-foot">
              <div className="grow hint"><Icon name="shield" size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Pays directly to your USDC wallet on file · Stellar {deadlineNote}</div>
              {prUrl && <a className="btn ghost" href={prUrl} target="_blank" rel="noopener noreferrer"><Icon name="external" size={12} /> View PR</a>}
              <button className="btn primary" disabled={busy} onClick={() => void requestPayout()}>
                <Icon name="coins" size={13} /> {busy ? "Requesting…" : `Request payout · ${cmoney(b.amountUsdc)}`}
              </button>
            </div>
          </>
        ) : !reviewed ? (
          <div className="c-ws-foot">
            <div className="grow hint"><Icon name="check" size={11} color="var(--success)" style={{ verticalAlign: -1, marginRight: 4 }} />Submitted. You can add more links or update your PR while it's in review. {deadlineNote}</div>
            <button className="btn ghost" onClick={() => { setLinksOnly(true); setSubmitOpen(true); }}><Icon name="plus" size={12} /> Add / update links</button>
          </div>
        ) : (
          <div className="c-ws-foot">
            <div className="grow hint"><Icon name="target" size={11} style={{ verticalAlign: -1, marginRight: 4 }} />{total - met} criteria outstanding. Push to {b.repo}#{b.prNumber} and DevAsign re-checks automatically. {deadlineNote}</div>
            {prUrl && <a className="btn primary" href={prUrl} target="_blank" rel="noopener noreferrer"><Icon name="external" size={12} /> Open the PR</a>}
          </div>
        )}
      </>}

      {submitOpen && (
        <SubmitModal b={b} linksOnly={linksOnly} onClose={() => setSubmitOpen(false)} onDone={() => void reload()} />
      )}
      {extOpen && (
        <ExtensionModal b={b} onClose={() => setExtOpen(false)} onDone={() => void reload()} />
      )}
    </div>
  );
};

// ═══ SMALL CARDS ═════════════════════════════════════════════════════════════
const Chev = ({ open }: { open: boolean }) => (
  <span className="c-chev" style={{ transform: open ? "rotate(-90deg)" : "rotate(90deg)" }}>
    <Icon name="chevron-r" size={11} />
  </span>
);

const BountyDetails = ({ b, kind }: { b: ContributorBounty; kind: "applied" | "completed" }) => {
  const { explorerBase } = useBounties();
  const escrowUrl = b.escrowContract
    ? `${explorerBase}/contract/${b.escrowContract}`
    : b.escrowTxHash
      ? `${explorerBase}/tx/${b.escrowTxHash}`
      : null;
  return (
  <div className="c-bdetails">
    {kind === "applied" && <>
      <div className="c-bd-h"><Icon name="lock" size={11} /> acceptance criteria</div>
      <div className="c-check-rows">
        {b.acceptance.map((c, i) => (
          <div key={i} className="c-check-row"><span className="box"></span><div className="txt">{c}</div></div>
        ))}
      </div>
      <div className="c-bd-h"><Icon name="coins" size={11} /> escrow</div>
      {escrowUrl ? (
        <a className="c-bd-escrow" href={escrowUrl} target="_blank" rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()} title={escrowUrl}>
          <span className="pip" style={{ background: "var(--accent)" }}></span>
          <span className="addr">{b.escrowTxHash ? `${b.escrowTxHash.slice(0, 6)}…${b.escrowTxHash.slice(-6)}` : "funded"}</span>
          <span className="go">View on Stellar Explorer <Icon name="external" size={11} /></span>
        </a>
      ) : (
        <div className="c-bd-escrow">
          <span className="pip" style={{ background: "var(--accent)" }}></span>
          <span className="addr">funded</span>
          <span className="go">escrowed on Stellar</span>
        </div>
      )}
    </>}

    {kind === "completed" && <>
      <div className="c-bd-h"><Icon name="pr" size={11} /> your submission</div>
      <div className="c-pr-row">
        <span className="gh"><Icon name="github" size={16} /></span>
        <div className="c-pr-info">
          <div className="c-pr-title">{b.review?.prTitle ?? `PR #${b.prNumber ?? "—"}`}</div>
          <div className="c-pr-meta">
            <span>{b.repo}#{b.prNumber ?? "—"}</span>
            <span style={{ color: "var(--success)" }}><Icon name="check" size={10} style={{ verticalAlign: -1 }} /> merged</span>
          </div>
        </div>
        {b.prNumber && (
          <a className="btn sm ghost" href={`https://github.com/${b.repo}/pull/${b.prNumber}`} target="_blank" rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}><Icon name="external" size={11} /> View</a>
        )}
      </div>
      {b.supportingLinks.length > 0 && (
        <div className="c-links">
          {b.supportingLinks.map((l, i) => (
            <a key={i} className="c-link" href={l.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
              <span className="ic"><Icon name={linkIcon(l.type)} size={13} /></span>
              <div className="body"><div className="k">{l.type}</div><div className="v">{l.url}</div></div>
              <Icon name="external" size={12} color="var(--fg-mute)" />
            </a>
          ))}
        </div>
      )}
      <div className="c-bd-payout">
        <Icon name="check" size={13} />
        <span>Paid {cmoney(b.amountUsdc)} USDC to your wallet{b.paidAt ? ` on ${fmtDate(b.paidAt)}` : ""} · Stellar</span>
        {b.payoutTxHash && <span className="tx">tx {b.payoutTxHash.slice(0, 8)}</span>}
      </div>
    </>}
  </div>
  );
};

const BountyCard = ({
  b,
  kind,
  expanded,
  onToggle,
}: {
  b: ContributorBounty;
  kind: "applied" | "completed";
  expanded?: boolean;
  onToggle?: () => void;
}) => {
  const content = (
    <>
      <div className="c-bcard-top">
        <span className="c-bcard-repo">{b.repo}#{b.issueNumber}</span>
        {kind === "applied" && <span className="pill"><i className="dot"></i> under review</span>}
        {kind === "completed" && <span className="pill success"><Icon name="check" size={9} /> paid</span>}
        <Chev open={!!expanded} />
        <span className="c-bcard-amt">{b.amountUsdc.toLocaleString()}<span className="u">USDC</span></span>
      </div>
      <div className="c-bcard-title">{b.title}</div>
      <div className="c-bcard-foot">
        {kind === "applied" && <>
          <span className="c-bcard-meta"><Icon name="clock" size={11} /> applied {b.myApplication ? timeAgo(b.myApplication.appliedAt) : ""}</span>
          <span className="c-bcard-meta"><Icon name="user" size={11} /> {b.applicantCount} applicant{b.applicantCount === 1 ? "" : "s"}</span>
        </>}
        {kind === "completed" && <>
          <span className="c-bcard-meta"><Icon name="coins" size={11} /> {b.paidAt ? `paid ${fmtDate(b.paidAt)}` : "paid"}</span>
          <span className="c-bcard-meta" style={{ color: "var(--success)" }}><Icon name="check" size={11} /> to wallet</span>
        </>}
      </div>
    </>
  );
  return (
    <div className={`c-bcard expandable ${kind} ${expanded ? "open" : ""}`}>
      <div className="c-bcard-inner" onClick={onToggle}>{content}</div>
      {expanded && <BountyDetails b={b} kind={kind} />}
    </div>
  );
};

// ═══ DASHBOARD ═══════════════════════════════════════════════════════════════
export function Dashboard() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { bounties, summary, loading } = useBounties();
  const groups = groupBounties(bounties);
  const [expandedActive, setExpandedActive] = React.useState<string | null>(null);
  const [expandedBounty, setExpandedBounty] = React.useState<string | null>(null);

  // Default the accordion to the first active bounty once data lands.
  React.useEffect(() => {
    if (expandedActive === null && groups.active.length > 0) setExpandedActive(groups.active[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.active.length]);

  const toggleActive = (id: string) => setExpandedActive((cur) => (cur === id ? null : id));
  const toggleBounty = (id: string) => setExpandedBounty((cur) => (cur === id ? null : id));

  const inReview = groups.active.filter((b) => ["review", "ready"].includes(bountyStage(b))).length;
  const inProgress = groups.active.length - inReview - groups.active.filter((b) => bountyStage(b) === "rejected").length;
  const acceptance = acceptanceRate(bounties);

  if (loading) {
    return <div style={{ display: "grid", placeItems: "center", minHeight: "50vh" }}><span className="mono mute" style={{ fontSize: 12 }}>loading your bounties…</span></div>;
  }

  const firstName = (auth.user?.githubLogin || "there");
  const empty = bounties.length === 0;

  return (
    <div className="c-dash">
      <div className="c-dash-hello">
        <div>
          <h1>Welcome back, {firstName}</h1>
          <div className="sub">
            {empty
              ? "Apply to a bounty from any DevAsign-funded GitHub issue and it shows up here."
              : `${groups.active.length} in progress · ${groups.applied.length} awaiting a decision`}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="c-stats">
        <div className="c-stat"><div className="c-stat-k">in progress</div><div className="c-stat-v">{summary.active}</div><div className="c-stat-d">{inReview} in review · {Math.max(inProgress, 0)} open</div></div>
        <div className="c-stat"><div className="c-stat-k">applications</div><div className="c-stat-v">{summary.applied}</div><div className="c-stat-d">awaiting decision</div></div>
        <div className="c-stat"><div className="c-stat-k">in escrow</div><div className="c-stat-v">{cmoney(summary.inEscrowUsdc)}<span className="u">USDC</span></div><div className="c-stat-d">across active work · releases on approval</div></div>
        <div className="c-stat"><div className="c-stat-k">lifetime earned</div><div className="c-stat-v">{cmoney(summary.lifetimeEarnedUsdc)}</div><div className="c-stat-d">{summary.completed} bounties{acceptance != null ? ` · ${acceptance}% accepted` : " paid out"}</div></div>
      </div>

      <div className="c-dash-grid">
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 22 }}>
          {/* Active workspaces — accordion, top 3 (per design; the rest live on the Bounties page) */}
          {groups.active.length > 0 && (
            <div>
              <div className="c-block-h" style={{ marginBottom: 12 }}>
                <span className="t">Active bounties</span>
                <span className="ct">{Math.min(groups.active.length, 3)}</span>
                <span className="line"></span>
                {groups.active.length > 3 && (
                  <span className="link" onClick={() => navigate("/bounties")}>all {groups.active.length} →</span>
                )}
              </div>
              {groups.active.slice(0, 3).map((ab) => (
                <Workspace key={ab.id} b={ab} expanded={expandedActive === ab.id} onToggle={() => toggleActive(ab.id)} />
              ))}
            </div>
          )}

          {/* Applied */}
          {groups.applied.length > 0 && (
            <div className="c-block">
              <div className="c-block-h">
                <span className="t">Applied</span>
                <span className="ct">{groups.applied.length}</span>
                <span className="line"></span>
              </div>
              {groups.applied.map((b) => (
                <BountyCard key={b.id} b={b} kind="applied" expanded={expandedBounty === b.id} onToggle={() => toggleBounty(b.id)} />
              ))}
            </div>
          )}

          {/* Completed */}
          {groups.completed.length > 0 && (
            <div className="c-block">
              <div className="c-block-h">
                <span className="t">Completed</span>
                <span className="ct">{groups.completed.length}</span>
                <span className="line"></span>
                <span className="link" onClick={() => navigate("/wallet")}>wallet →</span>
              </div>
              {groups.completed.map((b) => (
                <BountyCard key={b.id} b={b} kind="completed" expanded={expandedBounty === b.id} onToggle={() => toggleBounty(b.id)} />
              ))}
            </div>
          )}

          {empty && (
            <div className="card" style={{ padding: 28, textAlign: "center" }}>
              <div className="mono" style={{ fontSize: 13, color: "var(--fg)" }}>No bounties yet</div>
              <div className="mono mute" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
                Find a DevAsign bounty on a GitHub issue and hit "Apply for this bounty".<br />
                Your applications, active work, and payouts all land here.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
