import React, { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, ShieldQuestion, X } from "lucide-react";
import { useApprovalStore, type ApprovalRequest } from "../store/approvalStore";
import { useTerminalStore } from "../store/terminalStore";
import { answerInPane, approvalSummary, approvalView, decideApproval, toolLabel, type ApprovalView } from "../lib/approvals";
import { AGENTS } from "../lib/actions";
import { cn, findOwnerTab, findPane, tabLabel } from "../lib/layout";
import { useNow } from "../lib/useNow";
import { AgentGlyph } from "./ui";

const VERB: Record<ApprovalView["kind"], string> = {
  command: "Quiere ejecutar",
  edit: "Quiere editar",
  write: "Quiere escribir",
  url: "Quiere abrir",
  query: "Quiere buscar",
  raw: "Quiere usar",
};

/**
 * Permisos pendientes de los agentes, estés donde estés. Nunca toma el foco:
 * un Enter que ibas a mandar a la terminal no puede aprobar nada.
 */
export const ApprovalTray: React.FC = () => {
  const requests = useApprovalStore((s) => s.requests);
  if (!requests.length) return null;
  return (
    <section
      aria-label="Permisos pendientes"
      className="pointer-events-none fixed bottom-8 right-3 z-[45] flex w-[460px] max-w-[calc(100vw-24px)] flex-col items-end gap-2"
    >
      <ApprovalCard key={requests[0].id} request={requests[0]} position={1} total={requests.length} />
    </section>
  );
};

const ApprovalCard: React.FC<{ request: ApprovalRequest; position: number; total: number }> = ({ request, position, total }) => {
  const now = useNow(1000);
  const tabs = useTerminalStore((s) => s.tabs);
  const owner = findOwnerTab(tabs, request.paneId);
  const node = owner ? findPane(owner.root, request.paneId) : undefined;
  const pane = node && owner ? { agent: node.agentType, title: node.title, tab: tabLabel(owner) } : null;
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const reasonRef = useRef<HTMLInputElement | null>(null);
  const view = approvalView(request.tool, request.input);
  const remaining = Math.max(0, Math.ceil((request.expiresAt - now) / 1000));

  useEffect(() => {
    if (denying) reasonRef.current?.focus();
  }, [denying]);

  const decide = async (decision: "allow" | "deny") => {
    if (busy) return;
    setBusy(true);
    await decideApproval(request.id, decision, decision === "deny" ? reason : undefined);
    setBusy(false);
  };

  const agentName = pane?.agent ? AGENTS[pane.agent].title : "Agente";
  const named = pane && pane.title !== agentName ? pane.title : null;
  // El nombre del panel solo si dice algo más que el del agente.
  const where = pane && pane.tab && pane.tab !== pane.title && pane.tab !== agentName ? [named, pane.tab].filter(Boolean).join(" · ") : named;

  return (
    <article
      aria-labelledby={`${request.id}-title`}
      className="pointer-events-auto flex max-h-[min(70vh,640px)] w-full animate-pop-in flex-col overflow-hidden rounded-lg border border-accent/60 glass"
    >
      <span className="sr-only" aria-live="polite">
        {agentName} pide permiso: {approvalSummary(request)}
      </span>
      <header className="flex items-center gap-2 border-b border-line bg-accent/[0.07] px-3 py-2">
        <ShieldQuestion size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-accent" />
        <h2 id={`${request.id}-title`} className="flex min-w-0 flex-1 items-baseline gap-2 text-[12.5px]">
          <span className="flex shrink-0 items-center gap-1.5 font-medium text-ink">
            <AgentGlyph agentType={pane?.agent ?? "claude"} className="text-ink-3" />
            {agentName}
          </span>
          {where && <span className="min-w-0 truncate font-mono text-[11px] text-ink-3">{where}</span>}
        </h2>
        {total > 1 && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-3" title={`${total - 1} más en espera`}>
            {position} de {total}
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        <p className="mb-1.5 text-[12px] text-ink-2">
          {VERB[view.kind]} <span className="font-mono text-ink">{toolLabel(request.tool)}</span>
          {view.kind === "edit" && view.replaceAll && <span className="ml-2 text-[11px] text-accent">· todas las apariciones</span>}
        </p>
        <ApprovalBody view={view} />
        {request.cwd && (
          <p className="mt-2 truncate font-mono text-[10.5px] text-ink-3" title={request.cwd}>
            en {request.cwd}
          </p>
        )}
      </div>

      {denying ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void decide("deny");
          }}
          className="flex items-center gap-2 border-t border-line bg-chrome px-3 py-2"
        >
          <input
            ref={reasonRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setDenying(false);
              }
            }}
            maxLength={1000}
            placeholder="Motivo para Claude (opcional): «usa pnpm, no npm»"
            aria-label="Motivo de la negativa"
            className="h-7 min-w-0 flex-1 select-text rounded-md border border-line bg-canvas px-2 text-[12px] text-ink outline-none focus:border-line-strong"
          />
          <button
            type="submit"
            disabled={busy}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-signal px-2.5 text-[12px] font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
          >
            <X size={12} strokeWidth={2.25} aria-hidden="true" /> Denegar
          </button>
          <button type="button" onClick={() => setDenying(false)} className="h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-3 hover:bg-hover hover:text-ink">
            Cancelar
          </button>
        </form>
      ) : (
        <footer className="flex items-center gap-2 border-t border-line bg-chrome px-3 py-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide("allow")}
            className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[12px] font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
          >
            <Check size={13} strokeWidth={2.25} aria-hidden="true" /> Permitir una vez
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setDenying(true)}
            className="flex h-7 items-center gap-1.5 rounded-md border border-line px-2.5 text-[12px] text-ink-2 hover:border-del/60 hover:text-del disabled:opacity-50"
          >
            Denegar…
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => answerInPane(request)}
            title={`Claude te pregunta en su panel (pasa solo en ${remaining} s)`}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-ink-3 hover:bg-hover hover:text-ink"
          >
            Ir al panel <ArrowUpRight size={12} aria-hidden="true" />
            <span className={cn("ml-1 font-mono text-[10.5px] tabular-nums", remaining <= 15 && "text-accent")}>{remaining}s</span>
          </button>
        </footer>
      )}
    </article>
  );
};

