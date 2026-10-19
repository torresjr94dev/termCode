import React, { useLayoutEffect, useRef } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleCheck,
  ExternalLink,
  GitBranch,
  GitPullRequestArrow,
  Minus,
  Plus,
  Sparkles,
  Undo2,
} from "lucide-react";
import { useProjectStore } from "../../store/projectStore";
import { isStaged, isUnstaged, statusLetter, type GitChange } from "../../lib/git";
import {
  commit,
  discard,
  generateCommitMessage,
  setAmend,
  openDiff,
  openExternal,
  pull,
  push,
  sourceForChange,
  stage,
  stageAll,
  unstage,
  unstageAll,
} from "../../lib/project";
import { cn } from "../../lib/layout";
import { IS_MAC } from "../../lib/shortcuts";
import { Kbd } from "../ui";
import { EmptyState, PanelSection, StatusLetter, TextButton, splitPath } from "./common";

type Side = "staged" | "unstaged" | "conflict";

export const ChangesTab: React.FC = () => {
  const repo = useProjectStore((s) => s.repo);
  const status = useProjectStore((s) => s.status);

  if (!repo) {
    return (
      <EmptyState
        icon={<GitBranch size={20} strokeWidth={1.5} aria-hidden="true" />}
        title="Esta carpeta no es un repositorio git"
        detail="Cambia de directorio en la terminal (o en otro panel) y el panel lo sigue solo."
      />
    );
  }
  if (!status) return <p className="px-4 py-6 text-[12px] text-ink-3">Leyendo cambios…</p>;

  const conflicts = status.changes.filter((c) => c.conflicted);
  const staged = status.changes.filter(isStaged);
  const unstaged = status.changes.filter(isUnstaged);
  const clean = !status.changes.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pt-1.5">
        {clean && (
          <EmptyState
            icon={<CircleCheck size={20} strokeWidth={1.5} aria-hidden="true" />}
            title="Árbol de trabajo limpio"
            detail="No hay cambios pendientes en este repositorio."
          />
        )}
        {conflicts.length > 0 && (
          <PanelSection title="Conflictos" count={conflicts.length}>
            <ChangeList changes={conflicts} side="conflict" />
          </PanelSection>
        )}
        {staged.length > 0 && (
          <PanelSection
            title="Preparados"
            count={staged.length}
            actions={<SectionAction icon={Minus} label="Quitar todo del índice" onClick={unstageAll} />}
          >
            <ChangeList changes={staged} side="staged" />
          </PanelSection>
        )}
        {unstaged.length > 0 && (
          <PanelSection
            title="Cambios"
            count={unstaged.length}
            actions={
              <>
                <SectionAction icon={Undo2} label="Descartar todos los cambios" onClick={() => discard(unstaged)} danger />
                <SectionAction icon={Plus} label="Preparar todo" onClick={stageAll} />
              </>
            }
          >
            <ChangeList changes={unstaged} side="unstaged" />
          </PanelSection>
        )}
      </div>
      <CommitBox stagedCount={staged.length} />
      <SyncBar />
    </div>
  );
};

