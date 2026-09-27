import { listOf, nodeTitle, runDetail } from "@openfield/canvas/engine/describe";
import type { PreviewRow } from "@openfield/canvas/engine/preview";
import { CANVAS_CONFIRM_JOBS, type CostEstimate, costParts, formatCost, t } from "@openfield/core";
import { Button, Divider, Popover, PopoverAnchor, PopoverContent, ProviderLogo } from "@openfield/ui";
import { Check, Play, Sparkles } from "lucide-react";
import { type ReactNode, useMemo, useRef } from "react";
import { useProviders } from "../../api/hooks/keys";
import { companyName, logoFor, providerOfKey } from "../../lib/provider";
import { nodeRegistry } from "../nodes/registry";
import { useCanvas } from "../store/context";
import { useEngineContext } from "./context";
import { type RunDialog, useEngineStore } from "./engine-store";

// The run confirmation (§7.7): the run preview (design qlYUt, M4-18). When a single node has to run
// earlier nodes first, the same preview says so and its button reads "Run them too", so one answer
// covers both questions. It opens where the run was asked for: the pressed pill, or Run all.

interface Measurable {
  getBoundingClientRect(): DOMRect;
}

/** Top right, under the top bar, when nothing on screen asked. */
const FALLBACK: Measurable = {
  getBoundingClientRect: () => new DOMRect(window.innerWidth - 12, 12, 0, 40),
};

