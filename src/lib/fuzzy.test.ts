import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

const FILES = [
  "src/terminal/TerminalManager.ts",
  "src/components/TerminalPane.tsx",
  "src/lib/terminal-utils.ts",
  "src-tauri/src/pty.rs",
  "src/App.tsx",
  "docs/apps/application.md",
];

describe("fuzzy", () => {
  it("exige las letras en orden", () => {
    expect(fuzzyMatch("tm", "src/terminal/TerminalManager.ts")).not.toBeNull();
    expect(fuzzyMatch("zz", "src/App.tsx")).toBeNull();
    expect(fuzzyMatch("", "x")?.score).toBe(0);
  });

  it("prefiere iniciales de palabra y el nombre del archivo", () => {
    expect(fuzzyFilter(FILES, "tm", (f) => f)[0].item).toBe("src/terminal/TerminalManager.ts");
    expect(fuzzyFilter(FILES, "app", (f) => f)[0].item).toBe("src/App.tsx");
    expect(fuzzyFilter(FILES, "pty", (f) => f)[0].item).toBe("src-tauri/src/pty.rs");
  });

  it("devuelve las posiciones para resaltar", () => {
    const m = fuzzyMatch("app", "src/App.tsx");
    expect(m?.positions).toEqual([4, 5, 6]);
  });
});

describe("fuzzy · rendimiento", () => {
  it("filtra 50 000 rutas en un tiempo usable para cada tecla", () => {
    const paths = Array.from({ length: 50_000 }, (_, i) => `packages/pkg-${i % 97}/src/module${i}/component-${i}.tsx`);
    const t0 = performance.now();
    const results = fuzzyFilter(paths, "pkgcomp12", (p) => p);
    const elapsed = performance.now() - t0;
    expect(results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(400);
  });
});
