#!/usr/bin/env node
/**
 * Pruebas de punta a punta del frontend, sin dependencias: levanta Vite,
 * abre Chrome headless y lo maneja por CDP (WebSocket nativo de Node ≥ 22).
 * Las teclas se envían como eventos reales de entrada (Input.dispatchKeyEvent)
 * con los acordes que define la propia app en src/lib/shortcuts.ts, así que
 * funcionan igual en macOS (⌘) y en Linux (Ctrl+Shift).
 *
 * Fuera de Tauri no hay backend: lo que necesita git se simula reemplazando
 * funciones de `gitApi` dentro de la página.
 *
 *   pnpm e2e                 # todas
 *   pnpm e2e -- buscador     # solo las que contienen "buscador" (varias: buscador,paleta)
 *   CHROME_PATH=… pnpm e2e   # otro Chrome/Chromium
 *
 * Al fallar, deja una captura en e2e/artifacts/<prueba>.png.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = join(ROOT, "e2e", "artifacts");
const VITE_PORT = Number(process.env.E2E_PORT ?? 1437);
const CDP_PORT = Number(process.env.E2E_CDP_PORT ?? 9347);
const filter = process.argv.slice(2).find((a) => a !== "--");
const TEST_TIMEOUT_MS = 30_000;
/** E2E_DIAG=1: si la página se cuelga, imprime la pila del JavaScript que la bloquea. */
const DIAG = Boolean(process.env.E2E_DIAG);
// Tope de toda la corrida: pase lo que pase, CI no se queda esperando horas.
const RUN_TIMEOUT_MS = 4 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Procesos                                                            */
/* ------------------------------------------------------------------ */

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "darwin" && existsSync(mac)) return mac;
  // Windows no tiene `which`; Edge es Chromium y siempre viene instalado.
  if (process.platform === "win32") {
    const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
    const candidates = roots.flatMap((root) => [join(root, "Google/Chrome/Application/chrome.exe"), join(root, "Microsoft/Edge/Application/msedge.exe")]);
    const found = candidates.find((path) => existsSync(path));
    if (found) return found;
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const which = spawnSync("which", [name], { encoding: "utf8" });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  }
  throw new Error("No encontré Chrome/Chromium: define CHROME_PATH.");
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // aún no escucha
    }
    await sleep(200);
  }
  throw new Error(`${url} no respondió en ${timeoutMs} ms`);
}

function startVite() {
  const vite = spawn(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "--config", join(ROOT, "e2e/vite.config.ts"), "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none" },
  });
  let output = "";
  vite.stdout.on("data", (d) => (output += d));
  vite.stderr.on("data", (d) => (output += d));
  return { proc: vite, log: () => output };
}

