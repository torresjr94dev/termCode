import { describe, expect, it } from "vitest";
import { clampDock, sanitizeFileTabs, sanitizeViewerDock } from "./projectStore";

describe("pestañas guardadas en la sesión", () => {
  it("vuelven sin cambios, sin repetidas y solo con rutas relativas dentro del proyecto", () => {
    const saved = [
      { root: "/repo", path: "src/App.tsx", markdown: "split" },
      { root: "/repo", path: "src/App.tsx" },
      { root: "C:\\repo", path: "README.md", dirty: true, markdown: "otro" },
      { root: "/repo", path: "../fuera.txt" },
      { root: "/repo", path: "/etc/passwd" },
      { root: "/repo", path: "a//b.ts" },
      { root: "relativa", path: "a.ts" },
      { root: "/repo", path: 42 },
      null,
    ];
    expect(sanitizeFileTabs(saved)).toEqual([
      { root: "/repo", path: "src/App.tsx", dirty: false, markdown: "split" },
      { root: "C:\\repo", path: "README.md", dirty: false, markdown: undefined },
    ]);
    expect(sanitizeFileTabs("basura")).toEqual([]);
    expect(sanitizeFileTabs(Array.from({ length: 100 }, (_, i) => ({ root: "/r", path: `f${i}.ts` })))).toHaveLength(60);
  });

  it("el visor acoplado vuelve con un ancho usable", () => {
    expect(sanitizeViewerDock({ docked: true, width: 0.9 })).toEqual({ docked: true, width: 0.75 });
    expect(sanitizeViewerDock({ docked: "sí", width: "ancho" })).toEqual({ docked: false, width: 0.5 });
    expect(sanitizeViewerDock(undefined)).toEqual({ docked: false, width: 0.5 });
    expect(clampDock(Number.NaN)).toBe(0.5);
    expect(clampDock(0.1)).toBe(0.25);
  });
});
