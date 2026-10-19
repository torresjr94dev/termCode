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
 *   pnpm e2e -- buscador     # solo las que contienen "buscador"
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

  return { evaluate, run, waitFor, press, pressMod, shortcut, type, click, screenshot };
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
    name: "paleta",
    async run(p) {
      await p.shortcut("palette");
      await p.waitFor(`document.activeElement?.tagName === "INPUT"`, "la paleta enfoca su buscador");
      await p.type("dividir");
      await p.waitFor(`[...document.querySelectorAll('[role="option"]')].some((o) => o.textContent.includes("Dividir"))`, "aparece «Dividir»");
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
];

/* ------------------------------------------------------------------ */

async function main() {
  const watchdog = setTimeout(() => {
    console.error(`e2e: la corrida excedió ${RUN_TIMEOUT_MS / 60_000} min; se aborta.`);
    process.exit(1);
  }, RUN_TIMEOUT_MS);
  watchdog.unref();
  const selected = TESTS.filter((t) => !filter || t.name.includes(filter));
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
