#!/usr/bin/env node
/**
 * Capturas del README (docs/screenshots/*.webp) con datos de demostración.
 *
 * Usa el arnés de las e2e, pero cada escena arranca en una página recién
 * cargada (sin lo que dejó la anterior), espera a que terminen animaciones y
 * fuentes, quita los avisos y captura a 2x. Lo que se ve dentro de las
 * terminales se inyecta: fuera de Tauri no hay PTY ni agentes de verdad.
 *
 *   pnpm capturas                 # todas
 *   pnpm capturas -- consumo      # solo las que contienen "consumo"
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ROOT, VITE_PORT, connect, makePage, sleep, startChrome, startVite, waitForHttp } from "./harness.mjs";

const OUT = join(ROOT, "docs", "screenshots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 2;
const QUALITY = 92;
const RUN_TIMEOUT_MS = 3 * 60_000;
const filter = process.argv.slice(2).find((a) => a !== "--");

/* ------------------------------------------------------------------ */
/* Datos de demostración                                               */
/* ------------------------------------------------------------------ */

const HOME = "/Users/demo";
const REPO = `${HOME}/dev/tienda`;

/** Ayudas que cada escena tiene dentro de la página (`p.run`). */
const DEMO = `
  const { useTerminalStore } = await mod("/src/store/terminalStore.ts");
  const { useProjectStore } = await mod("/src/store/projectStore.ts");
  const { useApprovalStore } = await mod("/src/store/approvalStore.ts");
  const { useSystemStore } = await mod("/src/lib/system.ts");
  const { useSidebarStore } = await mod("/src/store/sidebarStore.ts");
  const { terminalManager } = await mod("/src/terminal/TerminalManager.ts");
  const { collectPanes } = await mod("/src/lib/layout.ts");
  const { actions } = await mod("/src/lib/actions.ts");
  const { gitApi } = await mod("/src/lib/git.ts");
  const project = await mod("/src/lib/project.ts");
  const store = () => useTerminalStore.getState();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const activeTab = () => store().tabs.find((t) => t.id === store().activeTabId);
  const panesOf = (tab) => collectPanes(tab.root);
  const ready = async (id) => {
    for (let i = 0; i < 100 && !terminalManager.getTerminal(id); i++) await wait(30);
    if (!terminalManager.getTerminal(id)) throw new Error("la terminal " + id + " no se montó");
  };
  const write = async (id, text) => {
    await ready(id);
    terminalManager.receiveForTesting(id, text.replace(/\\n/g, "\\r\\n"));
    await new Promise((resolve) => terminalManager.getTerminal(id).write("", resolve));
  };
  // Hasta que ningún terminal cambie de tamaño entre dos vistazos.
  const settleLayout = async () => {
    let last = "";
    for (let i = 0; i < 40; i++) {
      await wait(80);
      const sizes = [...terminalManager.instances.values()].map((inst) => inst.term.cols + "x" + inst.term.rows).join(",");
      if (sizes === last) return;
      last = sizes;
    }
  };
  const b64 = (t) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
  const osc = (id, body) => write(id, "\\x1b]7501;" + body + "\\x1b\\\\");
  const cwdMark = (cwd) => "\\x1b]7;file://mac" + cwd + "\\x07";
  const prompt = (cwd) => "\\x1b]133;A\\x07" + cwdMark(cwd) + "\\x1b[1;36m" + cwd.split("/").pop() + "\\x1b[0m \\x1b[2mmain\\x1b[0m % ";
  const command = (cmd) => cmd + "\\n\\x1b]633;E;" + cmd + "\\x07\\x1b]133;C\\x07";
  // Los agentes (TUI) esconden el cursor de la terminal mientras pintan.
  const HIDE_CURSOR = "\\x1b[?25l";
  const finished = (code = 0) => "\\x1b]133;D;" + code + "\\x07";
  const REPO = ${JSON.stringify(REPO)};
  const HOME = ${JSON.stringify(HOME)};
`;

