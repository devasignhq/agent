// Draws an InvoiceData onto a PDF page, reproducing the invoice design.
//
// Loaded only from the preview modal's Download button (`await import(...)`), so
// jsPDF and the two font files stay out of the main bundle for everyone who
// never downloads an invoice.
//
// Coordinates come from bounty-invoice-layout.ts, shared with the preview modal.
// `S` scales that design space onto US Letter so the result prints on standard
// paper.
import { jsPDF } from "jspdf";
import type { InvoiceData } from "./bounty-invoice.ts";
import { usdc, wrapMono } from "./bounty-invoice.ts";
import { LOGO_PATHS } from "./bounty-invoice-logo.ts";
import {
  BAND,
  BANDS,
  COL_CHARS,
  COL_L,
  COL_R,
  DESIGN_W,
  DIM,
  EDGE_R,
  INK,
  LEAD,
  MUTED,
  NOTE_CHARS,
  RULE_H,
  RULES,
  SIZE_BODY,
  SIZE_TITLE,
  TITLE_X,
  Y,
} from "./bounty-invoice-layout.ts";

const LETTER_W = 612;
const S = LETTER_W / DESIGN_W;

// Fetched once per page load, then reused: each TTF is ~150KB and jsPDF wants
// them base64-encoded, so neither the request nor the encode should repeat.
let fontCache: Promise<{ regular: string; bold: string }> | null = null;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  // Chunked: String.fromCharCode.apply blows the call stack on a 150KB spread.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function loadFonts() {
  if (!fontCache) {
    fontCache = (async () => {
      const [regular, bold] = await Promise.all(
        ["/fonts/GeistMono-Regular.ttf", "/fonts/GeistMono-Bold.ttf"].map(async (url) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Couldn't load invoice font (${res.status})`);
          return toBase64(await res.arrayBuffer());
        }),
      );
      return { regular, bold };
    })();
    // Don't cache a failure — a transient network blip shouldn't disable
    // downloads for the rest of the session.
    fontCache.catch(() => {
      fontCache = null;
    });
  }
  return fontCache;
}

// ─── SVG path replay ─────────────────────────────────────────────────────────
// jsPDF has no SVG support, but its canvas shim takes the same commands, so the
// logo is drawn as true vectors instead of an embedded raster. The design file
// only uses M/L/H/V/C/Z; anything else is ignored rather than mis-drawn.
//
// Note the shim's fill() is nonzero-winding only — it takes no fill-rule
// argument. The mark's counters (the two dots) are counter-wound, so nonzero
// reproduces them exactly as even-odd would; a future logo whose holes wind the
// same direction as their outer contour would fill in solid and need the
// low-level fillEvenOdd path instead.
function drawPath(ctx: jsPDF["context2d"], d: string) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const num = () => Number(tokens[i++]) * S;

  ctx.beginPath();
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    const up = cmd.toUpperCase();
    const rel = cmd !== up;

    if (up === "Z") {
      ctx.closePath();
      x = sx;
      y = sy;
      continue;
    }
    if (i >= tokens.length || /[A-Za-z]/.test(tokens[i])) continue;

    if (up === "M") {
      const nx = num();
      const ny = num();
      x = rel ? x + nx : nx;
      y = rel ? y + ny : ny;
      sx = x;
      sy = y;
      ctx.moveTo(x, y);
      cmd = rel ? "l" : "L"; // repeated pairs after M are implicit linetos
    } else if (up === "L") {
      const nx = num();
      const ny = num();
      x = rel ? x + nx : nx;
      y = rel ? y + ny : ny;
      ctx.lineTo(x, y);
    } else if (up === "H") {
      const nx = num();
      x = rel ? x + nx : nx;
      ctx.lineTo(x, y);
    } else if (up === "V") {
      const ny = num();
      y = rel ? y + ny : ny;
      ctx.lineTo(x, y);
    } else if (up === "C") {
      const c1x = num();
      const c1y = num();
      const c2x = num();
      const c2y = num();
      const ex = num();
      const ey = num();
      ctx.bezierCurveTo(
        rel ? x + c1x : c1x,
        rel ? y + c1y : c1y,
        rel ? x + c2x : c2x,
        rel ? y + c2y : c2y,
        rel ? x + ex : ex,
        rel ? y + ey : ey,
      );
      x = rel ? x + ex : ex;
      y = rel ? y + ey : ey;
    } else {
      break; // unsupported command — stop rather than emit garbage
    }
  }
  ctx.fill();
}

