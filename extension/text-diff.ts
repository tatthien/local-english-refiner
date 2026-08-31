import { diffWordsWithSpace } from "diff";

export type TextDiffPart = {
  kind: "added" | "removed" | "unchanged";
  value: string;
};

export type TextComparison = {
  parts: TextDiffPart[];
  changeCount: number;
};

export function compareText(original: string, refined: string): TextComparison {
  const parts = diffWordsWithSpace(original, refined).map((part) => ({
    kind: part.added ? "added" as const : part.removed ? "removed" as const : "unchanged" as const,
    value: part.value,
  }));

  let changeCount = 0;
  let insideChange = false;
  for (const part of parts) {
    if (part.kind === "unchanged") {
      insideChange = false;
    } else if (!insideChange) {
      changeCount += 1;
      insideChange = true;
    }
  }

  return { parts, changeCount };
}
