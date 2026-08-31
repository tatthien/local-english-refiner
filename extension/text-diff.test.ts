import assert from "node:assert/strict";
import test from "node:test";

import { compareText } from "./text-diff.ts";

test("compares a replacement as one changed section", () => {
  const comparison = compareText("This are correct.", "This is correct.");

  assert.equal(comparison.changeCount, 1);
  assert.deepEqual(
    comparison.parts.filter((part) => part.kind !== "unchanged"),
    [
      { kind: "removed", value: "are" },
      { kind: "added", value: "is" },
    ],
  );
});

test("preserves Markdown, HTML, and emoji in the comparison", () => {
  const original = "**Hello** <em>team</em> 😅";
  const refined = "**Hi** <em>team</em> 😅";
  const comparison = compareText(original, refined);

  const reconstructedOriginal = comparison.parts
    .filter((part) => part.kind !== "added")
    .map((part) => part.value)
    .join("");
  const reconstructedRefined = comparison.parts
    .filter((part) => part.kind !== "removed")
    .map((part) => part.value)
    .join("");

  assert.equal(reconstructedOriginal, original);
  assert.equal(reconstructedRefined, refined);
});

test("reports no changes for identical text", () => {
  const comparison = compareText("No changes 🎉", "No changes 🎉");

  assert.equal(comparison.changeCount, 0);
  assert.deepEqual(comparison.parts, [{ kind: "unchanged", value: "No changes 🎉" }]);
});
