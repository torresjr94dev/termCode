import React, { useEffect, useRef } from "react";
import { TriangleAlert, X } from "lucide-react";
import { useUiStore } from "../store/uiStore";
import { cn } from "../lib/layout";
import { Kbd } from "./ui";

/** Confirmación modal (cerrar algo con procesos vivos). Enter confirma, Esc cancela. */
export const ConfirmDialog: React.FC<{ onSettled: () => void }> = ({ onSettled }) => {
  const request = useUiStore((s) => s.confirm);
  const resolve = useUiStore((s) => s.resolveConfirm);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (request) confirmRef.current?.focus();
  }, [request]);

  if (!request) return null;

  const settle = (accepted: boolean) => {
    resolve(accepted);
    onSettled();
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) settle(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          settle(false);
        }
      }}
      className="fixed inset-0 z-50 flex animate-fade-in items-start justify-center bg-canvas/60 px-4 pt-[18vh]"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        className="w-full max-w-[380px] animate-pop-in overflow-hidden rounded-lg border border-line-strong bg-raised shadow-[0_24px_64px_-12px_rgb(0_0_0/0.7)]"
      >
        <div className="flex gap-3 px-4 pb-4 pt-4">
          <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-signal" />
          <div className="min-w-0">
            <h2 id="confirm-title" className="text-[13px] font-medium text-ink">
              {request.title}
            </h2>
            <p id="confirm-body" className="mt-1 text-[12px] leading-relaxed text-ink-2">
              {request.body}
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-chrome px-3 py-2.5">
          <button
            type="button"
            onClick={() => settle(false)}
            className="flex h-7 items-center gap-2 rounded-md px-2.5 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            Cancelar <Kbd>esc</Kbd>
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => settle(true)}
            className="flex h-7 items-center gap-2 rounded-md bg-signal px-3 text-[12px] font-medium text-on-amber transition-opacity duration-150 hover:opacity-90"
          >
            {request.confirmLabel} <Kbd className="text-on-amber/70">↵</Kbd>
          </button>
        </div>
      </div>
    </div>
  );
};

export const ToastHost: React.FC = () => {
  const toast = useUiStore((s) => s.toast);
  const dismiss = useUiStore((s) => s.dismissToast);
  if (!toast) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-9 z-50 flex justify-center px-4">
      <div
        role={toast.tone === "error" ? "alert" : "status"}
        className={cn(
          "pointer-events-auto flex max-w-[560px] animate-pop-in items-start gap-3 rounded-md border bg-raised py-2 pl-3 pr-1.5 text-[12px] shadow-[0_12px_32px_-8px_rgb(0_0_0/0.6)]",
          toast.tone === "error" ? "border-signal/60 text-ink" : "border-line-strong text-ink-2",
        )}
      >
        <span className="select-text py-0.5 leading-relaxed">{toast.text}</span>
        <button
          type="button"
          aria-label="Cerrar aviso"
          onClick={() => dismiss(toast.id)}
          className="grid size-6 shrink-0 place-items-center rounded text-ink-3 hover:bg-hover hover:text-ink"
        >
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};
