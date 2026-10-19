import React, { useEffect, useRef } from "react";
import { ArrowRight, Asterisk, Hexagon, X, type LucideIcon } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { actions, AGENTS, type AgentKind } from "../lib/actions";
import type { AIUsageWindow } from "../types/layout";
import { IconButton, Meter } from "./ui";

interface UsagePopoverProps {
  onClose: () => void;
}

export const UsagePopover: React.FC<UsagePopoverProps> = ({ onClose }) => {
  const isOpen = useTerminalStore((s) => s.isUsageDrawerOpen);
  if (!isOpen) return null;
  return <UsagePanel onClose={onClose} />;
};

const UsagePanel: React.FC<UsagePopoverProps> = ({ onClose }) => {
  const usage = useTerminalStore((s) => s.aiUsage);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const launch = (agent: AgentKind) => {
    onClose();
    actions.openAgentInSplit(agent);
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      className="fixed inset-0 z-40"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Cuotas de IA"
        className="absolute right-2 top-11 w-[320px] origin-top-right animate-pop-in overflow-hidden rounded-lg border border-line-strong bg-raised shadow-[0_24px_64px_-12px_rgb(0_0_0/0.7)] outline-none"
      >
        <div className="flex h-10 items-center justify-between border-b border-line pl-4 pr-1.5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">Cuotas de IA</h2>
          <IconButton icon={X} label="Cerrar" size="sm" onClick={onClose} />
        </div>

        <ProviderBlock
          icon={Asterisk}
          name={AGENTS.claude.title}
          plan={usage.claude.planType}
          windows={[
            { label: "Sesión · 5 h", data: usage.claude.fiveHour },
            { label: "Semana · 7 d", data: usage.claude.sevenDay },
          ]}
          onLaunch={() => launch("claude")}
        />
        <ProviderBlock
          icon={Hexagon}
          name={AGENTS.codex.title}
          plan={usage.chatgpt.planType}
          windows={[
            { label: "Sesión · 5 h", data: usage.chatgpt.primary5h },
            { label: "Semana · 7 d", data: usage.chatgpt.secondaryWeekly },
          ]}
          onLaunch={() => launch("codex")}
        />

        <p className="border-t border-line bg-chrome px-4 py-2 text-[11px] leading-snug text-ink-3">
          Valores de ejemplo: aún no hay una fuente de datos conectada.
        </p>
      </div>
    </div>
  );
};

interface ProviderBlockProps {
  icon: LucideIcon;
  name: string;
  plan: string;
  windows: Array<{ label: string; data: AIUsageWindow }>;
  onLaunch: () => void;
}

const ProviderBlock: React.FC<ProviderBlockProps> = ({ icon: Icon, name, plan, windows, onLaunch }) => (
  <section aria-label={name} className="border-b border-line px-4 pb-3 pt-3.5 last-of-type:border-b-0">
    <header className="mb-3 flex items-center gap-2">
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" className="text-ink-3" />
      <h3 className="flex-1 text-[13px] font-medium text-ink">{name}</h3>
      <span className="rounded-sm border border-line px-1.5 py-px font-mono text-[11px] text-ink-3">{plan}</span>
    </header>

    <div className="flex flex-col gap-3">
      {windows.map(({ label, data }) => (
        <div key={label}>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[12px] text-ink-2">{label}</span>
            <span
              className={`font-mono text-[13px] font-medium tabular-nums ${data.usedPercent >= 85 ? "text-signal" : "text-ink"}`}
            >
              {data.usedPercent}%
            </span>
          </div>
          <Meter value={data.usedPercent} label={`${name}, ${label}`} />
          {data.resetsAt && <div className="mt-1 text-[11px] text-ink-3">Se reinicia {data.resetsAt}</div>}
        </div>
      ))}
    </div>

    <button
      type="button"
      onClick={onLaunch}
      className="group mt-3 flex h-8 w-full items-center justify-between rounded-md border border-line px-2.5 text-[12px] text-ink-2 transition-colors duration-150 hover:border-amber/50 hover:bg-amber/10 hover:text-ink"
    >
      Abrir junto al panel actual
      <ArrowRight size={13} strokeWidth={1.75} aria-hidden="true" className="text-ink-3 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-amber" />
    </button>
  </section>
);
