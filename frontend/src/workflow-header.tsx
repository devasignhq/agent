// @ts-nocheck
// Workflow header widgets: the repo picker rendered inside the breadcrumb and
// the selected repo's details (reviews, flake, verification setup) on the right.
import React from "react";
import { useSearchParams } from "react-router-dom";
import { Icon } from "./icons";
import { api, type Repository } from "./api";
import { BOOT_CHECK_ASK_FAILED, VERIFY_YML_REFERENCE, bootCheckStarted, bootCheckView, browserTestsRow, opensBrowserSetup, withoutBrowserSetup } from "./verify-setup-view";
import { answersFromForm, checklistItems, formFromSetup, loginNoneToggle, probeSummary, serversLocked, serversNoneToggle, setupPrOpen } from "./verify-setup-form";

export type WorkflowHeaderState = {
  repos: Repository[];
  repoId: string;
  repo: Repository | null;
  select: (id: string) => void;
};

function usePopover(open: boolean, onClose: () => void) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // Deferred so the click that opened the popover doesn't close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    document.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open, onClose]);
  return ref;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// A modal drawer, not a popover: Tab stays inside, the page behind it doesn't
// scroll, and closing hands focus back to the button that opened it.
function useDrawer(onClose: () => void, opener: React.RefObject<HTMLElement>) {
  const ref = React.useRef<HTMLDivElement>(null);
  const latest = React.useRef(onClose);
  latest.current = onClose;
  React.useEffect(() => {
    const body = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); latest.current(); return; }
      if (e.key !== "Tab" || !ref.current) return;
      const f = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === ref.current);
      if (f.length === 0) { e.preventDefault(); ref.current.focus(); return; }
      const first = f[0];
      const last = f[f.length - 1];
      const inside = ref.current.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    ref.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = body;
      opener.current?.focus();
    };
  }, [opener]);
  return ref;
}

