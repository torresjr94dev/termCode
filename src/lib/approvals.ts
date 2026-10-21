import { useApprovalStore, type ApprovalDecision, type ApprovalRequest } from "../store/approvalStore";
import { useTerminalStore } from "../store/terminalStore";
import { useUiStore } from "../store/uiStore";
import { settingsNow, useSettingsStore } from "../store/settingsStore";
import { findOwnerTab } from "./layout";
import { ipc } from "./ipc";
import { basename } from "./paths";

/* ------------------------------------------------------------------ */
/* Qué pide el agente, en piezas que se pueden mostrar completas       */
/* ------------------------------------------------------------------ */

export type ApprovalView =
  | { kind: "command"; command: string; description?: string }
  | { kind: "edit"; path: string; edits: Array<{ before: string; after: string }>; replaceAll?: boolean }
  | { kind: "write"; path: string; content: string }
  | { kind: "url"; url: string; prompt?: string }
  | { kind: "query"; query: string }
  | { kind: "raw"; json: string };

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Herramientas que conocemos se muestran con forma; el resto, como JSON completo. */
export function approvalView(tool: string, input: unknown): ApprovalView {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const raw = (): ApprovalView => ({ kind: "raw", json: JSON.stringify(input ?? null, null, 2) });
  switch (tool) {
    case "Bash": {
      const command = str(i.command);
      return command === undefined ? raw() : { kind: "command", command, description: str(i.description) };
    }
    case "Edit": {
      const path = str(i.file_path);
      const before = str(i.old_string);
      const after = str(i.new_string);
      if (path === undefined || before === undefined || after === undefined) return raw();
      return { kind: "edit", path, edits: [{ before, after }], replaceAll: i.replace_all === true };
    }
    case "MultiEdit": {
      const path = str(i.file_path);
      const edits = Array.isArray(i.edits) ? i.edits : null;
      if (path === undefined || !edits) return raw();
      const parsed = edits.map((e) => ({ before: str((e as Record<string, unknown>)?.old_string), after: str((e as Record<string, unknown>)?.new_string) }));
      if (parsed.some((e) => e.before === undefined || e.after === undefined)) return raw();
      return { kind: "edit", path, edits: parsed as Array<{ before: string; after: string }> };
    }
    case "Write": {
      const path = str(i.file_path);
      const content = str(i.content);
      return path === undefined || content === undefined ? raw() : { kind: "write", path, content };
    }
    case "NotebookEdit": {
      const path = str(i.notebook_path);
      const content = str(i.new_source);
      return path === undefined || content === undefined ? raw() : { kind: "write", path, content };
    }
    case "WebFetch": {
      const url = str(i.url);
      return url === undefined ? raw() : { kind: "url", url, prompt: str(i.prompt) };
    }
    case "WebSearch": {
      const query = str(i.query);
      return query === undefined ? raw() : { kind: "query", query };
    }
    default:
      return raw();
  }
}

/** `mcp__github__create_issue` → `github · create_issue`. */
export function toolLabel(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : tool;
}

/** Una línea para notificaciones y lectores de pantalla (aquí sí se resume). */
export function approvalSummary(request: Pick<ApprovalRequest, "tool" | "input">): string {
  const view = approvalView(request.tool, request.input);
  const short = (text: string) => {
    const line = text.split("\n")[0].trim();
    return line.length > 90 ? `${line.slice(0, 89)}…` : line;
  };
  const name = toolLabel(request.tool);
  switch (view.kind) {
    case "command":
      return `${name}: ${short(view.command)}`;
    case "edit":
    case "write":
      return `${name}: ${basename(view.path)}`;
    case "url":
      return `${name}: ${short(view.url)}`;
    case "query":
      return `${name}: ${short(view.query)}`;
    default:
      return name;
  }
}

/* ------------------------------------------------------------------ */
/* Decidir                                                             */
/* ------------------------------------------------------------------ */