const ESC = "\x1b[";
const dim = (t) => `${ESC}2m${t}${ESC}0m`;
const green = (t) => `${ESC}32m${t}${ESC}0m`;
const red = (t) => `${ESC}31m${t}${ESC}0m`;
const bold = (t) => `${ESC}1m${t}${ESC}0m`;
const cyan = (t) => `${ESC}36m${t}${ESC}0m`;
const orange = (t) => `${ESC}38;5;209m${t}${ESC}0m`;

/** Una sesión de Claude Code a medio trabajo (las cadenas de su interfaz van en inglés, como en la real). */
const CLAUDE_SESSION = [
  `${dim(">")} agrega cupones de descuento al carrito: porcentaje y monto fijo, con tests`,
  "",
  `${green("⏺")} Primero reviso cómo se calcula hoy el total del carrito.`,
  "",
  `${green("⏺")} ${bold("Read")}(src/cart/total.ts)`,
  `  ${dim("⎿")}  Read ${bold("64")} lines`,
  "",
  `${green("⏺")} ${bold("Update")}(src/cart/total.ts)`,
  `  ${dim("⎿")}  Updated src/cart/total.ts with ${bold("4")} additions and ${bold("1")} removal`,
  `      ${dim("17")}    const subtotal = sum(items.map(lineTotal));`,
  `      ${dim("18")} ${red("-  return subtotal + shipping;")}`,
  `      ${dim("18")} ${green("+  const discount = coupon")}`,
  `      ${dim("19")} ${green("+    ? applyCoupon(subtotal, coupon)")}`,
  `      ${dim("20")} ${green("+    : 0;")}`,
  `      ${dim("21")} ${green("+  return Math.max(0, subtotal - discount) + shipping;")}`,
  "",
  `${green("⏺")} ${bold("Write")}(src/cart/coupons.test.ts)`,
  `  ${dim("⎿")}  Wrote ${bold("42")} lines to src/cart/coupons.test.ts`,
  "",
  `${green("⏺")} ${bold("Bash")}(pnpm test src/cart)`,
  `  ${dim("⎿")}  ${green("✓")} src/cart/total.test.ts (8 tests) 9ms`,
  `     ${green("✓")} src/cart/coupons.test.ts (6 tests) 14ms`,
  `     Test Files  ${green("2 passed")} (2)`,
  "",
  `${green("⏺")} Los 14 tests pasan. Falta validar que un cupón vencido no aplique.`,
  "",
  `${orange("✻")} ${orange("Editando src/cart/coupons.ts…")} ${dim("(esc to interrupt)")}`,
].join("\n");

const VITE_SESSION = [
  "",
  `  ${green(bold("VITE"))} ${green("v6.4.4")}  ${dim("ready in")} ${bold("412")} ${dim("ms")}`,
  "",
  `  ${green("➜")}  ${bold("Local")}:   ${cyan("http://localhost:5173/")}`,
  `  ${dim("➜  Network: use --host to expose")}`,
  "",
  `${dim("10:42:18")} ${cyan(bold("[vite]"))} ${green("hmr update")} ${dim("/src/cart/total.ts")}`,
  `${dim("10:42:31")} ${cyan(bold("[vite]"))} ${green("hmr update")} ${dim("/src/cart/coupons.ts")}`,
  `${dim("10:43:02")} ${cyan(bold("[vite]"))} ${green("hmr update")} ${dim("/src/cart/CartSummary.tsx")}`,
].join("\n");

const TEST_SESSION = [
  "",
  ` ${cyan(bold("DEV"))}  ${cyan("v5.0.5")} ${dim(REPO)}`,
  "",
  ` ${green("✓")} src/cart/total.test.ts ${dim("(8 tests)")} ${dim("9ms")}`,
  ` ${green("✓")} src/cart/coupons.test.ts ${dim("(6 tests)")} ${dim("14ms")}`,
  ` ${green("✓")} src/catalog/search.test.ts ${dim("(11 tests)")} ${dim("21ms")}`,
  "",
  ` ${dim("Test Files")}  ${green(bold("3 passed"))} ${dim("(3)")}`,
  `      ${dim("Tests")}  ${green(bold("25 passed"))} ${dim("(25)")}`,
  `   ${dim("Duration")}  612ms`,
  "",
  ` ${green(bold("PASS"))}  ${dim("Waiting for file changes...")}`,
].join("\n");