export function RepoPicker({ repos, repoId, repo, select }: WorkflowHeaderState) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const close = React.useCallback(() => setOpen(false), []);
  const ref = usePopover(open, close);
  const searchable = repos.length > 6;
  const needle = q.trim().toLowerCase();
  const shown = needle ? repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(needle)) : repos;

  return (
    <div ref={ref} className="wf-repo-pick">
      <button
        type="button"
        className={`wf-repo-btn ${open ? "is-open" : ""}`}
        onClick={() => { setOpen((o) => !o); setQ(""); }}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={repos.length === 0}
        title={repo ? `${repo.owner}/${repo.name}` : undefined}
      >
        <Icon name="github" size={12} />
        <span className="wf-repo-btn-name">
          {repo ? <><span className="wf-repo-owner">{repo.owner}/</span>{repo.name}</> : repos.length === 0 ? "No repositories" : "Select repository"}
        </span>
        <Icon name="chevron-d" size={11} />
      </button>
      {open && (
        <div className="wf-repo-menu" role="listbox" aria-label="Repositories">
          {searchable && (
            <div className="wf-repo-search">
              <Icon name="search" size={12} />
              <input autoFocus className="input bare" placeholder="Filter repositories…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          <div className="wf-repo-list">
            {shown.length === 0 && <div className="wf-repo-none mute">No matches.</div>}
            {shown.map((r) => {
              const s = r.reviewStats;
              const picked = r.id === repoId;
              return (
                <button
                  key={r.id}
                  type="button"
                  role="option"
                  aria-selected={picked}
                  className={`wf-repo-opt ${picked ? "is-picked" : ""}`}
                  onClick={() => { select(r.id); close(); }}
                >
                  <span className="wf-repo-opt-name"><span className="wf-repo-owner">{r.owner}/</span>{r.name}</span>
                  <span className="wf-repo-opt-meta">
                    {s ? `${s.total} ${s.total === 1 ? "review" : "reviews"}` : ""}
                    {picked && <Icon name="check" size={11} />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const VERIFY_LABEL = {
  verified: "verified",
  pr_merged: "awaiting first run",
  pr_open: "setup PR open",
  pr_closed: "setup PR closed",
  none: "not set up",
};

const SERVICES = ["postgres", "mysql", "redis"];
const EMPTY_SERVER = { dir: "", script: "", port: "", ready: "" };
const LOCAL_CHECK = /^(\/|https?:\/\/(localhost|127\.0\.0\.1)([:/]|$))/;

// The backend names the answer key at the head of its 400 message, so the
// sentence can land on the row that asked for it.
const ANSWER_FIELD = { start: "start", servers: "servers", services: "services", login: "login", env: "secrets" };
function fieldOf(message: string | undefined) {
  return ANSWER_FIELD[String(message || "").split(/[^a-zA-Z]/)[0]] || null;
}

const SETUP_QUEUED = "Queued — the setup PR takes about a minute to update, and these answers stay here until it lands.";

function recheckText(res: { pushed: boolean; reason?: string; retryAfterMs?: number }) {
  if (res.reason === "cooldown") return `A re-check was just asked for — try again in ${Math.ceil((res.retryAfterMs ?? 0) / 1000)}s`;
  if (res.reason === "no_setup_pr") return "There is no open setup PR to re-check";
  if (res.reason === "no_installation") return "The DevAsign GitHub App is no longer installed on this repo";
  if (res.reason === "push_failed") return "GitHub would not take the push — try again";
  return res.pushed ? "Pushed to the setup PR — its CI boots the app again" : "The setup PR already has nothing to re-run";
}

function CheckRow({ item, error, children }) {
  return (
    <section className={`wf-check ${item.needsAnswer ? "is-ask" : ""}`} aria-label={item.label} data-check={item.key}>
      <div className="wf-check-head">
        <i className={`wf-check-dot ${item.tone}`} />
        <span className="wf-check-label">{item.label}</span>
        {item.needsAnswer && <span className="wf-check-ask">needs an answer</span>}
      </div>
      <div className={`wf-check-text ${item.tone === "warn" ? "t-warn" : "mute"}`}>{item.text}</div>
      {children}
      {error && <div className="wf-check-err">{error}</div>}
    </section>
  );
}

function Cmd({ label, start, url, servers }: { label: string; start: string; url?: string; servers?: string[] }) {
  return (
    <div className="wf-check-cmd">
      <span className="wf-check-cmd-k">{label}</span>
      <span>
        <span className="mono">{start}</span>
        {url && <> → <span className="mono">{url}</span></>}
        {servers && servers.length > 0 && ` · with ${servers.join(", ")}`}
      </span>
    </div>
  );
}

function PackageFields({ packages, value, onChange, dirLabel }) {
  const pkg = packages.find((p) => p.dir === value.dir) || null;
  return (
    <div className="wf-answer-grid">
      <label className="wf-field">
        <span className="wf-label">{dirLabel}</span>
        <select
          className="input"
          value={value.dir}
          onChange={(e) => {
            const next = packages.find((p) => p.dir === e.target.value) || null;
            onChange({
              ...value,
              dir: e.target.value,
              script: next && next.scripts.includes(value.script) ? value.script : (next?.scripts[0] ?? ""),
              // Clearing the package is this row's reset, so the port goes with it — a kept port
              // makes "leave as proposed" submit a half-answer the form refuses.
              port: next ? (next.port ? String(next.port) : value.port) : "",
            });
          }}
        >
          <option value="">leave as proposed</option>
          {packages.map((p) => <option key={p.dir} value={p.dir}>{p.dir}{p.framework ? ` · ${p.framework}` : ""}</option>)}
        </select>
      </label>
      <label className="wf-field">
        <span className="wf-label">Script</span>
        <select className="input" value={value.script} disabled={!pkg} onChange={(e) => onChange({ ...value, script: e.target.value })}>
          <option value="">{pkg ? "pick a script" : "pick a package first"}</option>
          {(pkg?.scripts ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label className="wf-field">
        <span className="wf-label">Port</span>
        <input className="input" inputMode="numeric" placeholder="3001" value={value.port} onChange={(e) => onChange({ ...value, port: e.target.value })} />
      </label>
    </div>
  );
}

function ServersEditor({ packages, setup, form, patch }) {
  const locked = serversLocked(setup);
  if (locked) return <div className="wf-check-hint mute">{locked}</div>;
  return (
    <div className="wf-answer">
      <label className="wf-opt">
        <input type="checkbox" checked={form.serversNone} onChange={(e) => patch(serversNoneToggle(e.target.checked, setup))} />
        <span>This app needs no other server</span>
      </label>
      {!form.serversNone && packages.length > 0 && (
        <>
          {form.servers.map((s, i) => (
            <div key={i} className="wf-answer-row">
              <PackageFields
                packages={packages}
                value={s}
                dirLabel="Package"
                onChange={(next) => patch({ servers: form.servers.map((row, j) => (j === i ? next : row)) })}
              />
              <label className="wf-field">
                <span className="wf-label">Ready path</span>
                <input className="input" placeholder="/" value={s.ready} onChange={(e) => patch({ servers: form.servers.map((row, j) => (j === i ? { ...row, ready: e.target.value } : row)) })} />
              </label>
              <button type="button" className="btn ghost sm" onClick={() => patch({ servers: form.servers.filter((_, j) => j !== i) })}>
                <Icon name="x" size={11} /> Remove
              </button>
            </div>
          ))}
          <button type="button" className="btn ghost sm" onClick={() => patch({ servers: [...form.servers, EMPTY_SERVER] })}>
            <Icon name="plus" size={11} /> Add a server
          </button>
        </>
      )}
    </div>
  );
}

function SecretsBlock({ candidates, form, patch }) {
  const names = candidates?.secretNames ?? null;
  const missing = candidates?.missingSecrets ?? null;
  return (
    <div className="wf-answer">
      {candidates && (
        <div className="wf-check-links">
          {names === null
            ? <span className="mute">DevAsign can't read this repo's secrets, so it can't say which are set.</span>
            : names.length > 0
            ? <span className="mute">Set: <span className="mono">{names.join(", ")}</span></span>
            : null}
          {missing && missing.length > 0 && <span className="t-warn">Missing: <span className="mono">{missing.join(", ")}</span></span>}
          {candidates.secretsUrl && (
            <a className="wf-verify-link" href={candidates.secretsUrl} target="_blank" rel="noreferrer">repository secrets <Icon name="external" size={10} /></a>
          )}
        </div>
      )}
      {form && (
        <label className="wf-field">
          <span className="wf-label">Secrets the app needs to boot</span>
          <textarea className="textarea" rows={2} placeholder="DATABASE_URL, SESSION_SECRET" value={form.env} onChange={(e) => patch({ env: e.target.value })} />
          <span className="wf-check-hint mute">Names only, comma or newline separated. DevAsign passes them through from the repo's secrets.</span>
        </label>
      )}
    </div>
  );
}

function LoginBlock({ candidates, proposed, setup, form, patch }) {
  const scripts = candidates?.loginScripts ?? [];
  const typed = form?.login.check.trim() ?? "";
  const remote = typed && !LOCAL_CHECK.test(typed);
  const legacy = proposed?.login?.strategy && proposed.login.strategy !== "none" ? proposed.login.strategy : null;
  return (
    <div className="wf-answer">
      {legacy && (
        <div className="t-warn wf-check-hint">
          <span className="mono">login.strategy: {legacy}</span> still parses, but nothing applies it — a login script is what signs the browser in.
        </div>
      )}
      {form && (
        <>
          <label className="wf-opt">
            <input type="checkbox" checked={form.loginNone} onChange={(e) => patch(loginNoneToggle(e.target.checked, setup))} />
            <span>Browser tests don't need to be signed in</span>
          </label>
          {!form.loginNone && (
            <div className="wf-answer-grid two">
              <label className="wf-field">
                <span className="wf-label">Login script</span>
                <input
                  className="input"
                  list={scripts.length > 0 ? "wf-login-scripts" : undefined}
                  placeholder="scripts/devasign-login.mjs"
                  value={form.login.script}
                  onChange={(e) => patch({ login: { ...form.login, script: e.target.value } })}
                />
                {scripts.length > 0 && <datalist id="wf-login-scripts">{scripts.map((s) => <option key={s} value={s} />)}</datalist>}
              </label>
              <label className="wf-field">
                <span className="wf-label">Session check</span>
                <input className="input" placeholder="/api/me" value={form.login.check} onChange={(e) => patch({ login: { ...form.login, check: e.target.value } })} />
                <span className={`wf-check-hint ${remote ? "t-warn" : "mute"}`}>
                  {remote
                    ? "That check leaves localhost — CI would sign in against a real deployment."
                    : "A path DevAsign fetches with the saved session to prove the sign-in worked."}
                </span>
              </label>
            </div>
          )}
        </>
      )}
      <div className="wf-check-links">
        <a className="wf-verify-link" href={VERIFY_YML_REFERENCE} target="_blank" rel="noreferrer">verify block reference <Icon name="external" size={10} /></a>
      </div>
    </div>
  );
}

// Never re-opens a PR the user closed themselves; "Update workflow" is the only
// way an onboarded repo gets a refreshed workflow.
function VerifySetupDrawer({ repo, onClose, opener }: { repo: Repository; onClose: () => void; opener: React.RefObject<HTMLElement> }) {
  const ref = useDrawer(onClose, opener);
  const [setup, setSetup] = React.useState(null);
  const [form, setForm] = React.useState(null);
  const [failed, setFailed] = React.useState(false);
  const [mode, setMode] = React.useState("separate");
  const [workflow, setWorkflow] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState(null);
  const [queued, setQueued] = React.useState(null);
  const [checking, setChecking] = React.useState(false);
  const [checkNote, setCheckNote] = React.useState(null);
  const [rechecking, setRechecking] = React.useState(false);
  const [recheckNote, setRecheckNote] = React.useState(null);
  const load = React.useCallback(
    (reset?: boolean) =>
      api
        .verifySetup(repo.id)
        .then((s) => {
          setSetup(s);
          setFailed(false);
          // Re-reading after an action shouldn't throw away answers still being typed.
          setForm((f) => (reset || !f ? formFromSetup(s) : f));
        })
        .catch(() => setFailed(true)),
    [repo.id]
  );
  React.useEffect(() => { void load(true); }, [load]);

  const patch = React.useCallback((next) => { setForm((f) => ({ ...f, ...next })); setProblem(null); }, []);

  const body = () => {
    if (!setup) return <div className="wf-verify-body mute mono" style={{ fontSize: 11 }}>{failed ? "Couldn't load verification setup." : "loading…"}</div>;
    const ob = setup.onboarding || { state: "none" };
    const candidates = setup.candidates ?? null;
    const packages = candidates?.packages ?? [];
    const proposed = setup.proposed ?? null;
    const row = browserTestsRow(setup);
    const bootCheck = bootCheckView(setup);
    const probe = probeSummary(setup.boot);
    const items = checklistItems(setup);
    const frameworks = (setup.detected?.frameworks || []).map((f) => f.name).join(", ");
    const pillClass = ob.state === "verified" ? "ok" : ob.state === "pr_open" || ob.state === "pr_merged" ? "info" : "nit";
    const stateText =
      ob.state === "verified" ? "verified, a run succeeded" :
      ob.state === "pr_merged" ? "workflow merged, waiting for the first run" :
      ob.state === "pr_open" ? `setup PR #${ob.prNumber} open` :
      ob.state === "pr_closed" ? `setup PR #${ob.prNumber} was closed` : "not set up";
    // `answers` reach a backend that offered candidates; an older one gets the plain request.
    const answerable = !!candidates && !!form;

    const editor = (key) => {
      if (key === "start") {
        return (
          <div className="wf-answer">
            {proposed?.start && <Cmd label="setup PR" start={proposed.start} url={proposed.url} />}
            {row.boot && <Cmd label="default branch" start={row.boot.start} url={row.boot.url} />}
            {answerable && packages.length > 0 && (
              <PackageFields packages={packages} value={form.start} dirLabel="Package" onChange={(next) => patch({ start: next })} />
            )}
          </div>
        );
      }
      if (key === "servers") {
        return (
          <div className="wf-answer">
            {(proposed?.servers ?? []).map((s) => <Cmd key={s.name} label={s.name} start={s.start} url={s.url} />)}
            {answerable && <ServersEditor packages={packages} setup={setup} form={form} patch={patch} />}
          </div>
        );
      }
      if (key === "services") {
        if (!answerable) return null;
        return (
          <div className="wf-answer wf-answer-opts">
            {SERVICES.map((name) => (
              <label key={name} className="wf-opt">
                <input
                  type="checkbox"
                  checked={form.services.includes(name)}
                  onChange={(e) => patch({ services: e.target.checked ? [...form.services, name] : form.services.filter((s) => s !== name) })}
                />
                <span className="mono">{name}</span>
              </label>
            ))}
          </div>
        );
      }
      if (key === "secrets") return <SecretsBlock candidates={candidates} form={answerable ? form : null} patch={patch} />;
      if (key === "login") return <LoginBlock candidates={candidates} proposed={proposed} setup={setup} form={answerable ? form : null} patch={patch} />;
      if (key === "boot") {
        const saidByRow = (line) => !line || line === items.find((i) => i.key === "boot")?.text;
        return (
          <div className="wf-answer">
            {probe && !saidByRow(probe.line) && <div className={probe.tone === "warn" ? "t-warn" : probe.tone === "mute" ? "mute" : undefined}>{probe.line}</div>}
            {bootCheck.evidence && (
              <div className={bootCheck.evidence.tone === "warn" ? "t-warn" : "mute"}>
                {bootCheck.evidence.line}
                {bootCheck.evidence.links.map((l) => (
                  <React.Fragment key={l.href}>
                    {" · "}
                    <a className="wf-verify-link" href={l.href} target="_blank" rel="noreferrer">{l.label} <Icon name="external" size={10} /></a>
                  </React.Fragment>
                ))}
              </div>
            )}
            {row.last && !saidByRow(row.last) && <div className="mute">{row.last}</div>}
            {(checkNote || bootCheck.note) && <div className="mute">{checkNote || bootCheck.note}</div>}
            {recheckNote && <div className="mute">{recheckNote}</div>}
            <div className="wf-check-links">
              {bootCheck.button && (
                <button type="button" className="btn ghost sm" disabled={checking} onClick={recheckBoot}>
                  {checking ? "Starting…" : bootCheck.button.label}
                </button>
              )}
              {setupPrOpen(setup) && (
                <button type="button" className="btn ghost sm" disabled={rechecking} onClick={recheckSetupPr}>
                  {rechecking ? "Pushing…" : "Re-check setup PR"}
                </button>
              )}
            </div>
          </div>
        );
      }
      return null;
    };

    return (
      <div className="wf-verify-body">
        <div className="wf-verify-row">
          <span className={`pill ${pillClass}`}>{stateText}</span>
          {ob.prUrl && <a className="wf-verify-link" href={ob.prUrl} target="_blank" rel="noreferrer">open PR <Icon name="external" size={10} /></a>}
        </div>
        <dl className="wf-verify-facts">
          <dt>Workflow</dt>
          <dd>{ob.state === "none" ? "not created yet" : ob.mode === "extend" ? "a step in an existing workflow" : "its own workflow"}</dd>
          <dt>Runner</dt>
          <dd>{setup.runnerSeen ? "has reported in from CI" : "has not reported in yet"}</dd>
          {setup.detected && <><dt>Stack</dt><dd>{frameworks || "no test framework (bundled runner)"}</dd></>}
        </dl>
        {ob.missingSecrets && ob.missingSecrets.length > 0 && <div className="wf-verify-warn">missing secrets: {ob.missingSecrets.join(", ")}</div>}
        {ob.lastDiagnosis && <div className="wf-verify-warn">setup needs attention: {ob.lastDiagnosis.message}</div>}
        {ob.lastError && <div className="wf-verify-warn">{ob.lastError}</div>}

        <h3 className="wf-check-title">Browser tests</h3>
        {items.map((item) => (
          <CheckRow key={item.key} item={item} error={problem?.field === item.key ? problem.message : null}>
            {editor(item.key)}
          </CheckRow>
        ))}
        {answerable && (
          <section className="wf-check wf-check-opts">
            <div className="wf-answer-grid two">
              <label className="wf-field">
                <span className="wf-label">Run browser tests</span>
                <select className="input" value={form.e2e} onChange={(e) => patch({ e2e: e.target.value })}>
                  <option value="">leave as proposed</option>
                  <option value="auto">auto — when the app can boot</option>
                  <option value="always">always — unverifiable without a browser</option>
                  <option value="never">never</option>
                </select>
              </label>
              <label className="wf-field">
                <span className="wf-label">Boot timeout (seconds)</span>
                <input className="input" inputMode="numeric" placeholder="180" value={form.timeout} onChange={(e) => patch({ timeout: e.target.value })} />
              </label>
            </div>
          </section>
        )}
      </div>
    );
  };

  const ob = setup?.onboarding || { state: "none" };
  const workflows = setup?.detected?.existingWorkflows || [];
  const action = ob.state === "none" ? "Open setup PR" : ob.state === "verified" ? "Update workflow" : ob.state === "pr_open" ? "Update setup PR" : "Regenerate setup PR";
  // From the footer button the row that refused is usually scrolled out of sight, so the
  // message alone looks like nothing happened.
  const refuse = (field, message) => {
    setProblem({ field, message });
    if (field) ref.current?.querySelector(`[data-check="${field}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const submit = async () => {
    setProblem(null);
    setQueued(null);
    let answers;
    if (setup?.candidates && form) {
      const built = answersFromForm(form, setup);
      if (!built.ok) { refuse(built.field, built.error); return; }
      answers = built.answers;
    }
    setBusy(true);
    try {
      await api.requestSetupPr(repo.id, { mode, workflow: workflow || undefined, answers });
      setQueued(SETUP_QUEUED);
      // The request only enqueues the job, so this reload still reads the old proposal —
      // re-prefilling from it would wipe the answers the maintainer just typed.
      setTimeout(() => { void load(); setBusy(false); }, 2500);
    } catch (err) {
      setBusy(false);
      // The rejection sentence is in the body; err.message is only "invalid_answers".
      const message = err?.body?.message || "Could not update the setup PR — try again.";
      refuse(fieldOf(err?.body?.message), message);
    }
  };
  const recheckBoot = async () => {
    setChecking(true);
    setCheckNote(null);
    try {
      const res = await api.requestBootCheck(repo.id);
      setCheckNote(bootCheckStarted(res));
      setTimeout(() => { if (res.dispatched) setCheckNote(null); void load(); setChecking(false); }, 2500);
    } catch { setChecking(false); setCheckNote(BOOT_CHECK_ASK_FAILED); }
  };
  const recheckSetupPr = async () => {
    setRechecking(true);
    setRecheckNote(null);
    try {
      const res = await api.requestSetupRecheck(repo.id);
      setRecheckNote(recheckText(res));
      setTimeout(() => { void load(); setRechecking(false); }, 2500);
    } catch { setRechecking(false); setRecheckNote("Could not ask for the re-check — try again"); }
  };

  return (
    <div className="wf-verify-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="wf-verify-drawer" role="dialog" aria-modal="true" aria-labelledby="wf-verify-drawer-title" tabIndex={-1} ref={ref}>
        <div className="wf-panel-head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="wf-panel-title" id="wf-verify-drawer-title">Verification setup</div>
            <div className="wf-panel-sub mute">{repo.owner}/{repo.name}</div>
          </div>
          <button type="button" className="btn ghost sm icon-sq" onClick={onClose} aria-label="Close"><Icon name="x" size={12} /></button>
        </div>
        <div className="wf-panel-body">{body()}</div>
        <div className="wf-verify-foot">
          {problem && <div className="wf-check-err">{problem.message}</div>}
          {queued && !problem && <div className="wf-check-hint mute">{queued}</div>}
          <div className="wf-verify-actions">
            {ob.state !== "verified" && (
              <>
                <select className="input" aria-label="Workflow mode" value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="separate">separate workflow</option>
                  {workflows.length > 0 && <option value="extend">add a step to an existing workflow</option>}
                </select>
                {mode === "extend" && (
                  <select className="input" aria-label="Workflow file" value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
                    <option value="">pick a workflow</option>
                    {workflows.map((w) => <option key={w} value={w}>{w}</option>)}
                  </select>
                )}
              </>
            )}
            <button type="button" className="btn sm primary" disabled={busy || !setup} onClick={submit}>
              {busy ? "Opening…" : setup?.candidates ? `${action} with these answers` : action}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

export function RepoDetails({ repo }: { repo: Repository }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinked = opensBrowserSetup(searchParams, repo.id);
  const [open, setOpen] = React.useState(deepLinked);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => { if (deepLinked) setOpen(true); }, [deepLinked]);
  const close = React.useCallback(() => {
    setOpen(false);
    if (searchParams.has("setup")) setSearchParams(withoutBrowserSetup(searchParams), { replace: true });
  }, [searchParams, setSearchParams]);
  const s = repo.reviewStats;
  const flake = repo.flakeRate && repo.flakeRate.total > 0 ? repo.flakeRate : null;
  const state = repo.verify?.onboarding?.state || "none";

  return (
    <div className="wf-head-details">
      {s && (
        <span className="wf-head-stat" title={`${s.approved} approved · ${s.blocked} blocked`}>
          <b>{s.total}</b> {s.total === 1 ? "review" : "reviews"}
          <span className="wf-head-sep" />
          <span className="wf-stat-ok">✓ {s.approved}</span>
          <span className="wf-stat-blk">✕ {s.blocked}</span>
        </span>
      )}
      {flake && (
        <span className={`wf-head-stat ${flake.rate > 0.1 ? "t-warn" : ""}`} title="Quarantined generated tests over the last 30 verification runs">
          flake <b>{Math.round(flake.rate * 100)}%</b>
        </span>
      )}
      <div className="wf-verify">
        <button
          ref={btnRef}
          type="button"
          className={`btn ghost sm wf-verify-btn ${open ? "is-active" : ""}`}
          onClick={() => (open ? close() : setOpen(true))}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Verification setup: ${VERIFY_LABEL[state] || state}`}
          title={`Verification: ${VERIFY_LABEL[state] || state}`}
        >
          <i className={`wf-verify-dot ${state}`} />
          <span>Verification</span>
          <span className="wf-verify-state">{VERIFY_LABEL[state] || state}</span>
          <Icon name="chevron-d" size={11} />
        </button>
        {open && <VerifySetupDrawer key={repo.id} repo={repo} onClose={close} opener={btnRef} />}
      </div>
      <span className="wf-head-sep" aria-hidden="true" />
    </div>
  );
}