const SectionAction: React.FC<{ icon: typeof Plus; label: string; onClick: () => void; danger?: boolean }> = ({
  icon: Icon,
  label,
  onClick,
  danger,
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    onClick={onClick}
    className={cn(
      "grid size-6 place-items-center rounded text-ink-3 opacity-0 transition-opacity duration-150 hover:bg-press focus-visible:opacity-100 group-hover/section:opacity-100",
      danger ? "hover:text-signal" : "hover:text-ink",
    )}
  >
    <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
  </button>
);

const ChangeList: React.FC<{ changes: GitChange[]; side: Side }> = ({ changes, side }) => {
  const viewer = useProjectStore((s) => s.viewer);
  const diffSide = side === "staged" ? "staged" : "unstaged";
  const sources = changes.map((c) => sourceForChange(c, diffSide));

  return (
    <ul className="flex flex-col px-1.5">
      {changes.map((change, i) => {
        const { name, dir } = splitPath(change.path);
        const source = sources[i];
        const isOpen =
          viewer?.kind === "diff" && viewer.source.kind === source.kind && viewer.source.path === source.path;
        return (
          <li key={`${side}:${change.path}`} className="group relative flex items-center">
            <button
              type="button"
              onClick={() => void openDiff(source, sources)}
              title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
              className={cn(
                "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md pl-2 pr-16 text-left transition-colors duration-150",
                isOpen ? "bg-press text-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
              )}
            >
              <StatusLetter letter={statusLetter(change, diffSide)} />
              <span className="shrink-0 truncate font-mono text-[12px]">{name}</span>
              <span className="min-w-0 truncate font-mono text-[11px] text-ink-3">{dir}</span>
            </button>
            <div className="absolute right-1 flex items-center opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
              {side === "unstaged" && (
                <RowAction icon={Undo2} label={`Descartar cambios de ${change.path}`} onClick={() => discard([change])} danger />
              )}
              {side === "staged" ? (
                <RowAction icon={Minus} label={`Quitar ${change.path} del índice`} onClick={() => void unstage([change.path])} />
              ) : (
                <RowAction icon={Plus} label={`Preparar ${change.path}`} onClick={() => void stage([change.path])} />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
};

const RowAction: React.FC<{ icon: typeof Plus; label: string; onClick: () => void; danger?: boolean }> = ({
  icon: Icon,
  label,
  onClick,
  danger,
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    onClick={onClick}
    className={cn(
      "grid size-6 place-items-center rounded text-ink-3 hover:bg-press",
      danger ? "hover:text-signal" : "hover:text-ink",
    )}
  >
    <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
  </button>
);

const CommitBox: React.FC<{ stagedCount: number }> = ({ stagedCount }) => {
  const draft = useProjectStore((s) => s.draft);
  const amend = useProjectStore((s) => s.amend);
  const amendBase = useProjectStore((s) => s.amendBase);
  const hasCommits = useProjectStore((s) => Boolean(s.status?.head));
  const busy = useProjectStore((s) => s.busy);
  const set = useProjectStore((s) => s.set);
  const published = amendBase?.publishedIn ?? [];

  const canCommit = Boolean(draft.trim()) && (stagedCount > 0 || amend) && !busy;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Crece con el contenido (líneas largas envueltas incluidas) hasta un tope.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 240)}px`;
  }, [draft]);
  const shortcut = IS_MAC ? "⌘↵" : "Ctrl+↵";

  return (
    <div className="shrink-0 border-t border-line p-3">
      <label htmlFor="commit-message" className="sr-only">
        Mensaje de commit
      </label>
      <textarea
        id="commit-message"
        ref={textareaRef}
        value={draft}
        onChange={(e) => set({ draft: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (canCommit) void commit();
          }
        }}
        rows={3}
        spellCheck={false}
        placeholder={
          amend ? "Mensaje del commit enmendado" : stagedCount ? "Mensaje de commit" : "Prepara archivos (+) para hacer commit"
        }
        className="w-full select-text resize-none rounded-md border border-line bg-canvas px-2.5 py-2 font-mono text-[12px] leading-relaxed text-ink outline-none transition-colors duration-150 placeholder:font-sans placeholder:text-ink-3 focus:border-line-strong"
      />
      {amend && amendBase && (
        <p
          role={published.length ? "alert" : undefined}
          className={cn("mt-2 text-[11.5px] leading-relaxed", published.length ? "text-signal" : "text-ink-3")}
        >
          {published.length ? (
            <>
              {amendBase.short} ya está en {published[0]}
              {published.length > 1 ? ` y ${published.length - 1} más` : ""}: enmendarlo reescribe historial publicado y el
              push necesitará <code className="whitespace-nowrap font-mono">--force-with-lease</code>.
            </>
          ) : (
            `Reemplaza ${amendBase.short} (aún no publicado). Los archivos preparados se suman a ese commit.`
          )}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <TextButton
          onClick={() => void generateCommitMessage()}
          disabled={!stagedCount || Boolean(busy)}
          title="Claude (Haiku) escribe el mensaje a partir de los cambios preparados"
        >
          <Sparkles size={13} strokeWidth={1.75} aria-hidden="true" className={busy === "ai" ? "animate-pulse text-amber" : ""} />
          {busy === "ai" ? "Escribiendo…" : "Mensaje con IA"}
        </TextButton>
        <label
          title="Reemplazar el último commit en vez de crear uno nuevo"
          className={cn(
            "flex items-center gap-1.5 text-[12px]",
            hasCommits ? "cursor-pointer text-ink-3 hover:text-ink-2" : "cursor-not-allowed text-ink-3/50",
          )}
        >
          <input
            type="checkbox"
            checked={amend}
            disabled={!hasCommits || Boolean(busy)}
            onChange={(e) => void setAmend(e.target.checked)}
            className="size-3.5 accent-[var(--color-amber)]"
          />
          Amend
        </label>
        <span className="flex-1" />
        <TextButton
          tone="primary"
          onClick={() => void commit()}
          disabled={!canCommit}
          className={amend && published.length ? "bg-signal" : undefined}
        >
          {busy === "commit" ? (
            "Guardando…"
          ) : (
            <>
              <Check size={13} strokeWidth={2} aria-hidden="true" /> {amend ? "Enmendar" : "Commit"}{" "}
              <Kbd className="text-on-amber/70">{shortcut}</Kbd>
            </>
          )}
        </TextButton>
      </div>
    </div>
  );
};

const SyncBar: React.FC = () => {
  const repo = useProjectStore((s) => s.repo);
  const status = useProjectStore((s) => s.status);
  const pr = useProjectStore((s) => s.pr);
  const busy = useProjectStore((s) => s.busy);
  const set = useProjectStore((s) => s.set);
  if (!repo || !status?.branch) return null;

  const published = Boolean(status.upstream);
  const isDefault = status.branch === (repo.defaultBranch ?? "main");
  const canPr = Boolean(repo.remoteUrl) && !isDefault && repo.host !== "other";

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-3 py-2.5">
      <span className="flex min-w-0 items-center gap-1.5 font-mono text-[12px] text-ink-2">
        <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
        <span className="truncate" title={status.branch}>
          {status.branch}
        </span>
        {published ? (
          <span className="shrink-0 tabular-nums text-ink-3" title={`${status.ahead} por publicar · ${status.behind} por traer`}>
            ↑{status.ahead} ↓{status.behind}
          </span>
        ) : (
          <span className="shrink-0 text-ink-3">· sin publicar</span>
        )}
      </span>
      <span className="flex-1" />
      {published && (
        <TextButton onClick={() => void pull()} disabled={Boolean(busy)} title="git pull --ff-only">
          <ArrowDown size={13} strokeWidth={1.75} aria-hidden="true" />
          {busy === "pull" ? "Trayendo…" : "Pull"}
        </TextButton>
      )}
      {repo.remoteUrl && (
        <TextButton
          onClick={() => void push()}
          disabled={Boolean(busy) || (published && status.ahead === 0)}
          title={published ? "git push" : "Publicar la rama en origin"}
        >
          <ArrowUp size={13} strokeWidth={1.75} aria-hidden="true" />
          {busy === "push" ? "Publicando…" : published ? "Push" : "Publicar"}
        </TextButton>
      )}
      {pr ? (
        <TextButton onClick={() => openExternal(pr.url)} title={pr.title}>
          <ExternalLink size={13} strokeWidth={1.75} aria-hidden="true" />
          PR #{pr.number}
          {pr.isDraft && <span className="text-ink-3">borrador</span>}
        </TextButton>
      ) : (
        canPr && (
          <TextButton onClick={() => set({ isPrDialogOpen: true })} disabled={Boolean(busy)}>
            <GitPullRequestArrow size={13} strokeWidth={1.75} aria-hidden="true" />
            Crear PR
          </TextButton>
        )
      )}
    </div>
  );
};
