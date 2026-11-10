/**
 * Arnés de e2e/run.mjs (pruebas) y e2e/capturas.mjs (capturas del README):
 * levanta Vite, abre Chrome headless y lo maneja por CDP (WebSocket nativo de
 * Node ≥ 22), sin dependencias.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ARTIFACTS = join(ROOT, "e2e", "artifacts");
export const VITE_PORT = Number(process.env.E2E_PORT ?? 1437);
export const CDP_PORT = Number(process.env.E2E_CDP_PORT ?? 9347);
/** E2E_DIAG=1: si la página se cuelga, imprime la pila del JavaScript que la bloquea. */
export const DIAG = Boolean(process.env.E2E_DIAG);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export async function waitForHttp(url, timeoutMs) {
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

export function startVite() {
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

export function startChrome(profile, { width = 1280, height = 800, scale = null } = {}) {
  const args = [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  // La escala de verdad (como una pantalla Retina): la emulada por CDP no la respeta el canvas WebGL de xterm.
  if (scale) args.unshift(`--force-device-scale-factor=${scale}`);
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

export async function connect() {
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

export function makePage(cdp) {
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
    Tab: { code: "Tab", vk: 9 },
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

  /**
   * La página tal como se ve, en bytes (`format`: png · webp · jpeg; `quality` solo para webp/jpeg;
   * `clip`: un rectángulo en píxeles CSS).
   */
  const capture = async ({ format = "png", quality, clip } = {}) => {
    const { data } = await cdp.send("Page.captureScreenshot", {
      format,
      ...(quality != null ? { quality } : {}),
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    });
    return Buffer.from(data, "base64");
  };

  const screenshot = async (name) => {
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, `${name}.png`), await capture());
  };

  /** Rueda del ratón real (no un evento sintético de la página) en el centro de un elemento. */
  /**
   * La caja de un elemento cuando deja de moverse (igual en dos frames seguidos). El layout
   * puede ir detrás del DOM: en el runner de CI, tras cambiar el ancho del visor, la caja
   * siguió en el ancho viejo ~50 ms con el estilo ya nuevo, y un clic medido antes caía al lado.
   */
  const settledBox = async (selector, text) => {
    const read = `new Promise((resolve) => {
      const measure = () => {
        const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const el = ${text ? `els.find((e) => e.textContent.trim().includes(${JSON.stringify(text)}))` : "els[0]"};
        if (!el) return resolve(null);
        const r = el.getBoundingClientRect();
        resolve({ left: r.left, top: r.top, width: r.width, height: r.height });
      };
      // Dos frames; si la página no pinta (headless la marca oculta a veces), igual mide.
      const timer = setTimeout(measure, 100);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); measure(); }));
    })`;
    let last = await evaluate(read);
    for (let i = 0; i < 40 && last; i++) {
      const box = await evaluate(read);
      if (box && box.left === last.left && box.top === last.top && box.width === last.width && box.height === last.height) return box;
      last = box;
    }
    return last;
  };

  const wheel = async (selector, deltaY) => {
    const r = await settledBox(selector);
    const box = r && { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    if (!box) throw new Error(`No encontré ${selector} para la rueda`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY });
  };

  /** Doble clic real (dos pulsaciones con clickCount 1 y 2), en el centro del primer elemento que coincide. */
  const dblclick = async (selector, text) => {
    await evaluate(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = ${text ? `els.find((e) => e.textContent.trim().includes(${JSON.stringify(text)}))` : "els[0]"};
      el?.scrollIntoView({ block: "center" });
      return true;
    })()`);
    const r = await settledBox(selector, text);
    const box = r && { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 };
    if (!box) throw new Error(`No encontré ${selector}${text ? ` con «${text}»` : ""} para el doble clic`);
    const base = { x: box.x, y: box.y, button: "left" };
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    for (const clickCount of [1, 2]) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", clickCount, ...base });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", clickCount, ...base });
    }
  };

  /** Arrastre real con el ratón: pulsar en `from`, moverse en pasos hasta `to`, (`before`) y soltar. */
  const drag = async (from, to, { steps = 8, before } = {}) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    }
    if (before) await before();
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  };

  /** El ratón real sobre el centro de un elemento (dispara :hover, no un evento sintético). */
  const hover = async (selector) => {
    const r = await settledBox(selector);
    const box = r && { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    if (!box) throw new Error(`No encontré ${selector} para pasar el ratón`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  };

  return { evaluate, run, waitFor, press, pressMod, shortcut, type, click, capture, screenshot, settledBox, wheel, dblclick, drag, hover };
}
