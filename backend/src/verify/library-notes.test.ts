// Offline: the library facts a browser test's author is handed beside the app source.
//   node --import tsx/esm --test src/verify/library-notes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { libraryNotes } from "./library-notes.js";

test("a React Flow app's author learns how to select a line; any other app gets no section", () => {
  const section = libraryNotes(["react", "@xyflow/react", "zustand"]);
  assert.equal(section[0], "## Library notes");
  assert.ok(section.slice(1).every((line) => line.startsWith("- ")));
  assert.ok(section.some((n) => n.includes('named "Edge from <source id> to <target id>"')));
  assert.ok(section.some((n) => n.includes("ControlOrMeta")));
  assert.ok(section.some((n) => n.includes("empty bounding box")));
  assert.ok(section.some((n) => n.includes("no key clears the whole selection") && n.includes(".react-flow__pane")), "how to clear a selection, since Escape does not");
  assert.deepEqual(libraryNotes(["react", "zustand"]), []);
  assert.deepEqual(libraryNotes(undefined), [], "unknown dependencies add nothing");
  assert.deepEqual(libraryNotes(["@xyflow/react", "@xyflow/react"]), libraryNotes(["@xyflow/react"]), "each note once");
});
