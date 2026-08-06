// Draws the selected security findings as a multi-page PDF report.
//
// Loaded only from the dashboard's Export PDF button (`await import(...)`), so
// jsPDF and the font files stay out of the main bundle for everyone who never
// exports. What goes in each section — block order, meta lines, URLs — is
// decided by security-export.ts, where node --test can reach it; this module
// only draws.
//
// Unlike the invoice (a fixed one-page design), this is flowing content:
// a cursor `y` walks down the page and `ensure()` breaks to a new page when a
// piece wouldn't fit.
import { jsPDF } from "jspdf";
import type { SecurityFinding } from "./api.ts";
import { drawPath, loadFonts } from "./bounty-invoice-pdf.ts";
import { LOGO_PATHS } from "./bounty-invoice-logo.ts";
import { DESIGN_W } from "./bounty-invoice-layout.ts";
import { displayId } from "./security-findings.ts";
import {
  findingDetailBlocks,
  findingLocationLine,
  findingMetaLine,
  originLabel,
  type RepoBranchLookup,
} from "./security-export.ts";

// US Letter in pt.
const PAGE_W = 612;
const PAGE_H = 792;
const M = 54;
const BOTTOM = PAGE_H - M;
const CONTENT_W = PAGE_W - 2 * M;

const INK = "#1a1d21";
const MUTED = "#5c636e";
const RULE = "#d7dade";

// The DevAsign lockup is authored in the invoice's design space (mark + wordmark
// spanning x 34.6–136.3, y 23–44.7 — see bounty-invoice-logo.ts), and drawPath
// emits it pre-scaled by the invoice's letter factor. These are that rendering's
// right and bottom edges in page points, used to translate it into this
// document's top-right corner.
const LOGO_S = PAGE_W / DESIGN_W;
const LOGO_RIGHT = 136.3 * LOGO_S;
const LOGO_BOTTOM = 44.7 * LOGO_S;

// Print-safe severity accents (the screen's CSS variables don't exist here).
const SEV_COLOR: Record<string, string> = {
  critical: "#c0392b",
  high: "#c87f2f",
  medium: "#3d6fb4",
  low: "#8a8f98",
};

// Summary table geometry: x position and width per column, filling CONTENT_W.
const COLS = {
  severity: { x: M, w: 48 },
  id: { x: 106, w: 56 },
  finding: { x: 166, w: 168 },
  surface: { x: 338, w: 44 },
  origin: { x: 386, w: 88 },
  repo: { x: 478, w: PAGE_W - M - 478 },
};

