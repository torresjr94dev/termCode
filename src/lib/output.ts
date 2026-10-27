import { useProjectStore } from "../store/projectStore";
import { liveAgent, useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { terminalManager } from "../terminal/TerminalManager";
import type { CommandRecord } from "../terminal/commands";
import { actions } from "./actions";
import { collectPanes } from "./layout";

/** Lo que cabe en el visor: una salida de más (p. ej. un `cat` de un log enorme) se corta al final. */
const VIEWER_CHARS = 2_000_000;
/** Lo que se le manda al agente: el final, que es donde está el error. */
const AGENT_LINES = 150;
const AGENT_CHARS = 12_000;

const toast = (text: string, tone: "info" | "error" = "info") => useUiStore.getState().showToast(text, tone);

/** El registro pedido o el último del panel; avisa si no hay integración con la shell. */
function recordOf(paneId: string, record?: CommandRecord): CommandRecord | null {
  const tracker = terminalManager.getTracker(paneId);
  const found = record ?? tracker?.last();
  if (!found) {
    toast(
      tracker?.integrated
        ? "Este panel aún no ha corrido ningún comando."
        : "Ver la salida de un comando necesita la integración con la shell (Ajustes → Terminal).",
    );
    return null;
  }
  return found;
}

let nextOutputId = 1;

/** La salida completa de un comando en el visor: se lee entera y se busca con ⌘F. */
export function openOutput(paneId: string, record?: CommandRecord) {
  const found = recordOf(paneId, record);
  if (!found) return;
  const text = terminalManager.getTracker(paneId)?.output(found, VIEWER_CHARS) ?? "";
  useProjectStore.getState().set({
    viewer: {
      kind: "output",
      id: nextOutputId++,
      paneId,
      command: found.command,
      cwd: found.cwd,
      exitCode: found.endedAt === null ? null : found.exitCode,
      running: found.endedAt === null,
      durationMs: (found.endedAt ?? Date.now()) - found.startedAt,
      text,
      truncated: text.length >= VIEWER_CHARS,
    },
  });
}

/** Las últimas líneas de una salida, con el corte señalado. */
export function tailOf(text: string, lines = AGENT_LINES, chars = AGENT_CHARS): string {
  const all = text.split("\n");
  let tail = all.slice(-lines).join("\n");
  if (tail.length > chars) tail = tail.slice(-chars);
  return tail.length < text.length ? `[… ${all.length - Math.min(all.length, lines)} líneas antes]\n${tail}` : tail;
}

/** El mensaje para el agente: qué se corrió, dónde, cómo terminó y el final de la salida. */
export function explainPrompt(command: string, cwd: string | null, exitCode: number | null, output: string): string {
  const where = cwd ? ` en \`${cwd}\`` : "";
  const how = exitCode === null ? "no terminó bien" : `terminó con código ${exitCode}`;
  return [
    `Corrí \`${command}\`${where} y ${how}. Explícame la causa del error y cómo arreglarlo; si es un cambio en el código, hazlo.`,
    "",
    "Salida:",
    "```",
    tailOf(output) || "(sin salida)",
    "```",
  ].join("\n");
}

/**
 * «Explicar este error»: el comando, su carpeta y el final de su salida al
 * agente. Si ya hay uno abierto, se le pega (tú pulsas Enter, como con las
 * revisiones); si no, se abre Claude (o Codex) junto al panel con ese mensaje.
 */
export function explainFailure(paneId: string, record?: CommandRecord) {
  const found = recordOf(paneId, record);
  if (!found) return;
  const output = terminalManager.getTracker(paneId)?.output(found) ?? "";
  const prompt = explainPrompt(found.command.split("\n")[0], found.cwd, found.exitCode, output);
  const store = useTerminalStore.getState();
  const hasAgent = store.tabs.some((t) => collectPanes(t.root).some((p) => liveAgent(store, p)));
  if (hasAgent) {
    actions.sendTextToAgent(prompt);
    toast("Error pegado en el agente: revísalo y pulsa Enter para mandarlo.");
    return;
  }
  const agents = useTerminalStore.getState().agents;
  const agent = !agents || agents.claude ? "claude" : agents.codex ? "codex" : null;
  if (!agent) {
    toast("No hay ningún agente instalado (Claude Code o Codex) para explicar el error.", "error");
    return;
  }
  void actions.openAgentInSplit(agent, prompt);
}
