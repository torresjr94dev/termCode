import { describe, expect, it } from "vitest";
import { pace, windowDuration } from "./quota";

const HOUR = 60 * 60 * 1000;
const now = 1_800_000_000_000;
const session = (usedPercent: number, resetsInHours: number) => ({
  kind: "session",
  label: "Sesión · 5 h",
  usedPercent,
  resetsAt: now + resetsInHours * HOUR,
  severity: null,
});

describe("pace", () => {
  it("projects the usage at reset from the average pace so far", () => {
    // 2 h de 5 transcurridas, 20 % usado → 10 %/h → 50 % al reiniciar.
    const p = pace(session(20, 3), now)!;
    expect(p.elapsedPercent).toBeCloseTo(40);
    expect(p.projectedPercent).toBeCloseTo(50);
    expect(p.exhaustsAt).toBeNull();
    expect(p.ahead).toBe(false);
  });

  it("says when you will run out if the pace beats the clock", () => {
    // 1 h transcurrida, 40 % usado → 40 %/h → el 100 % llega en 1.5 h, antes del reinicio (4 h).
    const p = pace(session(40, 4), now)!;
    expect(p.ahead).toBe(true);
    expect(p.exhaustsAt).toBe(now + 1.5 * HOUR);
    expect(p.projectedPercent).toBeCloseTo(200);
  });

  it("does not guess from the first minutes or without a reset time", () => {
    expect(pace(session(5, 4.95), now)?.exhaustsAt).toBeNull(); // 3 min: ritmo sin sentido
    expect(pace({ ...session(30, 2), resetsAt: null }, now)).toBeNull();
    expect(pace({ ...session(30, 2), kind: "otra" }, now)).toBeNull();
  });

  it("knows the session and weekly windows", () => {
    expect(windowDuration("session")).toBe(5 * HOUR);
    expect(windowDuration("weekly_scoped:Fable")).toBe(7 * 24 * HOUR);
  });
});