const CODEX_SESSION = [
  `${dim("›")} migra el endpoint de pedidos a zod y valida el body`,
  "",
  `${dim("•")} Explored`,
  `  ${dim("└")} Read src/api/orders.ts, src/api/schema.ts`,
  "",
  `${dim("•")} Edited src/api/orders.ts ${green("(+18")} ${red("-6)")}`,
  "",
  `${dim("•")} Necesito instalar zod para validar el body.`,
].join("\n");

const DOCS_SESSION = [
  `${dim(">")} escribe la sección de cupones en docs/checkout.md`,
  "",
  `${green("⏺")} ${bold("Write")}(docs/checkout.md)`,
  `  ${dim("⎿")}  Wrote ${bold("38")} lines to docs/checkout.md`,
  "",
  `${green("⏺")} Listo: la sección explica los dos tipos de cupón y sus límites.`,
].join("\n");

const REVIEW_DIFF = [
  "diff --git a/src/cart/coupons.ts b/src/cart/coupons.ts",
  "index 3f2a1c4..9b8e7d2 100644",
  "--- a/src/cart/coupons.ts",
  "+++ b/src/cart/coupons.ts",
  "@@ -1,14 +1,20 @@",
  ' import type { Coupon } from "./types";',
  ' import { roundCents } from "../money";',
  " ",
  "-export function applyCoupon(subtotal: number, coupon: Coupon): number {",
  "-  return coupon.kind === \"percent\" ? subtotal * (coupon.value / 100) : coupon.value;",
  "+/** Lo que descuenta el cupón: nunca más que el subtotal ni un cupón vencido. */",
  "+export function applyCoupon(subtotal: number, coupon: Coupon, now = new Date()): number {",
  "+  if (coupon.expiresAt && coupon.expiresAt < now) return 0;",
  "+  if (subtotal < (coupon.minSubtotal ?? 0)) return 0;",
  "+  const raw = coupon.kind === \"percent\" ? subtotal * (coupon.value / 100) : coupon.value;",
  "+  return roundCents(Math.min(raw, subtotal));",
  " }",
  " ",
  "-export function isValidCode(code: string): boolean {",
  "-  return code.length > 0;",
  "+const CODE = /^[A-Z0-9]{4,16}$/;",
  "+",
  "+export function isValidCode(code: string): boolean {",
  "+  return CODE.test(code.trim().toUpperCase());",
  " }",
  " ",
  ' export function describe(coupon: Coupon): string {',
  '   return coupon.kind === "percent" ? `${coupon.value} %` : `$${coupon.value}`;',
  " }",
  "",
].join("\n");

/* ------------------------------------------------------------------ */
/* Escenas                                                             */
/* ------------------------------------------------------------------ */

// Cortas a propósito: la bandeja es angosta y parte las líneas largas.
const COUPON_BEFORE = ["  const off = isPercent(c) ? total * c.rate : c.amount;", "  return off;"].join("\n");
const COUPON_AFTER = ["  if (c.expiresAt && c.expiresAt < now) return 0;", "  const off = isPercent(c) ? total * c.rate : c.amount;", "  return roundCents(Math.min(off, total));"].join("\n");

/**
 * La sesión de trabajo que comparten las escenas: la pestaña «tienda» con
 * Claude a la izquierda y el servidor y los tests a la derecha, más dos
 * pestañas con otros agentes. Deja en `ids` los paneles. Primero el layout
 * (barra lateral, divisiones) y después la salida: escrita antes de que el
 * panel tome su ancho, xterm la partiría en otra columna.
 */
