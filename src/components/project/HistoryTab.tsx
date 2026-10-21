import React, { useEffect } from "react";
import { GitCommitHorizontal } from "lucide-react";
import { useProjectStore, type DiffSource } from "../../store/projectStore";
import type { CommitInfo } from "../../lib/git";
import { loadLog, openDiff, toggleCommit } from "../../lib/project";
import { formatAgo } from "../../lib/format";
import { useNow } from "../../lib/useNow";
import { cn } from "../../lib/layout";
import { EmptyState, StatusLetter, TextButton, splitPath } from "./common";

export const HistoryTab: React.FC = () => {
  const repo = useProjectStore((s) => s.repo);
  const log = useProjectStore((s) => s.log);
  const logDone = useProjectStore((s) => s.logDone);
  const logLoading = useProjectStore((s) => s.logLoading);
  const head = useProjectStore((s) => s.status?.head ?? null);
  const logHead = useProjectStore((s) => s.logHead);
  const now = useNow(60_000);

  // Un commit nuevo (aquí o en la terminal) cambia HEAD: solo entonces se recarga.
  useEffect(() => {
    if (repo && head !== logHead) void loadLog(true);
  }, [repo, head, logHead]);

  if (!repo) {
    return <EmptyState title="Sin historial" detail="El panel activo no está dentro de un repositorio git." />;
  }
  if (!log.length && !logLoading) {
    return (
      <EmptyState
        icon={<GitCommitHorizontal size={20} strokeWidth={1.5} aria-hidden="true" />}
        title="Todavía no hay commits"
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
      <ol className="flex flex-col">
        {log.map((commit, i) => (
          <CommitRow key={commit.sha} commit={commit} now={now} isLast={i === log.length - 1} />
        ))}
      </ol>
      {!logDone && (
        <div className="flex justify-center py-3">
          <TextButton onClick={() => void loadLog()} disabled={logLoading}>
            {logLoading ? "Cargando…" : "Cargar más"}
          </TextButton>
        </div>
      )}
    </div>
  );
};

function refLabel(ref: string): { text: string; head: boolean } {
  if (ref.startsWith("HEAD -> ")) return { text: ref.slice(8), head: true };
  if (ref.startsWith("tag: ")) return { text: ref.slice(5), head: false };
  return { text: ref, head: ref === "HEAD" };
}

const CommitRow: React.FC<{ commit: CommitInfo; now: number; isLast: boolean }> = ({ commit, now, isLast }) => {
  const openCommit = useProjectStore((s) => (s.openCommit?.sha === commit.sha ? s.openCommit : null));
  const isHead = commit.refs.some((r) => r.startsWith("HEAD"));
  const isMerge = commit.parents.length > 1;

  return (
    <li className="relative">
      {/* Línea de tiempo */}
      <span aria-hidden="true" className={cn("absolute left-[19px] top-0 w-px bg-line", isLast ? "h-4" : "h-full")} />
      <button
        type="button"
        aria-expanded={Boolean(openCommit)}
        onClick={() => void toggleCommit(commit.sha)}
        className={cn(
          "relative flex w-full items-start gap-3 py-2 pl-[15px] pr-3 text-left transition-colors duration-150",
          openCommit ? "bg-press" : "hover:bg-hover",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "mt-1 size-[9px] shrink-0 rounded-[2px] border",
            isHead ? "border-accent bg-accent" : isMerge ? "border-ink-3 bg-chrome" : "border-ink-3 bg-ink-3",
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[12.5px] leading-snug text-ink">{commit.subject}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-3">
            <span className="text-accent/80">{commit.short}</span>
            <span className="truncate">{commit.author}</span>
            <span>{formatAgo(commit.time * 1000, now)}</span>
            {commit.refs.map((ref) => {
              const { text, head } = refLabel(ref);
              return (
                <span
                  key={ref}
                  className={cn(
                    "rounded-sm border px-1 leading-4",
                    head ? "border-accent/50 text-accent" : "border-line text-ink-2",
                  )}
                >
                  {text}
                </span>
              );
            })}
          </span>
        </span>
      </button>
      {openCommit && <CommitDetailView commit={commit} />}
    </li>
  );
};

const CommitDetailView: React.FC<{ commit: CommitInfo }> = ({ commit }) => {
  const openCommit = useProjectStore((s) => s.openCommit);
  const viewer = useProjectStore((s) => s.viewer);
  if (!openCommit || openCommit.sha !== commit.sha) return null;
  if (openCommit.error) return <p className="px-10 py-2 text-[12px] text-signal">{openCommit.error}</p>;
  const detail = openCommit.detail;
  if (!detail) return <p className="px-10 py-2 text-[12px] text-ink-3">Cargando…</p>;

  const body = detail.body.split("\n").slice(1).join("\n").trim();
  const sources: DiffSource[] = detail.files.map((f) => ({
    kind: "commit",
    sha: commit.sha,
    short: commit.short,
    base: detail.base,
    path: f.path,
    origPath: f.origPath,
  }));

  return (
    <div className="relative bg-press/60 pb-2 pl-10 pr-3">
      {body && (
        <p className="mb-2 select-text whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-ink-2">{body}</p>
      )}
      <p className="mb-1 font-mono text-[11px] text-ink-3">
        {detail.authorEmail} · {detail.files.length} archivo{detail.files.length === 1 ? "" : "s"}
      </p>
      <ul className="flex flex-col">
        {detail.files.map((file, i) => {
          const { name, dir } = splitPath(file.path);
          const source = sources[i];
          const isOpen =
            viewer?.kind === "diff" &&
            viewer.source.kind === "commit" &&
            viewer.source.sha === commit.sha &&
            viewer.source.path === file.path;
          return (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => void openDiff(source, sources)}
                title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
                className={cn(
                  "flex h-6 w-full min-w-0 items-center gap-2 rounded px-1.5 text-left",
                  isOpen ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
                )}
              >
                <StatusLetter letter={file.status} />
                <span className="shrink-0 truncate font-mono text-[12px]">{name}</span>
                <span className="min-w-0 truncate font-mono text-[11px] text-ink-3">{dir}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
