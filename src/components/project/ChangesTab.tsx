import React, { useLayoutEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  CopyCheck,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsUpDown,
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequestArrow,
  Minus,
  Plus,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import { useProjectStore } from "../../store/projectStore";
import { isStaged, isUnstaged, statusLetter, type CiStatus, type GitChange, type StashEntry } from "../../lib/git";
import {
  commit,
  discard,
  finishOperation,
  generateCommitMessage,
  openBranchPicker,
  openConflict,
  operationLabel,
  setAmend,
  openDiff,
  openExternal,
  pull,
  push,
  sourceForChange,
  stage,
  stageAll,
  stashApply,
  stashDrop,
  stashPush,
  unstage,
  unstageAll,
} from "../../lib/project";
import { formatAgo } from "../../lib/format";
import { cn } from "../../lib/layout";
import { IS_MAC, shortcutLabel } from "../../lib/shortcuts";
import { Kbd } from "../ui";
import { EmptyState, PanelSection, StatusLetter, TextButton, splitPath } from "./common";
import { BranchPicker } from "./BranchPicker";

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
        {status.operation && <OperationBanner operation={status.operation} pending={conflicts.length} />}
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
                <SectionAction icon={Archive} label="Guardar todo en el stash (archivos nuevos incluidos)" onClick={() => void stashPush()} />
                <SectionAction icon={Undo2} label="Descartar todos los cambios" onClick={() => discard(unstaged)} danger />
                <SectionAction icon={Plus} label="Preparar todo" onClick={stageAll} />
              </>
            }
          >
            <ChangeList changes={unstaged} side="unstaged" />
          </PanelSection>
        )}
        <StashSection />
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
          side === "conflict"
            ? viewer?.kind === "conflict" && viewer.path === change.path
            : viewer?.kind === "diff" && viewer.source.kind === source.kind && viewer.source.path === source.path;
        return (
          <li key={`${side}:${change.path}`} className="group relative flex items-center">
            <button
              type="button"
              onClick={() => void (side === "conflict" ? openConflict(change.path) : openDiff(source, sources))}
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
              {side === "conflict" ? (
                <RowAction icon={GitMerge} label={`Resolver ${change.path}`} onClick={() => void openConflict(change.path)} />
              ) : side === "unstaged" && (
                <RowAction icon={Undo2} label={`Descartar cambios de ${change.path}`} onClick={() => discard([change])} danger />
              )}
              {side === "staged" && (
                <RowAction icon={Minus} label={`Quitar ${change.path} del índice`} onClick={() => void unstage([change.path])} />
              )}
              {side === "unstaged" && (
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
    <div className="relative flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-3 py-2.5">
      <BranchPicker />
      <span className="flex min-w-0 items-center gap-1.5 font-mono text-[12px] text-ink-2">
        <button
          type="button"
          onClick={openBranchPicker}
          title={`Cambiar de rama  ${shortcutLabel("switchBranch")}`}
          className="-ml-1.5 flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-hover hover:text-ink"
        >
          <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
          <span className="truncate">{status.branch}</span>
          <ChevronsUpDown size={11} aria-hidden="true" className="shrink-0 text-ink-3" />
        </button>
        <CiBadge />
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

/* ------------------------------------------------------------------ */

const OperationBanner: React.FC<{ operation: string; pending: number }> = ({ operation, pending }) => {
  const busy = useProjectStore((s) => s.busy === "resolve");
  return (
    <div role="status" className="mx-3 mb-2 rounded-md border border-amber/50 bg-amber/[0.07] px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[12.5px] text-ink">
        <GitMerge size={13} aria-hidden="true" className="text-amber" />
        Tienes {operationLabel(operation)} a medias
      </p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
        {pending
          ? pending === 1
            ? "Queda 1 archivo con conflictos: ábrelo para elegir qué se queda."
            : `Quedan ${pending} archivos con conflictos: ábrelos para elegir qué se queda.`
          : "Ya no hay conflictos. Termínalo para crear el commit, o cancélalo."}
      </p>
      <div className="mt-2 flex gap-2">
        <TextButton tone="primary" disabled={pending > 0 || busy} onClick={() => finishOperation(false)}>
          <Check size={13} strokeWidth={2} aria-hidden="true" /> Terminar
        </TextButton>
        <TextButton disabled={busy} onClick={() => finishOperation(true)}>
          Cancelar {operationLabel(operation)}
        </TextButton>
      </div>
    </div>
  );
};

const StashSection: React.FC = () => {
  const stashes = useProjectStore((s) => s.stashes);
  const [now] = useState(() => Date.now());
  if (!stashes.length) return null;
  return (
    <PanelSection title="Stash" count={stashes.length}>
      <ul className="flex flex-col px-1.5">
        {stashes.map((entry) => (
          <StashRow key={`${entry.index}:${entry.createdAt}`} entry={entry} now={now} />
        ))}
      </ul>
    </PanelSection>
  );
};

/** "On main: wip" / "WIP on main: abc123 asunto" → texto corto y legible. */
const stashTitle = (message: string) => message.replace(/^(WIP on|On) [^:]+:\s*/, "").replace(/^[0-9a-f]{7,12} /, "") || message;

const StashRow: React.FC<{ entry: StashEntry; now: number }> = ({ entry, now }) => (
  <li className="group relative flex items-center">
    <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md pl-2 pr-24 text-ink-2" title={entry.message}>
      <Archive size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
      <span className="min-w-0 truncate text-[12px]">{stashTitle(entry.message)}</span>
      <span className="shrink-0 font-mono text-[11px] text-ink-3">{formatAgo(entry.createdAt * 1000, now)}</span>
    </div>
    <div className="absolute right-1 flex items-center opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
      <RowAction icon={Trash2} label="Borrar del stash" onClick={() => stashDrop(entry)} danger />
      <RowAction icon={CopyCheck} label="Aplicar y conservar" onClick={() => void stashApply(entry, false)} />
      <RowAction icon={ArchiveRestore} label="Aplicar y retirar del stash" onClick={() => void stashApply(entry, true)} />
    </div>
  </li>
);

const CI_ICON: Record<CiStatus["state"], { icon: typeof Check; cls: string; label: string }> = {
  pending: { icon: CircleDashed, cls: "text-amber animate-[spin_3s_linear_infinite]", label: "CI en curso" },
  success: { icon: CircleCheck, cls: "text-add", label: "CI en verde" },
  failure: { icon: CircleX, cls: "text-del", label: "CI falló" },
};

/** Estado de los workflows del commit actual; clic → lista con enlaces. */
const CiBadge: React.FC = () => {
  const ci = useProjectStore((s) => s.ci);
  const [open, setOpen] = useState(false);
  if (!ci) return null;
  const { icon: Icon, cls, label } = CI_ICON[ci.state];
  return (
    <span className="flex">
      <button
        type="button"
        aria-label={`${label} (${ci.runs.length} workflow${ci.runs.length === 1 ? "" : "s"})`}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((v) => !v)}
        className="grid size-5 place-items-center rounded hover:bg-hover"
      >
        <Icon size={13} strokeWidth={2} aria-hidden="true" className={cls} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" aria-hidden="true" onMouseDown={() => setOpen(false)} />
          <ul className="absolute bottom-full left-2 right-2 z-40 mb-1.5 animate-pop-in overflow-hidden rounded-lg border border-line-strong bg-raised py-1 shadow-[0_16px_48px_-12px_rgb(0_0_0/0.7)]">
            <li className="px-3 pb-1 pt-1.5 font-sans text-[11px] text-ink-3">Workflows de {ci.sha.slice(0, 7)}</li>
            {ci.runs.map((run) => {
              const state = run.status !== "completed" ? "pending" : run.conclusion === "success" || run.conclusion === "skipped" ? "success" : "failure";
              const RunIcon = CI_ICON[state].icon;
              return (
                <li key={run.url}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      openExternal(run.url);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-sans text-[12px] text-ink-2 hover:bg-hover hover:text-ink"
                  >
                    <RunIcon size={12} strokeWidth={2} aria-hidden="true" className={CI_ICON[state].cls} />
                    <span className="min-w-0 flex-1 truncate">{run.name}</span>
                    <span className="shrink-0 font-mono text-[11px] text-ink-3">{run.conclusion || run.status.replace("_", " ")}</span>
                    <ExternalLink size={11} aria-hidden="true" className="shrink-0 text-ink-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </span>
  );
};
