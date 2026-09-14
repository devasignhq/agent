// @ts-nocheck
import React from "react";
import { Icon } from "./icons";
import { formatDuration, isSignedUrlStale, traceViewerUrl } from "./verify-view";

// A Playwright recording for one criterion: collapsed (poster, test, duration)
// by default, an inline player with full-screen + trace viewer when opened.
// Expired recordings keep the block (with the retention note) but no player.
export const RecordingBlock = ({ rec, testName, durationMs, initiallyOpen, onStale }) => {
  const [open, setOpen] = React.useState(!!initiallyOpen);
  const videoRef = React.useRef(null);
  React.useEffect(() => { if (initiallyOpen) setOpen(true); }, [initiallyOpen]);
  const stale = !rec.expired && isSignedUrlStale(rec.urlExpiresAt, Date.now());
  React.useEffect(() => { if (open && stale && onStale) onStale(); }, [open, stale]); // eslint-disable-line react-hooks/exhaustive-deps
  const label = rec.attempt ? `${testName} · attempt ${rec.attempt}` : testName;
  return (
    <div className={`acv-rec ${open && !rec.expired ? "open" : ""} ${rec.expired ? "expired" : ""}`}>
      <button
        type="button"
        className="acv-rec-head"
        aria-expanded={open && !rec.expired}
        disabled={rec.expired}
        title={rec.expired ? "Recording expired" : open ? "Collapse" : "Watch recording"}
        onClick={() => setOpen((v) => !v)}
      >
        {(!open || rec.expired) && (rec.posterUrl && !rec.expired
          ? <img className="acv-rec-thumb" src={rec.posterUrl} alt="" />
          : <div className="acv-rec-thumb placeholder"><Icon name="doc" size={12} /></div>)}
        <span className="acv-rec-title mono">{label}</span>
        {durationMs > 0 && <span className="mute mono acv-rec-dur">{formatDuration(durationMs)}</span>}
        {rec.expired
          ? <span className="pill nit">expired after {rec.expiredAfterDays} {rec.expiredAfterDays === 1 ? "day" : "days"}</span>
          : <span className="acv-rec-chev"><Icon name={open ? "chevron-d" : "chevron-r"} size={11} /></span>}
      </button>
      {open && !rec.expired && (
        <div className="acv-rec-body">
          <video ref={videoRef} className="acv-rec-video" controls playsInline preload="metadata" poster={rec.posterUrl || undefined} src={rec.getUrl || undefined} />
          <div className="acv-rec-actions">
            <button type="button" className="btn sm ghost" onClick={() => { const el = videoRef.current; if (el && el.requestFullscreen) el.requestFullscreen(); }}>Full screen</button>
            {rec.trace?.getUrl && <a className="btn sm ghost" href={traceViewerUrl(rec.trace.getUrl)} target="_blank" rel="noreferrer">Open trace</a>}
            {rec.getUrl && <a className="btn sm ghost" href={rec.getUrl} target="_blank" rel="noreferrer">Download</a>}
          </div>
        </div>
      )}
    </div>
  );
};
