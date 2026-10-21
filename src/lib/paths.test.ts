import { describe, expect, it } from "vitest";
import { basename, isWindowsPath, joinPath, relativeInside, tildify } from "./paths";

describe("paths", () => {
  it("recognizes Windows paths by their drive", () => {
    expect(isWindowsPath("C:\\Users")).toBe(true);
    expect(isWindowsPath("d:/repo")).toBe(true);
    expect(isWindowsPath("C:")).toBe(true);
    expect(isWindowsPath("/Users/c:")).toBe(false);
    expect(isWindowsPath("a:b.ts")).toBe(false);
  });

  it("takes basenames with either separator", () => {
    expect(basename("/Users/jorge/termCode/")).toBe("termCode");
    expect(basename("C:\\Users\\Jorge Torres\\repo\\")).toBe("repo");
    expect(basename("C:/Users/x")).toBe("x");
    expect(basename("/")).toBe("/");
    // En macOS `\` es parte del nombre.
    expect(basename("/tmp/a\\b")).toBe("a\\b");
  });

  it("knows what is inside a folder, ignoring case on Windows", () => {
    expect(relativeInside("/repo/src/lib", "/repo")).toBe("src/lib");
    expect(relativeInside("/repo", "/repo/")).toBe("");
    expect(relativeInside("/repository", "/repo")).toBeNull();
    expect(relativeInside("C:\\USERS\\jorge\\repo\\src", "C:/Users/jorge/repo")).toBe("src");
    expect(relativeInside("C:\\Users\\jorge\\repo2", "C:\\Users\\jorge\\repo")).toBeNull();
    expect(relativeInside("/Repo/src", "/repo")).toBeNull();
  });

  it("shortens the home folder to ~", () => {
    expect(tildify("/Users/j/code", "/Users/j")).toBe("~/code");
    expect(tildify("/Users/j", "/Users/j/")).toBe("~");
    expect(tildify("/Users/jj", "/Users/j")).toBe("/Users/jj");
    expect(tildify("C:\\Users\\j\\code", "C:\\Users\\j")).toBe("~\\code");
    expect(tildify("/x", null)).toBe("/x");
  });

  it("joins and resolves dots", () => {
    expect(joinPath("/repo/web", "../a/./b.ts")).toBe("/repo/a/b.ts");
    expect(joinPath("C:\\repo\\web", "..\\a/b.ts")).toBe("C:\\repo\\a\\b.ts");
    expect(joinPath("C:\\", "x.md")).toBe("C:\\x.md");
  });
});