function startChrome(profile) {
  const args = [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1280,800",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  // Los runners de Ubuntu restringen los user namespaces que usa el sandbox.
  if (process.platform === "linux" && process.env.CI) args.unshift("--no-sandbox");
  // Flags extra para depurar (p. ej. E2E_CHROME_ARGS="--disable-gpu" emula un runner sin GPU).
  if (process.env.E2E_CHROME_ARGS) args.unshift(...process.env.E2E_CHROME_ARGS.split(/\s+/).filter(Boolean));
  if (DIAG) args.unshift("--enable-logging=stderr", "--v=0");
  const chrome = spawn(findChrome(), args, { stdio: ["ignore", "ignore", DIAG ? "pipe" : "ignore"] });
  if (DIAG) {
    chrome.log = "";
    chrome.stderr.on("data", (d) => (chrome.log = (chrome.log + d).slice(-20_000)));
  }
  return chrome;
}

/* ------------------------------------------------------------------ */
/* CDP                                                                 */
/* ------------------------------------------------------------------ */

async function connect() {
  let url;
  for (let i = 0; i < 75 && !url; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      url = targets.find((t) => t.type === "page")?.webSocketDebuggerUrl;
    } catch {
      // Chrome aún arranca
    }
    if (!url) await sleep(200);
  }
  if (!url) throw new Error("Chrome no expuso el protocolo de depuración.");
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const errors = [];
  let onPaused = null;
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === "Page.javascriptDialogOpening") {
      errors.push(`diálogo ${msg.params.type} abierto: ${msg.params.message}`);
    } else if (msg.method === "Inspector.targetCrashed") {
      errors.push("el renderer de la página se cayó (Inspector.targetCrashed)");
      if (DIAG) console.log("    [diag] el renderer se cayó");
    } else if (msg.method === "Debugger.paused") {
      onPaused?.(msg.params.callFrames);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description ?? d.text);
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    }
  });
  // Una página colgada no debe colgar la corrida: cada llamada tiene plazo.
  const send = (method, params = {}, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} no respondió en ${timeoutMs / 1000} s (¿página colgada?)`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  /**
   * Diagnóstico de una página colgada: pausa el JavaScript que esté corriendo
   * y devuelve la pila. Requiere haber habilitado Debugger antes (E2E_DIAG=1).
   */
  const stackOfHang = async () => {
    const frames = new Promise((resolve) => {
      onPaused = resolve;
      setTimeout(() => resolve(null), 5000);
    });
    await send("Debugger.pause", {}, 5000).catch(() => {});
    const callFrames = await frames;
    onPaused = null;
    if (!callFrames) return "(no se pudo pausar: el bloqueo no es JavaScript)";
    await send("Debugger.resume", {}, 5000).catch(() => {});
    return callFrames
      .slice(0, 20)
      .map((f) => `${f.functionName || "(anónima)"}  ${f.url.replace(/^https?:\/\/[^/]+/, "")}:${f.location.lineNumber + 1}`)
      .join("\n      ");
  };

  return { ws, send, errors, stackOfHang };
}

/* ------------------------------------------------------------------ */
/* Ayudas para las pruebas                                             */
/* ------------------------------------------------------------------ */

function makePage(cdp) {
  const evaluate = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };

  /** Importa un módulo de la app con la misma URL que usa la app (misma instancia). */
  const IMPORT = `const mod = (p) => { const hit = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => new URL(n).pathname === p).pop(); return import(hit ?? p); };`;
  const run = (body) => evaluate(`(async () => { ${IMPORT} ${body} })()`);

  const waitFor = async (expression, what, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      // Un nodo del DOM no se puede serializar: cuenta como "sí".
      last = await evaluate(`(() => { try { const v = ${expression}; return v instanceof Node ? true : v; } catch { return undefined; } })()`);
      if (last) return last;
      await sleep(60);
    }
    throw new Error(`No pasó: ${what} (último valor: ${JSON.stringify(last)})`);
  };

  const KEYS = {
    Enter: { code: "Enter", vk: 13 },
    Escape: { code: "Escape", vk: 27 },
    ArrowUp: { code: "ArrowUp", vk: 38 },
    ArrowDown: { code: "ArrowDown", vk: 40 },
    ArrowLeft: { code: "ArrowLeft", vk: 37 },
    ArrowRight: { code: "ArrowRight", vk: 39 },
    ",": { code: "Comma", vk: 188 },
  };

  /** Pulsa una tecla con modificadores (máscara CDP: Alt 1, Ctrl 2, Meta 4, Shift 8). */
  const press = async (key, modifiers = 0) => {
    const known = KEYS[key];
    const letter = /^[a-z0-9]$/i.test(key);
    const code = known?.code ?? (letter ? (/\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`) : key);
    const vk = known?.vk ?? (letter ? key.toUpperCase().charCodeAt(0) : 0);
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };

  /** Atajo de la app por id, con el acorde que la app espera en este SO. */
  const shortcut = async (id) => {
    const chord = await run(`
      const { SHORTCUTS, IS_MAC } = await mod("/src/lib/shortcuts.ts");
      const c = SHORTCUTS[${JSON.stringify(id)}];
      return { key: Array.isArray(c.key) ? c.key[0] : c.key, shift: !!c.shift, alt: !!c.alt, mac: IS_MAC };`);
    const mods = chord.mac
      ? 4 | (chord.shift ? 8 : 0) | (chord.alt ? 1 : 0)
      : 2 | 8 | (chord.alt || chord.shift ? 1 : 0);
    await press(chord.key, mods);
  };

  const type = (text) => cdp.send("Input.insertText", { text });

  /** ⌘ en macOS, Ctrl en el resto (como "Mod" de CodeMirror). */
  let mac;
  const pressMod = async (key) => {
    mac ??= await run(`return (await mod("/src/lib/shortcuts.ts")).IS_MAC;`);
    await press(key, mac ? 4 : 2);
  };

  const click = (selector, text) =>
    evaluate(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = ${text ? `els.find((e) => e.textContent.trim().includes(${JSON.stringify(text)}))` : "els[0]"};
      if (!el) return false;
      el.click();
      return true;
    })()`).then((ok) => {
      if (!ok) throw new Error(`No encontré ${selector}${text ? ` con «${text}»` : ""}`);
    });

  const screenshot = async (name) => {
    mkdirSync(ARTIFACTS, { recursive: true });
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(ARTIFACTS, `${name}.png`), Buffer.from(data, "base64"));
  };

  /** Rueda del ratón real (no un evento sintético de la página) en el centro de un elemento. */
  const wheel = async (selector, deltaY) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`No encontré ${selector} para la rueda`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY });
  };

  /** Doble clic real (dos pulsaciones con clickCount 1 y 2), en el centro del primer elemento que coincide. */
  const dblclick = async (selector, text) => {
    const box = await evaluate(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = ${text ? `els.find((e) => e.textContent.trim().includes(${JSON.stringify(text)}))` : "els[0]"};
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`No encontré ${selector}${text ? ` con «${text}»` : ""} para el doble clic`);
    const base = { x: box.x, y: box.y, button: "left" };
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    for (const clickCount of [1, 2]) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", clickCount, ...base });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", clickCount, ...base });
    }
  };

  return { evaluate, run, waitFor, press, pressMod, shortcut, type, click, screenshot, wheel, dblclick };
}

/* ------------------------------------------------------------------ */
/* Pruebas                                                             */
/* ------------------------------------------------------------------ */

const CONFLICT = [
  "const a = 1;",
  "<<<<<<< HEAD",
  "export const PAGE = 50;",
  "=======",
  "export const PAGE = 25;",
  ">>>>>>> feature/x",
  "const b = 2;",
  "<<<<<<< HEAD",
  "uno();",
  "=======",
  "dos();",
  ">>>>>>> feature/x",
  "",
].join("\n");

const SESSION = "0b6f2a43-1c1e-4e57-9d0e-6b8f1c2d3e4f";

const REVIEW_DIFF = [
  "diff --git a/src/pagina.ts b/src/pagina.ts",
  "index 1111111..2222222 100644",
  "--- a/src/pagina.ts",
  "+++ b/src/pagina.ts",
  "@@ -1,2 +1,2 @@",
  " const a = 1;",
  "-export const PAGE = 25;",
  "+export const PAGE = 50;",
  "",
].join("\n");

const TESTS = [
  {
    name: "bienvenida-primera-vez",
    async run(p) {
      await p.waitFor(`document.querySelector('[aria-labelledby="welcome-title"]')`, "la bienvenida aparece la primera vez");
      await p.click("button", "Empezar");
      await p.waitFor(`!document.querySelector('[aria-labelledby="welcome-title"]')`, "la bienvenida se cierra");
      await p.waitFor(`document.querySelectorAll(".xterm").length === 1`, "hay una terminal");
    },
  },
  {
    name: "clear-no-tapa-salida",
    async run(p) {
      // El `clear` de macOS manda ESC[3J antes de ESC[H ESC[2J: la tarjeta va tras el borrado,
      // nunca encima de lo que se imprime después. Y lo que limpia un programa (Vite) no la trae.
      const r = await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const s = useTerminalStore.getState();
        const id = s.tabs.find((t) => t.id === s.activeTabId)?.activePaneId;
        const term = terminalManager.getTerminal(id);
        const pane = document.querySelector('[data-pane-id="' + id + '"]');
        const recv = (t) => terminalManager.receiveForTesting(id, t);
        const settle = async () => { await new Promise((resolve) => term.write("", resolve)); await new Promise((r) => setTimeout(r, 250)); };
        const prompt = "\\x1b]133;D;0\\x07\\x1b]7;file://h/Users/x/Kiosko\\x07\\x1b]133;A\\x07jorge@mac Kiosko % ";
        const run = (cmd) => cmd + "\\r\\n\\x1b]633;E;" + cmd + "\\x07\\x1b]133;C\\x07";
        recv(prompt + run("ls"));
        for (let i = 0; i < 60; i++) recv("archivo-" + i + ".js\\r\\n");
        recv(prompt + run("clear") + "\\x1b[3J\\x1b[H\\x1b[2J" + prompt + run("seq 30"));
        for (let i = 0; i < 30; i++) recv("salida-" + i + "\\r\\n");
        recv(prompt);
        await settle();
        const b = term.buffer.active;
        const lines = [];
        for (let y = 0; y < b.length; y++) lines.push(b.getLine(y)?.translateToString(true) ?? "");
        // La decoración puede haber salido de la vista (xterm no la dibuja): se mide sobre el buffer.
        const card = terminalManager.instances.get(id).welcomeCard;
        const screen = pane.querySelector(".xterm-screen").getBoundingClientRect();
        const cell = screen.height / term.rows;
        const top = card ? card.marker.line : -1;
        const height = Math.ceil(156 / cell);
        const covered = card ? lines.slice(top, top + height).filter((l) => l.trim()) : [];
        const cleared = { card: Boolean(card), top, covered, oldInHistory: lines.some((l) => l.includes("archivo-")) };

        recv(prompt + run("npm run dev") + "\\x1b[2J\\x1b[3J\\x1b[H  VITE v6 listo\\r\\n");
        for (let i = 0; i < 5; i++) recv("  ➜ linea " + i + "\\r\\n");
        await settle();
        // El ESC[3J de Vite borra el historial (y con él la tarjeta vieja): lo que no debe haber es una nueva.
        const after = terminalManager.instances.get(id).welcomeCard;
        return { cleared, viteCard: after !== null && after !== card };`);
      await p.screenshot("clear-no-tapa-salida");
      if (!r.cleared.card) throw new Error("clear no puso la tarjeta");
      if (r.cleared.covered.length) throw new Error(`La tarjeta tapa salida: ${JSON.stringify(r.cleared.covered)}`);
      if (r.cleared.oldInHistory) throw new Error("clear dejó la pantalla anterior en el historial");
      if (r.viteCard) throw new Error("Vite trajo otra tarjeta encima de su salida");
    },
  },
  {
    name: "historial-largo",
    async run(p) {
      // Una salida más alta que el panel (un traceback largo) se recorre con la rueda.
      const before = await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const s = useTerminalStore.getState();
        const id = s.tabs.find((t) => t.id === s.activeTabId)?.activePaneId;
        const lines = Array.from({ length: 300 }, (_, i) => "linea " + (i + 1) + " del traceback").join("\\r\\n");
        terminalManager.receiveForTesting(id, lines + "\\r\\n% ");
        const term = terminalManager.getTerminal(id);
        await new Promise((resolve) => term.write("", resolve));
        await new Promise((r) => setTimeout(r, 100));
        return { id, baseY: term.buffer.active.baseY, viewportY: term.buffer.active.viewportY, rows: term.rows, length: term.buffer.active.length };`);
      if (before.baseY < 200) throw new Error(`El historial no guardó las líneas: ${JSON.stringify(before)}`);
      const pane = `[data-pane-id="${before.id}"] .xterm-screen`;
      for (let i = 0; i < 6; i++) await p.wheel(pane, -400);
      await new Promise((r) => setTimeout(r, 300));
      const after = await p.run(`
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const term = terminalManager.getTerminal(${JSON.stringify(before.id)});
        return { viewportY: term.buffer.active.viewportY, baseY: term.buffer.active.baseY };`);
      await p.screenshot("historial-largo");
      if (after.viewportY >= before.viewportY) throw new Error(`La rueda no subió por el historial: ${JSON.stringify({ before, after })}`);

      // Ctrl+L en zsh (ESC[H ESC[2J, sin ESC[3J) limpia la vista, no el historial: lo
      // que estaba en pantalla sube al scrollback, como en Terminal.app e iTerm2.
      const kept = await p.run(`
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const id = ${JSON.stringify(before.id)};
        const term = terminalManager.getTerminal(id);
        terminalManager.receiveForTesting(id, "\\r\\nfinal del traceback: Invalid username or password.\\r\\n% ");
        terminalManager.receiveForTesting(id, "\\x1b[H\\x1b[2J% mlx_lm.generate otra vez\\r\\n");
        await new Promise((resolve) => term.write("", resolve));
        const buffer = term.buffer.active;
        const text = [];
        for (let y = 0; y < buffer.length; y++) text.push(buffer.getLine(y)?.translateToString(true) ?? "");
        return { last: text.some((l) => l.includes("Invalid username or password.")), tail: text.some((l) => l.includes("linea 300 del traceback")) };`);
      if (!kept.last || !kept.tail) throw new Error(`Ctrl+L borró la salida en vez de subirla al historial: ${JSON.stringify(kept)}`);
    },
  },
  {
    name: "paleta",
    async run(p) {
      await p.shortcut("palette");
      await p.waitFor(`document.activeElement?.tagName === "INPUT"`, "la paleta enfoca su buscador");
      // Un solo cursor, sobre la opción activa, y que la sigue con las flechas.
      const cursorOnActive = `(() => {
        const cursor = document.querySelector(".prompt-cursor");
        const active = document.querySelector('[role="option"][aria-selected="true"]');
        if (!cursor || !active) return false;
        const [a, c] = [active.getBoundingClientRect(), cursor.getBoundingClientRect()];
        return Math.abs(a.top - c.top) < 1 && Math.abs(a.height - c.height) < 1 && document.querySelectorAll(".prompt-caret").length === 1;
      })()`;
      await p.waitFor(cursorOnActive, "el cursor está en la primera opción");
      await new Promise((r) => setTimeout(r, 250));
      await p.screenshot("paleta-cursor");
      await p.press("ArrowDown");
      await p.press("ArrowDown");
      await p.waitFor(cursorOnActive, "el cursor sigue a la opción activa");
      await p.run(`(await mod("/src/store/settingsStore.ts")).useSettingsStore.getState().update({ theme: "papel" });`);
      await p.waitFor(`document.documentElement.dataset.theme === "papel"`, "tema claro");
      await new Promise((r) => setTimeout(r, 250));
      await p.screenshot("paleta-cursor-papel");
      await p.run(`(await mod("/src/store/settingsStore.ts")).useSettingsStore.getState().update({ theme: "neon" });`);
      await p.type("dividir");
      await p.waitFor(`[...document.querySelectorAll('[role="option"]')].some((o) => o.textContent.includes("Dividir"))`, "aparece «Dividir»");
      await p.waitFor(cursorOnActive, "al filtrar, el cursor vuelve a la opción activa");
      await p.press("ArrowDown");
      await p.press("ArrowDown");
      await p.waitFor(cursorOnActive, "el cursor llega a una opción con pista");
      await new Promise((r) => setTimeout(r, 250));
      await p.screenshot("paleta-cursor-pista");
      await p.press("Escape");
      await p.waitFor(`!document.querySelector('[role="option"]')`, "Esc cierra la paleta");
    },
  },
  {
    name: "dividir-panel",
    async run(p) {
      await p.shortcut("splitRight");
      await p.waitFor(`document.querySelectorAll(".xterm").length === 2`, "⌘D deja dos terminales");
      await p.shortcut("closePane");
      await p.waitFor(`document.querySelectorAll(".xterm").length === 1`, "cerrar un panel deja uno");
    },
  },
  {
    name: "ajustes-tema",
    async run(p) {
      await p.shortcut("settings");
      await p.waitFor(`[...document.querySelectorAll("h2")].some((h) => h.textContent.includes("Ajustes"))`, "se abren los ajustes");
      await p.click("button", "Papel");
      await p.waitFor(`document.documentElement.dataset.theme === "papel"`, "el tema Papel se aplica");
      await p.click("button", "Fósforo");
      await p.waitFor(`!document.documentElement.dataset.theme`, "vuelve a Fósforo");
      await p.press("Escape");
    },
  },
  {
    name: "buscador-archivos",
    async run(p) {
      await p.run(`
        const { gitApi } = await mod("/src/lib/git.ts");
        const { useProjectStore } = await mod("/src/store/projectStore.ts");
        gitApi.files = async () => ["src/App.tsx", "src/lib/terminal-utils.ts", "src/terminal/TerminalManager.ts", "README.md"];
        useProjectStore.setState({ cwd: "/repo-e2e" });`);
      await p.shortcut("fileFinder");
      await p.waitFor(`document.querySelectorAll('#finder-results [role="option"]').length === 4`, "lista los archivos");
      await p.type("tm");
      await p.waitFor(`document.querySelector('#finder-results [role="option"]')?.textContent.includes("TerminalManager")`, "«tm» pone TerminalManager primero");
      await p.press("ArrowDown");
      await p.waitFor(`(() => {
        const cursor = document.querySelector("#finder-results .prompt-cursor");
        const active = document.querySelector('#finder-results [aria-selected="true"]');
        return cursor && active && Math.abs(cursor.getBoundingClientRect().top - active.getBoundingClientRect().top) < 1;
      })()`, "el cursor sigue al archivo activo");
      await new Promise((r) => setTimeout(r, 250));
      await p.screenshot("buscador-cursor");
      await p.press("Escape");
      await p.waitFor(`!document.querySelector("#finder-results")`, "Esc cierra el buscador");
    },
  },
  {
    name: "resolver-conflicto",
    async run(p) {
      await p.run(`
        const { gitApi } = await mod("/src/lib/git.ts");
        const { useProjectStore } = await mod("/src/store/projectStore.ts");
        const project = await mod("/src/lib/project.ts");
        window.__saved = null;
        gitApi.read = async (_root, path) => ({ text: ${JSON.stringify(CONFLICT)}, size: 120, truncated: false, binary: false, absolute: "/repo-e2e/" + path });
        gitApi.resolveConflict = async (_root, path, content) => { window.__saved = { path, content }; };
        gitApi.status = async () => ({ branch: "main", head: "abc123456789", upstream: null, ahead: 0, behind: 0, changes: [], operation: null });
        useProjectStore.setState({ repo: { root: "/repo-e2e", name: "repo", remoteUrl: null, webUrl: null, host: "other", defaultBranch: "main" } });
        await project.openConflict("src/pagina.ts");`);
      await p.waitFor(`document.querySelectorAll('section[aria-label^="Conflicto"]').length === 2`, "muestra los dos bloques");
      await p.waitFor(`[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Guardar y marcar resuelto"))?.disabled`, "guardar empieza deshabilitado");
      await p.evaluate(`(() => {
        const pick = (section, label) => [...document.querySelectorAll('section[aria-label="' + section + '"] button')].find((b) => b.textContent === label).click();
        pick("Conflicto 1", "Aceptar entrante");
        pick("Conflicto 2", "Ambos");
        return true;
      })()`);
      await p.click("button", "Guardar y marcar resuelto");
      const saved = await p.waitFor(`window.__saved`, "se guarda el resultado");
      const expected = "const a = 1;\nexport const PAGE = 25;\nconst b = 2;\nuno();\ndos();\n";
      if (saved.content !== expected) throw new Error(`Contenido resuelto inesperado: ${JSON.stringify(saved.content)}`);
    },
  },
  {
    name: "imagen",
    async run(p) {
      await p.run(`
        const { gitApi } = await mod("/src/lib/git.ts");
        const { useProjectStore } = await mod("/src/store/projectStore.ts");
        const project = await mod("/src/lib/project.ts");
        // Un PNG real de 40×24 dibujado en la página.
        const canvas = document.createElement("canvas");
        canvas.width = 40; canvas.height = 24;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffb224"; ctx.fillRect(0, 0, 40, 24);
        const png = await new Promise((r) => canvas.toBlob(r, "image/png"));
        const bytes = await png.arrayBuffer();
        gitApi.readImage = async () => bytes;
        useProjectStore.setState({ cwd: "/repo-e2e", repo: null });
        await project.openFile("assets/logo.png");`);
      await p.waitFor(`document.querySelector('[data-viewer] img')?.naturalWidth === 40`, "la imagen se dibuja");
      await p.waitFor(`document.querySelector('[data-viewer]').textContent.includes("40×24")`, "muestra sus dimensiones");
      await p.press("Escape");
      await p.waitFor(`!document.querySelector("[data-viewer]")`, "Esc cierra la imagen");
    },
  },
  {
    name: "editar-y-guardar",
    async run(p) {
      await p.run(`
        const { gitApi } = await mod("/src/lib/git.ts");
        const { useProjectStore } = await mod("/src/store/projectStore.ts");
        const project = await mod("/src/lib/project.ts");
        useProjectStore.setState({ cwd: "/repo-e2e", repo: null });
        window.__writes = [];
        window.__failNext = false;
        gitApi.read = async (_root, path) => ({ text: "export const a = 1;\\n", size: 20, truncated: false, binary: false, utf8: true, version: "v1", absolute: "/repo-e2e/" + path });
        gitApi.fileVersion = async () => window.__writes.length ? "v" + (window.__writes.length + 1) : "v1";
        gitApi.writeFile = async (_root, _path, content, expected) => {
          if (window.__failNext) { window.__failNext = false; throw new Error("El archivo cambió en disco desde que lo abriste."); }
          window.__writes.push({ content, expected });
          return "v" + (window.__writes.length + 1);
        };
        await project.openFile("src/notas.ts");`);
      await p.waitFor(`document.querySelector("[data-viewer] .cm-content")`, "el editor se abre");
      await p.evaluate(`document.querySelector("[data-viewer] .cm-content").focus(), true`);
      await p.type("// hola\n");
      await p.waitFor(`document.querySelector("[data-viewer]").textContent.includes("Sin guardar")`, "marca cambios sin guardar");
      await p.pressMod("s");
      const first = await p.waitFor(`window.__writes[0]`, "⌘S guarda");
      if (first.content !== "// hola\nexport const a = 1;\n" || first.expected !== "v1") {
        throw new Error(`Guardado inesperado: ${JSON.stringify(first)}`);
      }
      await p.waitFor(`!document.querySelector("[data-viewer]").textContent.includes("Sin guardar")`, "queda guardado");

      // Alguien más cambió el archivo: no se pisa sin preguntar.
      await p.evaluate(`window.__failNext = true`);
      await p.type("x");
      await p.pressMod("s");
      await p.waitFor(`document.querySelector('[data-viewer] [role="alert"]')?.textContent.includes("cambió en disco")`, "avisa del cambio en disco");
      await p.click("[data-viewer] button", "Sobrescribir con lo mío");
      const forced = await p.waitFor(`window.__writes[1]`, "sobrescribe a sabiendas");
      if (forced.expected !== null) throw new Error("Sobrescribir debe ignorar la versión");

      // Esc con cambios: pregunta antes de cerrar.
      await p.type("y");
      await p.press("Escape");
      await p.waitFor(`[...document.querySelectorAll("button")].some((b) => b.textContent.includes("Descartar cambios"))`, "pide confirmar");
      await p.click("button", "Descartar cambios");
      await p.waitFor(`!document.querySelector("[data-viewer]")`, "se cierra tras confirmar");
    },
  },
  {
    name: "vista-general",
    async run(p) {
      await p.shortcut("newTab");
      await p.waitFor(`document.querySelectorAll("header li, [aria-current]").length > 0`, "hay pestañas");
      await p.shortcut("overview");
      await p.waitFor(`document.querySelectorAll('[aria-label="Paneles"] [role="option"]').length >= 2`, "muestra un panel por terminal");
      await p.press("Escape");
      await p.waitFor(`!document.querySelector('[aria-label="Todos los paneles"]')`, "Esc la cierra");
    },
  },
  {
    name: "mission-control-vacio",
    async run(p) {
      await p.shortcut("missionControl");
      await p.waitFor(`document.body.textContent.includes("No hay agentes abiertos.")`, "estado vacío de agentes");
      await p.press("Escape");
      await p.waitFor(`!document.querySelector('[aria-label="Mission Control de agentes"]')`, "Esc lo cierra");
    },
  },
  // Desde aquí hay agentes abiertos: las pruebas que necesitan cero agentes van antes.
  {
    name: "reanudar-agente",
    async run(p) {
      await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const pane = { id: "pane-resume", type: "pane", terminalId: "term-resume", title: "app", cwd: "/repo-e2e",
          resumable: { agent: "claude", sessionId: "${SESSION}", title: "Claude Code", prompt: "Agrega paginación", at: Date.now() - 2 * 3600e3 } };
        const tab = { id: "tab-resume", title: "Terminal", activePaneId: pane.id, root: pane };
        useTerminalStore.setState((s) => ({
          tabs: [...s.tabs, tab],
          activeTabId: tab.id,
          agents: { claude: "/bin/claude", codex: null, gh: null, editors: [], claudeSettingsPath: "/s/claude-settings.json", mcpConfigPath: null },
        }));`);
      await p.waitFor(`document.querySelector('[data-pane-id="pane-resume"] [role="status"]')?.textContent.includes("«Agrega paginación»")`, "el panel restaurado ofrece reanudar");
      await p.waitFor(`document.querySelector('[data-pane-id="pane-resume"]').textContent.includes("hace 2 h")`, "dice hace cuánto");
      // Lo que importa es con qué se arranca el terminal (antes el store decía "claude" y se lanzaba una shell).
      await p.run(`
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        window.__spawned = [];
        const attach = terminalManager.attach.bind(terminalManager);
        terminalManager.attach = (id, el, spec) => { window.__spawned.push({ id, command: spec.command ?? null }); return attach(id, el, spec); };`);
      await p.click('[data-pane-id="pane-resume"] button', "Reanudar conversación");
      const spawned = await p.waitFor(`window.__spawned.find((s) => s.id !== "pane-resume")`, "el panel nuevo se monta");
      if (spawned.command !== `claude --settings '/s/claude-settings.json' --resume '${SESSION}'`) throw new Error(`Se arrancó con: ${spawned.command}`);
      const resumed = await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { collectPanes } = await mod("/src/lib/layout.ts");
        for (let i = 0; i < 50; i++) {
          const pane = useTerminalStore.getState().tabs.flatMap((t) => collectPanes(t.root)).find((p) => p.agentType === "claude");
          if (pane) return pane.command;
          await new Promise((r) => setTimeout(r, 40));
        }
        return null;`);
      if (resumed !== `claude --settings '/s/claude-settings.json' --resume '${SESSION}'`) throw new Error(`Comando inesperado: ${resumed}`);
      await p.waitFor(`!document.querySelector('[data-pane-id="pane-resume"]')`, "el panel de shell se reemplazó por el agente");
    },
  },
  {
    name: "bandeja-permisos",
    async run(p) {
      await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { useApprovalStore } = await mod("/src/store/approvalStore.ts");
        const { collectPanes } = await mod("/src/lib/layout.ts");
        const { ipc } = await mod("/src/lib/ipc.ts");
        const agent = useTerminalStore.getState().tabs.flatMap((t) => collectPanes(t.root)).find((p) => p.agentType === "claude");
        window.__decisions = [];
        ipc.approvalDecide = async (id, decision, message) => { window.__decisions.push({ id, decision, message }); };
        // Estás en otra pestaña: la pregunta llega a la bandeja, no al panel.
        await (await mod("/src/lib/actions.ts")).actions.newTab();
        // La terminal nueva toma el foco en un frame: se espera a que lo tenga.
        const activePane = () => { const s = useTerminalStore.getState(); return s.tabs.find((t) => t.id === s.activeTabId)?.activePaneId; };
        const focusedPane = () => document.activeElement?.closest("[data-pane-id]")?.dataset.paneId;
        for (let i = 0; i < 75 && focusedPane() !== activePane(); i++) await new Promise((r) => setTimeout(r, 40));
        if (focusedPane() !== activePane()) throw new Error("la terminal nueva nunca tomó el foco");
        window.__focusBefore = document.activeElement;
        useApprovalStore.getState().add({ id: "ap-e2e", paneId: agent.id, tool: "Bash", input: { command: "pnpm add zod", description: "Instala zod" }, cwd: "/repo-e2e", at: Date.now(), expiresAt: Date.now() + 90000 });`);
      await p.waitFor(`document.querySelector('[aria-label="Permisos pendientes"]')?.textContent.includes("pnpm add zod")`, "la bandeja muestra el comando completo");
      await p.waitFor(`document.activeElement === window.__focusBefore`, "la bandeja no roba el foco");
      await p.waitFor(`[...document.querySelectorAll("footer button")].some((b) => b.textContent.includes("1 te necesita"))`, "la barra de estado cuenta al agente bloqueado");
      await p.click('[aria-label="Permisos pendientes"] button', "Denegar…");
      await p.waitFor(`document.activeElement?.getAttribute("aria-label") === "Motivo de la negativa"`, "pide el motivo");
      await p.type("usa npm no, pnpm sí");
      // CDP manda rawKeyDown sin «char»: Chrome no hace el envío implícito del formulario con Enter.
      await p.click('[aria-label="Permisos pendientes"] form button[type="submit"]');
      const decision = await p.waitFor(`window.__decisions[0]`, "la decisión llega al backend");
      if (decision.decision !== "deny" || decision.message !== "usa npm no, pnpm sí") throw new Error(`Decisión inesperada: ${JSON.stringify(decision)}`);
      await p.waitFor(`!document.querySelector('[aria-label="Permisos pendientes"]')`, "la bandeja se vacía");
    },
  },
  {
    name: "al-que-te-necesita",
    async run(p) {
      const agentPane = await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { collectPanes } = await mod("/src/lib/layout.ts");
        const agent = useTerminalStore.getState().tabs.flatMap((t) => collectPanes(t.root)).find((p) => p.agentType === "claude");
        useTerminalStore.getState().setAttention(agent.id, { kind: "needs-input", message: "", at: Date.now() });
        return agent.id;`);
      await p.shortcut("nextAttention");
      const active = await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const activePane = () => { const s = useTerminalStore.getState(); return s.tabs.find((t) => t.id === s.activeTabId)?.activePaneId; };
        for (let i = 0; i < 50 && activePane() !== ${JSON.stringify(agentPane)}; i++) await new Promise((r) => setTimeout(r, 40));
        return activePane();`);
      if (active !== agentPane) throw new Error(`⌘J no llevó al agente (activo: ${active})`);
      const cleared = await p.run(`return !((await mod("/src/store/terminalStore.ts")).useTerminalStore.getState().attention[${JSON.stringify(agentPane)}]);`);
      if (!cleared) throw new Error("La marca de atención debió quitarse al llegar");
    },
  },
  {
    name: "estado-agentes-osc",
    async run(p) {
      // Un `claude` escrito a mano en una shell: se anuncia por OSC 7501 y su estado
      // manda (antes, una marca "te necesita" vieja ganaba y nunca se iba).
      const id = await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        await (await mod("/src/lib/actions.ts")).actions.newTab();
        const s = useTerminalStore.getState();
        const id = s.tabs.find((t) => t.id === s.activeTabId).activePaneId;
        const focused = () => document.activeElement?.closest("[data-pane-id]")?.dataset.paneId;
        for (let i = 0; i < 75 && (focused() !== id || !terminalManager.getTerminal(id)); i++) await new Promise((r) => setTimeout(r, 40));
        if (focused() !== id) throw new Error("la terminal nueva nunca tomó el foco");
        return id;`);
      const helpers = `
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const id = ${JSON.stringify(id)};
        const inst = terminalManager.instances.get(id);
        const flush = () => new Promise((resolve) => inst.term.write("", resolve));
        const b64 = (t) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
        const osc = (body) => terminalManager.receiveForTesting(id, "\\x1b]7501;" + body + "\\x1b\\\\");
        const writes = () => inst.pendingInput.map((w) => w.args.data);`;

      // La consulta se contesta antes que la de `CSI c` que el programa manda detrás.
      const replies = await p.run(`${helpers}
        inst.pendingInput.length = 0;
        terminalManager.receiveForTesting(id, "\\x1b]7501;?\\x1b\\\\\\x1b[c");
        await flush();
        return writes();`);
      if (replies[0] !== "\x1b]7501;?\x1b\\" || !replies[1]?.startsWith("\x1b[?")) throw new Error(`Respuestas: ${JSON.stringify(replies)}`);

      await p.run(`${helpers}
        useTerminalStore.getState().setAttention(id, { kind: "needs-input", message: "", at: Date.now() });
        osc("state=working:app=claude-code:msg=" + b64("Editando schema.ts"));
        await flush();`);
      const settled = await p.run(`${helpers} return !useTerminalStore.getState().attention[id];`);
      if (!settled) throw new Error("La marca 'te necesita' siguió aunque el agente ya trabajaba");

      await p.shortcut("missionControl");
      const card = `[...document.querySelectorAll('[aria-label="Mission Control de agentes"] article')].find((a) => a.textContent.includes("Editando schema.ts"))`;
      await p.waitFor(`${card}?.textContent.includes("Trabajando")`, "Mission Control lista al agente escrito a mano, trabajando");
      await p.run(`${helpers} osc("state=blocked:kind=permission:app=claude-code:msg=" + b64("Bash: pnpm add zod")); await flush();`);
      await p.waitFor(`[...document.querySelectorAll('[aria-label="Mission Control de agentes"] article')].some((a) => a.textContent.includes("Te necesita") && a.textContent.includes("pnpm add zod"))`, "pasa a te necesita");
      await p.run(`${helpers} osc("state=done:app=claude-code:msg=" + b64("Listo: paginación agregada")); await flush();`);
      await p.waitFor(`[...document.querySelectorAll('[aria-label="Mission Control de agentes"] article')].some((a) => a.textContent.includes("Esperando instrucciones") && a.textContent.includes("paginación agregada"))`, "al terminar espera instrucciones");
      await p.screenshot("estado-agentes-osc");
      // Mission Control tapa todo: nada de las terminales (p. ej. la tarjeta de bienvenida) queda
      // encima. Los avisos (toasts) sí van sobre todo, a propósito.
      const leaks = await p.run(`
        const dialog = document.querySelector('[aria-label="Mission Control de agentes"]');
        const out = [];
        for (let x = 20; x < innerWidth; x += 60) for (let y = 20; y < innerHeight; y += 60) {
          const el = document.elementFromPoint(x, y);
          if (el && !dialog.contains(el) && !el.closest('[role="status"], [role="alert"]')) out.push(x + "," + y + " " + (el.className?.toString?.() ?? el.tagName).slice(0, 60));
        }
        return out.slice(0, 8);`);
      if (leaks.length) throw new Error(`Algo se ve por encima de Mission Control: ${JSON.stringify(leaks)}`);
      await p.press("Escape");
      await p.waitFor(`!document.querySelector('[aria-label="Mission Control de agentes"]')`, "Esc cierra Mission Control");
      await p.run(`
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const id = ${JSON.stringify(id)};
        const focused = () => document.activeElement?.closest("[data-pane-id]")?.dataset.paneId;
        terminalManager.focus(id);
        for (let i = 0; i < 50 && focused() !== id; i++) await new Promise((r) => setTimeout(r, 40));`);

      // Shift+Enter: salto de línea (Ctrl+J) para el agente; Enter normal en la shell.
      await p.run(`${helpers} inst.pendingInput.length = 0;`);
      await p.press("Enter", 8);
      const agentKeys = await p.run(`${helpers} await new Promise((r) => setTimeout(r, 100)); return writes();`);
      if (JSON.stringify(agentKeys) !== JSON.stringify(["\n"])) throw new Error(`Shift+Enter en el agente mandó ${JSON.stringify(agentKeys)}`);
      await p.run(`${helpers} osc("state=clear"); await flush(); inst.pendingInput.length = 0;`);
      await p.press("Enter", 8);
      const shellKeys = await p.run(`${helpers} await new Promise((r) => setTimeout(r, 100)); return writes();`);
      if (JSON.stringify(shellKeys) !== JSON.stringify(["\r"])) throw new Error(`Shift+Enter en la shell mandó ${JSON.stringify(shellKeys)}`);
      const gone = await p.run(`${helpers} return !useTerminalStore.getState().agentActivity[id];`);
      if (!gone) throw new Error("Tras `clear` el panel debía dejar de contar como agente");
      // Si el agente muere sin `clear`, el siguiente prompt de la shell lo da por ido.
      const afterCrash = await p.run(`${helpers}
        osc("state=working:app=claude-code");
        await flush();
        const before = useTerminalStore.getState().agentActivity[id]?.state;
        terminalManager.receiveForTesting(id, "\\x1b]133;A\\x07% ");
        await flush();
        return { before, after: useTerminalStore.getState().agentActivity[id]?.state ?? null };`);
      if (afterCrash.before !== "working" || afterCrash.after !== null) throw new Error(`Tras el prompt: ${JSON.stringify(afterCrash)}`);
    },
  },
  {
    name: "raton-tras-ssh-caido",
    async run(p) {
      // Claude Code (o vim) del otro lado de un ssh activa el ratón; la conexión se corta y nadie
      // lo apaga: cada movimiento escribía `35;88;22M…` en el prompt. El prompt lo apaga.
      const r = await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const s = useTerminalStore.getState();
        const id = s.tabs.find((t) => t.id === s.activeTabId).activePaneId;
        const term = terminalManager.getTerminal(id);
        const flush = () => new Promise((resolve) => term.write("", resolve));
        const recv = (t) => terminalManager.receiveForTesting(id, t);
        recv("\\x1b]133;C\\x07\\x1b[?1003h\\x1b[?1006h\\x1b[?1004h\\x1b[?25l");
        await flush();
        const during = { mouse: term.modes.mouseTrackingMode, focus: term.modes.sendFocusMode };
        recv("\\r\\nclient_loop: send disconnect: Broken pipe\\r\\n\\x1b]133;D;255\\x07\\x1b]133;A\\x07% ");
        await flush();
        await flush();
        return { during, after: { mouse: term.modes.mouseTrackingMode, focus: term.modes.sendFocusMode } };`);
      if (r.during.mouse !== "any" || !r.during.focus) throw new Error(`El programa no activó el ratón: ${JSON.stringify(r)}`);
      if (r.after.mouse !== "none" || r.after.focus) throw new Error(`El ratón siguió activo en el prompt: ${JSON.stringify(r)}`);
    },
  },
  {
    name: "revision-al-agente",
    async run(p) {
      await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { useProjectStore } = await mod("/src/store/projectStore.ts");
        const { collectPanes } = await mod("/src/lib/layout.ts");
        const { gitApi } = await mod("/src/lib/git.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const project = await mod("/src/lib/project.ts");
        const agent = useTerminalStore.getState().tabs.flatMap((t) => collectPanes(t.root)).find((p) => p.agentType === "claude");
        window.__agent = agent.id;
        window.__pasted = null;
        terminalManager.paste = (id, text) => { window.__pasted = { id, text }; };
        gitApi.reviewDiff = async () => ({ text: ${JSON.stringify(REVIEW_DIFF)}, truncated: false });
        useProjectStore.setState({ repo: { root: "/repo-e2e", name: "repo", remoteUrl: null, webUrl: null, host: "other", defaultBranch: "main" } });
        await project.openDiff({ kind: "review", base: "abc123", path: "src/pagina.ts", origPath: null, created: false, root: "/repo-e2e", label: "desde tu último mensaje", paneId: agent.id });`);
      await p.waitFor(`document.querySelector('[data-viewer] button[aria-label="Comentar la línea 2"]')`, "cada línea se puede comentar");
      await p.click('[data-viewer] button[aria-label="Comentar la línea 2"]');
      await p.waitFor(`document.activeElement?.getAttribute("aria-label") === "Comentario para el agente"`, "se abre el campo del comentario");
      await p.type("Usa la constante de config.");
      await p.pressMod("Enter");
      await p.waitFor(`[...document.querySelectorAll("[data-viewer] button")].some((b) => b.textContent.includes("Enviar revisión (1)"))`, "el comentario queda pendiente");
      await p.click("[data-viewer] button", "Enviar revisión (1)");
      const pasted = await p.waitFor(`window.__pasted`, "la revisión se pega en el agente");
      const agent = await p.evaluate(`window.__agent`);
      const expected = "Revisé tus cambios. Atiende este comentario:\n\n1. src/pagina.ts:2\n   > export const PAGE = 50;\n   Usa la constante de config.\n";
      if (pasted.id !== agent || pasted.text !== expected) throw new Error(`Pegado inesperado: ${JSON.stringify(pasted)}`);
      await p.waitFor(`!document.querySelector("[data-viewer]")`, "el visor se cierra para que mandes el mensaje");
    },
  },
  {
    name: "barra-lateral",
    async run(p) {
      // Sin backend: el sistema, la carpeta del panel y las carpetas recientes se inyectan.
      await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { useSidebarStore } = await mod("/src/store/sidebarStore.ts");
        const { useSystemStore } = await mod("/src/lib/system.ts");
        const s = useTerminalStore.getState();
        if (!s.isSidebarOpen) s.toggleSidebar();
        const id = s.tabs.find((t) => t.id === s.activeTabId)?.activePaneId;
        s.setPaneProject(id, { cwd: "/Users/e2e/dev/termCode/src", name: "termCode", root: "/Users/e2e/dev/termCode" });
        useSidebarStore.getState().hydrate({ recent: [{ path: "/Users/e2e/dev/termCode", at: 2 }, { path: "/Users/e2e/dev/kiosko", at: 1 }], pinned: ["/Users/e2e/dev/kiosko"], collapsed: {} });
        const GB = 1024 ** 3;
        for (let i = 0; i < 30; i++) {
          useSystemStore.getState().push({ cpuPercent: 20 + (i % 7) * 6, cpuCount: 10, memoryUsed: 11.2 * GB, memoryTotal: 16 * GB, swapUsed: 0, swapTotal: 0, memoryPressure: i > 25 ? "warn" : "normal", gpuPercent: i > 20 ? 85 : 4, gpuMemory: 2 * GB, top: [{ pid: 7, name: "Python", cpuPercent: 98.4, memory: 9.6 * GB }, { pid: 9, name: "termCode", cpuPercent: 3, memory: 0.4 * GB }] });
        }`);
      await p.waitFor(`document.querySelector('aside[aria-label="Sesiones"] [aria-current="page"]')?.textContent.includes("termCode / src")`, "la sesión dice en qué carpeta está");
      await p.waitFor(`document.querySelector('section[aria-label="Carpetas"]')?.textContent.includes("kiosko")`, "las carpetas recientes y fijadas aparecen");
      await p.waitFor(`document.querySelector('section[aria-label="Sistema"]')?.textContent.includes("presión alta")`, "el sistema muestra CPU, GPU, RAM y su presión");
      const text = await p.evaluate(`document.querySelector('section[aria-label="Sistema"]').textContent`);
      if (!/CPU/.test(text) || !/GPU/.test(text) || !/11\.2 \/ 16 GB/.test(text) || !/Python/.test(text)) throw new Error(`Sistema incompleto: ${text}`);
      await p.screenshot("barra-lateral");
      // Plegar recuerda el estado y deja de medir (la sección no se monta).
      await p.click('section[aria-label="Sistema"] button[aria-expanded]');
      await p.waitFor(`!document.querySelector('section[aria-label="Sistema"]').textContent.includes("RAM")`, "la sección se pliega");
      await p.click('section[aria-label="Sistema"] button[aria-expanded]');
      await p.run(`(await mod("/src/store/terminalStore.ts")).useTerminalStore.getState().toggleSidebar();`);
    },
  },
  {
    name: "proyecto-riel",
    async run(p) {
      await p.waitFor(`document.querySelector('aside[aria-label="Proyecto"]')`, "el panel de proyecto empieza abierto");
      await p.click('aside[aria-label="Proyecto"] button[aria-label="Plegar panel de proyecto"]');
      await p.waitFor(`document.querySelector('aside[aria-label="Proyecto (plegado)"]')`, "plegado queda el riel");
      await p.screenshot("proyecto-riel");
      await p.click('aside[aria-label="Proyecto (plegado)"] button[aria-label="Cambios"]');
      await p.waitFor(`document.querySelector('aside[aria-label="Proyecto"] [role="tab"][aria-selected="true"]')?.textContent.includes("Cambios")`, "el riel abre la vista elegida");
      await p.click('aside[aria-label="Proyecto"] [role="tab"]', "Archivos");
    },
  },
  {
    name: "doble-clic-cd",
    async run(p) {
      // Una shell propia: las pruebas anteriores pueden dejar un agente en el panel activo.
      const tabs = await p.run(`return (await mod("/src/store/terminalStore.ts")).useTerminalStore.getState().tabs.length;`);
      await p.shortcut("newTab");
      await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        for (let i = 0; i < 50 && useTerminalStore.getState().tabs.length === ${tabs}; i++) await new Promise((r) => setTimeout(r, 40));`);
      await p.run(`
        const { gitApi } = await mod("/src/lib/git.ts");
        const { useProjectStore } = await mod("/src/store/projectStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const entry = (name, isDir) => ({ name, path: name, isDir, size: 0, ignored: false });
        gitApi.list = async (_root, path) => (path === "" ? [entry("src", true), entry("README.md", false)] : []);
        window.__sent = [];
        window.__restore = { info: terminalManager.info, run: terminalManager.run };
        terminalManager.info = async () => ({ shellPid: 1, foregroundPid: 1, foregroundName: "zsh", cwd: "/Users/e2e/repo", busy: false });
        terminalManager.run = (id, line) => window.__sent.push(line);
        useProjectStore.setState({ isOpen: true, tab: "files", cwd: "/Users/e2e/repo", repo: { root: "/Users/e2e/repo", name: "repo", remoteUrl: null, webUrl: null, host: "other", defaultBranch: "main" }, tree: {}, expanded: {} });`);
      await p.waitFor(`[...document.querySelectorAll('[role="tree"] button')].some((b) => b.textContent.includes("src"))`, "el árbol muestra la carpeta");
      await p.dblclick('[role="tree"] button', "src");
      const sent = await p.waitFor(`window.__sent.length && window.__sent`, "el doble clic hace cd en la terminal");
      if (sent[0] !== "\x05\x15cd '/Users/e2e/repo/src'") throw new Error(`cd inesperado: ${JSON.stringify(sent)}`);
      const expanded = await p.evaluate(`[...document.querySelectorAll('[role="treeitem"]')].find((li) => li.textContent.includes("src"))?.getAttribute("aria-expanded")`);
      if (expanded !== "true") throw new Error(`El doble clic dejó la carpeta plegada (aria-expanded=${expanded})`);

      // Migas de pan: el tramo de arriba lleva ahí; con algo corriendo, se abre una pestaña en vez de teclear.
      await p.run(`
        const { useProjectStore } = await mod("/src/store/projectStore.ts");
        useProjectStore.setState({ cwd: "/Users/e2e/repo/src" });`);
      await p.waitFor(`document.querySelector('nav[aria-label="Carpeta de la terminal"]')?.textContent.includes("src")`, "las migas muestran la carpeta");
      await p.click('nav[aria-label="Carpeta de la terminal"] button', "repo");
      await p.waitFor(`window.__sent.length === 2`, "la miga hace cd");
      const tabsBefore = await p.run(`return (await mod("/src/store/terminalStore.ts")).useTerminalStore.getState().tabs.length;`);
      await p.run(`
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        terminalManager.info = async () => ({ shellPid: 1, foregroundPid: 2, foregroundName: "vim", cwd: "/Users/e2e/repo", busy: true });`);
      await p.dblclick('[role="tree"] button', "src");
      await p.waitFor(`document.body.textContent.includes("vim sigue corriendo")`, "avisa que no tecleó encima de vim");
      const after = await p.run(`return { tabs: (await mod("/src/store/terminalStore.ts")).useTerminalStore.getState().tabs.length, sent: window.__sent.length };`);
      if (after.tabs !== tabsBefore + 1 || after.sent !== 2) throw new Error(`Con vim corriendo no debía teclear: ${JSON.stringify({ tabsBefore, after })}`);
      await p.screenshot("doble-clic-cd");
      await p.run(`
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        Object.assign(terminalManager, window.__restore);
        const { useProjectStore } = await mod("/src/store/projectStore.ts");
        useProjectStore.setState({ cwd: null, repo: null, tree: {}, expanded: {} });`);
      // La pestaña que abrió el aviso de vim y la shell de esta prueba.
      await p.shortcut("closePane");
      await p.shortcut("closePane");
    },
  },
  {
    name: "detalle-sistema",
    async run(p) {
      await p.run(`
        const { useSystemStore } = await mod("/src/lib/system.ts");
        const GB = 1024 ** 3;
        for (let i = 0; i < 20; i++) useSystemStore.getState().push({ cpuPercent: 30 + i, cpuCount: 8, cpuCores: [90, 10, 20, 5, 70, 40, 15, 2], loadAverage: [2.1, 1.8, 1.5], uptimeSecs: 93784, memoryUsed: 12 * GB, memoryTotal: 16 * GB, memoryAvailable: 4 * GB, swapUsed: GB, swapTotal: 4 * GB, memoryPressure: "warn", gpuPercent: 55, gpuMemory: 3 * GB, top: [] });`);
      await p.waitFor(`document.querySelector("[data-system-trigger]")`, "la barra de estado muestra el sistema");
      await p.click("footer [data-system-trigger]");
      await p.waitFor(`document.querySelector('[role="dialog"][aria-label="Detalle del sistema"]')`, "el clic abre el detalle");
      const text = await p.evaluate(`document.querySelector('[aria-label="Detalle del sistema"]').textContent`);
      for (const want of ["8 núcleos", "encendido hace 1 d 2 h", "carga 2.10 · 1.80 · 1.50", "presión alta", "disponible 4.0 GB"]) {
        if (!text.includes(want)) throw new Error(`Falta «${want}» en el detalle: ${text}`);
      }
      const cores = await p.evaluate(`document.querySelectorAll('[aria-label^="Uso por núcleo"] > span').length`);
      if (cores !== 8) throw new Error(`Se esperaban 8 núcleos, hay ${cores}`);
      await p.screenshot("detalle-sistema");
      await p.press("Escape");
      await p.waitFor(`!document.querySelector('[aria-label="Detalle del sistema"]')`, "Esc lo cierra");
    },
  },
  {
    name: "terminal-del-agente",
    async run(p) {
      // Un panel de agente (sin backend no corre nada; el layout es lo que se prueba).
      await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        useTerminalStore.getState().createTab({ title: "Claude Code", agentType: "claude", command: "claude", cwd: "/Users/e2e/repo" });`);
      await p.waitFor(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "terminal")`, "el agente ofrece su terminal");
      await p.shortcut("agentShell");
      await p.waitFor(`document.querySelector('section[aria-label="Terminal acoplada"] .xterm')`, "⌘L abre la terminal acoplada con su xterm");
      const layout = await p.evaluate(`(() => {
        const pane = [...document.querySelectorAll("[data-pane-id]")].find((el) => el.offsetParent !== null);
        const drawer = pane.querySelector('section[aria-label="Terminal acoplada"]').getBoundingClientRect();
        const agent = pane.querySelector(".xterm").getBoundingClientRect();
        return { drawerTop: drawer.top, agentBottom: agent.bottom, ratio: drawer.height / pane.getBoundingClientRect().height, panes: document.querySelectorAll("[data-pane-id]").length };
      })()`);
      if (layout.agentBottom > layout.drawerTop + 1) throw new Error(`La terminal tapa al agente: ${JSON.stringify(layout)}`);
      if (layout.ratio < 0.2 || layout.ratio > 0.5) throw new Error(`Alto inesperado de la terminal: ${JSON.stringify(layout)}`);
      await p.screenshot("terminal-del-agente");
      // Plegar deja la barra (la shell sigue viva) y no divide el panel.
      await p.click('section[aria-label="Terminal acoplada"] button[aria-label="Plegar la terminal"]');
      await p.waitFor(`!document.querySelector('section[aria-label="Terminal acoplada"]') && document.querySelector("[data-drawer] button[aria-label='Mostrar la terminal']")`, "plegada queda la barra");
      await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const s = useTerminalStore.getState();
        const tab = s.tabs.find((t) => t.id === s.activeTabId);
        const pane = tab.root;
        if (!terminalManager.getTerminal(pane.drawer.id)) throw new Error("plegar mató la shell acoplada");
        s.closeTab(tab.id);
        if (terminalManager.getTerminal(pane.drawer.id)) throw new Error("cerrar el agente dejó viva su shell acoplada");`);
    },
  },
  {
    name: "salida-en-el-visor",
    async run(p) {
      await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const s = useTerminalStore.getState();
        const id = s.tabs.find((t) => t.id === s.activeTabId)?.activePaneId;
        const term = terminalManager.getTerminal(id);
        const recv = (t) => terminalManager.receiveForTesting(id, t);
        recv("\\x1b]133;A\\x07% pnpm test\\r\\n\\x1b]633;E;pnpm test\\x07\\x1b]133;C\\x07");
        for (let i = 0; i < 400; i++) recv("linea " + i + " de la salida\\r\\n");
        recv("FAIL src/a.test.ts\\r\\n\\x1b]133;D;1\\x07\\x1b]133;A\\x07% ");
        await new Promise((resolve) => term.write("", resolve));`);
      await p.waitFor(`[...document.querySelectorAll("footer button")].some((b) => b.textContent.includes("Explicar"))`, "un ✗ ofrece explicarse");
      await p.click("footer button", "pnpm test");
      await p.waitFor(`document.querySelector('[data-viewer] .cm-content')`, "la salida se abre en el visor");
      const viewer = await p.evaluate(`(() => {
        const v = document.querySelector("[data-viewer]");
        return { header: v.textContent.slice(0, 200), lines: v.querySelector(".cm-content").cmView?.view?.state.doc.lines ?? null, text: v.textContent };
      })()`);
      if (!viewer.header.includes("código 1") || !viewer.text.includes("Explicar este error")) throw new Error(`Encabezado incompleto: ${viewer.header}`);
      await p.screenshot("salida-en-el-visor");
      await p.press("Escape");
      await p.waitFor(`!document.querySelector("[data-viewer]")`, "Esc cierra el visor");
    },
  },
  {
    name: "servidor-ssh",
    async run(p) {
      await p.run(`(await mod("/src/store/uiStore.ts")).useUiStore.getState().setSshDialog({});`);
      await p.waitFor(`document.querySelector('form[aria-labelledby="ssh-title"]')`, "se abre el diálogo");
      if (await p.evaluate(`!!document.querySelector('form[aria-labelledby="ssh-title"] input[type="password"]')`)) throw new Error("No debe pedir contraseña");
      // Un host que ssh leería como opción no se guarda: el error va junto al campo.
      await p.evaluate(`(() => {
        const set = (id, value) => { const el = document.getElementById(id); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; setter.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); };
        set("ssh-name", "Producción");
        set("ssh-host", "-oProxyCommand=sh");
        return true;
      })()`);
      await p.click('form[aria-labelledby="ssh-title"] button[type="submit"]');
      await p.waitFor(`document.getElementById("ssh-host-error")`, "el error del host aparece junto al campo");
      await p.screenshot("servidor-ssh");
      await p.evaluate(`(() => {
        const el = document.getElementById("ssh-host"); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(el, "10.0.0.5"); el.dispatchEvent(new Event("input", { bubbles: true })); return true;
      })()`);
      await p.click('form[aria-labelledby="ssh-title"] button[type="submit"]');
      await p.waitFor(`!document.querySelector('form[aria-labelledby="ssh-title"]')`, "se guarda y se cierra");
      const saved = await p.run(`return (await mod("/src/store/sidebarStore.ts")).useSidebarStore.getState().servers.map((s) => s.host);`);
      if (JSON.stringify(saved) !== JSON.stringify(["10.0.0.5"])) throw new Error(`Servidores: ${JSON.stringify(saved)}`);
    },
  },
  {
    name: "workspace-confianza",
    async run(p) {
      await p.run(`
        const { gitApi } = await mod("/src/lib/git.ts");
        const { useProjectStore } = await mod("/src/store/projectStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        window.__ran = [];
        window.__restoreRun = terminalManager.runWhenReady;
        terminalManager.runWhenReady = (id, line) => window.__ran.push(line);
        gitApi.read = async () => ({ text: JSON.stringify({ name: "Kiosko", panes: [{ title: "dev", run: "npm run dev" }, { run: "npm test", split: "down" }] }), size: 90, truncated: false, binary: false, utf8: true, version: "1", absolute: "/repo/.termcode.json" });
        useProjectStore.setState({ cwd: "/repo", repo: { root: "/repo", name: "repo", remoteUrl: null, webUrl: null, host: "other", defaultBranch: "main" } });
        void (await mod("/src/lib/workspace.ts")).openWorkspace();`);
      await p.waitFor(`document.getElementById("confirm-body")?.textContent.includes("$ npm run dev")`, "pide confianza mostrando los comandos exactos");
      const focus = await p.evaluate(`document.activeElement?.textContent.trim()`);
      if (!focus.startsWith("Cancelar")) throw new Error(`El foco debe empezar en Cancelar, está en «${focus}»`);
      if (await p.evaluate(`window.__ran.length`)) throw new Error("Ejecutó algo antes de aprobar");
      await p.screenshot("workspace-confianza");
      await p.click('[role="alertdialog"] button', "Confiar y abrir");
      await p.waitFor(`window.__ran.length === 2`, "con tu sí, abre los paneles y escribe sus comandos");
      const ran = await p.evaluate(`window.__ran`);
      if (ran.join("|") !== "npm run dev|npm test") throw new Error(`Comandos: ${JSON.stringify(ran)}`);
      const panes = await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { collectPanes } = await mod("/src/lib/layout.ts");
        const s = useTerminalStore.getState();
        return collectPanes(s.tabs.find((t) => t.id === s.activeTabId).root).length;`);
      if (panes !== 2) throw new Error(`Se esperaban 2 paneles, hay ${panes}`);
      await p.run(`
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        terminalManager.runWhenReady = window.__restoreRun;
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const s = useTerminalStore.getState();
        s.closeTab(s.activeTabId);
        (await mod("/src/store/projectStore.ts")).useProjectStore.setState({ cwd: null, repo: null, tree: {}, expanded: {} });`);
    },
  },
  {
    name: "arranque-lento",
    async run(p) {
      // Una zsh que no da su prompt: el panel dice cuánto lleva, y se va en cuanto llega el prompt.
      const id = await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        useTerminalStore.getState().setShells([{ name: "zsh", path: "/bin/zsh", args: ["-l"], default: true }]);
        useTerminalStore.getState().createTab({ cwd: "/Users/e2e" });
        const s = useTerminalStore.getState();
        const id = s.tabs.find((t) => t.id === s.activeTabId).activePaneId;
        for (let i = 0; i < 50 && !terminalManager.instances.get(id); i++) await new Promise((r) => setTimeout(r, 40));
        const inst = terminalManager.instances.get(id);
        inst.isShell = true;
        inst.spawnedAt = Date.now() - 5000;
        return id;`);
      await p.waitFor(`document.querySelector('[data-pane-id="${id}"] [role="status"]')?.textContent.includes("zsh lleva")`, "avisa que la shell no arranca", 4000);
      await p.screenshot("arranque-lento");
      await p.run(`(await mod("/src/terminal/TerminalManager.ts")).terminalManager.receiveForTesting(${JSON.stringify(id)}, "\\x1b]133;A\\x07% ");`);
      await p.waitFor(`!document.querySelector('[data-pane-id="${id}"] [role="status"]')`, "el aviso se va con el primer prompt", 3000);
      await p.shortcut("closePane");
    },
  },
  {
    name: "cabecera-angosta",
    async run(p) {
      // Un agente en un panel angosto: contexto, costo y el botón de terminal nunca se enciman.
      const id = await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const st = useTerminalStore.getState();
        st.createTab({ title: "Claude Code", agentType: "claude", command: "claude", cwd: "/Users/e2e/un/proyecto/con/ruta/larga" });
        const s = useTerminalStore.getState();
        const id = s.tabs.find((t) => t.id === s.activeTabId).activePaneId;
        s.setAgentStatus({ paneId: id, model: "Opus 5.5 (1M context)", contextPercent: 0, costUsd: 0.01 });
        s.splitPane(id, "horizontal", {});
        s.splitPane(id, "horizontal", {});
        return id;`);
      await p.waitFor(`document.querySelector('[data-pane-id="${id}"] button[aria-pressed]')`, "el botón de terminal está");
      const boxes = await p.evaluate(`(() => {
        const header = document.querySelector('[data-pane-id="${id}"] > div');
        // Los botones que flotan al pasar el cursor se superponen a propósito: no cuentan.
        const items = [...header.children].filter((el) => el.offsetParent !== null && getComputedStyle(el).display !== "none" && getComputedStyle(el).position !== "absolute" && el.getBoundingClientRect().width > 0);
        const box = header.getBoundingClientRect();
        const rects = items.map((el) => ({ text: (el.innerText ?? "").trim(), left: Math.round(el.getBoundingClientRect().left), right: Math.round(el.getBoundingClientRect().right) }));
        return { width: Math.round(box.width), right: Math.round(box.right), rects };
      })()`);
      const last = boxes.rects[boxes.rects.length - 1];
      if (last.right > boxes.right) throw new Error(`Se sale de la cabecera en ${boxes.width}px: ${JSON.stringify(boxes)}`);
      for (let i = 1; i < boxes.rects.length; i++) {
        if (boxes.rects[i].left < boxes.rects[i - 1].right - 1) throw new Error(`Se enciman en ${boxes.width}px: ${JSON.stringify(boxes.rects)}`);
      }
      if (!boxes.rects.some((r) => /\d+%/.test(r.text))) throw new Error(`El contexto debe verse siempre: ${JSON.stringify(boxes.rects)}`);
      await p.screenshot("cabecera-angosta");
      await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const s = useTerminalStore.getState();
        s.closeTab(s.activeTabId);`);
    },
  },
  {
    name: "bienvenida-pestana",
    async run(p) {
      await p.shortcut("newTab");
      const activeCard = `(() => { const pane = document.querySelector('[data-pane-id] .xterm:not([hidden])') && [...document.querySelectorAll("[data-pane-id]")].find((el) => el.offsetParent !== null && el.querySelector(".welcome-card")); return pane?.querySelector(".welcome-card") ?? null; })()`;
      await p.waitFor(activeCard, "la pestaña nueva muestra la tarjeta de bienvenida", 6000);
      const text = await p.evaluate(`${activeCard}.textContent`);
      if (!text.includes("termCode") || !text.includes("by CODERGENIUS MX") || !text.includes("Comandos")) throw new Error(`Tarjeta incompleta: ${text}`);
      // Las líneas reservadas van vacías: la shell no ve nada y copiar no arrastra arte.
      const blank = await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const s = useTerminalStore.getState();
        const id = s.tabs.find((t) => t.id === s.activeTabId)?.activePaneId;
        return terminalManager.snapshot(id, 12).every((l) => !l.trim());`);
      if (!blank) throw new Error("Las líneas de la tarjeta deberían estar en blanco");
      await p.screenshot("bienvenida-pestana");

      // Dividir no deforma la tarjeta (se reacomoda) y el panel nuevo trae la suya.
      const widthBefore = await p.evaluate(`${activeCard}.getBoundingClientRect().width`);
      await p.shortcut("splitRight");
      // El ancho nuevo llega en un layout posterior al de la tarjeta nueva: se espera en vez
      // de medir una sola vez (en el runner del CI tarda más y la primera aún medía lo de antes).
      await p.waitFor(
        `(() => { const cards = [...document.querySelectorAll(".welcome-card")].filter((c) => c.offsetParent !== null); return cards.length === 2 && cards.every((c) => c.getBoundingClientRect().width < ${widthBefore}); })()`,
        "el panel nuevo también da la bienvenida y las dos tarjetas caben",
        6000,
      );
      const after = await p.evaluate(`(() => {
        const cards = [...document.querySelectorAll(".welcome-card")].filter((c) => c.offsetParent !== null);
        return { widths: cards.map((c) => c.getBoundingClientRect().width), text: cards.map((c) => c.textContent).join("|") };
      })()`);
      if (!after.widths.every((w) => w < widthBefore) || !after.text.includes("termCode")) throw new Error(`Las tarjetas no se reacomodaron: ${JSON.stringify({ widthBefore, after })}`);
      // La tarjeta que nació completa no se aplasta: pasa a la compacta, igual que la del panel nuevo.
      const heights = await p.evaluate(`[...document.querySelectorAll(".welcome-card")].filter((c) => c.offsetParent !== null).map((c) => Math.round(c.getBoundingClientRect().height))`);
      if (new Set(heights).size !== 1) throw new Error(`Las tarjetas divididas deberían verse iguales: ${JSON.stringify(heights)}`);
      await p.screenshot("bienvenida-dividida");

      // `clear` escrito en la shell (lo que emite en Linux: ESC[H ESC[2J ESC[3J) vuelve a poner la tarjeta arriba.
      const cleared = await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const s = useTerminalStore.getState();
        const id = s.tabs.find((t) => t.id === s.activeTabId)?.activePaneId;
        const pane = document.querySelector('[data-pane-id="' + id + '"]');
        const before = pane.querySelector(".welcome-card");
        terminalManager.receiveForTesting(id, "ls\\r\\nuno dos tres\\r\\n");
        terminalManager.receiveForTesting(id, "clear\\r\\n\\x1b]633;E;clear\\x07\\x1b]133;C\\x07\\x1b[H\\x1b[2J\\x1b[3J\\x1b]133;D;0\\x07\\x1b]133;A\\x07% ");
        for (let i = 0; i < 50; i++) {
          const now = pane.querySelector(".welcome-card");
          if (now && now !== before) break;
          await new Promise((r) => setTimeout(r, 40));
        }
        const term = terminalManager.getTerminal(id);
        return { replaced: pane.querySelector(".welcome-card") !== before && !!pane.querySelector(".welcome-card"), cards: pane.querySelectorAll(".welcome-card").length, promptRow: term.buffer.active.cursorY, top: term.buffer.active.viewportY };
      `);
      if (!cleared.replaced || cleared.cards !== 1 || cleared.promptRow < 3) throw new Error(`clear no devolvió la tarjeta: ${JSON.stringify(cleared)}`);

      // Solo colores del tema: en el claro se repinta legible.
      await p.run(`(await mod("/src/store/settingsStore.ts")).useSettingsStore.getState().update({ theme: "papel" });`);
      await p.waitFor(`document.documentElement.dataset.theme === "papel"`, "tema claro");
      await new Promise((r) => setTimeout(r, 150));
      await p.screenshot("bienvenida-papel");
      await p.run(`(await mod("/src/store/settingsStore.ts")).useSettingsStore.getState().update({ theme: "fosforo" });`);
      await p.shortcut("closePane");
    },
  },
];

