// Fund bounty — the page a sponsor lands on from the GitHub bot comment's
// "Fund bounty" link (/bounties/:id/fund?token=…).
//
// Two jobs in one screen, in the order they have to happen: REVIEW the
// acceptance criteria DevAsign drafted from the issue and the codebase, then
// sign the escrow. Funding freezes the list — every delivered PR is judged
// against exactly these words — so this page is the sponsor's last chance to
// change them, and the only place the review is nudged.
//
// A dedicated page rather than the modal this route used to open over the
// dashboard: an editable list plus save state plus the wallet handshake is more
// than a modal holds, and loading the whole bounties dashboard behind a scrim to
// host it was wasted work for someone arriving cold from an external link.
//
// Criteria are a NUDGE, never a gate. Funding stays available while the draft is
// still running, after it failed, and with an empty list — money must never wait
// on an LLM.
import React from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Icon } from "./icons";
import { api, ApiError, type Bounty } from "./api";
import { freighterAddress, freighterSign, money, shortHash, stellarTxUrl } from "./bounty-shared";
import { runFund, type FundPhase } from "./bounty-fund";
import {
  addRow,
  editRow,
  isDirty,
  MAX_CRITERIA,
  MAX_CRITERION_CHARS,
  moveRow,
  normalizeForSave,
  overLongRows,
  removeRow,
} from "./acceptance-edit";
import { isTransientNotDurable, runSave, saveErrorMessage } from "./optimistic-save";

// How long to keep polling a draft before giving up and letting the sponsor
// write their own. Generous: the job is one model call, but it queues behind
// other reviews.
const DRAFT_POLL_MS = 3000;
const DRAFT_POLL_LIMIT_MS = 90_000;
// Debounce before autosaving an edit. Long enough not to fire mid-word.
const SAVE_DEBOUNCE_MS = 800;

/** Client-side mirror of the backend's acceptanceLocked: frozen once funded. */
const isLocked = (b: Bounty) => b.status !== "PENDING_FUNDING" || Boolean(b.escrowTxHash);

/**
 * A textarea that grows to fit its content.
 *
 * Sizing on `onInput` alone is not enough: criteria arrive already written, so
 * the first paint has to measure too, or a criterion that wraps is clipped to
 * one row — which is exactly what happens at mobile widths. A layout effect on
 * `value` covers mount and every later change, and the resize listener covers
 * the case where the wrap point moves without the text doing so.
 */
const AutoTextarea = ({
  value,
  onChange,
  className,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
}) => {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const fit = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  React.useLayoutEffect(fit, [value, fit]);
  React.useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fit]);
  return (
    <textarea
      ref={ref}
      className={className}
      value={value}
      rows={1}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    />
  );
};

