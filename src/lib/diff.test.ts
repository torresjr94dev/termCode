import { describe, expect, it } from "vitest";
import { changedSpan, hunkPatch, parseUnifiedDiff, toSplitRows } from "./diff";

const SAMPLE = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,4 @@ export function saludo() {",
  " const a = 1;",
  "-const nombre = 'mundo';",
  "+const nombre = 'termCode';",
  " console.log(a);",
  "+console.log(nombre);",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  const parsed = parseUnifiedDiff(SAMPLE);

  it("counts changes and skips noisy headers", () => {
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(1);
    expect(parsed.rows.some((r) => r.text.startsWith("index "))).toBe(false);
    expect(parsed.rows[0]).toEqual({ kind: "hunk", text: "export function saludo() {", hunk: 0 });
  });

  it("numbers old and new lines", () => {
    const [, ctx, del, add, ctx2, add2] = parsed.rows;
    expect([ctx.oldNo, ctx.newNo]).toEqual([1, 1]);
    expect(del.oldNo).toBe(2);
    expect(add.newNo).toBe(2);
    expect([ctx2.oldNo, ctx2.newNo]).toEqual([3, 3]);
    expect(add2.newNo).toBe(4);
  });

  it("highlights the changed span inside paired lines", () => {
    const del = parsed.rows[2];
    const add = parsed.rows[3];
    expect(del.text.slice(...(del.changed ?? [0, 0]))).toBe("mundo");
    expect(add.text.slice(...(add.changed ?? [0, 0]))).toBe("termCode");
  });

  it("detects binary diffs", () => {
    expect(parseUnifiedDiff("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n").binary).toBe(true);
  });

  it("keeps rename metadata visible", () => {
    const d = parseUnifiedDiff("diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n");
    expect(d.rows.map((r) => r.text)).toEqual(["rename from a", "rename to b"]);
  });
});

describe("hunk patches", () => {
  it("rebuilds an applicable patch per hunk", () => {
    const text = [
      "diff --git a/x.txt b/x.txt",
      "index 1..2 100644",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1,2 +1,2 @@",
      "-uno",
      "+UNO",
      " dos",
      "@@ -9,2 +9,2 @@",
      " nueve",
      "-diez",
      "+DIEZ",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const d = parseUnifiedDiff(text);
    expect(d.hunks).toHaveLength(2);
    expect(d.rows.filter((r) => r.kind === "hunk").map((r) => r.hunk)).toEqual([0, 1]);
    expect(hunkPatch(d, 0)).toBe("diff --git a/x.txt b/x.txt\nindex 1..2 100644\n--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n-uno\n+UNO\n dos\n");
    expect(hunkPatch(d, 1)?.endsWith("+DIEZ\n\\ No newline at end of file\n")).toBe(true);
    expect(hunkPatch(d, 5)).toBeNull();
  });
});

describe("pairing by similarity", () => {
  it("still pairs a re-indented block when a new line opens it", () => {
    const text = [
      "@@ -1,2 +1,3 @@",
      "-  <main>",
      "-    {tabs}",
      "+  <div className=\"row\">",
      "+    <main>",
      "+      {tabs}",
    ].join("\n");
    const rows = parseUnifiedDiff(text).rows;
    const opener = rows.find((r) => r.text.includes("row"));
    expect(opener?.changed).toBeUndefined(); // línea nueva: nada que resaltar
    const main = rows.filter((r) => r.text.includes("main"));
    expect(main.every((r) => r.changed)).toBe(true);
    const add = main.find((r) => r.kind === "add");
    expect(add?.text.slice(...(add.changed ?? [0, 0]))).toBe("  "); // solo la indentación nueva
  });
});

describe("changedSpan", () => {
  it("returns null for identical or totally different lines", () => {
    expect(changedSpan("abc", "abc")).toBeNull();
    expect(changedSpan("abcdef", "uvwxyz")).toBeNull();
  });
});

describe("toSplitRows", () => {
  it("aligns deletions with additions block by block", () => {
    const split = toSplitRows(parseUnifiedDiff(SAMPLE).rows);
    const pair = split.find((r) => r.left?.kind === "del");
    expect(pair?.right?.kind).toBe("add");
    const lonelyAdd = split.find((r) => !r.left && r.right?.kind === "add");
    expect(lonelyAdd?.right?.text).toBe("console.log(nombre);");
    expect(split[0].full?.kind).toBe("hunk");
  });
});
