import { describe, expect, it } from "vitest";
import { foldersOf, parseFileQuery, rankEntries, relativeTo, splitByRanges, textRows } from "./finderModel";
import type { LineMatch } from "./git";

const FILES = ["README.md", "src/App.tsx", "src/lib/fuzzy.ts", "src/lib/git.ts", "src/components/FileFinder.tsx", "src-tauri/src/fs.rs"];

describe("parseFileQuery", () => {
  it("reads a line (and column) after the name, like compiler output", () => {
    expect(parseFileQuery("App.tsx:120")).toEqual({ text: "App.tsx", line: 120, column: undefined });
    expect(parseFileQuery("src/App.tsx:12:5:")).toEqual({ text: "src/App.tsx", line: 12, column: 5 });
  });

  it("leaves plain queries alone", () => {
    expect(parseFileQuery("  app ")).toEqual({ text: "app" });
    expect(parseFileQuery(":12")).toEqual({ text: ":12" });
    expect(parseFileQuery("App.tsx:0")).toEqual({ text: "App.tsx", line: undefined, column: undefined });
  });
});

describe("foldersOf", () => {
  it("lists every folder that holds a file, once", () => {
    expect(foldersOf(FILES)).toEqual(["src", "src-tauri", "src-tauri/src", "src/components", "src/lib"]);
  });
});

describe("rankEntries", () => {
  const folders = foldersOf(FILES);

  it("shows recent files first when there is no query", () => {
    const out = rankEntries(FILES, folders, "", "", ["src/borrado.ts", "src/lib/git.ts"], 3);
    expect(out.map((e) => e.path)).toEqual(["src/lib/git.ts", "README.md", "src/App.tsx"]);
    expect(out[0].recent).toBe(true);
  });

  it("limits files and folders to the chosen folder and matches on the part inside it", () => {
    const out = rankEntries(FILES, folders, "src/lib", "ts", [], 10);
    expect(out.map((e) => e.path)).toEqual(["src/lib/git.ts", "src/lib/fuzzy.ts"]);
    expect(out[0].shown).toBe("git.ts");
    expect(rankEntries(FILES, folders, "src/lib", "", [], 10).every((e) => e.path.startsWith("src/lib/"))).toBe(true);
  });

  it("finds folders, behind a file that matches as well", () => {
    const out = rankEntries(FILES, folders, "", "comp", [], 10);
    expect(out.map((e) => `${e.isDir ? "dir" : "file"}:${e.path}`)).toContain("dir:src/components");
    const lib = rankEntries(FILES, folders, "", "lib", [], 10);
    expect(lib[0]).toMatchObject({ path: "src/lib", isDir: true });
  });

  it("never offers the scope folder itself", () => {
    expect(rankEntries(FILES, folders, "src/lib", "lib", [], 10).some((e) => e.path === "src/lib")).toBe(false);
  });
});

describe("relativeTo", () => {
  it("cuts the scope prefix only on a folder boundary", () => {
    expect(relativeTo("src/lib/git.ts", "src")).toBe("lib/git.ts");
    expect(relativeTo("src-tauri/x.rs", "src")).toBe("src-tauri/x.rs");
    expect(relativeTo("a.ts", "")).toBe("a.ts");
  });
});

describe("text results", () => {
  const m = (line: number): LineMatch => ({ line, column: 0, length: 1, preview: "x", ranges: [[0, 1]] });

  it("interleaves a header per file and numbers only the matches", () => {
    const rows = textRows({ files: [{ path: "a.ts", matches: [m(1), m(4)], more: false }, { path: "b.ts", matches: [m(2)], more: true }] });
    expect(rows.map((r) => (r.kind === "file" ? `# ${r.path}` : `${r.path}:${r.match.line}@${r.index}`))).toEqual([
      "# a.ts",
      "a.ts:1@0",
      "a.ts:4@1",
      "# b.ts",
      "b.ts:2@2",
    ]);
    expect(textRows(null)).toEqual([]);
  });

  it("splits a preview around its matches", () => {
    expect(splitByRanges("let total = total;", [[12, 17], [4, 9]])).toEqual([
      { text: "let ", hit: false },
      { text: "total", hit: true },
      { text: " = ", hit: false },
      { text: "total", hit: true },
      { text: ";", hit: false },
    ]);
    expect(splitByRanges("abc", [])).toEqual([{ text: "abc", hit: false }]);
  });
});
