import { describe, expect, it } from "vitest";
import { breadcrumbs, cdKeystrokes, parentDir } from "./cd";
import { powershellQuote } from "./ipc";

const MAC = "/Users/jorge/Documents/Documentos - Jorge’s MacBook Air/Development";

describe("cdKeystrokes", () => {
  it("clears what was half-typed and quotes the folder for zsh", () => {
    expect(cdKeystrokes("/Users/jorge/mi carpeta", false)).toBe("\x05\x15cd '/Users/jorge/mi carpeta'");
  });

  it("survives quotes in the path without leaving the string", () => {
    expect(cdKeystrokes("/tmp/it's here; rm -rf ~", false)).toBe(`\x05\x15cd '/tmp/it'\\''s here; rm -rf ~'`);
    expect(cdKeystrokes(MAC, false)).toBe(`\x05\x15cd '${MAC}'`);
  });

  it("uses Set-Location with PowerShell quoting on Windows", () => {
    expect(cdKeystrokes("C:\\Users\\Jorge’s\\repo", true)).toBe("\x1bSet-Location -LiteralPath 'C:\\Users\\Jorge’’s\\repo'");
  });
});

describe("powershellQuote", () => {
  it("doubles each single quote as it is, typographic ones included", () => {
    expect(powershellQuote("a'b")).toBe("'a''b'");
    expect(powershellQuote("Jorge’s")).toBe("'Jorge’’s'");
    expect(powershellQuote("‘x’")).toBe("'‘‘x’’'");
    expect(powershellQuote('$env:HOME "x"')).toBe(`'$env:HOME "x"'`);
  });
});

describe("parentDir", () => {
  it("goes one folder up, stopping at the root", () => {
    expect(parentDir("/Users/jorge/repo")).toBe("/Users/jorge");
    expect(parentDir("/Users/jorge/repo/")).toBe("/Users/jorge");
    expect(parentDir("/Users")).toBe("/");
    expect(parentDir("/")).toBeNull();
  });

  it("understands Windows drives", () => {
    expect(parentDir("C:\\Users\\jorge")).toBe("C:\\Users");
    expect(parentDir("C:\\Users")).toBe("C:\\");
    expect(parentDir("C:\\")).toBeNull();
  });
});

describe("breadcrumbs", () => {
  it("starts at ~ inside the home folder, each crumb leading to its folder", () => {
    expect(breadcrumbs("/Users/jorge/dev/termCode", "/Users/jorge")).toEqual([
      { label: "~", path: "/Users/jorge" },
      { label: "dev", path: "/Users/jorge/dev" },
      { label: "termCode", path: "/Users/jorge/dev/termCode" },
    ]);
  });

  it("does not mistake a sibling with the same prefix for home", () => {
    expect(breadcrumbs("/Users/jorge2/x", "/Users/jorge").map((c) => c.label)).toEqual(["/", "Users", "jorge2", "x"]);
  });

  it("starts at / outside home and at the drive on Windows", () => {
    expect(breadcrumbs("/opt/homebrew", "/Users/jorge")).toEqual([
      { label: "/", path: "/" },
      { label: "opt", path: "/opt" },
      { label: "homebrew", path: "/opt/homebrew" },
    ]);
    expect(breadcrumbs("D:\\work\\app", null)).toEqual([
      { label: "D:", path: "D:\\" },
      { label: "work", path: "D:\\work" },
      { label: "app", path: "D:\\work\\app" },
    ]);
  });

  it("is just ~ at home", () => {
    expect(breadcrumbs("/Users/jorge/", "/Users/jorge")).toEqual([{ label: "~", path: "/Users/jorge" }]);
  });
});
