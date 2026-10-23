import { useProjectStore } from "../store/projectStore";
import { useSidebarStore } from "../store/sidebarStore";
import { useTerminalStore, type PaneSpec } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { terminalManager } from "../terminal/TerminalManager";
import { AGENTS, agentSpec } from "./actions";
import { gitApi } from "./git";
import { basename, joinPath } from "./paths";
import { projectRoot } from "./project";
import { parseWorkspace, WORKSPACE_FILE, WORKSPACE_TEMPLATE, type Workspace } from "./workspaceFile";

const ui = () => useUiStore.getState();

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Lo que vas a aprobar, tal cual se va a ejecutar. */
function describe(workspace: Workspace): string {
  const lines = workspace.panes.map((pane, i) => {
    const what = pane.agent ? AGENTS[pane.agent].title : pane.run ? `$ ${pane.run}` : "shell";
    return `${i + 1}. ${pane.title ? `${pane.title}: ` : ""}${what}${pane.cwd ? `  (en ${pane.cwd})` : ""}`;
  });
  return `${WORKSPACE_FILE} abre ${workspace.panes.length} panel${workspace.panes.length === 1 ? "" : "es"} y escribe estos comandos en ellos:\n\n${lines.join("\n")}\n\nSolo aprueba si conoces este repo. Si el archivo cambia, se vuelve a preguntar.`;
}

/**
 * Abre el workspace del proyecto (`.termcode.json` en la raíz). La primera
 * vez, y cada vez que el archivo cambia, muestra los comandos exactos y pide
 * confianza: un repo clonado no ejecuta nada en tu equipo sin tu sí.
 */
export async function openWorkspace() {
  const root = projectRoot();
  if (!root) {
    ui().showToast("No sé en qué proyecto está el panel activo.", "error");
    return;
  }
  let text: string;
  try {
    const preview = await gitApi.read(root, WORKSPACE_FILE);
    if (preview.binary || preview.truncated || !preview.utf8) throw new Error("no es un archivo de texto válido");
    text = preview.text;
  } catch (err) {
    ui().showToast(`No hay ${WORKSPACE_FILE} en ${basename(root)} (${err instanceof Error ? err.message : String(err)}).`, "error");
    return;
  }
  const parsed = parseWorkspace(text, useProjectStore.getState().repo?.name ?? basename(root));
  if (!parsed.ok) {
    ui().showToast(parsed.error, "error");
    return;
  }
  const key = `${root}#${await sha256(text)}`;
  if (useSidebarStore.getState().trustedWorkspaces.includes(key)) {
    launch(parsed.workspace, root);
    return;
  }
  ui().askConfirm({
    title: `¿Confiar en el workspace «${parsed.workspace.name}»?`,
    body: describe(parsed.workspace),
    confirmLabel: "Confiar y abrir",
    safeDefault: true,
    onConfirm: () => {
      useSidebarStore.getState().trustWorkspace(key);
      launch(parsed.workspace, root);
    },
  });
}

/** Una pestaña con los paneles en orden: cada uno se divide del anterior. */
function launch(workspace: Workspace, root: string) {
  const store = useTerminalStore.getState;
  const agents = store().agents;
  let previous: string | null = null;
  for (const pane of workspace.panes) {
    const cwd = pane.cwd ? joinPath(root, pane.cwd) : root;
    let spec: PaneSpec = { cwd, ...(pane.title ? { title: pane.title } : {}) };
    if (pane.agent) {
      if (agents && !agents[pane.agent]) {
        ui().showToast(`${AGENTS[pane.agent].title} no está instalado: ese panel abre una shell.`, "error");
      } else {
        spec = agentSpec(pane.agent, cwd, pane.title);
      }
    }
    if (previous === null) {
      store().createTab(spec);
      const { tabs, activeTabId } = store();
      previous = tabs.find((t) => t.id === activeTabId)?.activePaneId ?? null;
    } else {
      store().splitPane(previous, pane.split === "down" ? "vertical" : "horizontal", spec);
      const { tabs, activeTabId } = store();
      previous = tabs.find((t) => t.id === activeTabId)?.activePaneId ?? previous;
    }
    if (pane.run && previous && !spec.command) terminalManager.runWhenReady(previous, pane.run);
  }
  ui().showToast(`Workspace «${workspace.name}» abierto.`);
}

/** Para empezar uno: la plantilla, al portapapeles. */
export async function copyWorkspaceTemplate() {
  try {
    await navigator.clipboard.writeText(WORKSPACE_TEMPLATE);
    ui().showToast(`Plantilla copiada: guárdala como ${WORKSPACE_FILE} en la raíz de tu repo.`);
  } catch {
    ui().showToast("No se pudo copiar la plantilla.", "error");
  }
}
