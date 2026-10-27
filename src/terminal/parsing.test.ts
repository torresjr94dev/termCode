import { describe, expect, it } from "vitest";
import { commandAgent, decodeCommandLine, decodeCwd, withShellFacts, type CommandRecord } from "./commands";
import { findPaths, resolvePath } from "./links";
import { sanitizePaste } from "./paste";
import { clearEnd, initialClearState, isClearCommand } from "./clear";

describe("shell integration payloads", () => {
  it("decodes escaped command lines", () => {
    expect(decodeCommandLine("echo a\\x3b ls \\\\ x")).toBe("echo a; ls \\ x");
    expect(decodeCommandLine("git commit -m \\x22hola\\x22\\x0agit push")).toBe('git commit -m "hola"\ngit push');
  });

  it("decodes OSC 7 directories", () => {
    expect(decodeCwd("file://mac.local/Users/jorge/Mi%20proyecto")).toBe("/Users/jorge/Mi proyecto");
    expect(decodeCwd("file:///tmp")).toBe("/tmp");
    expect(decodeCwd("file://host/bad%E0%A4%A")).toBe("/bad%E0%A4%A");
    expect(decodeCwd("nope")).toBeNull();
  });

  it("decodes the directories PowerShell reports on Windows", () => {
    expect(decodeCwd("file://PC-JORGE/C:/Users/Jorge%20Torres/repo")).toBe("C:\\Users\\Jorge Torres\\repo");
    expect(decodeCwd("file://PC/D:/")).toBe("D:\\");
    expect(decodeCwd("file://PC/C:/50%25")).toBe("C:\\50%");
  });
});

describe("commandAgent", () => {
  it("recognizes an agent typed in the shell, with path, env or a prefix", () => {
    expect(commandAgent("claude")).toBe("claude");
    expect(commandAgent("  claude --model opus  ")).toBe("claude");
    expect(commandAgent("/opt/homebrew/bin/codex --model o3")).toBe("codex");
    expect(commandAgent("ANTHROPIC_MODEL=x DEBUG=1 claude")).toBe("claude");
    expect(commandAgent("command claude --continue")).toBe("claude");
    expect(commandAgent("codex -p trabajo")).toBe("codex"); // en Codex, -p es --profile
    expect(commandAgent('claude "arregla el login"')).toBe("claude");
  });

  it("ignores what does not open the agent's interface", () => {
    expect(commandAgent("claude -p 'resume el diff'")).toBeNull();
    expect(commandAgent("claude --print hola")).toBeNull();
    expect(commandAgent("claude --version")).toBeNull();
    expect(commandAgent("claude mcp list")).toBeNull();
    expect(commandAgent("claude --dangerously-skip-permissions mcp list")).toBeNull();
    expect(commandAgent("claude doctor")).toBeNull();
    expect(commandAgent("codex exec 'corre los tests'")).toBeNull();
    expect(commandAgent("codex login")).toBeNull();
  });

  it("ignores other programs and look-alikes", () => {
    expect(commandAgent("claudette")).toBeNull();
    expect(commandAgent("npx claude")).toBeNull();
    expect(commandAgent("echo claude")).toBeNull();
    expect(commandAgent("")).toBeNull();
    expect(commandAgent(null)).toBeNull();
  });
});

describe("withShellFacts", () => {
  const base = { shellPid: 10, foregroundPid: null, foregroundName: null, cwd: null, busy: false };
  const record = (command: string, endedAt: number | null) => ({ command, endedAt }) as CommandRecord;

  it("uses what the shell reported when the system cannot tell (Windows)", () => {
    const tracker = { cwd: "C:\\repo", records: [record("npm run dev", null)], integrated: true };
    expect(withShellFacts(base, tracker, true)).toMatchObject({ cwd: "C:\\repo", busy: true, foregroundName: "npm" });
    const idle = { ...tracker, records: [record("ls", 5)] };
    expect(withShellFacts(base, idle, true)).toMatchObject({ busy: false, foregroundName: null });
  });

  it("keeps an agent busy until its shell shows the first prompt", () => {
    expect(withShellFacts(base, { cwd: null, records: [], integrated: false }, false).busy).toBe(true);
    expect(withShellFacts(base, { cwd: null, records: [], integrated: true }, false).busy).toBe(false);
  });

  it("trusts the system when it knows the foreground process (macOS)", () => {
    const mac = { ...base, foregroundPid: 10, cwd: "/repo" };
    const tracker = { cwd: "/old", records: [record("vim", null)], integrated: false };
    expect(withShellFacts(mac, tracker, false)).toEqual(mac);
    expect(withShellFacts({ ...mac, cwd: null }, tracker, false).cwd).toBe("/old");
  });
});

