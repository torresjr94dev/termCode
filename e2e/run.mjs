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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DIAG, VITE_PORT, connect, makePage, sleep, startChrome, startVite, waitForHttp } from "./harness.mjs";

const filter = process.argv.slice(2).find((a) => a !== "--");
const TEST_TIMEOUT_MS = 30_000;
// Tope de toda la corrida: pase lo que pase, CI no se queda esperando horas.
const RUN_TIMEOUT_MS = 4 * 60_000;

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
    name: "clear-limpia-historial",
    async run(p) {
      // El `clear` de macOS manda ESC[3J antes de ESC[H ESC[2J: sin un ESC[3J de más tras el
      // borrado, la pantalla anterior subía al historial. Lo que viene después queda entero.
      const r = await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const s = useTerminalStore.getState();
        const id = s.tabs.find((t) => t.id === s.activeTabId)?.activePaneId;
        const term = terminalManager.getTerminal(id);
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
        return { oldInHistory: lines.some((l) => l.includes("archivo-")), output: lines.filter((l) => /^salida-\\d+$/.test(l.trim())).length };`);
      await p.screenshot("clear-limpia-historial");
      if (r.oldInHistory) throw new Error("clear dejó la pantalla anterior en el historial");
      if (r.output !== 30) throw new Error(`Tras clear faltan líneas de salida: ${r.output} de 30`);
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
      // Un agente crea un archivo: al reabrir ⌘P ya está (no espera a que caduque la caché).
      await p.run(`
        const { gitApi } = await mod("/src/lib/git.ts");
        gitApi.files = async () => ["src/App.tsx", "src/lib/terminal-utils.ts", "src/terminal/TerminalManager.ts", "README.md", "src/nuevo-del-agente.ts"];`);
      await p.shortcut("fileFinder");
      await p.waitFor(`document.querySelectorAll('#finder-results [role="option"]').length === 5`, "el archivo nuevo aparece al reabrir");
      await p.press("Escape");
      await p.waitFor(`!document.querySelector("#finder-results")`, "Esc cierra el buscador");
    },
  },
  {
    name: "buscador-texto",
    async run(p) {
      await p.run(`
        const { gitApi } = await mod("/src/lib/git.ts");
        const { useProjectStore } = await mod("/src/store/projectStore.ts");
        useProjectStore.setState({ cwd: "/repo-e2e", repo: null, viewer: null, fileTabs: [] });
        window.__searches = [];
        gitApi.files = async () => ["src/App.tsx", "src/lib/total.ts", "README.md"];
        gitApi.read = async (_root, path) => ({ text: "const a = 1;\\nexport const total = a + 1;\\n", size: 40, truncated: false, binary: false, utf8: true, version: "v1", absolute: "/repo-e2e/" + path });
        gitApi.search = async (_root, query, id) => {
          window.__searches.push({ ...query, id });
          return {
            files: [
              { path: "src/lib/total.ts", more: false, matches: [
                { line: 2, column: 13, length: 5, preview: "export const total = a + 1;", ranges: [[13, 18]] },
              ] },
              { path: "README.md", more: false, matches: [
                { line: 7, column: 3, length: 5, preview: "El total del mes", ranges: [[3, 8]] },
              ] },
            ],
            total: 2, searched: 3, truncated: false, cancelled: false, skipped: 1,
          };
        };`);
      await p.shortcut("searchText");
      await p.waitFor(`document.querySelector('[role="dialog"][aria-label="Buscar en archivos"]')`, "⇧⌘F abre la búsqueda de texto");
      await p.type("total");
      await p.waitFor(`document.querySelectorAll('#finder-results [role="option"]').length === 2`, "lista las líneas que coinciden");
      await p.waitFor(`document.querySelector('[role="status"]')?.textContent.includes("2 líneas en 2 archivos")`, "resume lo encontrado");
      await p.waitFor(`document.querySelector('[role="status"]')?.textContent.includes("1 sin leer")`, "avisa de lo que no leyó (iCloud)");
      await p.waitFor(`document.querySelector('#finder-results mark')?.textContent === "total"`, "resalta la coincidencia");
      const last = await p.evaluate(`window.__searches[window.__searches.length - 1]`);
      if (last.query !== "total" || last.dir !== "" || last.regex) throw new Error(`Búsqueda inesperada: ${JSON.stringify(last)}`);

      // Opciones: expresión regular.
      await p.evaluate(`[...document.querySelectorAll('button[aria-pressed]')].find((b) => b.title.startsWith("Expresión regular")).click(), true`);
      await p.waitFor(`window.__searches.some((s) => s.regex)`, "con .* busca como expresión regular");
      await p.evaluate(`[...document.querySelectorAll('button[aria-pressed]')].filter((b) => b.getAttribute("aria-pressed") === "true").forEach((b) => b.click()), true`);

      // Enter abre el archivo en la línea con la coincidencia seleccionada.
      await p.evaluate(`document.querySelector('[role="dialog"] input').focus(), true`);
      await p.press("Enter");
      await p.waitFor(`!document.querySelector("#finder-results")`, "Enter cierra el buscador");
      await p.waitFor(`document.querySelector("[data-viewer] .cm-activeLine")?.textContent.includes("export const total")`, "abre en la línea de la coincidencia");
      await p.waitFor(`document.querySelector('[data-viewer] [role="tab"][aria-selected="true"]')?.textContent.includes("total.ts")`, "en su pestaña");

      // Tab cambia a archivos sin cerrar; Esc cierra.
      await p.shortcut("searchText");
      await p.waitFor(`document.querySelector('[role="dialog"] input')?.value === "total"`, "recuerda la última búsqueda");
      await p.press("Tab");
      await p.waitFor(`document.querySelector('[role="dialog"][aria-label="Buscar archivo"]')`, "Tab pasa a buscar archivos");
      await p.press("Escape");
      await p.waitFor(`!document.querySelector("#finder-results")`, "Esc cierra");
      await p.run(`(await mod("/src/lib/project.ts")).closeFileTabs(["src/lib/total.ts"]);`);
      await p.waitFor(`!document.querySelector("[data-viewer]")`, "sin pestañas, sin visor");
    },
  },
  {
    name: "pestanas-y-markdown",
    async run(p) {
      await p.run(`
        const { gitApi } = await mod("/src/lib/git.ts");
        const { useProjectStore } = await mod("/src/store/projectStore.ts");
        const project = await mod("/src/lib/project.ts");
        useProjectStore.setState({ cwd: "/repo-e2e", repo: null, viewer: null, fileTabs: [] });
        const md = "# Guía\\n\\nVer [uso](#uso) y [código](../src/b.ts#L2).\\n\\n<script>window.__xss = 1</script>\\n\\n## Uso\\n\\n- [x] hecho\\n\\n\`\`\`ts\\nconst x = 1;\\n\`\`\`\\n";
        gitApi.read = async (_root, path) => ({ text: path.endsWith(".md") ? md : "uno\\ndos\\ntres\\n", size: 50, truncated: false, binary: false, utf8: true, version: "v1", absolute: "/repo-e2e/" + path });
        gitApi.fileVersion = async () => "v1";
        await project.openFile("docs/GUIA.md");`);
      await p.waitFor(`document.querySelector("[data-viewer] h1")?.textContent === "Guía"`, "el Markdown se abre renderizado");
      await p.waitFor(`document.querySelector('[data-viewer] input[type="checkbox"]')?.checked === true`, "las tareas son casillas");
      const xss = await p.evaluate(`window.__xss === undefined && !document.querySelector("[data-viewer] script") && document.querySelector("[data-viewer]").textContent.includes("<script>")`);
      if (!xss) throw new Error("El HTML del Markdown no debe ejecutarse ni insertarse");
      // Sobre un enlace no aparece el menú nativo («Abrir enlace» navegaría la vista y cerraría las terminales).
      const linkMenu = await p.evaluate(`(() => {
        const link = [...document.querySelectorAll("[data-viewer] a")].find((a) => a.textContent === "código");
        const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        link.dispatchEvent(ev);
        return ev.defaultPrevented && !link.hasAttribute("href");
      })()`);
      if (!linkMenu) throw new Error("Un enlace del Markdown no debe ofrecer el menú nativo ni tener href");
      // Un enlace relativo abre el archivo en su pestaña, en la línea del #L.
      await p.click("[data-viewer] a", "código");
      await p.waitFor(`document.querySelectorAll('[data-viewer] [role="tab"]').length === 2`, "abre una segunda pestaña");
      await p.waitFor(`document.querySelector("[data-viewer] .cm-activeLine")?.textContent === "dos"`, "en la línea del enlace (#L2)");
      // Volver a la pestaña del Markdown y pasar a texto.
      await p.click('[data-viewer] [role="tab"]', "GUIA.md");
      await p.waitFor(`document.querySelector("[data-viewer] h1")`, "vuelve renderizado");
      await p.click("[data-viewer] button", "Texto");
      await p.waitFor(`document.querySelector("[data-viewer] .cm-content")?.textContent.includes("# Guía")`, "Texto muestra el Markdown fuente");
      // «Ambos»: texto y vista previa a la vez, y la vista sigue lo que escribes.
      await p.click("[data-viewer] button", "Ambos");
      await p.waitFor(`document.querySelector("[data-viewer] h1")?.textContent === "Guía" && document.querySelector("[data-viewer] .cm-content")`, "muestra el texto y la vista previa");
      await p.evaluate(`document.querySelector("[data-viewer] .cm-content").focus(), true`);
      await p.press("ArrowDown");
      await p.type("## Nuevo título\n");
      await p.waitFor(`[...document.querySelectorAll("[data-viewer] h2")].some((h) => h.textContent === "Nuevo título")`, "la vista previa se actualiza mientras escribes");
      // ⌃Tab: a la otra pestaña.
      await p.evaluate(`document.querySelector("[data-viewer] .cm-content").focus(), true`);
      await p.press("Tab", 2);
      await p.waitFor(`document.querySelector('[data-viewer] [role="tab"][aria-selected="true"]')?.textContent.includes("b.ts")`, "⌃Tab cambia de pestaña");
      await p.run(`(await mod("/src/lib/project.ts")).closeFileTabs(["docs/GUIA.md", "src/b.ts"]);`);
      await p.click("button", "Cerrar sin guardar");
      await p.waitFor(`!document.querySelector("[data-viewer]")`, "cerrar todas cierra el visor");
    },
  },
  {
    name: "visor-acoplado",
    async run(p) {
      await p.run(`
        const { gitApi } = await mod("/src/lib/git.ts");
        const { useProjectStore } = await mod("/src/store/projectStore.ts");
        const project = await mod("/src/lib/project.ts");
        useProjectStore.setState({ cwd: "/repo-e2e", repo: null, viewer: null, fileTabs: [], viewerDock: { docked: false, width: 0.5 } });
        gitApi.read = async (_root, path) => ({ text: "const a = 1;\\n", size: 13, truncated: false, binary: false, utf8: true, version: "v1", absolute: "/repo-e2e/" + path });
        gitApi.fileVersion = async () => "v1";
        await project.openFile("src/a.ts");`);
      await p.waitFor(`document.querySelector("[data-viewer] .cm-content")`, "abre el archivo encima de las terminales");
      const covers = await p.evaluate(`(() => {
        const v = document.querySelector("[data-viewer]").getBoundingClientRect();
        const t = document.querySelector(".xterm").getBoundingClientRect();
        return v.left <= t.left + 1 && v.right >= t.right - 1;
      })()`);
      if (!covers) throw new Error("Sin acoplar, el visor va encima de las terminales");
      await p.evaluate(`(document.querySelector("[data-viewer] .cm-editor").__antes = true)`);
      await p.click('[data-viewer] button[aria-label="Ver junto a las terminales"]');
      await p.waitFor(`(() => {
        const v = document.querySelector("[data-viewer]").getBoundingClientRect();
        const t = [...document.querySelectorAll(".xterm")].find((x) => x.offsetParent).getBoundingClientRect();
        return t.right <= v.left && t.width > 200 && v.width > 200;
      })()`, "acoplado, terminales y visor quedan lado a lado");
      // Acoplarlo no rehace el editor (si lo rehiciera, al crearse le quitaría el foco a la terminal).
      const same = await p.evaluate(`document.querySelector("[data-viewer] .cm-editor")?.__antes === true`);
      if (!same) throw new Error("Acoplar el visor no debe volver a crear el editor");
      // Con el visor acoplado, la terminal se puede usar sin cerrarlo.
      await p.evaluate(`[...document.querySelectorAll(".xterm textarea")].find((t) => t.offsetParent)?.focus(), true`);
      await p.waitFor(`document.activeElement?.closest(".xterm") && document.querySelector("[data-viewer]")`, "la terminal toma el teclado y el visor sigue abierto");
      // El divisor: ← agranda el visor, doble clic lo deja a la mitad.
      await p.evaluate(`document.querySelector('[role="separator"][aria-label="Ancho del visor"]').focus(), true`);
      await p.press("ArrowLeft");
      await p.waitFor(`document.querySelector('[role="separator"][aria-label="Ancho del visor"]').getAttribute("aria-valuenow") === "55"`, "← agranda el visor");
      await p.dblclick('[role="separator"][aria-label="Ancho del visor"]');
      await p.waitFor(`document.querySelector('[role="separator"][aria-label="Ancho del visor"]').getAttribute("aria-valuenow") === "50"`, "doble clic: a la mitad");
      await p.click('[data-viewer] button[aria-label="Ver encima de las terminales"]');
      await p.waitFor(`!document.querySelector('[role="separator"][aria-label="Ancho del visor"]')`, "vuelve a ir encima");
      await p.run(`(await mod("/src/lib/project.ts")).closeFileTabs(["src/a.ts"]);`);
      await p.waitFor(`!document.querySelector("[data-viewer]")`, "se cierra");
    },
  },
  {
    name: "menu-contextual",
    async run(p) {
      await p.run(`
        const { gitApi } = await mod("/src/lib/git.ts");
        const { useProjectStore } = await mod("/src/store/projectStore.ts");
        const project = await mod("/src/lib/project.ts");
        gitApi.list = async (_root, path) => path === "" ? [
          { name: "src", path: "src", isDir: true, size: 0, ignored: false },
          { name: "README.md", path: "README.md", isDir: false, size: 10, ignored: false },
        ] : [];
        useProjectStore.setState({ cwd: "/repo-e2e", repo: null, viewer: null, isOpen: true, tab: "files", tree: {}, expanded: {} });
        await project.loadDir("");`);
      await p.waitFor(`[...document.querySelectorAll('[role="tree"] button')].some((b) => b.textContent.includes("README.md"))`, "el árbol lista los archivos");
      // Fuera de campos de texto, el menú del webview («Recargar») no aparece.
      const blocked = await p.evaluate(`(() => {
        const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
        document.querySelector("footer, [role='status'], header")?.dispatchEvent(ev);
        return ev.defaultPrevented;
      })()`);
      if (!blocked) throw new Error("El menú nativo con «Recargar» debe quedar bloqueado");
      const native = await p.evaluate(`(() => {
        const input = document.createElement("input");
        document.body.append(input);
        const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        input.dispatchEvent(ev);
        input.remove();
        return !ev.defaultPrevented;
      })()`);
      if (!native) throw new Error("En un campo de texto se conserva el menú nativo (Copiar, Pegar)");
      // Clic derecho en una carpeta: menú propio con buscar dentro.
      await p.evaluate(`(() => {
        const row = [...document.querySelectorAll('[role="tree"] button')].find((b) => b.textContent.trim().startsWith("src"));
        const r = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
        return true;
      })()`);
      await p.waitFor(`document.querySelector('[role="menu"][aria-label="Carpeta src"]')`, "abre el menú de la carpeta");
      await p.press("ArrowDown");
      await p.press("Escape");
      await p.waitFor(`!document.querySelector('[role="menu"]')`, "Esc cierra el menú");
      await p.evaluate(`(() => {
        const row = [...document.querySelectorAll('[role="tree"] button')].find((b) => b.textContent.trim().startsWith("src"));
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }));
        return true;
      })()`);
      await p.click('[role="menu"] [role="menuitem"]', "Buscar texto en esta carpeta");
      await p.waitFor(`document.querySelector('[role="dialog"][aria-label="Buscar en archivos"] [role="radio"][aria-checked="true"]')?.textContent === "src"`, "busca solo dentro de src");
      await p.press("Escape");
      await p.waitFor(`!document.querySelector("#finder-results")`, "Esc cierra");
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
        useProjectStore.setState({ cwd: "/repo-e2e", repo: null, viewer: null, fileTabs: [] });
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

      // Esc con cambios: vuelve a las terminales sin perder nada; la pestaña espera en «Abiertos».
      await p.type("y");
      await p.press("Escape");
      await p.waitFor(`!document.querySelector("[data-viewer]")`, "Esc cierra el visor sin preguntar");
      await p.waitFor(`document.querySelector('section[aria-label="Archivos abiertos"]')?.textContent.includes("1 sin guardar")`, "la pestaña sigue con sus cambios");
      await p.click('section[aria-label="Archivos abiertos"] button', "notas.ts");
      await p.waitFor(`document.querySelector("[data-viewer] .cm-content")?.textContent.includes("xyexport const")`, "al volver, lo editado sigue ahí");
      // ⌘W cierra la pestaña: con cambios, pregunta.
      await p.evaluate(`document.querySelector("[data-viewer] .cm-content").focus(), true`);
      await p.shortcut("closePane");
      await p.waitFor(`[...document.querySelectorAll("button")].some((b) => b.textContent.includes("Cerrar sin guardar"))`, "pide confirmar");
      await p.click("button", "Cerrar sin guardar");
      await p.waitFor(`!document.querySelector("[data-viewer]")`, "se cierra tras confirmar");
      await p.waitFor(`!document.querySelector('section[aria-label="Archivos abiertos"]')`, "sin pestañas abiertas");
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
      // Dice qué quiere hacer, sin repetir el nombre de la herramienta («Quiere ejecutar Bash»).
      await p.waitFor(`document.querySelector('[aria-label="Permisos pendientes"]')?.textContent.includes("Quiere ejecutar un comando")`, "el encabezado dice qué quiere hacer");
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

      // Shift+Enter: salto de línea (Ctrl+J) para el agente; Enter normal en una shell sin la integración.
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

      // En el prompt de zsh que la integración anunció, Shift+Enter va en CSI u (ella lo liga a un salto
      // de línea). Un prompt marcado sin anuncio (fish, un bash con su integración) y un programa
      // corriendo (nano justifica con Ctrl+J) siguen recibiendo Enter.
      const shiftEnter = async (output) => {
        await p.run(`${helpers} terminalManager.receiveForTesting(id, ${JSON.stringify(output)}); await flush(); inst.pendingInput.length = 0;`);
        await p.press("Enter", 8);
        return p.run(`${helpers} await new Promise((r) => setTimeout(r, 100)); return writes();`);
      };
      const announced = "\x1b]633;P;ShiftEnter=newline\x07\x1b]133;A\x07% ";
      const cases = [
        ["prompt sin anuncio", "", ["\r"]],
        ["prompt de zsh", announced, ["\x1b[13;2u"]],
        ["nano corriendo", "nano notas.md\r\n\x1b]633;E;nano notas.md\x07\x1b]133;C\x07", ["\r"]],
        ["prompt tras nano", "\x1b]133;D;0\x07" + announced, ["\x1b[13;2u"]],
        ["fish tras exec", "exec fish\r\n\x1b]633;E;exec fish\x07\x1b]133;C\x07\x1b]133;A\x07> ", ["\r"]],
        // fish marca sus propios prompts y comandos: nada corre, pero su prompt no viene anunciado.
        ["fish tras un comando", "ls\r\n\x1b]133;C\x07\x1b]133;D;0\x07\x1b]133;A\x07> ", ["\r"]],
      ];
      for (const [what, output, expected] of cases) {
        const keys = await shiftEnter(output);
        if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error(`Shift+Enter (${what}) mandó ${JSON.stringify(keys)}`);
      }

      // Escribiendo en todos, cada panel recibe su propio Shift+Enter: el CSI u del prompt de zsh
      // sería deshacer (`u`) en un vim o un nano de otro panel.
      const otherId = await p.run(`${helpers}
        const [otherId, other] = [...terminalManager.instances.entries()].find(([, i]) => i !== inst && i.spawnRequested);
        terminalManager.receiveForTesting(id, ${JSON.stringify(announced)});
        terminalManager.receiveForTesting(otherId, "nano notas.md\\r\\n\\x1b]633;E;nano notas.md\\x07\\x1b]133;C\\x07");
        await flush();
        await new Promise((resolve) => other.term.write("", resolve));
        for (const i of terminalManager.instances.values()) i.pendingInput.length = 0;
        useTerminalStore.setState({ isBroadcastEnabled: true });
        return otherId;`);
      await p.press("Enter", 8);
      const broadcastKeys = await p.run(`${helpers}
        await new Promise((r) => setTimeout(r, 100));
        const other = terminalManager.instances.get(${JSON.stringify(otherId)});
        const keys = { mine: writes(), other: other.pendingInput.map((w) => w.args.data) };
        useTerminalStore.setState({ isBroadcastEnabled: false });
        terminalManager.receiveForTesting(${JSON.stringify(otherId)}, "\\x1b]133;D;0\\x07\\x1b]133;A\\x07% ");
        return keys;`);
      if (JSON.stringify(broadcastKeys) !== JSON.stringify({ mine: ["\x1b[13;2u"], other: ["\r"] })) {
        throw new Error(`Shift+Enter en broadcast mandó ${JSON.stringify(broadcastKeys)}`);
      }
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
    name: "barra-lateral-desborde",
    async run(p) {
      // Más sesiones de las que caben: el borde por donde sigue la lista se difumina y la
      // sesión activa siempre se ve entera (antes una quedaba cortada y parecía la última).
      const ids = await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const s = () => useTerminalStore.getState();
        if (!s().isSidebarOpen) s().toggleSidebar();
        const before = s().tabs.map((t) => t.id);
        const active = s().activeTabId;
        for (let i = 0; i < 8; i++) s().createTab({ title: "extra " + i });
        return { first: before[0], active, added: s().tabs.map((t) => t.id).filter((id) => !before.includes(id)) };`);
      const list = `document.querySelector('nav[aria-label="Pestañas abiertas"]')`;
      const activeVisible = `(() => {
        const nav = ${list};
        const item = nav?.querySelector('[aria-current="page"]')?.closest("li");
        if (!nav || !item) return false;
        const [box, row] = [nav.getBoundingClientRect(), item.getBoundingClientRect()];
        return row.top >= box.top - 1 && row.bottom <= box.bottom + 1;
      })()`;
      await p.waitFor(`${list}?.dataset.more === "above"`, "con la última activa, el borde de arriba avisa que hay más");
      await p.waitFor(activeVisible, "la última sesión, activa, se ve entera");
      await p.run(`(await mod("/src/store/terminalStore.ts")).useTerminalStore.getState().setActiveTab(${JSON.stringify(ids.first)});`);
      await p.waitFor(`${list}?.dataset.more === "below"`, "con la primera activa, avisa el borde de abajo");
      await p.waitFor(activeVisible, "la primera sesión, activa, se ve entera");
      const mask = await p.evaluate(`getComputedStyle(${list}).maskImage || getComputedStyle(${list}).webkitMaskImage`);
      if (!/gradient/.test(mask)) throw new Error(`El borde no se difumina: ${mask}`);
      await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const s = () => useTerminalStore.getState();
        for (const id of ${JSON.stringify(ids.added)}) s().closeTab(id);
        s().setActiveTab(${JSON.stringify(ids.active)});
        s().toggleSidebar();`);
      await p.waitFor(`!${list}`, "la barra lateral se cierra");
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
        // Todo cuenta, también los botones que aparecen al pasar el cursor: tienen su sitio.
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
    name: "mover-paneles",
    async run(p) {
      // a | (b / c), cada terminal con su texto: moverlos no debe reiniciar ninguna.
      await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const st = useTerminalStore.getState();
        st.createTab();
        const a = useTerminalStore.getState().tabs.at(-1).activePaneId;
        st.splitPane(a, "horizontal", {});
        const b = useTerminalStore.getState().tabs.at(-1).activePaneId;
        st.splitPane(b, "vertical", {});
        const c = useTerminalStore.getState().tabs.at(-1).activePaneId;
        window.__panes = { [a]: "a", [b]: "b", [c]: "c" };
        for (let i = 0; i < 75 && ![a, b, c].every((id) => terminalManager.getTerminal(id)); i++) await new Promise((r) => setTimeout(r, 40));
        for (const [id, name] of Object.entries(window.__panes)) {
          terminalManager.receiveForTesting(id, "soy el panel " + name + "\\r\\n% ");
          terminalManager.getTerminal(id).__e2e = name;
        }`);
      const layout = `(async () => {
        const { useTerminalStore } = await import("/src/store/terminalStore.ts");
        const { terminalManager } = await import("/src/terminal/TerminalManager.ts");
        const tab = useTerminalStore.getState().tabs.at(-1);
        const name = (id) => window.__panes[id];
        const shape = (n) => n.type === "pane" ? name(n.id) : "(" + shape(n.first) + (n.direction === "horizontal" ? " | " : " / ") + shape(n.second) + ")";
        const id = (n) => Object.keys(window.__panes).find((k) => window.__panes[k] === n);
        const box = (n, sel = "") => { const r = document.querySelector('[data-pane-id="' + id(n) + '"] ' + sel).getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
        const intact = Object.entries(window.__panes).every(([pid, n]) => {
          const term = terminalManager.getTerminal(pid);
          const text = term.buffer.active.getLine(0)?.translateToString(true) ?? "";
          return term.__e2e === n && text.includes("soy el panel " + n) && document.querySelector('[data-pane-id="' + pid + '"] .xterm') === term.element;
        });
        const focused = document.activeElement?.closest("[data-pane-id]")?.dataset.paneId;
        return { shape: shape(tab.root), active: name(tab.activePaneId), focused: focused ? name(focused) : null, intact, bars: { a: box("a", "[data-pane-bar]"), b: box("b", "[data-pane-bar]"), c: box("c", "[data-pane-bar]") }, panes: { a: box("a"), b: box("b"), c: box("c") } };
      })()`;
      const before = await p.evaluate(layout);
      if (before.shape !== "(a | (b / c))") throw new Error(`Forma inicial: ${before.shape}`);

      // Arrastrar c por su barra hasta el borde de arriba de a: c queda encima de a.
      const grab = (bar) => ({ x: bar.left + 30, y: bar.top + bar.height / 2 });
      const pa = before.panes.a;
      let preview = null;
      await p.drag(grab(before.bars.c), { x: pa.left + pa.width / 2, y: pa.top + pa.height * 0.1 }, {
        before: async () => {
          preview = await p.evaluate(`(() => {
            const ids = Object.keys(window.__panes);
            const label = (n) => document.querySelector('[data-pane-id="' + ids.find((k) => window.__panes[k] === n) + '"] > .animate-pop-in')?.textContent ?? null;
            const source = document.querySelector('[data-pane-id="' + ids.find((k) => window.__panes[k] === "c") + '"]');
            return { a: label("a"), dragging: document.documentElement.hasAttribute("data-pane-dragging"), sourceDimmed: source.classList.contains("opacity-50") };
          })()`);
          await p.screenshot("mover-paneles-arrastre");
        },
      });
      await new Promise((r) => setTimeout(r, 150));
      if (preview?.a !== "Mover aquí" || !preview.dragging || !preview.sourceDimmed) throw new Error(`Vista previa al arrastrar: ${JSON.stringify(preview)}`);
      const docked = await p.evaluate(layout);
      if (docked.shape !== "((c / a) | b)" || docked.active !== "c" || !docked.intact) throw new Error(`Tras moverlo: ${JSON.stringify(docked)}`);
      if (docked.focused !== "c") throw new Error(`El teclado debía quedar en el panel movido, quedó en ${docked.focused}`);
      await p.screenshot("mover-paneles");

      // Al centro de otro panel, se intercambian.
      const pb = docked.panes.b;
      await p.drag(grab(docked.bars.a), { x: pb.left + pb.width / 2, y: pb.top + pb.height / 2 });
      await new Promise((r) => setTimeout(r, 150));
      const swapped = await p.evaluate(layout);
      if (swapped.shape !== "((c / b) | a)" || !swapped.intact) throw new Error(`Intercambio: ${JSON.stringify(swapped)}`);

      // Esc a medio arrastre lo cancela.
      const pc = swapped.panes.c;
      await p.drag(grab(swapped.bars.a), { x: pc.left + 20, y: pc.top + pc.height / 2 }, { before: () => p.press("Escape") });
      await new Promise((r) => setTimeout(r, 150));
      const cancelled = await p.evaluate(layout);
      if (cancelled.shape !== "((c / b) | a)") throw new Error(`Esc no canceló: ${cancelled.shape}`);

      // Con el teclado (paleta): el activo se cambia por su vecino.
      await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const st = useTerminalStore.getState();
        const tab = st.tabs.at(-1);
        st.setActivePane(Object.keys(window.__panes).find((k) => window.__panes[k] === "c"));
        (await mod("/src/lib/actions.ts")).actions.movePaneSide("bottom");`);
      const keyboard = await p.evaluate(layout);
      if (keyboard.shape !== "((b / c) | a)" || !keyboard.intact) throw new Error(`Con el teclado: ${JSON.stringify(keyboard)}`);
      await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const st = useTerminalStore.getState();
        st.closeTab(st.tabs.at(-1).id);`);
    },
  },
  {
    name: "barra-ruta-larga",
    async run(p) {
      // Una carpeta como «~/Documents/Documentos - Jorge’s MacBook Air/…»: la ruta se recorta,
      // no los botones, y al pasar el cursor los de dividir no tapan Claude Code ni Codex.
      await p.shortcut("newTab");
      const id = await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const s = useTerminalStore.getState();
        const id = s.tabs.find((t) => t.id === s.activeTabId).activePaneId;
        for (let i = 0; i < 75 && !terminalManager.getTerminal(id); i++) await new Promise((r) => setTimeout(r, 40));
        s.setAgents({ claude: "/x/claude", codex: "/x/codex", gh: null, editors: [], claudeSettingsPath: "/x/claude-settings.json", mcpConfigPath: null });
        const inst = terminalManager.instances.get(id);
        terminalManager.receiveForTesting(id, "\\x1b]7;file://h/Users/e2e/Documents/Documentos%20-%20Jorge%E2%80%99s%20MacBook%20Air/Development/Personal/un-proyecto-con-nombre-largo/termCode\\x07\\x1b]133;A\\x07% ");
        await new Promise((resolve) => inst.term.write("", resolve));
        return id;`);
      const launcher = `[data-pane-id="${id}"] [data-pane-bar] button[aria-label="Abrir Codex CLI en este panel"]`;
      await p.waitFor(`document.querySelector('${launcher}')`, "la barra ofrece los agentes");
      await p.hover(`[data-pane-id="${id}"] [data-pane-bar]`);
      await p.hover(launcher);
      await p.waitFor(`getComputedStyle(document.querySelector('[data-pane-id="${id}"] [data-pane-bar] button[aria-label="Dividir a la derecha"]').closest(".pointer-events-none")).opacity === "1"`, "al pasar el cursor aparecen los controles del panel");
      const reach = await p.evaluate(`(() => {
        const bar = document.querySelector('[data-pane-id="${id}"] [data-pane-bar]');
        const out = {};
        for (const name of ["Claude Code", "Codex CLI"]) {
          const b = bar.querySelector('button[aria-label="Abrir ' + name + ' en este panel"]');
          const r = b.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          out[name] = Boolean(hit && b.contains(hit));
        }
        // La ruta se recorta por el principio: el final (dónde estás) se ve.
        const path = bar.querySelector('[dir="rtl"]');
        const text = path.firstElementChild.firstChild;
        const range = document.createRange();
        range.setStart(text, text.length - 8);
        range.setEnd(text, text.length);
        const tail = range.getBoundingClientRect();
        const box = path.getBoundingClientRect();
        out.truncated = path.scrollWidth > path.clientWidth;
        // El nombre del panel no se recorta mientras la ruta tenga de dónde ceder.
        const name = path.parentElement.previousElementSibling;
        out.nameWhole = name.scrollWidth <= name.clientWidth;
        out.tailVisible = tail.left >= box.left - 1 && tail.right <= box.right + 1;
        return out;
      })()`);
      if (!reach["Claude Code"] || !reach["Codex CLI"]) throw new Error(`Los botones de agente quedan tapados: ${JSON.stringify(reach)}`);
      if (!reach.tailVisible) throw new Error(`El final de la ruta debe verse: ${JSON.stringify(reach)}`);
      if (!reach.nameWhole) throw new Error(`La ruta debe ceder antes que el nombre del panel: ${JSON.stringify(reach)}`);
      await p.screenshot("barra-ruta-larga");
      // Clic derecho en la barra: las mismas acciones en un menú.
      await p.evaluate(`(() => {
        const bar = document.querySelector('[data-pane-id="${id}"] [data-pane-bar]');
        const r = bar.getBoundingClientRect();
        bar.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10 }));
        return true;
      })()`);
      await p.waitFor(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].some((b) => b.textContent.includes("Dividir a la derecha"))`, "el clic derecho trae las acciones del panel");
      await p.press("Escape");
      await p.waitFor(`!document.querySelector('[role="menu"]')`, "Esc cierra el menú");
      await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const s = useTerminalStore.getState();
        s.closeTab(s.activeTabId);`);
    },
  },
  {
    name: "barra-del-panel",
    async run(p) {
      await p.shortcut("newTab");
      await p.run(`
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const s = useTerminalStore.getState();
        const id = s.tabs.find((t) => t.id === s.activeTabId).activePaneId;
        for (let i = 0; i < 75 && !terminalManager.getTerminal(id); i++) await new Promise((r) => setTimeout(r, 40));`);
      const helpers = `
        const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
        const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
        const s = useTerminalStore.getState();
        const id = s.tabs.find((t) => t.id === s.activeTabId).activePaneId;
        const inst = terminalManager.instances.get(id);
        const flush = () => new Promise((resolve) => inst.term.write("", resolve));
        const recv = (t) => terminalManager.receiveForTesting(id, t);
        const bar = () => document.querySelector('[data-pane-id="' + id + '"] [data-pane-bar]');
        const launcher = (name) => bar()?.querySelector('button[aria-label="Abrir ' + name + ' en este panel"]');
        const writes = () => inst.pendingInput.map((w) => w.args.data);
        const tabPanes = async () => (await mod("/src/lib/layout.ts")).collectPanes(useTerminalStore.getState().tabs.find((t) => t.id === useTerminalStore.getState().activeTabId).root);`;
      // Una shell sola ya lleva su barra: el logo, su carpeta y los agentes instalados.
      const id = await p.run(`${helpers}
        s.setAgents({ claude: "/x/claude", codex: "/x/codex", gh: null, editors: [], claudeSettingsPath: "/x/claude-settings.json", mcpConfigPath: null });
        // La integración da su primer prompt: la shell está libre.
        recv("\\x1b]7;file://h/Users/e2e/Kiosko\\x07\\x1b]133;A\\x07% ");
        await flush();
        return id;`);
      await p.waitFor(`document.querySelector('[data-pane-id="${id}"] button[aria-label="Abrir Claude Code en este panel"]')`, "la barra ofrece abrir Claude Code ahí");
      await p.waitFor(`document.querySelector('[data-pane-id="${id}"] button[aria-label="Abrir Codex CLI en este panel"]')`, "y Codex");
      await p.screenshot("barra-del-panel");

      // Clic en Claude Code: se teclea `claude` en ESA shell (sin dividir), sobre lo que hubiera a medio escribir.
      const typed = await p.run(`${helpers}
        const info = terminalManager.info;
        terminalManager.info = async () => ({ busy: false, foregroundName: "zsh", foregroundPid: 1, cwd: "/Users/e2e/Kiosko" });
        inst.pendingInput.length = 0;
        try {
          launcher("Claude Code").click();
          for (let i = 0; i < 50 && !writes().length; i++) await new Promise((r) => setTimeout(r, 40));
        } finally {
          terminalManager.info = info;
        }
        return { writes: writes(), panes: (await tabPanes()).length };`);
      if (JSON.stringify(typed.writes) !== JSON.stringify(["\x05\x15claude\r"]) || typed.panes !== 1) throw new Error(`Abrir Claude aquí: ${JSON.stringify(typed)}`);

      // La shell dice que corre `claude`: la misma barra pasa a ser la del agente (sin esperar a OSC 7501).
      await p.run(`${helpers}
        recv("claude\\r\\n\\x1b]633;E;claude\\x07\\x1b]133;C\\x07");
        await flush();
        useTerminalStore.getState().setAgentStatus({ paneId: id, model: "Opus 5.5", contextPercent: 38, costUsd: null });`);
      await p.waitFor(`document.querySelector('[data-pane-id="${id}"] > div button[aria-pressed]')`, "la barra del agente trae su terminal acoplada");
      const agentBar = await p.run(`${helpers} return { text: bar().innerText, launchers: Boolean(launcher("Claude Code")), running: useTerminalStore.getState().runningAgent[id] ?? null };`);
      if (!agentBar.text.includes("62%") || agentBar.launchers || agentBar.running !== "claude") throw new Error(`Barra del agente: ${JSON.stringify(agentBar)}`);
      await p.screenshot("barra-del-panel-agente");

      // Sale el agente: vuelve la shell, sin el modelo ni el contexto de esa sesión.
      const back = await p.run(`${helpers}
        recv("\\x1b]133;D;0\\x07\\x1b]133;A\\x07% ");
        await flush();
        await new Promise((r) => setTimeout(r, 50));
        return { launchers: Boolean(launcher("Claude Code")), status: Boolean(useTerminalStore.getState().agentStatus[id]), terminal: Boolean(bar().querySelector("button[aria-pressed]")) };`);
      if (!back.launchers || back.status || back.terminal) throw new Error(`Al salir del agente: ${JSON.stringify(back)}`);

      // `clear` no se la lleva: vive fuera de la terminal.
      const cleared = await p.run(`${helpers}
        recv("clear\\r\\n\\x1b]633;E;clear\\x07\\x1b]133;C\\x07\\x1b[3J\\x1b[H\\x1b[2J\\x1b]133;D;0\\x07\\x1b]133;A\\x07% ");
        await flush();
        return Boolean(launcher("Claude Code"));`);
      if (!cleared) throw new Error("clear se llevó la barra");

      // Con algo corriendo, el clic no teclea encima: abre el agente junto al panel y avisa.
      const busy = await p.run(`${helpers}
        const info = terminalManager.info;
        terminalManager.info = async () => ({ busy: true, foregroundName: "vite", foregroundPid: 9, cwd: "/Users/e2e/Kiosko" });
        inst.pendingInput.length = 0;
        try {
          launcher("Codex CLI").click();
          for (let i = 0; i < 50 && (await tabPanes()).length < 2; i++) await new Promise((r) => setTimeout(r, 40));
        } finally {
          terminalManager.info = info;
        }
        const panes = await tabPanes();
        return { writes: writes(), agents: panes.map((p) => p.agentType), toast: document.body.innerText.includes("vite sigue corriendo") };`);
      if (busy.writes.length || JSON.stringify(busy.agents) !== JSON.stringify([null, "codex"]) || !busy.toast) throw new Error(`Con algo corriendo: ${JSON.stringify(busy)}`);
      await p.shortcut("closePane");

      // Sin la barra en Ajustes, una shell sola usa todo el panel; un agente la lleva igual.
      const off = await p.run(`${helpers}
        (await mod("/src/store/settingsStore.ts")).useSettingsStore.getState().update({ paneBar: false });
        await new Promise((r) => setTimeout(r, 50));
        const shell = Boolean(bar());
        recv("codex\\r\\n\\x1b]633;E;codex\\x07\\x1b]133;C\\x07");
        await flush();
        await new Promise((r) => setTimeout(r, 50));
        const agent = Boolean(bar()?.querySelector("button[aria-pressed]"));
        recv("\\x1b]133;D;0\\x07\\x1b]133;A\\x07% ");
        await flush();
        (await mod("/src/store/settingsStore.ts")).useSettingsStore.getState().update({ paneBar: true });
        return { shell, agent };`);
      if (off.shell || !off.agent) throw new Error(`Barra apagada en Ajustes: ${JSON.stringify(off)}`);
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
