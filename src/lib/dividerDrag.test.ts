import { describe, expect, it } from "vitest";
import { draggedRatio } from "./dividerDrag";

describe("draggedRatio", () => {
  it("does not move the divider when the cursor has not moved (the old code jumped to its edge)", () => {
    expect(draggedRatio(0.55, 0, 900, -1)).toBe(0.55);
    expect(draggedRatio(0.3, 0, 640, 1)).toBe(0.3);
  });

  it("moves the edge exactly as far as the cursor", () => {
    // 900 px por ratio de 1: 45 px son 0.05.
    expect(draggedRatio(0.5, 45, 900, 1)).toBeCloseTo(0.55);
    // El visor crece hacia la izquierda: mover el cursor a la derecha lo achica.
    expect(draggedRatio(0.5, 45, 900, -1)).toBeCloseTo(0.45);
  });

  it("keeps the ratio when the size is unknown", () => {
    expect(draggedRatio(0.5, 30, 0, 1)).toBe(0.5);
    expect(draggedRatio(0.5, 30, Number.NaN, 1)).toBe(0.5);
    expect(draggedRatio(0.5, 30, Number.POSITIVE_INFINITY, 1)).toBe(0.5);
  });
});