describe("findPaths", () => {
  const paths = (text: string) => findPaths(text).map((m) => [m.path, m.line, m.column]);

  it("finds compiler-style locations", () => {
    expect(paths("error[E0308]: --> src/main.rs:42:7")).toEqual([["src/main.rs", 42, 7]]);
    expect(paths("  at render (./components/App.tsx:10:3)")).toEqual([["./components/App.tsx", 10, 3]]);
    expect(paths("FAIL tests/user.test.ts")).toEqual([["tests/user.test.ts", undefined, undefined]]);
  });

  it("finds absolute, home and bare files", () => {
    expect(paths("/Users/jorge/termCode/package.json")).toEqual([["/Users/jorge/termCode/package.json", undefined, undefined]]);
    expect(paths("ver ~/notas/todo.md:3")).toEqual([["~/notas/todo.md", 3, undefined]]);
    expect(paths("README.md cambió")).toEqual([["README.md", undefined, undefined]]);
  });

  it("ignores URLs and version numbers", () => {
    expect(paths("https://github.com/o/r/blob/main/a.ts")).toEqual([]);
    expect(paths("node v24.12.0 y 1.2.3")).toEqual([]);
  });

  it("finds Windows paths", () => {
    expect(paths("error TS2322: C:\\repo\\src\\app.ts:42:7")).toEqual([["C:\\repo\\src\\app.ts", 42, 7]]);
    expect(paths("FAIL src\\user.test.ts")).toEqual([["src\\user.test.ts", undefined, undefined]]);
    expect(paths("ver .\\notas\\todo.md:3")).toEqual([[".\\notas\\todo.md", 3, undefined]]);
  });

  it("reports exact columns for underlining", () => {
    const [m] = findPaths("x src/a.ts:1");
    expect([m.index, m.length]).toEqual([2, 10]);
  });
});

describe("resolvePath", () => {
  it("resolves relative to the pane directory", () => {
    expect(resolvePath("src/a.ts", "/repo", null)).toBe("/repo/src/a.ts");
    expect(resolvePath("../b/c.ts", "/repo/web", null)).toBe("/repo/b/c.ts");
    expect(resolvePath("./x.md", "/repo", null)).toBe("/repo/x.md");
    expect(resolvePath("~/y.md", null, "/Users/j")).toBe("/Users/j/y.md");
    expect(resolvePath("z.md", null, null)).toBeNull();
  });

  it("resolves Windows paths with backslashes and either separator", () => {
    expect(resolvePath("src\\a.ts", "C:\\repo", null)).toBe("C:\\repo\\src\\a.ts");
    expect(resolvePath("../b/c.ts", "C:\\repo\\web", null)).toBe("C:\\repo\\b\\c.ts");
    expect(resolvePath("c:\\x\\y.md", null, null)).toBe("C:\\x\\y.md");
    expect(resolvePath("~\\notas.md", null, "C:\\Users\\j")).toBe("C:\\Users\\j\\notas.md");
    // `/x` no tiene unidad en Windows; `\` no separa en macOS.
    expect(resolvePath("/etc/hosts.txt", "C:\\repo", null)).toBeNull();
    expect(resolvePath("a\\b.ts", "/repo", null)).toBeNull();
  });
});

describe("sanitizePaste", () => {
  it("cannot break out of bracketed paste", () => {
    const evil = "> línea citada\x1b[201~rm -rf ~\r\x1b[200~";
    const clean = sanitizePaste(evil);
    // Sin ESC el bracket no se puede cerrar: el \r queda como salto de línea *dentro* del pegado.
    expect(clean).not.toContain("\x1b");
    expect(clean).toBe("> línea citada[201~rm -rf ~\r[200~");
  });

  it("turns newlines into terminal Enter and keeps tabs", () => {
    expect(sanitizePaste("a\r\nb\nc\td\x07")).toBe("a\rb\rc\td");
  });
});

describe("clearEnd", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const run = (cmd: string) => `\x1b]633;E;${cmd}\x07\x1b]133;C\x07`;
  const prompt = "\x1b]133;D;0\x07\x1b]133;A\x07% ";

  it("ends after the erase in macOS order (ESC[3J first)", () => {
    const state = initialClearState();
    const out = bytes(`${run("clear")}\x1b[3J\x1b[H\x1b[2J${prompt}`);
    expect(clearEnd(out, state)).toBe(out.length - prompt.length);
  });

  it("and in Linux order (ESC[3J last)", () => {
    const out = bytes(`${run("clear")}\x1b[H\x1b[2J\x1b[3J${prompt}`);
    expect(clearEnd(out, initialClearState())).toBe(out.length - prompt.length);
  });

  it("follows the sequence across chunks", () => {
    const state = initialClearState();
    expect(clearEnd(bytes(run("/usr/bin/clear")), state)).toBe(-1);
    expect(clearEnd(bytes("\x1b[3J"), state)).toBe(-1);
    expect(clearEnd(bytes(`\x1b[H\x1b[2J${prompt}`), state)).toBe(7);
  });

  it("leaves alone what a program clears (vite, tsc -w, jest)", () => {
    const state = initialClearState();
    expect(clearEnd(bytes(`${run("npm run dev")}\x1b[2J\x1b[3J\x1b[H  VITE v6 ready\r\n`), state)).toBe(-1);
    expect(clearEnd(bytes(`${run("tsc -w")}\x1b[3J\x1b[H\x1b[2JStarting compilation`), state)).toBe(-1);
  });

  it("ignores Ctrl+L and clears outside a command", () => {
    expect(clearEnd(bytes("\x1b[H\x1b[2J% "), initialClearState())).toBe(-1);
    expect(clearEnd(bytes(`${prompt}\x1b[3J\x1b[H\x1b[2J`), initialClearState())).toBe(-1);
  });

  it("recognizes what you type to clear", () => {
    for (const c of ["clear", "clear -x", "/usr/bin/clear", "command clear", "reset", "tput clear", "cls"]) expect(isClearCommand(c)).toBe(true);
    for (const c of ["clearance", "npm run clear-cache", "echo clear", "tput cols"]) expect(isClearCommand(c)).toBe(false);
  });
});
