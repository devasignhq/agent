// Invoice preview modal, opened from the PDF button on a payout row in the
// transaction history.
//
// The preview is an SVG drawn in the invoice's design space (562.493 × 730) —
// the same coordinate system, constants and baselines the PDF generator uses,
// because SVG `<text y>` and jsPDF's `doc.text` both take a baseline. What you
// see here is what the download contains.
//
// jsPDF and its two font files are pulled in by `import()` inside the Download
// handler, so nobody who never downloads an invoice pays for them.
import React from "react";
import { Icon } from "./icons";
import { type InvoiceData, usdc, wrapMono } from "./bounty-invoice.ts";
import { LOGO_PATHS } from "./bounty-invoice-logo.ts";
import {
  BAND,
  BANDS,
  COL_CHARS,
  COL_L,
  COL_R,
  DESIGN_H,
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

const T = ({
  x,
  y,
  children,
  size = SIZE_BODY,
  bold,
  color = INK,
  anchor,
}: {
  x: number;
  y: number;
  children: React.ReactNode;
  size?: number;
  bold?: boolean;
  color?: string;
  anchor?: "end";
}) => (
  <text x={x} y={y} fontSize={size} fontWeight={bold ? 700 : 400} fill={color} textAnchor={anchor}>
    {children}
  </text>
);

/** The invoice page itself — scales to its container, aspect fixed by viewBox. */
export const InvoicePage = ({ data }: { data: InvoiceData }) => {
  const tax = data.amountUsdc * data.taxRate;
  return (
    <svg className="inv-page" viewBox={`0 0 ${DESIGN_W} ${DESIGN_H}`} role="img">
      <title>{`Bounty invoice ${data.invoiceNumber}`}</title>
      <rect width={DESIGN_W} height={DESIGN_H} fill="#ffffff" />
      {BANDS.map((b) => (
        <rect key={b.y} y={b.y} width={DESIGN_W} height={b.h} fill={BAND} />
      ))}

      {LOGO_PATHS.map((p, i) => (
        <path key={i} d={p.d} fill={p.fill} fillRule={p.evenOdd ? "evenodd" : "nonzero"} />
      ))}

      <T x={TITLE_X} y={Y.title} size={SIZE_TITLE} bold>
        Bounty Invoice
      </T>
      <T x={COL_R} y={Y.invoiceLabel} bold>
        Invoice Number:
      </T>
      <T x={COL_R} y={Y.invoiceValue} color={MUTED}>
        {data.invoiceNumber}
      </T>
      <T x={COL_R} y={Y.dateLabel} bold>
        Date:
      </T>
      <T x={COL_R} y={Y.dateValue} color={MUTED}>
        {data.date}
      </T>

      <T x={COL_L} y={Y.billLabel} bold>
        Bill To:
      </T>
      <T x={COL_L} y={Y.billValue} color={MUTED}>
        {data.billToName}
      </T>
      <T x={COL_L} y={Y.billValue + LEAD} color={MUTED}>
        {data.billToHandle}
      </T>

      <T x={COL_R} y={Y.billLabel} bold>
        Bill From:
      </T>
      <T x={COL_R} y={Y.billValue} color={MUTED}>
        {data.billFrom}
      </T>

      <T x={COL_L} y={Y.walletLabel} bold>
        Wallet Address:
      </T>
      <T x={COL_L} y={Y.walletChain} color={MUTED}>
        {data.walletChain}
      </T>
      {wrapMono(data.walletAddress, COL_CHARS, 2).map((line, n) => (
        <T key={n} x={COL_L} y={Y.walletAddress + n * LEAD} color={MUTED}>
          {line}
        </T>
      ))}

      <T x={COL_L} y={Y.tableHead} bold>
        ITEM
      </T>
      <T x={COL_R} y={Y.tableHead} bold>
        QTY
      </T>
      <T x={EDGE_R} y={Y.tableHead} bold anchor="end">
        PRICE
      </T>

      <T x={COL_L} y={Y.itemRow}>
        {data.itemTitle}
      </T>
      <T x={COL_R} y={Y.itemRow}>
        {data.qty}
      </T>
      <T x={EDGE_R} y={Y.itemRow} anchor="end">
        {usdc(data.amountUsdc)}
      </T>
      {wrapMono(data.itemDescription, COL_CHARS, 2).map((line, n) => (
        <T key={n} x={COL_L} y={Y.itemDescription + n * LEAD} color={MUTED}>
          {line}
        </T>
      ))}

      {RULES.map((y) => (
        <rect key={y} x={COL_R} y={y} width={EDGE_R - COL_R} height={RULE_H} fill={INK} />
      ))}

      <T x={COL_R} y={Y.taxRow} color={DIM}>
        {`Tax (${Math.round(data.taxRate * 100)}%)`}
      </T>
      <T x={EDGE_R} y={Y.taxRow} color={DIM} anchor="end">
        {usdc(tax)}
      </T>
      <T x={COL_R} y={Y.totalRow} color={DIM}>
        Total
      </T>
      <T x={EDGE_R} y={Y.totalRow} color={DIM} anchor="end">
        {usdc(data.amountUsdc + tax)}
      </T>

      <T x={COL_R} y={Y.amountDue} bold>
        Amount Due
      </T>
      <T x={EDGE_R} y={Y.amountDue} bold anchor="end">
        {usdc(data.amountUsdc + tax)}
      </T>

      <T x={COL_L} y={Y.paymentLabel} bold>
        Payment:
      </T>
      <T x={COL_L} y={Y.paymentValue} color={MUTED}>
        {data.paymentLine}
      </T>
      <T x={COL_L} y={Y.notesLabel} bold>
        Notes:
      </T>
      {wrapMono(data.notes, NOTE_CHARS, 2).map((line, n) => (
        <T key={n} x={COL_L} y={Y.notesValue + n * LEAD} color={MUTED}>
          {line}
        </T>
      ))}
    </svg>
  );
};

export const InvoicePreviewModal = ({
  data,
  onClose,
}: {
  data: InvoiceData;
  onClose: () => void;
}) => {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const { downloadInvoicePdf } = await import("./bounty-invoice-pdf.ts");
      await downloadInvoicePdf(data);
    } catch {
      // Almost always the font fetch or the chunk failing to load; either way the
      // preview is still on screen, so the modal stays open to retry.
      setError("Couldn't build the PDF. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal inv-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <Icon name="x" size={13} />
        </button>

        <div className="inv-modal-head">
          <div className="cb-eyebrow">Invoice</div>
          <h2 className="cb-modal-title">{data.invoiceNumber}</h2>
          <div className="cb-modal-sub">
            Bounty payout to {data.billToName} · {usdc(data.amountUsdc)} · {data.date}
          </div>
        </div>

        <div className="inv-paper-wrap">
          <InvoicePage data={data} />
        </div>

        <div className="inv-modal-foot">
          {error && <span className="inv-error">{error}</span>}
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={download} disabled={busy}>
            <Icon name="download" size={13} /> {busy ? "Preparing…" : "Download"}
          </button>
        </div>
      </div>
    </div>
  );
};