export async function downloadFindingsPdf(
  findings: SecurityFinding[],
  branchOf: RepoBranchLookup,
  filename: string,
  scopeLabel: string
): Promise<void> {
  const fonts = await loadFonts();

  const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
  doc.addFileToVFS("GeistMono-Regular.ttf", fonts.regular);
  doc.addFont("GeistMono-Regular.ttf", "GeistMono", "normal");
  doc.addFileToVFS("GeistMono-Bold.ttf", fonts.bold);
  doc.addFont("GeistMono-Bold.ttf", "GeistMono", "bold");

  let y = M;

  const setStyle = (size: number, opts: { bold?: boolean; color?: string } = {}) => {
    doc.setFont("GeistMono", opts.bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(opts.color ?? INK);
  };

  // Break to a new page unless `h` more points fit above the bottom margin.
  // `redraw` re-establishes context that must repeat per page (table header).
  const ensure = (h: number, redraw?: () => void) => {
    if (y + h > BOTTOM) {
      doc.addPage();
      y = M;
      redraw?.();
    }
  };

  const rule = (color = RULE) => {
    doc.setDrawColor(color);
    doc.setLineWidth(0.6);
    doc.line(M, y, PAGE_W - M, y);
  };

  // Ellipsis-truncate to a column width at the CURRENT font size. The full
  // value is never lost — every truncated cell reappears in its detail section.
  const fit = (s: string, w: number): string => {
    if (doc.getTextWidth(s) <= w) return s;
    let t = s;
    while (t.length > 1 && doc.getTextWidth(`${t}…`) > w) t = t.slice(0, -1);
    return `${t}…`;
  };

  // ── header ──
  setStyle(16, { bold: true });
  doc.text("Security findings", M, y + 12);
  // Logo lockup in the top-right corner, bottom-aligned with the title's
  // baseline. drawPath replays it at the invoice's position/scale; the
  // translate moves that rendering here.
  const ctx = doc.context2d;
  ctx.save();
  ctx.translate(PAGE_W - M - LOGO_RIGHT, y + 12 - LOGO_BOTTOM);
  for (const p of LOGO_PATHS) {
    ctx.fillStyle = p.fill;
    drawPath(ctx, p.d);
  }
  ctx.restore();
  y += 30;
  setStyle(8, { color: MUTED });
  const stamp = new Date().toISOString().slice(0, 10);
  doc.text(
    `${scopeLabel} · ${findings.length} finding${findings.length === 1 ? "" : "s"} · exported ${stamp} (UTC)`,
    M,
    y
  );
  // Website reference at the far right, sharing the meta line's baseline.
  // textWithLink has no align option, so right-align by measured width.
  const site = "devasign.com";
  doc.textWithLink(site, PAGE_W - M - doc.getTextWidth(site), y, {
    url: "https://devasign.com",
  });
  y += 20;

  // ── summary table (the on-page columns) ──
  const tableHead = () => {
    setStyle(6.5, { bold: true, color: MUTED });
    doc.text("SEVERITY", COLS.severity.x, y + 8);
    doc.text("ID", COLS.id.x, y + 8);
    doc.text("FINDING", COLS.finding.x, y + 8);
    doc.text("SURFACE", COLS.surface.x, y + 8);
    doc.text("ORIGIN", COLS.origin.x, y + 8);
    doc.text("REPO", COLS.repo.x, y + 8);
    y += 12;
    rule();
    y += 4;
  };
  tableHead();

  const ROW_H = 13;
  for (const f of findings) {
    ensure(ROW_H, tableHead);
    setStyle(7.5, { bold: true, color: SEV_COLOR[f.severity] ?? INK });
    doc.text(f.severity, COLS.severity.x, y + 8);
    setStyle(7.5, { color: MUTED });
    doc.text(displayId(f), COLS.id.x, y + 8);
    setStyle(7.5);
    doc.text(fit(f.title, COLS.finding.w), COLS.finding.x, y + 8);
    setStyle(7.5, { color: MUTED });
    doc.text(f.surface, COLS.surface.x, y + 8);
    doc.text(fit(originLabel(f), COLS.origin.w), COLS.origin.x, y + 8);
    doc.text(fit(f.repo || "—", COLS.repo.w), COLS.repo.x, y + 8);
    y += ROW_H;
  }

  // ── detail sections, same order as the table ──
  const LINE = 11;
  for (const f of findings) {
    // Never start a finding it can't at least open: heading + meta + a couple
    // of body lines.
    ensure(72);
    y += 14;
    rule();
    y += 14;

    setStyle(10.5, { bold: true });
    const heading = doc.splitTextToSize(`${displayId(f)} — ${f.title}`, CONTENT_W) as string[];
    for (const line of heading) {
      ensure(14);
      doc.text(line, M, y);
      y += 14;
    }

    setStyle(8, { color: MUTED });
    for (const line of [findingMetaLine(f), ...findingLocationLine(f, branchOf).split("\n")]) {
      ensure(LINE);
      doc.text(line, M, y);
      y += LINE;
    }
    y += 4;

    for (const block of findingDetailBlocks(f)) {
      // Widow control: the label plus at least two body lines move together.
      ensure(20 + 2 * LINE);
      setStyle(7, { bold: true, color: MUTED });
      doc.text(block.label.toUpperCase(), M, y + 8);
      // 12pt from label baseline to the first body baseline — an 8.5pt body
      // ascender reaches ~6pt, so anything tighter collides with the label.
      y += 20;
      setStyle(8.5);
      const lines = doc.splitTextToSize(block.text, CONTENT_W) as string[];
      for (const line of lines) {
        ensure(LINE);
        doc.text(line, M, y);
        y += LINE;
      }
      y += 6;
    }
  }

  // ── footer on every page, once the count is final ──
  const total = doc.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    setStyle(7, { color: MUTED });
    doc.text("Powered by DevAsign AI", M, PAGE_H - 28);
    doc.text(`${p} / ${total}`, PAGE_W - M, PAGE_H - 28, { align: "right" });
  }

  doc.setProperties({
    title: "DevAsign security findings",
    subject: `Security findings export — ${scopeLabel}`,
    creator: "DevAsign",
  });
  doc.save(filename);
}