// ─── Page ────────────────────────────────────────────────────────────────────
export async function renderInvoicePdf(data: InvoiceData): Promise<jsPDF> {
  const fonts = await loadFonts();

  const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
  doc.addFileToVFS("GeistMono-Regular.ttf", fonts.regular);
  doc.addFont("GeistMono-Regular.ttf", "GeistMono", "normal");
  doc.addFileToVFS("GeistMono-Bold.ttf", fonts.bold);
  doc.addFont("GeistMono-Bold.ttf", "GeistMono", "bold");

  // Design-space drawing helpers — every call site stays in SVG coordinates.
  const text = (
    s: string,
    xd: number,
    yd: number,
    opts: { size?: number; bold?: boolean; color?: string; align?: "left" | "right" } = {},
  ) => {
    doc.setFont("GeistMono", opts.bold ? "bold" : "normal");
    doc.setFontSize((opts.size ?? SIZE_BODY) * S);
    doc.setTextColor(opts.color ?? INK);
    doc.text(s, xd * S, yd * S, opts.align === "right" ? { align: "right" } : undefined);
  };
  const band = (yd: number, hd: number, color: string) => {
    doc.setFillColor(color);
    doc.rect(0, yd * S, LETTER_W, hd * S, "F");
  };
  const rule = (yd: number) => {
    doc.setFillColor(INK);
    doc.rect(COL_R * S, yd * S, (EDGE_R - COL_R) * S, RULE_H * S, "F");
  };
  // A label in ink with its value beneath in grey — the design's repeating unit.
  const field = (label: string, value: string, xd: number, labelY: number, valueY: number) => {
    text(label, xd, labelY, { bold: true });
    text(value, xd, valueY, { color: MUTED });
  };

  // Bands first so text lands on top of them.
  for (const b of BANDS) band(b.y, b.h, BAND);

  // Logo lockup — already positioned in design space, so no transform.
  const ctx = doc.context2d;
  for (const p of LOGO_PATHS) {
    ctx.fillStyle = p.fill;
    drawPath(ctx, p.d);
  }

  // Header
  text("Bounty Invoice", TITLE_X, Y.title, { size: SIZE_TITLE, bold: true });
  field("Invoice Number:", data.invoiceNumber, COL_R, Y.invoiceLabel, Y.invoiceValue);
  field("Date:", data.date, COL_R, Y.dateLabel, Y.dateValue);

  // Parties
  text("Bill To:", COL_L, Y.billLabel, { bold: true });
  text(data.billToName, COL_L, Y.billValue, { color: MUTED });
  text(data.billToHandle, COL_L, Y.billValue + LEAD, { color: MUTED });

  text("Bill From:", COL_R, Y.billLabel, { bold: true });
  text(data.billFrom, COL_R, Y.billValue, { color: MUTED });

  text("Wallet Address:", COL_L, Y.walletLabel, { bold: true });
  text(data.walletChain, COL_L, Y.walletChain, { color: MUTED });
  // A Stellar address is 56 characters and the column fits 37, so it wraps to a
  // second line rather than being truncated — a payout document should state the
  // destination in full.
  wrapMono(data.walletAddress, COL_CHARS, 2).forEach((line, n) => {
    text(line, COL_L, Y.walletAddress + n * LEAD, { color: MUTED });
  });

  // Line-item table
  text("ITEM", COL_L, Y.tableHead, { bold: true });
  text("QTY", COL_R, Y.tableHead, { bold: true });
  text("PRICE", EDGE_R, Y.tableHead, { bold: true, align: "right" });

  text(data.itemTitle, COL_L, Y.itemRow);
  text(String(data.qty), COL_R, Y.itemRow);
  text(usdc(data.amountUsdc), EDGE_R, Y.itemRow, { align: "right" });
  // Two lines is what fits between the description and the rule beneath it.
  wrapMono(data.itemDescription, COL_CHARS, 2).forEach((line, n) => {
    text(line, COL_L, Y.itemDescription + n * LEAD, { color: MUTED });
  });

  rule(RULES[0]);

  const tax = data.amountUsdc * data.taxRate;
  text(`Tax (${Math.round(data.taxRate * 100)}%)`, COL_R, Y.taxRow, { color: DIM });
  text(usdc(tax), EDGE_R, Y.taxRow, { color: DIM, align: "right" });
  text("Total", COL_R, Y.totalRow, { color: DIM });
  text(usdc(data.amountUsdc + tax), EDGE_R, Y.totalRow, { color: DIM, align: "right" });

  rule(RULES[1]);

  text("Amount Due", COL_R, Y.amountDue, { bold: true });
  text(usdc(data.amountUsdc + tax), EDGE_R, Y.amountDue, { bold: true, align: "right" });

  // Footer
  field("Payment:", data.paymentLine, COL_L, Y.paymentLabel, Y.paymentValue);
  text("Notes:", COL_L, Y.notesLabel, { bold: true });
  // Notes carries the 64-character tx hash, which needs the full content width.
  wrapMono(data.notes, NOTE_CHARS, 2).forEach((line, n) => {
    text(line, COL_L, Y.notesValue + n * LEAD, { color: MUTED });
  });

  doc.setProperties({
    title: `Bounty Invoice ${data.invoiceNumber}`,
    subject: `Bounty payout to ${data.billToName}`,
    creator: "DevAsign",
  });
  return doc;
}

// Invoice numbers are bounty codes ("DA-8842") or a short transaction id, but
// both are user-influenced enough to sanitise before they reach a filename.
const invoiceFileName = (data: InvoiceData) =>
  `invoice-${data.invoiceNumber.replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`;

export async function downloadInvoicePdf(data: InvoiceData) {
  const doc = await renderInvoicePdf(data);
  doc.save(invoiceFileName(data));
}
