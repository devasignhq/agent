// Trigger a browser download from an in-memory string.
//
// No dependency: a Blob, an object URL and a synthetic anchor is the whole
// mechanism. Kept separate from the modules that build the content so those stay
// pure and testable — this half has no branching logic to get wrong.
export function downloadTextFile(
  filename: string,
  mime: string,
  text: string,
  { bom = false }: { bom?: boolean } = {}
): void {
  // Excel on Windows decodes a .csv in the system ANSI codepage unless a UTF-8
  // BOM leads the file, which mangles the "·" the transaction notes carry. Added
  // here rather than in the serialiser so its output stays clean text.
  const blob = new Blob(bom ? ["﻿", text] : [text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  // Firefox has historically ignored a programmatic click on a detached anchor,
  // so it's attached for the duration of the click and removed immediately.
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next task rather than synchronously: click() returns before
  // the browser has started reading the blob URL, and revoking first cancels the
  // download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
