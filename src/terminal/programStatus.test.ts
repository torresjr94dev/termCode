import { describe, expect, it } from "vitest";
import { parseProgramStatus } from "./programStatus";

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe("parseProgramStatus", () => {
  it("answers the support query", () => {
    expect(parseProgramStatus("?")).toBe("query");
  });

  it("parses what Claude Code sends", () => {
    expect(parseProgramStatus(`state=blocked:app=claude-code:kind=permission:msg=${b64("Bash: rm -rf dist")}`)).toEqual({
      state: "blocked",
      id: null,
      kind: "permission",
      progress: null,
      app: "claude-code",
      title: null,
      msg: "Bash: rm -rf dist",
    });
    expect(parseProgramStatus("state=working:app=claude-code:progress=40")).toMatchObject({ state: "working", progress: 40 });
    expect(parseProgramStatus("state=clear")).toMatchObject({ state: "clear", id: null });
  });

  it("decodes unpadded base64 and UTF-8", () => {
    const msg = b64("Revisé el esquema ✓").replace(/=+$/, "");
    expect(parseProgramStatus(`state=done:msg=${msg}`)).toMatchObject({ state: "done", msg: "Revisé el esquema ✓" });
  });

  it("keeps child records apart from the root", () => {
    expect(parseProgramStatus("state=working:id=agents/explore-1")).toMatchObject({ id: "agents/explore-1" });
  });

  it("ignores reports with an unknown state, a bad id or a broken message", () => {
    expect(parseProgramStatus("state=sleeping")).toBeNull();
    expect(parseProgramStatus("app=claude-code")).toBeNull();
    expect(parseProgramStatus("state=working:id=a//b")).toBeNull();
    expect(parseProgramStatus(`state=working:id=${"x".repeat(33)}`)).toBeNull();
    expect(parseProgramStatus(`state=working:id=${Array(9).fill("a").join("/")}`)).toBeNull();
    expect(parseProgramStatus("state=done:msg=a.b,c")).toBeNull();
    // Un par fuera de la gramática solo se salta.
    expect(parseProgramStatus("state=done:msg=@@@")).toMatchObject({ state: "done", msg: null });
    expect(parseProgramStatus(`state=done:msg=${b64("hola\x1b[31m")}`)).toBeNull();
    expect(parseProgramStatus(`state=done:msg=${btoa("\xff\xfe")}`)).toBeNull();
    expect(parseProgramStatus(`state=done:msg=${"A".repeat(5000)}`)).toBeNull();
  });

  it("skips malformed pairs, lets the last value win and drops meaningless fields", () => {
    expect(parseProgramStatus("state=idle:bogus:state=working:APP=x:kind=question")).toMatchObject({
      state: "working",
      kind: null,
      app: null,
    });
    expect(parseProgramStatus("state=idle:progress=50")).toMatchObject({ progress: null });
    expect(parseProgramStatus("state=working:progress=150")).toMatchObject({ progress: null });
    expect(parseProgramStatus("state=blocked:kind=coffee")).toMatchObject({ kind: null });
  });

  it("strips bidi overrides and invisible characters from text", () => {
    expect(parseProgramStatus(`state=done:msg=${b64(`ok${String.fromCharCode(0x202e)}txt.exe${String.fromCharCode(0x200b)}`)}`)).toMatchObject({ msg: "oktxt.exe" });
  });
});
