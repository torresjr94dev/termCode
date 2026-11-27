import { describe, expect, it } from "vitest";
import { FESTIVE_PALETTE, SPRITES } from "./sprites";
import { spriteRuns } from "./PixelSprite";

describe("sprites navideños", () => {
  it("cada sprite es un rectángulo y solo usa colores de la paleta", () => {
    for (const [name, rows] of Object.entries(SPRITES)) {
      const widths = new Set(rows.map((r) => r.length));
      expect(widths.size, name).toBe(1);
      for (const ch of rows.join("")) {
        if (ch !== ".") expect(FESTIVE_PALETTE[ch], `${name}: ${ch}`).toBeDefined();
      }
    }
  });

  it("junta los pixeles del mismo color en tramos", () => {
    expect(spriteRuns(["RR.G", ".WWW"])).toEqual([
      { x: 0, y: 0, w: 2, fill: FESTIVE_PALETTE.R },
      { x: 3, y: 0, w: 1, fill: FESTIVE_PALETTE.G },
      { x: 1, y: 1, w: 3, fill: FESTIVE_PALETTE.W },
    ]);
  });
});
