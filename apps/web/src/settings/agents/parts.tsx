import { type AgentClient, formatMoney, t } from "@openfield/core";
import { Button, cn, IconButton, Input } from "@openfield/ui";
import { AppWindow, Bot, Check, CodeXml, Copy, type LucideIcon, RefreshCw, Terminal } from "lucide-react";
import { type FocusEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { relativeTime } from "../../detail/format";
import { notifyError } from "../../lib/notify";
import { maskKey } from "./snippets";

// The pieces of Settings > Agents, each built to its node on the design's "Components · Agents"
// board: Settings / Code block, Agents / Access key, Agents / Client row (and / Live).

/** Copies, then shows a check for two seconds (the Code block's note in the design). */
function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2_000);
      },
      () => notifyError(t("errors.transport.internal")),
    );
  };
  return [copied, copy];
}

/** Settings / Code block: mono 12 at 1.6, wrapping, with Copy at the top right. */
export function CodeBlock({ shown, copied: text, label }: { shown: string; copied: string; label: string }) {
  const [copied, copy] = useCopy();
  return (
    <div className="flex w-full items-start gap-12 rounded-10 bg-surface py-10 pr-8 pl-14 inset-ring inset-ring-border">
      <pre className="min-w-0 flex-1 whitespace-pre-wrap font-mono text-[12px] leading-[1.6] text-text-primary [overflow-wrap:anywhere]">
        {shown}
      </pre>
      <IconButton
        icon={copied ? Check : Copy}
        label={copied ? t("settings.agents.copied") : label}
        onClick={() => copy(text)}
      />
    </div>
  );
}

/** Agents / Access key: the key, hidden but for its end, Copy, then Make a new key. */
export function AccessKey({ value, onNewKey, busy }: { value: string; onNewKey: () => void; busy: boolean }) {
  const [copied, copy] = useCopy();
  return (
    <div className="flex shrink-0 items-center gap-8">
      <div className="flex h-32 items-center gap-6 rounded-8 bg-surface pr-4 pl-12 inset-ring inset-ring-border">
        <span className="text-mono-12 text-text-primary">{maskKey(value)}</span>
        <IconButton
          size={24}
          className="rounded-8"
          icon={copied ? Check : Copy}
          label={copied ? t("settings.agents.copied") : t("settings.agents.copyKey")}
          onClick={() => copy(value)}
        />
      </div>
      <Button variant="secondary" size="s" icon={RefreshCw} loading={busy} onClick={onNewKey}>
        {t("settings.agents.newKey")}
      </Button>
    </div>
  );
}

const APP_ICONS: [RegExp, LucideIcon][] = [
  [/^Claude Desktop$/, AppWindow],
  [/^Cursor$|^VS Code$|^Windsurf$|^Zed$/, CodeXml],
  [/^Claude Code$|^Codex$/, Terminal],
];

const iconFor = (name: string) => APP_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? Bot;

/** Agents / Client row, and / Live while the app is connected: bone ring, icon and dot. */
export function ClientRow({ client, now }: { client: AgentClient; now: number }) {
  const Icon = iconFor(client.name);
  const live = client.active;
  const status = live
    ? t("settings.agents.connectedNow")
    : client.lastSeenAt
      ? t("settings.agents.lastUsed", { when: lowerFirst(relativeTime(client.lastSeenAt, now)) })
      : t("settings.agents.usedToday");
  const today =
    client.today.images > 0 || client.today.usd > 0
      ? t("settings.agents.today", { count: client.today.images, spent: formatMoney(client.today.usd) })
      : t("settings.agents.nothingToday");
  return (
    <div className="flex w-full items-center gap-12 py-12">
      <div
        className={cn(
          "flex size-32 shrink-0 items-center justify-center rounded-8 bg-elevated-2 inset-ring",
          live ? "inset-ring-accent-line" : "inset-ring-border",
        )}
      >
        <Icon aria-hidden size={16} className={live ? "text-accent" : "text-text-secondary"} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-body-medium text-text-primary">{client.name}</span>
        <span className="flex items-center gap-6">
          {live ? <span aria-hidden className="size-6 shrink-0 rounded-full bg-accent" /> : null}
          <span className="text-small text-text-secondary">{status}</span>
        </span>
      </div>
      <span className="shrink-0 text-mono-12 text-text-secondary">{today}</span>
    </div>
  );
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * Input / Text / Mono, 120 wide, showing dollars as the design does ("$0.50"). Saves on Enter or
 * when focus leaves; a blank one means no amount (`allowEmpty`), anything unreadable puts the
 * saved amount back.
 */
export function AmountInput({
  value,
  onSave,
  allowEmpty = false,
  placeholder,
  ...aria
}: {
  value: number | null;
  onSave: (value: number | null) => void;
  allowEmpty?: boolean;
  placeholder?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}) {
  const shown = value === null ? "" : formatMoney(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);

  const commit = () => {
    const raw = draft.trim().replace(/^\$/, "").replace(",", ".").trim();
    if (raw === "") {
      if (allowEmpty && value !== null) onSave(null);
      else setDraft(shown);
      return;
    }
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0 || (allowEmpty && amount === 0)) {
      notifyError(t("settings.agents.amountInvalid"));
      setDraft(shown);
      return;
    }
    const rounded = Math.round(amount * 100) / 100;
    if (rounded !== value) onSave(rounded);
    setDraft(formatMoney(rounded));
  };

  return (
    <Input
      mono
      inputMode="decimal"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(_e: FocusEvent<HTMLInputElement>) => commit()}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(shown);
          e.currentTarget.blur();
        }
      }}
      boxClassName="w-120 shrink-0"
      {...aria}
    />
  );
}