export function RunDialogs() {
  const dialog = useEngineStore((s) => s.dialog);
  const answer = useEngineStore((s) => s.answer);
  const anchor = useRef<Measurable | null>(null);
  anchor.current = dialog?.anchor?.isConnected ? dialog.anchor : FALLBACK;

  return (
    <Popover open={!!dialog} onOpenChange={(open) => !open && answer(false)}>
      <PopoverAnchor virtualRef={anchor} />
      {dialog ? (
        <PopoverContent
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="w-380 gap-4 p-16"
          onOpenAutoFocus={(event) => {
            // Run is the answer most people give; Enter takes it.
            event.preventDefault();
            (event.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-autofocus]")?.focus();
          }}
        >
          <Preview dialog={dialog} onAnswer={answer} />
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

/** "About $0.52": the word in Inter, the amount in mono (§0.15). "Free" and "Cost unknown" are words. */
function Amount({ estimate, size }: { estimate: CostEstimate; size: "row" | "total" }) {
  const parts = costParts(estimate);
  const word = size === "row" ? "text-caption text-text-secondary" : "text-small text-text-secondary";
  if (parts.kind !== "amount") return <span className={word}>{parts.text}</span>;
  return (
    <span className="flex shrink-0 items-center gap-4">
      <span className={word}>{t("canvas.run.about")}</span>
      <span
        className={
          size === "row" ? "text-mono-12 text-text-primary" : "text-mono-13 font-medium text-text-primary"
        }
      >
        {parts.amount}
      </span>
    </span>
  );
}

function Row({
  glyph,
  title,
  detail,
  cost,
}: {
  glyph: ReactNode;
  title: string;
  detail: string;
  cost: ReactNode;
}) {
  return (
    <li className="flex h-40 w-full items-center gap-10">
      <span className="flex size-16 shrink-0 items-center justify-center">{glyph}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-small font-medium text-text-primary">{title}</span>
        <span className="truncate text-caption text-text-tertiary">{detail}</span>
      </span>
      {cost}
    </li>
  );
}

function Preview({ dialog, onAnswer }: { dialog: RunDialog; onAnswer: (yes: boolean) => void }) {
  const ctx = useEngineContext();
  const providers = useProviders().data;
  const doc = useCanvas((s) => s.doc);
  const { preview, items } = dialog;
  const byId = useMemo(() => new Map(items.map((c) => [c.item.nodeId, c.item])), [items]);
  const title = (id: string) => (doc.nodes[id] ? nodeTitle(doc.nodes[id]!, nodeRegistry) : id);

  const glyph = (id: string) => {
    const logo = logoFor(providerOfKey(byId.get(id)?.model ?? ""));
    return logo ? (
      <ProviderLogo provider={logo} />
    ) : (
      <Sparkles size={16} aria-hidden className="text-text-tertiary" />
    );
  };
  const detail = (row: Extract<PreviewRow, { nodeId: string }>) => {
    const item = byId.get(row.nodeId);
    return item ? runDetail(item, row.jobs, ctx) : "";
  };

  const companies = [
    ...new Set(
      preview.rows.flatMap((row) =>
        row.kind === "up_to_date"
          ? []
          : (byId.get(row.nodeId)?.calls ?? []).map((c) => providerOfKey(c.model) ?? ""),
      ),
    ),
  ]
    .filter(Boolean)
    .map((id) => companyName(providers, id));
  const unknownNames = preview.unknown.map(title);
  const many = dialog.response.jobs > CANVAS_CONFIRM_JOBS;
  const upstream = dialog.upstream;

  return (
    <>
      <div className="flex flex-col gap-4 pb-8">
        <h2 className="text-body-strong text-text-primary">
          {upstream?.length
            ? t("canvas.run.earlier", { count: upstream.length })
            : t("canvas.run.title", { nodes: preview.running, images: preview.images })}
        </h2>
        {upstream?.length ? (
          <p className="text-caption text-text-tertiary">
            {t("canvas.run.title", { nodes: preview.running, images: preview.images })}
          </p>
        ) : null}
      </div>
      {/* The design's rows sit in the popover's own gap of 4 (qlYUt). */}
      <ul className="flex flex-col gap-4">
        {preview.rows.map((row) =>
          row.kind === "up_to_date" ? (
            <Row
              key="up-to-date"
              glyph={<Check size={16} aria-hidden className="text-text-tertiary" />}
              title={t("canvas.run.upToDate", { count: row.nodeIds.length })}
              detail={listOf(row.nodeIds.map(title))}
              cost={<span className="shrink-0 text-caption text-text-secondary">{t("cost.free")}</span>}
            />
          ) : (
            <Row
              key={row.nodeId}
              glyph={glyph(row.nodeId)}
              title={title(row.nodeId)}
              detail={detail(row)}
              cost={
                row.kind === "run" ? (
                  <Amount estimate={row.estimate} size="row" />
                ) : (
                  <span className="shrink-0 text-caption text-text-secondary">{t("cost.unknown")}</span>
                )
              }
            />
          ),
        )}
      </ul>
      <Divider />
      <div className="flex flex-col items-end gap-16 pt-10">
        <div className="flex w-full flex-col gap-6">
          <div className="flex w-full items-center justify-between">
            <span className="text-small font-medium text-text-primary">{t("canvas.run.total")}</span>
            <Amount estimate={preview.total} size="total" />
          </div>
          {many ? (
            <p className="text-caption leading-[1.45] text-text-secondary">
              {t("canvas.errors.confirmJobs", { count: dialog.response.jobs })}
            </p>
          ) : null}
          <p className="text-caption leading-[1.45] text-text-tertiary">
            {companies.length ? t("canvas.run.note", { companies: listOf(companies) }) : null}
            {unknownNames.length
              ? ` ${t("canvas.run.notInTotal", { names: listOf(unknownNames), count: unknownNames.length })}`
              : null}
          </p>
        </div>
        <div className="flex items-center gap-6">
          <Button variant="ghost" size="s" onClick={() => onAnswer(false)}>
            {t("canvas.run.cancel")}
          </Button>
          <Button
            variant="primary"
            size="s"
            icon={Play}
            data-autofocus
            aria-label={`${upstream?.length ? t("canvas.run.runThemToo") : t("canvas.run.run")} ${formatCost(preview.total)}`}
            onClick={() => onAnswer(true)}
          >
            {upstream?.length ? t("canvas.run.runThemToo") : t("canvas.run.run")}
          </Button>
        </div>
      </div>
    </>
  );
}