const approvals = () => useApprovalStore.getState();

/**
 * Tu respuesta al agente. `ask` devuelve la pregunta a su panel. Si el
 * backend ya la soltó (tiempo agotado), se avisa: Claude te pregunta allí.
 */
export async function decideApproval(id: string, decision: ApprovalDecision, message?: string): Promise<boolean> {
  const request = approvals().requests.find((r) => r.id === id);
  approvals().remove(id);
  try {
    await ipc.approvalDecide(id, decision, message);
    // Respondiste: esa marca de atención ya está atendida.
    if (request && decision !== "ask") useTerminalStore.getState().setAttention(request.paneId, null);
    return true;
  } catch (err) {
    useUiStore.getState().showToast(String(err), "error");
    return false;
  }
}

/** Ir al panel: la pregunta vuelve a Claude y tú la contestas allí. */
export function answerInPane(request: ApprovalRequest) {
  void decideApproval(request.id, "ask").then(() => {
    const owner = findOwnerTab(useTerminalStore.getState().tabs, request.paneId);
    if (!owner) return;
    useTerminalStore.getState().setActiveTab(owner.id);
    useTerminalStore.getState().setActivePane(request.paneId);
  });
}

/* ------------------------------------------------------------------ */
/* Conexión con el backend                                             */
/* ------------------------------------------------------------------ */

interface ApprovalDeps {
  /** El usuario tiene ese panel al frente y la ventana enfocada. */
  isLookingAt: (paneId: string) => boolean;
  raiseAttention: (paneId: string, kind: string, message: string) => void;
}

/**
 * Si estás mirando el panel del agente, pregunta el panel (como siempre); si
 * no, la bandeja. Una solicitud cuyo panel pasas a mirar vuelve a él.
 */
export function startApprovals({ isLookingAt, raiseAttention }: ApprovalDeps): () => void {
  const release = () => {
    for (const request of approvals().requests) {
      if (isLookingAt(request.paneId)) void decideApproval(request.id, "ask");
    }
  };

  const onRequest = (request: ApprovalRequest) => {
    const exists = Boolean(findOwnerTab(useTerminalStore.getState().tabs, request.paneId));
    if (!exists || !settingsNow().approvalsInApp || isLookingAt(request.paneId)) {
      void ipc.approvalDecide(request.id, "ask").catch(() => {});
      return;
    }
    approvals().add(request);
    raiseAttention(request.paneId, "needs-input", approvalSummary(request));
  };

  const unlisteners = [
    ipc.onApprovalRequest(onRequest),
    ipc.onApprovalClosed(({ id }) => approvals().remove(id)),
  ];

  // El backend solo retiene solicitudes cuando la vista dice que escucha.
  const syncEnabled = (enabled: boolean) => void ipc.approvalsSetEnabled(enabled);
  syncEnabled(settingsNow().approvalsInApp);
  const unsubscribeSettings = useSettingsStore.subscribe((s, prev) => {
    if (s.settings.approvalsInApp === prev.settings.approvalsInApp) return;
    syncEnabled(s.settings.approvalsInApp);
    // Al desactivarla, lo pendiente vuelve a sus paneles.
    if (!s.settings.approvalsInApp) approvals().requests.forEach((r) => void decideApproval(r.id, "ask"));
  });
  // Tras recargar la vista: lo que el backend sigue esperando.
  void ipc.approvalsPending().then((pending) => pending?.forEach(onRequest));

  const unsubscribeTerminals = useTerminalStore.subscribe((s, prev) => {
    if (s.activeTabId !== prev.activeTabId || s.tabs !== prev.tabs) release();
  });
  window.addEventListener("focus", release);

  return () => {
    unsubscribeSettings();
    unsubscribeTerminals();
    window.removeEventListener("focus", release);
    unlisteners.forEach((p) => void p.then((unlisten) => unlisten()));
  };
}
