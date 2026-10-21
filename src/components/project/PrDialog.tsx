import React, { useEffect, useRef, useState } from "react";
import { GitPullRequestArrow, Sparkles } from "lucide-react";
import { useProjectStore } from "../../store/projectStore";
import { useTerminalStore } from "../../store/terminalStore";
import { createPr, defaultBase, generatePrDraft } from "../../lib/project";
import { TextButton } from "./common";

const HOST_NAME = { github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket", azure: "Azure DevOps", other: "tu proveedor" };

export const PrDialog: React.FC = () => {
  const isOpen = useProjectStore((s) => s.isPrDialogOpen);
  if (!isOpen) return null;
  return <PrForm />;
};

const PrForm: React.FC = () => {
  const repo = useProjectStore((s) => s.repo);
  const branch = useProjectStore((s) => s.status?.branch);
  const busy = useProjectStore((s) => s.busy);
  const set = useProjectStore((s) => s.set);
  const hasGh = useTerminalStore((s) => Boolean(s.agents?.gh));
  const hasClaude = useTerminalStore((s) => Boolean(s.agents?.claude));

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState(defaultBase);
  const [draft, setDraft] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  if (!repo) return null;
  const close = () => set({ isPrDialogOpen: false });
  const direct = repo.host === "github" && hasGh;

  const generate = async () => {
    const result = await generatePrDraft(base.trim());
    if (result) {
      setTitle(result.title);
      setBody(result.body);
    }
  };

  const submit = async () => {
    if (await createPr(title, body, base.trim(), draft)) close();
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && title.trim() && !busy) {
          e.preventDefault();
          void submit();
        }
      }}
      className="fixed inset-0 z-50 flex animate-fade-in items-start justify-center bg-canvas/60 px-4 pt-[10vh]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pr-title"
        className="flex max-h-[80vh] w-full max-w-[620px] animate-pop-in flex-col overflow-hidden rounded-lg border border-[var(--glass-border)] glass"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <GitPullRequestArrow size={15} strokeWidth={1.75} aria-hidden="true" className="text-ink-3" />
          <h2 id="pr-title" className="text-[13px] font-medium text-ink">
            Nuevo pull request
          </h2>
          <span className="min-w-0 truncate font-mono text-[11px] text-ink-3">
            {branch} → {base || "…"}
          </span>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div className="flex gap-3">
            <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-[12px] text-ink-2">
              Título
              <input
                ref={titleRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="h-8 select-text rounded-md border border-line bg-canvas px-2.5 text-[13px] text-ink outline-none focus:border-line-strong"
              />
            </label>
            <label className="flex w-36 flex-col gap-1.5 text-[12px] text-ink-2">
              Base
              <input
                value={base}
                onChange={(e) => setBase(e.target.value)}
                spellCheck={false}
                className="h-8 select-text rounded-md border border-line bg-canvas px-2.5 font-mono text-[12px] text-ink outline-none focus:border-line-strong"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1.5 text-[12px] text-ink-2">
            Descripción (Markdown)
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              spellCheck={false}
              className="select-text resize-y rounded-md border border-line bg-canvas px-2.5 py-2 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-line-strong"
            />
          </label>
          <label className="flex w-fit cursor-pointer items-center gap-2 text-[12px] text-ink-2">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} className="size-3.5 accent-[var(--color-accent)]" />
            Crear como borrador
          </label>
        </div>

        <div className="flex items-center gap-2 border-t border-line bg-chrome px-4 py-3">
          <TextButton
            onClick={() => void generate()}
            disabled={!hasClaude || Boolean(busy) || !base.trim()}
            title={hasClaude ? "Claude (Haiku) escribe título y descripción a partir de los commits" : "Claude Code no está instalado"}
          >
            <Sparkles size={13} strokeWidth={1.75} aria-hidden="true" className={busy === "pr-ai" ? "animate-pulse text-accent" : ""} />
            {busy === "pr-ai" ? "Escribiendo…" : "Redactar con IA"}
          </TextButton>
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3">
            {direct ? "Se crea directamente con gh." : `Se abrirá el formulario de ${HOST_NAME[repo.host]} ya rellenado.`}
          </span>
          <TextButton onClick={close}>Cancelar</TextButton>
          <TextButton tone="primary" onClick={() => void submit()} disabled={!title.trim() || !base.trim() || Boolean(busy)}>
            {busy === "pr" ? "Creando…" : direct ? "Crear PR" : "Publicar y abrir"}
          </TextButton>
        </div>
      </div>
    </div>
  );
};
