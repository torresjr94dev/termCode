import { describe, expect, it } from "vitest";
import { MAX_PANES, parseWorkspace, WORKSPACE_TEMPLATE } from "./workspaceFile";

const parse = (value: unknown) => parseWorkspace(JSON.stringify(value), "repo");

describe("parseWorkspace", () => {
  it("reads the template", () => {
    const result = parseWorkspace(WORKSPACE_TEMPLATE, "repo");
    expect(result.ok && result.workspace.panes.map((p) => p.run ?? p.agent)).toEqual(["npm run dev", "npm test -- --watch", "claude"]);
  });

  it("uses the folder name when there is none", () => {
    const result = parse({ panes: [{ run: "make" }] });
    expect(result.ok && result.workspace.name).toBe("repo");
  });

  it("rejects hidden extra commands and control characters", () => {
    expect(parse({ panes: [{ run: "npm run dev\nrm -rf ~" }] }).ok).toBe(false);
    expect(parse({ panes: [{ run: "echo \u001b[2Jhola" }] }).ok).toBe(false);
  });

  it("keeps panes inside the repo", () => {
    for (const cwd of ["../otro", "/etc", "C:\\Windows", "a/../../b"]) expect(parse({ panes: [{ run: "ls", cwd }] }).ok).toBe(false);
    const ok = parse({ panes: [{ run: "ls", cwd: "./apps/web" }] });
    expect(ok.ok && ok.workspace.panes[0].cwd).toBe("apps/web");
  });

  it("rejects malformed files as a whole", () => {
    expect(parseWorkspace("{nope", "r").ok).toBe(false);
    expect(parse({ panes: [] }).ok).toBe(false);
    expect(parse({ panes: Array.from({ length: MAX_PANES + 1 }, () => ({ run: "ls" })) }).ok).toBe(false);
    expect(parse({ panes: [{ run: "ls", agent: "claude" }] }).ok).toBe(false);
    expect(parse({ panes: [{ agent: "gpt" }] }).ok).toBe(false);
    expect(parse({ panes: [{ split: "diagonal" }] }).ok).toBe(false);
  });
});
