// CSV export of the bounty transaction history.
//
// Pure data + formatting, deliberately free of React and of the DOM: every
// correctness rule (escaping, precision, column order) lives here so it can be
// unit-tested under `node --test`. The half that actually touches the browser is
// download.ts, which has no logic to get wrong.
//
// The file this produces is an accounting artifact, which is why several columns
// disagree with the on-screen table: the table truncates ids and hashes and
// rounds amounts to whole dollars for column density (screen-bounties.tsx:418-422),
// and none of those compromises survive contact with a spreadsheet.
import type { EscrowTransaction } from "./api.ts";
import { stroopsToUsdc } from "./bounty-invoice.ts";

// ─── CSV primitives ──────────────────────────────────────────────────────────

// RFC 4180: quote a field only when it contains a quote, a comma or a line
// break; a quote inside quotes is doubled. Leading and trailing spaces are
// quoted too — the RFC says preserve them, but several importers strip them
// when the field is bare.
//
// Note what this does NOT do: it never touches a leading "=" or "+". Formula
// neutering is guardFormula's job and is applied per-column, because doing it
// here would rewrite every negative amount as text. See below.
export const csvCell = (value: string): string =>
  /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

// CRLF row terminator, per RFC 4180. It's what Excel on Windows expects, every
// other parser accepts it, and it keeps a row break visually distinct from a
// bare LF embedded inside a quoted note.
export const toCsv = (rows: string[][]): string =>
  rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";

// A spreadsheet treats a cell starting with = + - @ (or a leading tab/CR) as a
// formula, so `=HYPERLINK(...)` arriving in a text field becomes live content in
// Excel, Sheets and LibreOffice. RFC quoting does not prevent this — "=1+1" is
// still a formula — so the trigger character has to be neutered outright.
//
// Nothing can trigger it today: notes are composed by the backend and a GitHub
// login cannot begin with any of those characters. The guard is here because
// `note` is typed `string | undefined` with nothing enforcing where it comes
// from, and a live formula in a finance export is a bad way to discover that
// changed.
//
// Applied to TEXT columns only. Running it over the amount would rewrite
// "-450.75" as "'-450.75" and stop the column being a number at all.
export const guardFormula = (text: string): string =>
  /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;

// ─── Column formatting ───────────────────────────────────────────────────────

// UTC, matching the table (screen-bounties.tsx:83). ISO order also sorts
// correctly as text, which a spreadsheet column of dates otherwise won't.
const day = (ts?: number | null) => (ts ? new Date(ts).toISOString().slice(0, 10) : "");

// Mirrors TXN_PILL (screen-bounties.tsx:398) so the CSV and the screen use the
// same words. A support conversation stalls when the file says "confirmed" and
// the dashboard says "COMPLETED".
const STATUS_LABEL: Record<EscrowTransaction["status"], string> = {
  confirmed: "COMPLETED",
  pending: "PENDING",
  failed: "FAILED",
};

// The table rounds to whole dollars for density; an export must not drop cents.
// Same reasoning as the invoice (bounty-invoice.ts:34), but toFixed rather than
// its usdc(): toLocaleString groups thousands ("1,234.50"), and a comma inside a
// number forces quoting and defeats numeric import.
//
// Signed, rather than the table's "+" prefix for inbound. On screen the
// direction is carried by colour, which does not survive export — two positive
// numbers in a spreadsheet make a payout look like income and the column won't
// sum to a net. (A literal "+450.00" would also be a formula trigger.)
const amountUsdc = (t: EscrowTransaction) =>
  ((t.dir === "in" ? 1 : -1) * stroopsToUsdc(t.amountStroops)).toFixed(2);

// Same fallback as TxnRow (screen-bounties.tsx:414), so a row reads the same in
// the file as it does on the screen it came from.
const note = (t: EscrowTransaction) =>
  t.note || `${t.kind}${t.githubLogin ? ` · @${t.githubLogin}` : ""}`;

// Every text cell goes through this: the optional fields are `| null` or
// `| undefined`, and interpolating one of those writes a literal "undefined"
// into the file.
const text = (value?: string | null) => guardFormula(value ?? "");

export const TRANSACTION_HEADERS = [
  "Transaction ID",
  "Date (UTC)",
  "Confirmed (UTC)",
  "Kind",
  "Direction",
  "Status",
  "Amount (USDC)",
  "Amount (stroops)",
  "Note",
  "GitHub Login",
  "Transaction Hash",
  "Bounty ID",
  "Destination Address",
];

// ─── Rows ────────────────────────────────────────────────────────────────────

// Ordered identity → time → classification → money → context → keys, so the
// file is readable opened raw and not just in a spreadsheet.
//
// Some columns aren't on screen at all. `Confirmed` because settlement date, not
// submission date, is what lands in an accounting period — a distinction this
// feature already makes elsewhere (bounty-invoice.ts dates an invoice by
// confirmedAt). `Kind` and `Direction` because on screen they're prose and
// colour respectively. `Amount (stroops)` because every USDC figure in this app
// passes through a lossy double, so the raw on-chain integer is the only exact
// record — and the only way to see a sub-cent amount that rounds to 0.00.
// `Bounty ID` because without it a row with a generic note can't be reconciled.
//
// Left out: `signer` (internal — which key signed; `kind` already implies it),
// `destMemo` (near-always null), an explorer URL (stellarTxUrl hardcodes
// testnet, and baking that into a file that outlives the session is worse than
// omitting it), and the undeclared fields the route serialises along with the
// row (githubId, idempotencyKey, sourceAccount, ledger, error) — not part of the
// typed contract, and `error` could carry an internal chain message into a
// document a sponsor forwards to their accountant.
export const transactionRows = (txns: EscrowTransaction[]): string[][] => [
  TRANSACTION_HEADERS,
  ...txns.map((t) => [
    text(t.id),
    day(t.createdAt),
    day(t.confirmedAt),
    text(t.kind),
    text(t.dir),
    STATUS_LABEL[t.status],
    amountUsdc(t),
    text(t.amountStroops),
    text(note(t)),
    text(t.githubLogin),
    text(t.hash),
    text(t.bountyId),
    text(t.destAddress),
  ]),
];

export const transactionsCsv = (txns: EscrowTransaction[]): string =>
  toCsv(transactionRows(txns));

// One user-influenced value would break a filename, so the stem goes through the
// same sanitiser the invoice uses (bounty-invoice-pdf.ts:271). It's a no-op on
// today's constant — it's here so that adding the org name, the obvious next
// iteration, is safe by construction rather than by memory.
//
// Stamped in UTC to match the Date column, so a file exported at 23:00 EST
// doesn't carry a date its own rows contradict.
export const transactionsCsvFilename = (nowMs: number): string =>
  `${`devasign-transactions-${day(nowMs)}`.replace(/[^A-Za-z0-9._-]+/g, "-")}.csv`;
