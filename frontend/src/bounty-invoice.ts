// Invoice model for a bounty payout.
//
// Pure data + formatting, deliberately free of React and of jsPDF: the preview
// modal renders this shape as DOM and the PDF generator draws the same shape on
// a page, so the two can't drift. The PDF side (bounty-invoice-pdf.ts) is loaded
// only when someone actually downloads.
import type { Bounty, EscrowTransaction } from "./api.ts";

export type InvoiceData = {
  invoiceNumber: string;
  date: string;
  // "Bill To" is the payee — the contributor who did the work. We only ever hold
  // a GitHub login for them (no display name is stored anywhere), so the two
  // lines are the handle and a qualifier rather than name + handle.
  billToName: string;
  billToHandle: string;
  walletChain: string;
  walletAddress: string;
  // "Bill From" is the paying org, derived from the repo owner. There is no
  // billing-address field in the data model, so the design's Address block is
  // omitted rather than filled with a placeholder.
  billFrom: string;
  itemTitle: string;
  itemDescription: string;
  qty: number;
  amountUsdc: number;
  taxRate: number;
  paymentLine: string;
  notes: string;
};

// Stellar amounts are i128 "stroops" (1 USDC = 10^7 stroops). Display-only, so a
// double is fine for the magnitudes bounties use. Mirrors screen-bounties.tsx,
// but without its rounding — an invoice states the exact amount settled.
export const stroopsToUsdc = (s: string) => (Number(s) || 0) / 1e7;

export const usdc = (n: number) =>
  `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;

// "15 December, 2025" — the format the invoice design specifies, which no
// Intl.DateTimeFormat preset produces (they all put the month first or add a
// weekday), so it's assembled from parts.
export const invoiceDate = (ts: number) => {
  const d = new Date(ts);
  const month = d.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  return `${d.getUTCDate()} ${month}, ${d.getUTCFullYear()}`;
};

// Greedy word wrap for a monospaced column, measured in characters because every
// glyph is the same width. Words longer than the column (Stellar addresses, long
// identifiers) are hard-split rather than allowed to overflow. Returns at most
// `maxLines`, with the last line ellipsised if content remains.
export function wrapMono(text: string, maxChars: number, maxLines: number): string[] {
  if (maxChars <= 0 || maxLines <= 0) return [];
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";

  const push = () => {
    if (cur) lines.push(cur);
    cur = "";
  };

  for (const word of words) {
    if (lines.length >= maxLines) break;
    let w = word;
    // Hard-split a word that can never fit on one line.
    while (w.length > maxChars) {
      push();
      if (lines.length >= maxLines) break;
      lines.push(w.slice(0, maxChars));
      w = w.slice(maxChars);
    }
    if (lines.length >= maxLines) break;
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += ` ${w}`;
    else {
      push();
      cur = w;
    }
  }
  push();

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1];
    kept[maxLines - 1] = last.length >= maxChars ? `${last.slice(0, maxChars - 1)}…` : `${last}…`;
    return kept;
  }
  return lines;
}

/**
 * Fold a payout transaction (plus the bounty it settles) into invoice fields.
 *
 * `bounty` is optional because the transaction list and the bounty list are
 * fetched separately — a payout whose bounty has since been filtered out still
 * has to produce a coherent document, so every bounty-derived field degrades to
 * what the transaction alone can prove.
 */
export function buildInvoice({
  txn,
  bounty,
}: {
  txn: EscrowTransaction;
  bounty?: Bounty | null;
}): InvoiceData {
  const amount = stroopsToUsdc(txn.amountStroops);
  const login = txn.githubLogin || bounty?.assigneeGithubLogin || null;
  const address = txn.destAddress || bounty?.assigneeAddress || null;
  const org = bounty?.repo?.split("/")[0] || null;

  return {
    invoiceNumber: bounty?.code || txn.id.slice(0, 12).toUpperCase(),
    date: invoiceDate(txn.confirmedAt || txn.createdAt),
    billToName: login ? `@${login}` : "Unassigned",
    billToHandle: login ? "GitHub contributor" : "—",
    walletChain: "Blockchain - Stellar",
    walletAddress: address || "—",
    billFrom: org || "—",
    itemTitle: bounty ? `Task Submission - Issue #${bounty.issueNumber}` : "Bounty payout",
    itemDescription: bounty?.title || txn.note || "—",
    qty: 1,
    amountUsdc: amount,
    taxRate: 0,
    paymentLine: `${usdc(amount)} paid from DevAsign Wallet`,
    // The design leaves Notes as a dash. A settled payout has something more
    // useful to say, so the on-chain hash fills it when there's no operator note
    // — it's the only field on the page that proves the transfer happened.
    notes: txn.note || (txn.hash ? `Stellar tx: ${txn.hash}` : "—"),
  };
}
