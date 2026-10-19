import { describe, expect, it } from "vitest";
import { formatAgo, formatUntil, toEpochMs } from "./format";

const MIN = 60_000;
const NOW = Date.parse("2026-10-19T12:00:00Z");

describe("toEpochMs", () => {
  it("accepts ISO strings and epoch seconds or milliseconds", () => {
    expect(toEpochMs("2026-10-19T18:40:00.108298+00:00")).toBe(Date.parse("2026-10-19T18:40:00.108Z"));
    expect(toEpochMs(1792435200)).toBe(1792435200_000);
    expect(toEpochMs(1792435200_108)).toBe(1792435200_108);
  });

  it("rejects missing or invalid values", () => {
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs("")).toBeNull();
    expect(toEpochMs("mañana")).toBeNull();
    expect(toEpochMs(Number.NaN)).toBeNull();
  });
});

describe("relative times", () => {
  it("formats the time until a reset", () => {
    expect(formatUntil(NOW + 165 * MIN, NOW)).toBe("en 2 h 45 min");
    expect(formatUntil(NOW + 12 * MIN, NOW)).toBe("en 12 min");
    expect(formatUntil(NOW + 3 * 24 * 60 * MIN, NOW)).toBe("en 3 días");
    expect(formatUntil(NOW - MIN, NOW)).toBe("ahora");
  });

  it("formats how long ago a reading was taken", () => {
    expect(formatAgo(NOW - 10_000, NOW)).toBe("justo ahora");
    expect(formatAgo(NOW - 3 * MIN, NOW)).toBe("hace 3 min");
    expect(formatAgo(NOW - 26 * 60 * MIN, NOW)).toBe("hace 1 día");
  });
});
