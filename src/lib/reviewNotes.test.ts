import { describe, expect, it } from "vitest";
import { formatReview, type ReviewNote } from "./reviewNotes";

const note = (over: Partial<ReviewNote>): ReviewNote => ({
  id: "n",
  root: "/repo",
  path: "src/a.ts",
  side: "new",
  line: 1,
  quote: "",
  text: "x",
  ...over,
});

describe("formatReview", () => {
  it("orders by file and line and quotes each line", () => {
    const text = formatReview([
      note({ path: "src/z.ts", line: 3, quote: "  const z = 1;", text: "Renombra z." }),
      note({ path: "src/a.ts", line: 40, quote: "export const PAGE = 50;", text: "Usa la config.\nNo un número fijo." }),
      note({ path: "src/a.ts", line: 12, side: "old", quote: "return all;", text: "¿Por qué lo quitaste?" }),
    ]);
    expect(text).toBe(
      [
        "Revisé tus cambios. Atiende estos comentarios:",
        "",
        "1. src/a.ts:12 (línea que borraste)",
        "   > return all;",
        "   ¿Por qué lo quitaste?",
        "",
        "2. src/a.ts:40",
        "   > export const PAGE = 50;",
        "   Usa la config.",
        "   No un número fijo.",
        "",
        "3. src/z.ts:3",
        "   > const z = 1;",
        "   Renombra z.",
        "",
      ].join("\n"),
    );
  });

  it("speaks in singular for a single note and skips empty quotes", () => {
    expect(formatReview([note({ quote: "   " })])).toBe("Revisé tus cambios. Atiende este comentario:\n\n1. src/a.ts:1\n   x\n");
  });
});