export const FundBountyPage = () => {
  const params = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const id = params.id;
  const token = search.get("token");

  const [bounty, setBounty] = React.useState<Bounty | null>(null);
  const [phase, setPhase] = React.useState<FundPhase>("loading");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [hash, setHash] = React.useState<string | null>(null);

  // Editor state. `rows` is what's on screen (blank rows allowed while typing);
  // `saved` is what the backend last confirmed.
  const [rows, setRows] = React.useState<string[]>([]);
  const [saved, setSaved] = React.useState<string[]>([]);
  const [savePending, setSavePending] = React.useState(false);
  const [saveErr, setSaveErr] = React.useState<string | null>(null);

  const saveSeq = React.useRef(0);
  const retryTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowsRef = React.useRef<string[]>([]);
  const savedRef = React.useRef<string[]>([]);
  rowsRef.current = rows;
  savedRef.current = saved;

  const locked = bounty ? isLocked(bounty) : false;
  const drafting = bounty?.acceptanceState === "generating";

  // ── load ───────────────────────────────────────────────────────────────────
  React.useEffect(() => {
    let alive = true;
    if (!id || !token) {
      setPhase("error");
      setMsg("This funding link is missing its bounty id or security token.");
      return;
    }
    (async () => {
      try {
        const r = await api.bounty(id);
        if (!alive) return;
        setBounty(r.bounty);
        setRows(r.bounty.acceptance);
        setSaved(r.bounty.acceptance);
        setPhase("ready");
      } catch (e: any) {
        if (!alive) return;
        setPhase("error");
        setMsg(
          e instanceof ApiError && e.status === 404
            ? "That bounty no longer exists."
            : e?.message || "Couldn't load this bounty."
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, token]);

  // ── poll while the draft is running ────────────────────────────────────────
  React.useEffect(() => {
    if (!drafting || !id) return;
    let alive = true;
    const startedAt = Date.now();
    const t = setInterval(async () => {
      if (Date.now() - startedAt > DRAFT_POLL_LIMIT_MS) {
        clearInterval(t);
        // Present it as failed rather than spinning forever; the sponsor can
        // still write their own list and fund.
        if (alive) setBounty((b) => (b ? { ...b, acceptanceState: "errored" } : b));
        return;
      }
      try {
        const r = await api.bounty(id);
        if (!alive || r.bounty.acceptanceState === "generating") return;
        setBounty(r.bounty);
        // Only adopt the draft if the sponsor hasn't started writing their own.
        if (!isDirty(rowsRef.current, savedRef.current)) {
          setRows(r.bounty.acceptance);
          setSaved(r.bounty.acceptance);
        }
      } catch {
        // transient — keep polling
      }
    }, DRAFT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [drafting, id]);

  // ── poll while the escrow confirms ─────────────────────────────────────────
  React.useEffect(() => {
    if (phase !== "confirming" || !id) return;
    let alive = true;
    const t = setInterval(async () => {
      try {
        const r = await api.bounty(id);
        if (!alive) return;
        setBounty(r.bounty);
        if (r.bounty.status !== "PENDING_FUNDING") setPhase("done");
      } catch {
        // transient — keep polling
      }
    }, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [phase, id]);

  React.useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    },
    []
  );

  // ── saving ─────────────────────────────────────────────────────────────────
  const persist = React.useCallback(
    async (bountyId: string, next: string[]) => {
      const r = await api.setBountyAcceptance(bountyId, next);
      setSaved(r.bounty.acceptance);
      return r;
    },
    []
  );

  const scheduleSave = React.useCallback(
    (next: string[]) => {
      if (!id) return;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        void runSave<string[]>(
          {
            scopeId: id,
            getPrev: () => savedRef.current,
            persist,
            setValue: (v) => setSaved(v ?? []),
            setErr: setSaveErr,
            setPending: setSavePending,
            seqRef: saveSeq,
            retryTimer,
            scheduleRetry: (fn, ms) => setTimeout(fn, ms),
          },
          normalizeForSave(next)
        );
      }, SAVE_DEBOUNCE_MS);
    },
    [id, persist]
  );

  const update = (next: string[]) => {
    setRows(next);
    setSaveErr(null);
    scheduleSave(next);
  };

  /**
   * Flush pending edits before funding. Deliberately does NOT reuse runSave's
   * transient handling: on the Workflow screen a not-yet-durable edit is
   * recoverable, but here it would be frozen into a paid contract the moment
   * the escrow lands. The sponsor must never escrow against a list different
   * from the one on screen, so a 503 blocks funding rather than proceeding.
   */
  const flushSave = React.useCallback(async (): Promise<boolean> => {
    if (!id) return false;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    saveSeq.current++; // supersede any in-flight debounced save
    const next = normalizeForSave(rowsRef.current);
    try {
      await persist(id, next);
      setRows(next);
      setSavePending(false);
      setSaveErr(null);
      return true;
    } catch (e: any) {
      setSavePending(false);
      setSaveErr(
        isTransientNotDurable(e)
          ? "Your edits are still saving — retry funding in a moment."
          : saveErrorMessage(e)
      );
      return false;
    }
  }, [id, persist]);

  // ── funding ────────────────────────────────────────────────────────────────
  const fund = async () => {
    if (!id || !token) return;
    // The list that locks must be the list on screen.
    if (!locked && (isDirty(rows, saved) || savePending)) {
      const ok = await flushSave();
      if (!ok) return;
    }
    await runFund({
      getAddress: freighterAddress,
      buildTx: (address) => api.bountyFundingTx(id, token, address),
      sign: freighterSign,
      submit: (signedXdr) => api.submitBountyFunding(id, token, signedXdr),
      setPhase,
      setMsg,
      setHash,
    });
  };

  const close = () => navigate("/bounty");

  // ── render ─────────────────────────────────────────────────────────────────
  if (phase === "loading") {
    return (
      <div className="fb-page">
        <div className="fb-shell mono mute">Loading bounty…</div>
      </div>
    );
  }

  if (!bounty) {
    return (
      <div className="fb-page">
        <div className="fb-shell">
          <div className="fb-eyebrow">Fund bounty</div>
          <h1 className="fb-title">Couldn't open this bounty</h1>
          <div className="tu-notice fb-notice">
            <Icon name="warn" size={15} />
            <span>{msg || "Something went wrong."}</span>
          </div>
          <div className="fb-foot">
            <button className="btn ghost" onClick={close}>
              Back to bounties
            </button>
          </div>
        </div>
      </div>
    );
  }

  const settled = phase === "done" || phase === "confirming";
  const busy = phase === "working";
  const tooLong = overLongRows(rows);
  const effective = normalizeForSave(rows);

  return (
    <div className="fb-page">
      <div className="fb-shell">
        <div className="fb-head">
          <div className="fb-eyebrow">Fund bounty</div>
          <h1 className="fb-title">{bounty.title}</h1>
          <div className="fb-meta mono">
            <span className="fb-code">{bounty.code}</span>
            <span className="fb-dot">·</span>
            <a href={bounty.issueUrl} target="_blank" rel="noreferrer" className="fb-link">
              {bounty.repo}#{bounty.issueNumber}
            </a>
            <span className="fb-dot">·</span>
            <span>{money(bounty.amountUsdc)} USDC</span>
            <span className="fb-dot">·</span>
            <span>{bounty.deliveryDays}-day delivery window</span>
          </div>
        </div>

        {settled ? (
          <div className="wd-success fb-success">
            <div className="wd-success-icon">
              <Icon name="check" size={22} />
            </div>
            <div className="wd-success-title">
              {phase === "done" ? "Escrow funded" : "Transaction submitted"}
            </div>
            <div className="wd-success-sub">
              {phase === "done" ? (
                <>
                  {money(bounty.amountUsdc)} USDC is now escrowed and the acceptance criteria are locked.{" "}
                  {hash ? (
                    <>
                      Tx{" "}
                      <a className="mono" href={stellarTxUrl(hash)} target="_blank" rel="noreferrer">
                        {shortHash(hash)}
                      </a>
                      .
                    </>
                  ) : (
                    "The transaction has been submitted."
                  )}
                </>
              ) : (
                <>
                  Your funding transaction was signed and broadcast to Stellar. Waiting for on-chain
                  confirmation — this usually takes under a minute. You can close this page; the bounty
                  opens automatically once the escrow confirms.
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            <section className="fb-section">
              <div className="fb-section-head">
                <span>Acceptance criteria</span>
                {locked ? (
                  <span className="fb-tag fb-tag-locked">locked</span>
                ) : drafting ? (
                  <span className="fb-tag">drafting…</span>
                ) : bounty.acceptanceState === "errored" ? (
                  <span className="fb-tag fb-tag-warn">draft failed</span>
                ) : (
                  <span className="fb-tag">AI-drafted</span>
                )}
              </div>

              {bounty.acceptanceEndGoal ? (
                <div className="fb-endgoal">
                  <span className="fb-endgoal-label mono">End goal</span>
                  <span>{bounty.acceptanceEndGoal}</span>
                </div>
              ) : null}

              {locked ? (
                <p className="fb-nudge">This bounty is funded — its criteria are locked.</p>
              ) : (
                <p className="fb-nudge">
                  DevAsign drafted these from your issue and your codebase.{" "}
                  <strong>Give them a read.</strong> Once you fund, they're locked, and every pull request
                  is reviewed against exactly this list.
                </p>
              )}

              {drafting ? (
                <div className="fb-drafting">
                  <div className="fb-skel" />
                  <div className="fb-skel" />
                  <div className="fb-skel" />
                  <div className="mono mute fb-drafting-note">
                    Reading the issue and your codebase… you can fund without waiting.
                  </div>
                </div>
              ) : locked ? (
                <ul className="fb-locked-list">
                  {bounty.acceptance.length ? (
                    bounty.acceptance.map((c, i) => (
                      <li key={i} className="fb-locked-item">
                        <span className="fb-num mono">{i + 1}</span>
                        <span>{c}</span>
                      </li>
                    ))
                  ) : (
                    <li className="mono mute">No acceptance criteria were set.</li>
                  )}
                </ul>
              ) : (
                <>
                  {bounty.acceptanceState === "errored" && (
                    <div className="tu-notice fb-notice">
                      <Icon name="warn" size={15} />
                      <span>
                        Couldn't draft criteria automatically. Add your own below, or fund without any.
                      </span>
                    </div>
                  )}

                  <div className="fb-rows">
                    {rows.map((row, i) => (
                      <div className="fb-row" key={i}>
                        <span className="fb-num mono">{i + 1}</span>
                        <AutoTextarea
                          className={`fb-input${tooLong.includes(i) ? " fb-input-bad" : ""}`}
                          value={row}
                          ariaLabel={`Acceptance criterion ${i + 1}`}
                          placeholder="Something a reviewer can confirm by reading the pull request…"
                          onChange={(next) => update(editRow(rows, i, next))}
                        />
                        <div className="fb-row-actions">
                          <button
                            className="fb-icon-btn"
                            title="Move up"
                            aria-label={`Move criterion ${i + 1} up`}
                            disabled={i === 0}
                            onClick={() => update(moveRow(rows, i, -1))}
                          >
                            ↑
                          </button>
                          <button
                            className="fb-icon-btn"
                            title="Move down"
                            aria-label={`Move criterion ${i + 1} down`}
                            disabled={i === rows.length - 1}
                            onClick={() => update(moveRow(rows, i, 1))}
                          >
                            ↓
                          </button>
                          <button
                            className="fb-icon-btn fb-icon-del"
                            title="Remove"
                            aria-label={`Remove criterion ${i + 1}`}
                            onClick={() => update(removeRow(rows, i))}
                          >
                            <Icon name="x" size={11} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {tooLong.length > 0 && (
                    <div className="fb-save-note fb-save-bad mono">
                      {tooLong.length === 1 ? "One criterion is" : `${tooLong.length} criteria are`} over{" "}
                      {MAX_CRITERION_CHARS} characters and won't save.
                    </div>
                  )}

                  <div className="fb-rows-foot">
                    <button
                      className="btn ghost sm"
                      disabled={rows.length >= MAX_CRITERIA}
                      onClick={() => update(addRow(rows))}
                    >
                      + Add criterion
                    </button>
                    <span className="fb-save-note mono">
                      {saveErr ? (
                        <span className="fb-save-bad">{saveErr}</span>
                      ) : savePending ? (
                        "Saving…"
                      ) : isDirty(rows, saved) ? (
                        "Unsaved"
                      ) : effective.length ? (
                        `${effective.length} of ${MAX_CRITERIA} saved`
                      ) : (
                        "No criteria"
                      )}
                    </span>
                  </div>
                </>
              )}
            </section>

            {/* A stale Fund link still resolves after the escrow lands (the bot
                comment is edited away, but a bookmark isn't). Telling a sponsor
                their money "will move into escrow" when it already has — and
                offering the button again — is the worst thing this page could
                say, so the funded case gets its own notice and no CTA. */}
            {locked ? (
              <div className="tu-notice fb-notice fb-notice-ok">
                <Icon name="check" size={15} />
                <span>
                  This bounty is already funded — <b>{money(bounty.amountUsdc)} USDC</b> is held in
                  escrow. There's nothing left to do here.
                </span>
              </div>
            ) : (
              <div className="tu-notice fb-notice">
                <Icon name="warn" size={15} />
                <span>
                  <b>{money(bounty.amountUsdc)} USDC</b> will move from your wallet into escrow on
                  Stellar. It's released to the contributor when you merge their PR, or refunded to you
                  if the deadline elapses.
                </span>
              </div>
            )}

            {msg && phase === "error" ? (
              <div className="fb-save-note fb-save-bad mono">{msg}</div>
            ) : null}
          </>
        )}

        <div className="fb-foot">
          <button className="btn ghost" onClick={close}>
            {settled || locked ? "Done" : "Cancel"}
          </button>
          {/* Never disabled by draft state: criteria are a nudge, not a gate. A
              Fund button switched off by an LLM hiccup is a revenue bug. But an
              ALREADY funded bounty gets no button at all — see the notice above. */}
          {!settled && !locked && (
            <button className="btn primary" disabled={busy} onClick={fund}>
              <Icon name="check" size={13} />{" "}
              {busy
                ? "Signing…"
                : effective.length === 0 && !locked
                  ? "Fund without criteria"
                  : "Fund with Freighter"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