const Pre: React.FC<{ children: string; tone?: "add" | "del"; label?: string }> = ({ children, tone, label }) => (
  <pre
    aria-label={label}
    className={cn(
      "select-text whitespace-pre-wrap break-all rounded-md border px-2 py-1.5 font-mono text-[11.5px] leading-[17px]",
      tone === "add" && "border-add/30 bg-add/[0.07] text-ink",
      tone === "del" && "border-del/30 bg-del/[0.07] text-ink-2",
      !tone && "border-line bg-canvas text-ink",
    )}
  >
    {children || " "}
  </pre>
);

/** Todo, sin recortar: aprobar un texto con «…» es aprobar a ciegas. Si es largo, se desplaza. */
const ApprovalBody: React.FC<{ view: ApprovalView }> = ({ view }) => {
  switch (view.kind) {
    case "command":
      return (
        <>
          {view.description && <p className="mb-1.5 text-[12px] leading-relaxed text-ink-3">{view.description}</p>}
          <Pre label="Comando">{view.command}</Pre>
        </>
      );
    case "edit":
      return (
        <>
          <p className="mb-1.5 break-all font-mono text-[11.5px] text-ink-2">{view.path}</p>
          <div className="flex flex-col gap-2">
            {view.edits.map((edit, i) => (
              <div key={i} className="flex flex-col gap-1">
                <Pre tone="del" label="Texto que se quita">{edit.before}</Pre>
                <Pre tone="add" label="Texto que se pone">{edit.after}</Pre>
              </div>
            ))}
          </div>
        </>
      );
    case "write":
      return (
        <>
          <p className="mb-1.5 break-all font-mono text-[11.5px] text-ink-2">{view.path}</p>
          <Pre tone="add" label="Contenido completo">{view.content}</Pre>
        </>
      );
    case "url":
      return (
        <>
          <Pre label="Dirección">{view.url}</Pre>
          {view.prompt && <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">{view.prompt}</p>}
        </>
      );
    case "query":
      return <Pre label="Búsqueda">{view.query}</Pre>;
    default:
      return <Pre label="Datos de la herramienta">{view.json}</Pre>;
  }
};
