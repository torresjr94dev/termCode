import { describe, expect, it } from "vitest";
import { conflictCount, parseConflicts, resolveConflicts } from "./conflicts";

const FILE = [
  "uno",
  "<<<<<<< HEAD",
  "dos (mía)",
  "=======",
  "dos (suya)",
  ">>>>>>> feature/x",
  "tres",
  "<<<<<<< HEAD",
  "cuatro",
  "||||||| base",
  "4",
  "=======",
  "CUATRO",
  ">>>>>>> feature/x",
  "",
].join("\n");

describe("conflictos", () => {
  it("separa texto común y bloques, con etiquetas y base diff3", () => {
    const chunks = parseConflicts(FILE);
    expect(conflictCount(chunks)).toBe(2);
    expect(chunks[1]).toEqual({
      kind: "conflict",
      ours: ["dos (mía)"],
      base: null,
      theirs: ["dos (suya)"],
      oursLabel: "HEAD",
      theirsLabel: "feature/x",
    });
    const second = chunks[3];
    expect(second.kind === "conflict" && second.base).toEqual(["4"]);
  });

  it("resuelve por bloque y conserva el salto de línea final", () => {
    const chunks = parseConflicts(FILE);
    expect(resolveConflicts(chunks, ["ours", "theirs"])).toBe("uno\ndos (mía)\ntres\nCUATRO\n");
    expect(resolveConflicts(chunks, ["both", "ours"])).toBe("uno\ndos (mía)\ndos (suya)\ntres\ncuatro\n");
    expect(resolveConflicts(chunks, ["ours"])).toBeNull();
  });

  it("un bloque sin cerrar queda como texto", () => {
    const text = "a\n<<<<<<< HEAD\nb\n=======\nc\n";
    const chunks = parseConflicts(text);
    expect(conflictCount(chunks)).toBe(0);
    expect(resolveConflicts(chunks, [])).toBe(text);
  });

  it("respeta finales de línea CRLF", () => {
    const text = "a\r\n<<<<<<< HEAD\r\nb\r\n=======\r\nc\r\n>>>>>>> otra\r\nz\r\n";
    const chunks = parseConflicts(text);
    expect(conflictCount(chunks)).toBe(1);
    expect(resolveConflicts(chunks, ["theirs"])).toBe("a\r\nc\r\nz\r\n");
  });
});
