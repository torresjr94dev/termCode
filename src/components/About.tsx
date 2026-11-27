import React, { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Bug, Check, Copy, ExternalLink, RefreshCw, ScrollText, Scale, X } from "lucide-react";
import { useUiStore } from "../store/uiStore";
import { IS_TAURI } from "../lib/ipc";
import { cn } from "../lib/layout";
import { checkForUpdate, installUpdate, updatesSupported, type UpdateInfo, type UpdateProgress } from "../lib/updates";
import { IconButton } from "./ui";
import { LogoMark } from "./Logo";

const REPO_URL = "https://github.com/torresjr94dev/termCode";

const LINKS = [
  { label: "Novedades", icon: ScrollText, url: `${REPO_URL}/releases` },
  { label: "Código fuente", icon: ExternalLink, url: REPO_URL },
  { label: "Reportar un problema", icon: Bug, url: `${REPO_URL}/issues/new` },
  { label: "Licencia MIT", icon: Scale, url: `${REPO_URL}/blob/main/LICENSE` },
] as const;

/* ------------------------------------------------------------------ */
/* Actualizaciones (Ajustes y «Acerca de» usan lo mismo)               */
/* ------------------------------------------------------------------ */

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current"; at: number }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "installing"; info: UpdateInfo; progress: UpdateProgress | null }
  | { kind: "error"; message: string };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const formatMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Versión instalada, si esta compilación se actualiza sola, y buscar/instalar. */
