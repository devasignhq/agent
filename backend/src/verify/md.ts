// One line of untrusted text made inert in App-authored markdown: no links (autolinks included),
// images, code spans, HTML, @-mentions or issue references. Runner-reported strings pass through this.
export function mdInline(text: string, cap = 300): string {
  return String(text ?? "")
    .replace(/[\r\n]+/g, " ")
    .trimStart()
    .slice(0, cap)
    .replace(/[\\`*_[\]()!~|]/g, "\\$&")
    // Callers may put the text on a line of its own, where a leading marker would open a heading or list.
    .replace(/^[#+=-]/, "\\$&")
    .replace(/^(\d{1,9})\./, "$1\\.")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@​")
    // GitHub autolinks bare URLs and www. hosts, and turns #12, GH-12 and owner/repo#12 into cross-references.
    .replace(/:\/\//g, ":​//")
    .replace(/\bwww\./gi, (m) => `${m.slice(0, 3)}​.`)
    .replace(/(#|\bGH-)(?=\d)/gi, "$1​");
}
