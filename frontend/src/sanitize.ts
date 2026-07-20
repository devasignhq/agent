// Framework-agnostic text-safety helpers for the agent composer. Kept DOM-free
// (no DOMPurify import here) so they can be unit-tested under `node --test`,
// which has no jsdom — mirrors the optimistic-save.ts extraction pattern. The
// DOMPurify wiring that consumes SANITIZE_ALLOWED_* lives in screen-agent.tsx,
// since DOMPurify needs a browser DOM and its methods don't exist under bare node.

/** Escape the HTML-significant characters for safe interpolation into markup. */
export const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Accept a raw user-supplied string only if it is a well-formed http(s) URL.
// Returns the normalized URL, or "" for anything else — javascript:, data:,
// vbscript:, mailto:, relative/garbage input all get rejected.
export const safeUrl = (raw) => {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  // If the input already declares a scheme, it must be http(s) — never silently
  // rewrite mailto:/javascript:/data: into an https link. A schemeless string
  // (e.g. "example.com") is retried as https:// so the common case still works.
  // The negative lookahead ensures that port numbers (e.g. localhost:3000) are
  // not mistaken for custom schemes.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(s);
  const candidates = hasScheme ? [s] : [s, `https://${s}`];
  for (const candidate of candidates) {
    try {
      const u = new URL(candidate);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch {
      /* not a valid URL for this candidate — try the next */
    }
  }
  return "";
};

// The strict allow-list the composer's rich text is sanitized against (consumed
// by sanitizeHtml in screen-agent.tsx). Exported so tests can lock it down: no
// script/img/svg/iframe/style tags, and only href/target/rel attributes (never
// on* handlers or src). Everything outside this list is stripped by DOMPurify.
export const SANITIZE_ALLOWED_TAGS = [
  "b", "strong", "i", "em", "u", "s", "code", "pre",
  "a", "br", "p", "div", "span", "ul", "ol", "li", "blockquote",
];
export const SANITIZE_ALLOWED_ATTR = ["href", "target", "rel"];