const WORKSPACE = `
  ${DEMO}
  const ids = await (async () => {
  store().setAgents({ claude: "/opt/bin/claude", codex: "/opt/bin/codex", gh: "/opt/bin/gh", editors: ["code"], claudeSettingsPath: null, mcpConfigPath: null });
  const repoMeta = (root) => ({ root, name: root.split("/").pop(), remoteUrl: null, webUrl: null, host: "github", defaultBranch: "main" });
  gitApi.repo = async (cwd) => repoMeta(cwd.startsWith(HOME + "/dev/api") ? HOME + "/dev/api" : REPO);
  gitApi.status = async () => ({ branch: "feat/cupones", head: "9b8e7d2", upstream: "origin/feat/cupones", ahead: 2, behind: 0, operation: null, changes: [
    { path: "src/cart/coupons.ts", origPath: null, index: ".", worktree: "M", untracked: false, conflicted: false },
    { path: "src/cart/total.ts", origPath: null, index: ".", worktree: "M", untracked: false, conflicted: false },
    { path: "src/cart/CartSummary.tsx", origPath: null, index: ".", worktree: "M", untracked: false, conflicted: false },
    { path: "src/cart/coupons.test.ts", origPath: null, index: ".", worktree: "?", untracked: true, conflicted: false },
  ] });
  const TREE = {
    "": [["src", true], ["docs", true], ["package.json", false], ["README.md", false], ["tsconfig.json", false], ["vite.config.ts", false]],
    "src": [["cart", true], ["catalog", true], ["api", true], ["main.tsx", false], ["money.ts", false]],
    "src/cart": [["CartSummary.tsx", false], ["coupons.test.ts", false], ["coupons.ts", false], ["total.test.ts", false], ["total.ts", false], ["types.ts", false]],
  };
  gitApi.list = async (root, path) => (TREE[path] ?? []).map(([name, isDir]) => ({ name, path: path ? path + "/" + name : name, isDir, size: 1200, ignored: false }));
  if (!store().isSidebarOpen) store().toggleSidebar();
  useProjectStore.setState({ isOpen: false });

  // Pestaña 1: tienda. Claude a la izquierda; a la derecha, el servidor arriba y los tests abajo.
  const first = activeTab();
  store().replacePane(first.activePaneId, { title: "Claude Code", agentType: "claude", command: "claude", cwd: REPO });
  const claude = activeTab().activePaneId;
  store().splitPane(claude, "horizontal", { title: "zsh", cwd: REPO });
  const dev = panesOf(activeTab()).find((p) => p.id !== claude).id;
  store().splitPane(dev, "vertical", { title: "zsh", cwd: REPO });
  const tests = panesOf(activeTab()).find((p) => p.id !== claude && p.id !== dev).id;
  if (activeTab().root.type === "split") store().updateSplitRatio(activeTab().root.id, 0.6);

  // Pestaña 2: Codex en la API, esperando permiso. Pestaña 3: Claude en la documentación, terminó.
  store().createTab({ title: "Codex", agentType: "codex", command: "codex", cwd: HOME + "/dev/api" });
  const codexTab = activeTab();
  const codex = codexTab.activePaneId;
  store().createTab({ title: "Claude Code", agentType: "claude", command: "claude", cwd: REPO + "/docs" });
  const docsTab = activeTab();
  const docs = docsTab.activePaneId;

  // Cada pestaña se ve (y toma su tamaño) antes de escribir en ella.
  const show = async (tabId, paneId, panes) => {
    actions.focusPane(tabId, paneId);
    for (const id of panes) await ready(id);
    await settleLayout();
  };
  await show(codexTab.id, codex, [codex]);
  await write(codex, ${JSON.stringify(CODEX_SESSION)} + HIDE_CURSOR);
  await osc(codex, "state=blocked:kind=permission:app=codex:msg=" + b64("Bash: pnpm add zod"));
  store().setAgentStatus({ paneId: codex, model: null, contextPercent: 41, costUsd: null });

  await show(docsTab.id, docs, [docs]);
  await write(docs, ${JSON.stringify(DOCS_SESSION)} + HIDE_CURSOR);
  await osc(docs, "state=done:app=claude-code:msg=" + b64("Listo: sección de cupones en docs/checkout.md"));
  store().setAgentStatus({ paneId: docs, model: "Sonnet 5.5", contextPercent: 12, costUsd: 0.31 });

  await show(first.id, claude, [claude, dev, tests]);
  await write(dev, prompt(REPO) + command("pnpm dev") + "\\x1b]2;pnpm dev\\x07" + ${JSON.stringify(VITE_SESSION)});
  await write(tests, prompt(REPO) + command("pnpm test --watch") + "\\x1b]2;pnpm test\\x07" + ${JSON.stringify(TEST_SESSION)});
  await write(claude, ${JSON.stringify(CLAUDE_SESSION)} + HIDE_CURSOR);
  await osc(claude, "state=working:app=claude-code:msg=" + b64("Editando src/cart/coupons.ts"));
  store().setAgentStatus({ paneId: claude, model: "Opus 5.5", contextPercent: 34, costUsd: 1.42 });
  store().setPanePorts({ [dev]: [5173] });

  for (const id of [claude, dev, tests]) store().setPaneProject(id, { cwd: REPO, name: "tienda", root: REPO });
  store().setPaneProject(codex, { cwd: HOME + "/dev/api", name: "api", root: HOME + "/dev/api" });
  store().setPaneProject(docs, { cwd: REPO + "/docs", name: "tienda", root: REPO });

  const GB = 1024 ** 3;
  for (let i = 0; i < 40; i++) {
    useSystemStore.getState().push({ cpuPercent: 18 + ((i * 7) % 23), cpuCount: 10, cpuCores: [42, 18, 30, 12, 55, 8, 21, 5, 14, 9], loadAverage: [2.4, 2.1, 1.9], uptimeSecs: 86400 * 3 + 7200, memoryUsed: 10.4 * GB, memoryTotal: 16 * GB, memoryAvailable: 5.6 * GB, swapUsed: 0, swapTotal: 0, memoryPressure: "normal", gpuPercent: 6 + (i % 5) * 3, gpuMemory: 1.4 * GB, top: [{ pid: 7, name: "node", cpuPercent: 24, memory: 1.1 * GB }, { pid: 8, name: "claude", cpuPercent: 6, memory: 0.42 * GB }, { pid: 9, name: "termCode", cpuPercent: 3, memory: 0.35 * GB }] });
  }
  useSidebarStore.getState().hydrate({ recent: [{ path: REPO, at: 3 }, { path: HOME + "/dev/api", at: 2 }, { path: HOME + "/dev/blog", at: 1 }], pinned: [REPO], collapsed: {} });

  // Fuera de Tauri el panel de proyecto no sigue al panel activo: se le dice dónde está.
  useProjectStore.setState({ cwd: REPO, repo: repoMeta(REPO), tree: {}, expanded: { src: true, "src/cart": true } });
  await project.refreshStatus({ force: true });
  for (const dir of ["", "src", "src/cart"]) await project.loadDir(dir);
  return { claude, dev, tests, codex, docs, tab: first.id, codexTab: codexTab.id, docsTab: docsTab.id };
  })();
`;

