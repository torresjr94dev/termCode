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
  const vite = spawn(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"], {
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
  return spawn(findChrome(), args, { stdio: "ignore" });
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
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description ?? d.text);
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, errors };
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

  return { evaluate, run, waitFor, press, shortcut, type, click, screenshot };
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
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${VITE_PORT}/` });
    const page = makePage(cdp);
    await page.waitFor(`document.querySelector("#root")?.childElementCount > 0`, "la app arranca", 20_000);

    // Las pruebas comparten la página (como un usuario): el orden importa.
    for (const test of TESTS) {
      if (!selected.includes(test) && test.name !== "bienvenida-primera-vez") continue;
      const started = Date.now();
      try {
        await test.run(page);
        if (selected.includes(test)) console.log(`  ✓ ${test.name} (${Date.now() - started} ms)`);
      } catch (err) {
        failed++;
        console.log(`  ✗ ${test.name}: ${err.message}`);
        await page.screenshot(test.name).catch(() => {});
        // Deja la app limpia para la siguiente: Esc cierra cualquier diálogo.
        await page.press("Escape").catch(() => {});
      }
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
