import { describe, expect, it } from "vitest";
import { decodeCommandLine, decodeCwd } from "./commands";
import { findPaths, resolvePath } from "./links";

describe("shell integration payloads", () => {
  it("decodes escaped command lines", () => {
    expect(decodeCommandLine("echo a\\x3b ls \\\\ x")).toBe("echo a; ls \\ x");
    expect(decodeCommandLine("git commit -m \\x22hola\\x22\\x0agit push")).toBe('git commit -m "hola"\ngit push');
  });

  it("decodes OSC 7 directories", () => {
    expect(decodeCwd("file://mac.local/Users/jorge/Mi%20proyecto")).toBe("/Users/jorge/Mi proyecto");
    expect(decodeCwd("file:///tmp")).toBe("/tmp");
    expect(decodeCwd("file://host/bad%E0%A4%A")).toBe("/bad%E0%A4%A");
    expect(decodeCwd("nope")).toBeNull();
  });
});

describe("findPaths", () => {
  const paths = (text: string) => findPaths(text).map((m) => [m.path, m.line, m.column]);

  it("finds compiler-style locations", () => {
    expect(paths("error[E0308]: --> src/main.rs:42:7")).toEqual([["src/main.rs", 42, 7]]);
    expect(paths("  at render (./components/App.tsx:10:3)")).toEqual([["./components/App.tsx", 10, 3]]);
    expect(paths("FAIL tests/user.test.ts")).toEqual([["tests/user.test.ts", undefined, undefined]]);
  });

  it("finds absolute, home and bare files", () => {
    expect(paths("/Users/jorge/termCode/package.json")).toEqual([["/Users/jorge/termCode/package.json", undefined, undefined]]);
    expect(paths("ver ~/notas/todo.md:3")).toEqual([["~/notas/todo.md", 3, undefined]]);
    expect(paths("README.md cambió")).toEqual([["README.md", undefined, undefined]]);
  });

  it("ignores URLs and version numbers", () => {
    expect(paths("https://github.com/o/r/blob/main/a.ts")).toEqual([]);
    expect(paths("node v24.12.0 y 1.2.3")).toEqual([]);
  });

  it("reports exact columns for underlining", () => {
    const [m] = findPaths("x src/a.ts:1");
    expect([m.index, m.length]).toEqual([2, 10]);
  });
});

describe("resolvePath", () => {
  it("resolves relative to the pane directory", () => {
    expect(resolvePath("src/a.ts", "/repo", null)).toBe("/repo/src/a.ts");
    expect(resolvePath("../b/c.ts", "/repo/web", null)).toBe("/repo/b/c.ts");
    expect(resolvePath("./x.md", "/repo", null)).toBe("/repo/x.md");
    expect(resolvePath("~/y.md", null, "/Users/j")).toBe("/Users/j/y.md");
    expect(resolvePath("z.md", null, null)).toBeNull();
  });
});