const HOUR = 3600e3;
/** Tokens por hora de las últimas 24 h (la última es la hora en curso): una jornada de trabajo. */
const TOKENS_BY_HOUR = [36, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 14, 52, 98, 136, 84, 26, 60, 118, 174, 212, 166, 94].map((k) => k * 1000);

const SCENES = [
  {
    name: "principal",
    alt: "termCode con Claude Code trabajando a la izquierda, el servidor de desarrollo y los tests a la derecha, y la barra lateral con las sesiones, las carpetas y el sistema",
    async run(p) {
      await p.run(WORKSPACE);
    },
  },
  {
    name: "mission-control",
    alt: "Mission Control: tres agentes con su estado (trabajando, te necesita, esperando instrucciones), el contexto que les queda, su modelo y su costo",
    async run(p) {
      await p.run(WORKSPACE);
      await p.shortcut("missionControl");
      await p.waitFor(`document.querySelectorAll('[aria-label="Mission Control de agentes"] article').length === 3`, "Mission Control muestra los tres agentes");
    },
    // Las tarjetas ocupan la parte de arriba: debajo solo hay fondo.
    clip: `(() => {
      const bottom = Math.max(...[...document.querySelectorAll('[aria-label="Mission Control de agentes"] article')].map((a) => a.getBoundingClientRect().bottom));
      return { x: 0, y: 0, width: innerWidth, height: Math.ceil(bottom + 32) };
    })()`,
  },
  {
    name: "aprobaciones",
    alt: "La bandeja de aprobaciones: desde otra pestaña, el cambio completo que Claude Code pide permiso para hacer, con Permitir y Denegar",
    async run(p) {
      await p.run(`${WORKSPACE}
        await osc(ids.claude, "state=blocked:kind=permission:app=claude-code:msg=" + b64("Edit: src/cart/coupons.ts"));
        actions.focusPane(ids.docsTab, ids.docs);
        useApprovalStore.getState().add({ id: "ap-demo", paneId: ids.claude, tool: "Edit", cwd: REPO, at: Date.now() - 6000, expiresAt: Date.now() + 84000,
          input: { file_path: REPO + "/src/cart/coupons.ts", old_string: ${JSON.stringify(COUPON_BEFORE)}, new_string: ${JSON.stringify(COUPON_AFTER)} } });`);
      await p.waitFor(`document.querySelector('[aria-label="Permisos pendientes"]')?.textContent.includes("coupons.ts")`, "la bandeja muestra el cambio");
    },
  },
  {
    name: "revision",
    alt: "Revisar cambios: el diff de lo que hizo el agente desde tu último mensaje, con un comentario en una línea listo para enviarle",
    async run(p) {
      await p.run(`${WORKSPACE}
        gitApi.reviewDiff = async () => ({ text: ${JSON.stringify(REVIEW_DIFF)}, truncated: false });
        await project.openDiff({ kind: "review", base: "4e1d0c2", path: "src/cart/coupons.ts", origPath: null, created: false, root: REPO, label: "desde tu último mensaje", paneId: ids.claude });`);
      await p.waitFor(`document.querySelector('[data-viewer] button[aria-label="Comentar la línea 7"]')`, "cada línea se puede comentar");
      await p.click('[data-viewer] button[aria-label="Comentar la línea 7"]');
      await p.waitFor(`document.activeElement?.getAttribute("aria-label") === "Comentario para el agente"`, "se abre el campo del comentario");
      await p.type("minSubtotal va en centavos, como el resto de los montos.");
      await p.pressMod("Enter");
      await p.waitFor(`[...document.querySelectorAll("[data-viewer] button")].some((b) => b.textContent.includes("Enviar revisión (1)"))`, "el comentario queda pendiente");
    },
  },
  {
    name: "consumo",
    alt: "Consumo de IA: la ventana de 5 h de Claude y Codex contra el tiempo transcurrido, con la proyección del ritmo, la semana y los tokens por hora",
    async run(p) {
      await p.run(`${WORKSPACE}
        const now = Date.now();
        const tokens = ${JSON.stringify(TOKENS_BY_HOUR)};
        const iso = (ms) => new Date(ms).toISOString();
        store().setUsage({
          claude: { status: "ok", plan: "Pro", authMode: "subscription", source: "oauth", fetchedAt: now - 40e3, message: null,
            windows: [
              { kind: "session", label: "Sesión · 5 h", usedPercent: 46, resetsAt: iso(now + 2.2 * ${HOUR}), severity: null },
              { kind: "weekly_all", label: "Semana", usedPercent: 31, resetsAt: iso(now + 3.4 * 24 * ${HOUR}), severity: null },
            ],
            tokens24h: tokens.reduce((a, b) => a + b, 0), tokensByHour: tokens },
          codex: { status: "ok", plan: "Plus", authMode: "subscription", source: "session-log", fetchedAt: now - 95e3, message: null,
            windows: [
              { kind: "session", label: "Sesión · 5 h", usedPercent: 18, resetsAt: iso(now + 3.6 * ${HOUR}), severity: null },
              { kind: "weekly_all", label: "Semana", usedPercent: 9, resetsAt: iso(now + 5.1 * 24 * ${HOUR}), severity: null },
            ],
            tokens24h: null, tokensByHour: null },
        });
        if (!store().isUsageDrawerOpen) store().toggleUsageDrawer();`);
    },
  },
];

