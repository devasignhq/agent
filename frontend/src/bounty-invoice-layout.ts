// The invoice's geometry, in the design's own coordinate space (562.493 × 730).
//
// Shared deliberately: the PDF generator draws with these numbers and the
// preview modal renders an SVG with the same viewBox, so the two cannot drift.
// Both treat Y values as text baselines — `doc.text` and SVG `<text y>` agree on
// that, which is why the preview is a faithful proof of the download.
//
// Values are measured from the design file (glyph-outline bounding boxes), not
// estimated. The body size was solved from its advance width: 6.2353 design
// units ÷ Geist Mono's 0.6-em advance = 10.3922.

export const DESIGN_W = 562.493;
export const DESIGN_H = 730;

// Margins are symmetric — 34.58 in from each edge.
export const COL_L = 34.58; // left column origin
export const COL_R = 297.38; // right column origin
export const EDGE_R = 527.91; // right margin: right-aligned amounts, rule ends

// Characters per column line. Not the widest that would physically fit — it's
// the design's own wrap point, measured from where its description and address
// lines break (36 and 37 characters).
export const COL_CHARS = 37;
// The footer's Notes field runs the full content width rather than one column.
export const NOTE_CHARS = Math.floor((EDGE_R - COL_L) / 6.2353);

export const SIZE_BODY = 10.3922;
export const SIZE_TITLE = 17.75;
export const LEAD = 13.1; // leading between wrapped lines inside one block

export const INK = "#000000";
export const MUTED = "#AAAAAA"; // values sitting under a label
export const DIM = "#646464"; // tax and total rows
export const BAND = "#F7F7F7";

// The two grey full-bleed bands: page header, and the table's column header.
export const BANDS = [
  { y: 0, h: 163.601 },
  { y: 323.895, h: 36.053 },
];

// Hairlines bracketing the totals block, spanning COL_R → EDGE_R.
export const RULES = [428.6, 483.75];
export const RULE_H = 0.85;

/** Text baselines, keyed by the element each one carries. */
export const Y = {
  title: 41.7,
  invoiceLabel: 74.47,
  invoiceValue: 90.97,
  dateLabel: 121.21,
  dateValue: 137.5,
  billLabel: 200.31, // "Bill To:" and "Bill From:" share a baseline
  billValue: 216.77,
  walletLabel: 260.06,
  walletChain: 276.56,
  walletAddress: 292.8,
  tableHead: 345.42,
  itemRow: 394,
  itemDescription: 410.35,
  taxRow: 450,
  totalRow: 469.2,
  amountDue: 506.92,
  paymentLabel: 543.78,
  paymentValue: 560.07,
  notesLabel: 590.55,
  notesValue: 606.95,
} as const;

// The title's glyphs start a hair right of the column origin in the design.
export const TITLE_X = COL_R + 1.4;