function useUpdater() {
  const [version, setVersion] = useState<string | null>(null);
  // Fuera de la app (navegador, pruebas) no hay nada que actualizar.
  const [supported, setSupported] = useState<boolean | null>(IS_TAURI ? null : false);
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const askConfirm = useUiStore((s) => s.askConfirm);

  useEffect(() => {
    if (!IS_TAURI) return;
    let alive = true;
    void Promise.all([getVersion().catch(() => null), updatesSupported()]).then(([v, ok]) => {
      if (!alive) return;
      setVersion(v);
      setSupported(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  const check = useCallback(async () => {
    setState({ kind: "checking" });
    try {
      const info = await checkForUpdate();
      setState(info ? { kind: "available", info } : { kind: "current", at: Date.now() });
    } catch (err) {
      setState({ kind: "error", message: errorText(err) });
    }
  }, []);

  const install = (info: UpdateInfo) =>
    askConfirm({
      title: `¿Instalar termCode ${info.version} y reiniciar?`,
      body: "termCode se cierra y vuelve a abrir: tus pestañas y carpetas se restauran, pero los procesos que estén corriendo en las terminales terminan.",
      confirmLabel: "Instalar y reiniciar",
      onConfirm: () => {
        setState({ kind: "installing", info, progress: null });
        installUpdate((progress) => setState({ kind: "installing", info, progress })).catch((err: unknown) =>
          setState({ kind: "error", message: errorText(err) }),
        );
      },
    });

  return { version, supported, state, check, install };
}

/**
 * Botón de buscar, resultado y, si hay versión nueva, sus notas e instalar.
 * `autoCheck`: busca en cuanto sabe que esta compilación puede actualizarse
 * (lo pide el menú «Buscar actualizaciones…»).
 */
export const UpdateControls: React.FC<{ autoCheck?: boolean; className?: string }> = ({ autoCheck, className }) => {
  const { version, supported, state, check, install } = useUpdater();
  const checkedOnOpen = useRef(false);

  useEffect(() => {
    if (!autoCheck || !supported || checkedOnOpen.current) return;
    checkedOnOpen.current = true;
    void check();
  }, [autoCheck, supported, check]);

  const percent =
    state.kind === "installing" && state.progress?.total ? Math.round((state.progress.downloaded / state.progress.total) * 100) : null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[13px] text-ink">{version ? `Versión ${version}` : "Versión de desarrollo"}</p>
          <p className="text-[11.5px] text-ink-3" aria-live="polite">
            {supported === false
              ? "Esta compilación no se actualiza sola (compilada en local o sin firma)."
              : state.kind === "checking"
                ? "Buscando versión nueva…"
                : state.kind === "current"
                  ? "Ya tienes la última versión."
                  : "Se busca sola una vez al día."}
          </p>
        </div>
        {supported && (
          <button
            type="button"
            onClick={() => void check()}
            disabled={state.kind === "checking" || state.kind === "installing"}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-50"
          >
            <RefreshCw size={12} strokeWidth={2} aria-hidden="true" className={cn(state.kind === "checking" && "animate-spin")} />
            {state.kind === "checking" ? "Buscando…" : "Buscar actualizaciones"}
          </button>
        )}
      </div>
      {state.kind === "error" && (
        <p role="alert" className="text-[12px] text-signal">
          {state.message}
        </p>
      )}
      {(state.kind === "available" || state.kind === "installing") && (
        <div className="rounded-md border border-accent/50 bg-accent/[0.06] p-3">
          <p className="text-[13px] text-ink">
            termCode {state.info.version} disponible
            <span className="text-ink-3"> · tienes {state.info.currentVersion}</span>
          </p>
          {state.info.notes && (
            <p className="mt-1.5 max-h-32 select-text overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-ink-2">
              {state.info.notes}
            </p>
          )}
          <div className="mt-2.5 flex items-center gap-3">
            {state.kind === "available" ? (
              <button
                type="button"
                onClick={() => install(state.info)}
                className="h-7 rounded-md bg-accent px-3 text-[12px] font-medium text-on-accent hover:opacity-90"
              >
                Instalar y reiniciar
              </button>
            ) : (
              <span className="font-mono text-[12px] text-ink-2" aria-live="polite">
                {state.progress
                  ? percent !== null
                    ? `Descargando… ${percent} %`
                    : `Descargando… ${formatMb(state.progress.downloaded)}`
                  : "Preparando…"}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Ventana «Acerca de termCode»                                        */
/* ------------------------------------------------------------------ */

interface SystemInfo {
  os: string;
  osVersion: string | null;
  arch: string;
  tauri: string;
  webview: string | null;
}

const WEBVIEW_NAME = navigator.userAgent.includes("Edg/") ? "WebView2" : "WebKit";

function buildDate(): string | null {
  const iso = typeof __TERMCODE_BUILT_AT__ === "string" ? __TERMCODE_BUILT_AT__ : "";
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}

const COMMIT = typeof __TERMCODE_COMMIT__ === "string" ? __TERMCODE_COMMIT__ : "";

function open(url: string) {
  if (!IS_TAURI) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  openUrl(url).catch(() => useUiStore.getState().showToast(`No se pudo abrir ${url}.`, "error"));
}

export const AboutDialog: React.FC<{ onClosed: () => void }> = ({ onClosed }) => {
  const about = useUiStore((s) => s.about);
  if (!about) return null;
  return <AboutPanel checkUpdates={about.checkUpdates} onClosed={onClosed} />;
};

const AboutPanel: React.FC<{ checkUpdates: boolean; onClosed: () => void }> = ({ checkUpdates, onClosed }) => {
  const closeAbout = useUiStore((s) => s.closeAbout);
  const [version, setVersion] = useState<string | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
    if (!IS_TAURI) return;
    let alive = true;
    void getVersion()
      .then((v) => alive && setVersion(v))
      .catch(() => {});
    void invoke<SystemInfo>("app_info")
      .then((info) => alive && setSystem(info))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const close = () => {
    closeAbout();
    onClosed();
  };

  const built = buildDate();
  const rows: Array<[string, string]> = [
    ["Versión", version ?? "desarrollo"],
    ["Compilación", [COMMIT || null, built].filter(Boolean).join(" · ") || "local"],
    ...(system
      ? ([
          ["Sistema", `${system.os}${system.osVersion ? ` ${system.osVersion}` : ""} (${system.arch})`],
          ["Motor", `Tauri ${system.tauri}${system.webview ? ` · ${WEBVIEW_NAME} ${system.webview}` : ""}`],
        ] as Array<[string, string]>)
      : []),
  ];

  /** Lo que conviene pegar en un reporte de error. */
  const copyInfo = async () => {
    const text = ["termCode", ...rows.map(([k, v]) => `${k}: ${v}`)].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      useUiStore.getState().showToast("No se pudo copiar al portapapeles.", "error");
    }
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
        }
      }}
      className="fixed inset-0 z-50 flex animate-fade-in items-start justify-center bg-canvas/60 px-4 pt-[8vh]"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        className="relative flex max-h-[84vh] w-full max-w-[460px] animate-pop-in flex-col overflow-hidden rounded-xl border border-[var(--glass-border)] glass outline-none"
      >
        <div className="absolute right-2 top-2 z-10">
          <IconButton icon={X} label="Cerrar" shortcut="esc" size="sm" onClick={close} />
        </div>

        <div className="min-h-0 overflow-y-auto">
          <header className="flex flex-col items-center px-6 pb-5 pt-8 text-center">
            <div className="grid size-[72px] place-items-center rounded-[18px] border border-line bg-canvas shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]">
              <LogoMark blink className="h-auto w-[46px] text-ink" />
            </div>
            <h2 id="about-title" className="mt-3.5 font-mono text-[17px] font-bold tracking-[0.04em] text-ink">
              termCode
            </h2>
            <p className="mt-1 max-w-[320px] text-[12.5px] leading-relaxed text-ink-2">
              La terminal rápida que entiende a tus agentes: Claude Code y Codex con su estado, sus cuotas y sus cambios a la vista.
            </p>
            <p className="mt-1.5 text-[11.5px] text-ink-3">by CODERGENIUS MX</p>
          </header>

          <section aria-label="Actualizaciones" className="mx-4 rounded-lg border border-line bg-canvas/50 p-3">
            <UpdateControls autoCheck={checkUpdates} />
          </section>

          <section aria-label="Detalles" className="mx-4 mt-4">
            <div className="flex items-center justify-between">
              <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">Detalles</h3>
              <button
                type="button"
                onClick={() => void copyInfo()}
                className="flex h-6 items-center gap-1.5 rounded px-1.5 text-[11.5px] text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
              >
                {copied ? <Check size={12} strokeWidth={2.25} aria-hidden="true" className="text-accent" /> : <Copy size={12} strokeWidth={2} aria-hidden="true" />}
                {copied ? "Copiado" : "Copiar"}
              </button>
            </div>
            <dl className="mt-1.5 grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5 text-[12px]">
              {rows.map(([label, value]) => (
                <React.Fragment key={label}>
                  <dt className="text-ink-3">{label}</dt>
                  <dd className="min-w-0 select-text truncate font-mono text-ink-2" title={value}>
                    {value}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          </section>

          <nav aria-label="Enlaces" className="mx-4 mt-4 grid grid-cols-2 gap-1.5">
            {LINKS.map(({ label, icon: Icon, url }) => (
              <button
                key={label}
                type="button"
                onClick={() => open(url)}
                className="flex h-8 items-center gap-2 rounded-md border border-line px-2.5 text-left text-[12px] text-ink-2 transition-colors duration-150 hover:border-line-strong hover:bg-hover hover:text-ink"
              >
                <Icon size={13} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </nav>

          <p className="px-6 pb-5 pt-4 text-center text-[11px] leading-relaxed text-ink-3">
            Hecho con Tauri, React, xterm.js y CodeMirror.
            <br />© 2026 Jorge Torres · Licencia MIT
          </p>
        </div>
      </div>
    </div>
  );
};