/* ------------------------------------------------------------------ */

async function settle(page) {
  // Fuentes cargadas, sin animaciones corriendo y dos frames pintados.
  await page.waitFor(`document.fonts.status === "loaded"`, "las fuentes cargan", 10_000);
  await page.waitFor(`document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity)`, "las animaciones terminan", 5000);
  await page.run(`(await mod("/src/store/uiStore.ts")).useUiStore.setState({ toast: null });`);
  await page.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  await sleep(250);
}

async function main() {
  const watchdog = setTimeout(() => {
    console.error(`capturas: la corrida excedió ${RUN_TIMEOUT_MS / 60_000} min; se aborta.`);
    process.exit(1);
  }, RUN_TIMEOUT_MS);
  watchdog.unref();
  const filters = filter ? filter.split(",").filter(Boolean) : [];
  const selected = SCENES.filter((s) => !filters.length || filters.some((f) => s.name.includes(f)));
  if (!selected.length) throw new Error(`Ninguna escena coincide con «${filter}».`);

  mkdirSync(OUT, { recursive: true });
  const vite = startVite();
  const profile = mkdtempSync(join(tmpdir(), "termcode-capturas-"));
  let chrome;
  try {
    await waitForHttp(`http://127.0.0.1:${VITE_PORT}/`, 30_000).catch((err) => {
      throw new Error(`${err.message}\n${vite.log()}`);
    });
    chrome = startChrome(profile, { width: WIDTH, height: HEIGHT, scale: SCALE });
    const cdp = await connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    // Alto exacto: la ventana de Chrome headless resta su marco del viewport.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });
    const page = makePage(cdp);

    for (const scene of selected) {
      const started = Date.now();
      // Cada escena en una página nueva: fuera de Tauri no se guarda nada entre cargas.
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${VITE_PORT}/` });
      await page.waitFor(`document.querySelector("#root")?.childElementCount > 0`, "la app arranca", 20_000);
      await page.waitFor(`document.querySelectorAll(".xterm").length === 1`, "la primera terminal se monta", 10_000);
      await page.run(`(await mod("/src/store/settingsStore.ts")).useSettingsStore.getState().update({ onboardingDone: true });`);
      await cdp.send("Page.bringToFront").catch(() => {});
      await scene.run(page);
      await settle(page);
      const clip = scene.clip ? await page.evaluate(scene.clip) : undefined;
      const file = join(OUT, `${scene.name}.webp`);
      writeFileSync(file, await page.capture({ format: "webp", quality: QUALITY, clip }));
      console.log(`  ✓ ${scene.name} (${Date.now() - started} ms)`);
    }
    const errors = cdp.errors.filter((e) => !/React DevTools|__TAURI|transformCallback/.test(e));
    if (errors.length) console.log(`  ! errores en la consola:\n    ${errors.slice(0, 8).join("\n    ")}`);
    cdp.ws.close();
  } finally {
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill();
      await Promise.race([exited, sleep(5000)]);
    }
    vite.proc.kill();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log(`\n${selected.length} captura(s) en docs/screenshots/`);
}

main()
  .catch((err) => {
    console.error(`capturas: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(), 5000).unref();
  });