/* ------------------------------------------------------------------ */

async function main() {
  const watchdog = setTimeout(() => {
    console.error(`e2e: la corrida excedió ${RUN_TIMEOUT_MS / 60_000} min; se aborta.`);
    process.exit(1);
  }, RUN_TIMEOUT_MS);
  watchdog.unref();
  // Varias separadas por coma: `pnpm e2e -- clear,bienvenida`.
  const filters = filter ? filter.split(",").filter(Boolean) : [];
  const selected = TESTS.filter((t) => !filters.length || filters.some((f) => t.name.includes(f)));
  if (!selected.length) throw new Error(`Ninguna prueba coincide con «${filter}».`);

  const vite = startVite();
  const profile = mkdtempSync(join(tmpdir(), "termcode-e2e-"));
  let chrome;
  let failed = 0;
  try {
    await waitForHttp(`http://127.0.0.1:${VITE_PORT}/`, 30_000).catch((err) => {
      throw new Error(`${err.message}\n${vite.log()}`);
    });
    chrome = startChrome(profile);
    const cdp = await connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    if (DIAG) await cdp.send("Debugger.enable");
    // E2E_PLATFORM=linux en una Mac: prueba la ruta de atajos de Linux/Windows (Ctrl+Shift).
    if (process.env.E2E_PLATFORM === "linux") {
      await cdp.send("Emulation.setUserAgentOverride", {
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
        platform: "Linux x86_64",
      });
    }
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${VITE_PORT}/` });
    const page = makePage(cdp);
    await page.waitFor(`document.querySelector("#root")?.childElementCount > 0`, "la app arranca", 20_000);
    if (DIAG) {
      const mac = await page.run(`return (await mod("/src/lib/shortcuts.ts")).IS_MAC;`);
      console.log(`  [diag] plataforma: ${await page.evaluate("navigator.platform")} · IS_MAC=${mac}`);
    }

    // Las pruebas comparten la página (como un usuario): el orden importa.
    for (const test of TESTS) {
      if (!selected.includes(test) && test.name !== "bienvenida-primera-vez") continue;
      const started = Date.now();
      // Chrome headless a veces marca la página como oculta tras una tecla (p. ej. Esc al cerrar un
      // popover) y entonces deja de correr requestAnimationFrame: xterm no pinta. Al frente, siempre.
      await cdp.send("Page.bringToFront").catch(() => {});
      try {
        await Promise.race([
          test.run(page),
          sleep(TEST_TIMEOUT_MS).then(() => {
            throw new Error(`excedió ${TEST_TIMEOUT_MS / 1000} s`);
          }),
        ]);
        if (selected.includes(test)) console.log(`  ✓ ${test.name} (${Date.now() - started} ms)`);
      } catch (err) {
        failed++;
        console.log(`  ✗ ${test.name}: ${err.message}`);
        if (DIAG && /no respondió/.test(err.message)) {
          console.log(`    pila del bloqueo:\n      ${await cdp.stackOfHang()}`);
          console.log(`    errores vistos: ${cdp.errors.join(" | ") || "ninguno"}`);
          const tail = (chrome.log ?? "").split("\n").filter((l) => /ERROR|FATAL|crash|Crash/.test(l)).slice(-15);
          console.log(`    log de Chrome (errores):\n      ${tail.join("\n      ") || "(nada)"}`);
          break; // con la página colgada, el resto de pruebas solo repetiría el mismo fallo
        }
        await page.screenshot(test.name).catch(() => {});
        // Deja la app limpia para la siguiente: Esc cierra cualquier diálogo.
        await page.press("Escape").catch(() => {});
      }
    }

    if (DIAG) {
      const notes = vite.log().split("\n").filter((l) => /reload|optimiz|error/i.test(l));
      if (notes.length) console.log(`  [diag] vite:\n    ${notes.slice(-12).join("\n    ")}`);
    }
    const errors = cdp.errors.filter((e) => !/React DevTools|__TAURI|transformCallback/.test(e));
    if (errors.length) {
      failed++;
      console.log(`  ✗ errores en la consola:\n    ${errors.slice(0, 8).join("\n    ")}`);
    }
    cdp.ws.close();
  } finally {
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill();
      await Promise.race([exited, sleep(5000)]);
    }
    vite.proc.kill();
    // Chrome puede seguir soltando archivos del perfil un instante.
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log(failed ? `\n${failed} fallo(s). Capturas en e2e/artifacts/` : `\n${selected.length} pruebas e2e en verde.`);
  // exitCode y no process.exit(): con stdout en un pipe (CI) exit() corta la salida pendiente.
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(`e2e: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // Red de seguridad: si algún proceso hijo no suelta el event loop, salir igual.
    setTimeout(() => process.exit(), 5000).unref();
  });
