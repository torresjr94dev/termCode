import { describe, expect, it } from "vitest";
import { brightValue, tintFloor } from "./backdrop";
import { LIMITS } from "../store/settingsStore";

/** Pixeles RGBA de un solo color. */
const solid = (r: number, g: number, b: number, n = 64) => {
  const px = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) px.set([r, g, b, 255], i * 4);
  return px;
};

describe("velo del vidrio líquido", () => {
  it("con fondos oscuros deja el vidrio tan claro como quieras", () => {
    expect(tintFloor(brightValue(solid(10, 12, 20)))).toBe(LIMITS.glassTint.min);
  });

  it("con un fondo blanco el vidrio sube lo necesario, sin pasar del tope", () => {
    const floor = tintFloor(brightValue(solid(255, 255, 255)));
    expect(floor).toBeGreaterThanOrEqual(0.77);
    expect(floor).toBeLessThanOrEqual(LIMITS.glassTint.max);
  });

  it("más claro el fondo, más opaco el vidrio", () => {
    const floors = [60, 120, 180, 240].map((v) => tintFloor(brightValue(solid(v, v, v))));
    expect([...floors].sort((a, b) => a - b)).toEqual(floors);
  });

  it("mide lo claro de la imagen (percentil 90), no su promedio", () => {
    // 85 % oscuro y 15 % blanco: el promedio engaña, las zonas blancas existen.
    const px = new Uint8ClampedArray(100 * 4);
    for (let i = 0; i < 100; i++) px.set(i < 85 ? [0, 0, 0, 255] : [255, 255, 255, 255], i * 4);
    expect(brightValue(px)).toBeCloseTo(1, 2);
  });

  it("ignora los pixeles transparentes", () => {
    const px = solid(255, 255, 255);
    for (let i = 3; i < px.length; i += 4) px[i] = 0;
    expect(brightValue(px)).toBe(0);
  });
});
