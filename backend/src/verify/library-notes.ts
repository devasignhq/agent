// Interaction facts a browser test cannot read off the app's own source, keyed by the
// package that brings them. The React Flow notes were checked against @xyflow/react 12.11.
const XYFLOW: readonly string[] = [
  "Each line is an SVG group with role `group`, focusable, named \"Edge from <source id> to <target id>\" unless the app sets its own aria-label. Select one with `page.getByRole('group', { name: 'Edge from a to b' }).press('Enter')`; clicking a curved line's bounding-box centre lands on the empty canvas and clears the selection.",
  "To add lines to the selection, hold the multi-selection key while pressing Enter on each: `await page.keyboard.down('ControlOrMeta')`, `.press('Enter')` on every further line, then `await page.keyboard.up('ControlOrMeta')` (React Flow's default key; check the app's `multiSelectionKeyCode` prop). Escape deselects only the line that has focus; no key clears the whole selection. To clear it, click an empty stretch of the canvas: `page.locator('.react-flow__pane').click({ position: { x: 8, y: 8 } })`.",
  "A selected line carries the `selected` class (`.react-flow__edge.selected`).",
  "A perfectly horizontal or vertical line has an empty bounding box, so Playwright reports it hidden: never wait for `.react-flow__edge` `.first()` to be visible; wait for a count, or for a line by name.",
];

const NOTES: Record<string, readonly string[]> = { "@xyflow/react": XYFLOW };

/** The "Library notes" section of a browser test's request; empty when no installed package has any. */
export function libraryNotes(dependencies: readonly string[] | undefined): string[] {
  const notes = [...new Set((dependencies ?? []).flatMap((d) => NOTES[d] ?? []))];
  return notes.length ? ["## Library notes", ...notes.map((n) => `- ${n}`)] : [];
}
