import {
  type AssetListItem,
  type CostEstimate,
  formatPrice,
  LAYER_SIZES,
  type LayerSize,
  type ModelListItem,
  newId,
  type StackLayer,
  t,
} from "@openfield/core";
import { estimate, priceFor } from "@openfield/providers/manifest";
import {
  Button,
  cn,
  Field,
  GroupLabel,
  Input,
  ModelRow,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProgressBar,
  ProviderLogo,
  Segmented,
  SegmentedItem,
  Spinner,
  useFieldControl,
} from "@openfield/ui";
import {
  Brush,
  Check,
  ChevronDown,
  Combine,
  Download,
  Eye,
  EyeOff,
  FileArchive,
  GripVertical,
  ImagePlus,
  Info,
  Layers,
  Lock,
  TriangleAlert,
} from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { queryClient, queryKeys } from "../../api/client";
import { useAuthedImage } from "../../api/hooks/images";
import { exportStack, flattenStack } from "../../api/hooks/layers";
import { useModels } from "../../api/hooks/models";
import { useSettings } from "../../api/hooks/settings";
import { errorMessage } from "../../api/raw";
import { useAddReference } from "../../image/composer/use-reference";
import { tightCost } from "../../lib/cost";
import { focusSelected, Listbox } from "../../lib/listbox";
import { notify, notifyError } from "../../lib/notify";
import { logoFor } from "../../lib/provider";
import { downloadOriginal } from "../actions";
import { thumbAt } from "../format";
import type { DetailTab } from "../use-detail";
import { formatRate, layerInputProblem, layerModels, moveLayer, stackCost, stackEntries } from "./stack";
import { promptFor, startSeparation, updateView, useLayers } from "./store";
import type { LayersTab } from "./use-layers-tab";

// The detail view's Layers tab (design YuFQEjr0TW and its states): the form that asks for a split,
// which rests at 50% while one runs, or says why this image can't be split; once there's a stack,
// its layers top first with the base pinned at the bottom, the selected one's actions under it,
// and the downloads and Flatten at the panel's foot.

export interface LayersPanelProps {
  item: AssetListItem;
  tab: LayersTab;
  /** Shows another image, on Info or on a tab. */
  onOpen: (assetId: string, tab?: DetailTab) => void;
}

export function LayersPanel({ item, tab, onOpen }: LayersPanelProps) {
  if (tab.runId && tab.stack && tab.rows)
    return <StackPanel runId={tab.runId} tab={tab} rows={tab.rows} onOpen={onOpen} />;
  // A stack named but not read yet: nothing to ask for meanwhile.
  if (tab.runId) return null;
  return <SplitForm item={item} status={tab.separation?.status} />;
}

interface Pricing {
  estimate: CostEstimate;
  /** One image's rate, the base's and each layer's. */
  rate: string;
  /** The most layers, besides the base. */
  most: number;
  atMost: string;
}

/** What a split of this image costs: the range for the button, the rates for the price box. */
function pricingOf(model: ModelListItem, image: AssetListItem, size: LayerSize): Pricing | null {
  const price = priceFor(model, "standard");
  if (price.kind !== "per_image" || !price.decompose) return null;
  const { outputs } = price.decompose;
  const cost = estimate(model, {
    batch: 1,
    op: "decompose",
    base: { assetId: image.id, role: "base" },
    layers: { size },
    inputImageSizes: [{ width: image.width, height: image.height }],
    speed: "standard",
  });
  if (cost.confidence === "unknown") return null;
  const low = cost.min / outputs.min;
  const high = cost.max / outputs.max;
  const rate =
    formatRate(low, cost.currency) === formatRate(high, cost.currency)
      ? formatRate(low, cost.currency)
      : t("cost.range", { min: formatRate(low, cost.currency), max: formatRate(high, cost.currency) });
  return {
    estimate: cost,
    rate,
    most: outputs.max - 1,
    atMost: t("layers.price.atMost", { cost: formatPrice(cost.max, cost.currency) }),
  };
}

function SplitForm({
  item,
  status,
}: {
  item: AssetListItem;
  status: "running" | "failed" | "done" | undefined;
}) {
  const models = layerModels(useModels().data ?? []).filter((m) => m.ready);
  const defaultModel = useSettings().data?.defaultModel;
  const picked = useLayers((s) => s.model);
  const pickedSize = useLayers((s) => s.size);
  const prompt = useLayers((s) => (s.promptFor === item.id ? s.prompt : ""));
  const model =
    models.find((m) => m.key === picked) ?? models.find((m) => m.key === defaultModel) ?? models[0];
  const rules = model?.capabilities.layers;
  const size: LayerSize =
    pickedSize && rules?.sizes.includes(pickedSize) ? pickedSize : (rules?.default ?? "auto");
  const problem = layerInputProblem(item, model);
  const pricing = model ? pricingOf(model, item, size) : null;
  const running = status === "running";
  const failed = status === "failed";
  const ready = model !== undefined && !problem && !running;

  const separate = () => {
    if (!ready || !model) return;
    const words = promptFor(item.id).trim();
    startSeparation({
      idempotencyKey: newId(),
      model: model.key,
      image: item.id,
      size,
      ...(words && { prompt: words }),
      source: "detail_editor",
    });
  };

  // Separating: everything but the footer rests at 50%, as drawn.
  const rest = running ? "opacity-50" : undefined;
  return (
    <>
      {/* Intro */}
      <div
        inert={running}
        className={cn("flex w-full shrink-0 flex-col gap-6 rounded-14 bg-surface p-14", rest)}
      >
        <div className="flex items-center gap-8">
          <Layers size={16} aria-hidden className="shrink-0 text-text-primary" />
          <span className="text-small font-semibold text-text-primary">{t("layers.intro.title")}</span>
        </div>
        <p className="w-full text-caption leading-[1.45] text-text-tertiary">{t("layers.intro.body")}</p>
      </div>
      {/* What to separate */}
      <Field
        inert={running}
        label={t("layers.what.label")}
        description={t("layers.what.hint")}
        className={cn("shrink-0 px-2 py-4", rest)}
      >
        <Input
          value={prompt}
          placeholder={t("layers.what.placeholder")}
          onChange={(event) => useLayers.setState({ prompt: event.target.value, promptFor: item.id })}
          onKeyDown={(event) => {
            if (event.key === "Enter") separate();
          }}
        />
      </Field>
      {/* Model */}
      <div inert={running} className={cn("flex w-full shrink-0 flex-col gap-6", rest)}>
        <Field label={t("layers.model")} className="px-2 py-4">
          <LayersModelPicker
            models={models}
            selected={model}
            onPick={(next) => useLayers.setState({ model: next.key })}
          />
        </Field>
      </div>
      {/* Size */}
      {rules ? (
        <Field inert={running} label={t("layers.size.label")} className={cn("shrink-0 px-2 py-4", rest)}>
          <Segmented value={size} onValueChange={(next) => useLayers.setState({ size: next as LayerSize })}>
            {LAYER_SIZES.filter((s) => rules.sizes.includes(s)).map((s) => (
              <SegmentedItem key={s} value={s}>
                {s === "auto" ? t("layers.size.auto") : s}
              </SegmentedItem>
            ))}
          </Segmented>
          <p className="text-caption text-text-tertiary">
            {size === "auto"
              ? t("layers.size.autoNote", { width: item.width, height: item.height })
              : t("layers.size.tierNote", { size })}
          </p>
        </Field>
      ) : null}
      {/* Price */}
      {pricing ? (
        <div
          inert={running}
          className={cn("flex w-full shrink-0 flex-col gap-8 rounded-14 bg-surface p-12", rest)}
        >
          <PriceRow label={t("layers.price.base")} value={pricing.rate} />
          <PriceRow label={t("layers.price.each")} value={pricing.rate} />
          <PriceRow label={t("layers.price.upTo", { count: pricing.most })} value={pricing.atMost} />
          <p className="w-full text-caption leading-[1.45] text-text-tertiary">{t("layers.price.note")}</p>
        </div>
      ) : null}
      {/* Footer */}
      <div className="flex w-full flex-1 flex-col justify-end gap-10">
        {running ? (
          <div role="status" className="flex w-full flex-col gap-10 rounded-14 bg-surface p-14">
            <div className="flex items-center gap-8">
              <Spinner size={16} className="text-text-secondary" />
              <span className="text-small font-medium text-text-primary">{t("layers.separating.title")}</span>
            </div>
            <ProgressBar label={t("layers.separating.title")} />
            <p className="w-full text-caption leading-[1.45] text-text-tertiary">
              {t("layers.separating.note")}
            </p>
          </div>
        ) : (
          <>
            {problem ? (
              <div className="flex w-full items-center gap-6 px-2">
                <Info size={12} aria-hidden className="shrink-0 text-text-tertiary" />
                <p className="min-w-0 flex-1 text-caption text-text-tertiary">
                  {problem.kind === "type"
                    ? t("layers.wrongType")
                    : t("layers.tooSmall", { width: problem.width, height: problem.height })}
                </p>
              </div>
            ) : failed ? (
              <div
                role="alert"
                className="flex w-full items-start gap-10 rounded-10 bg-danger-soft px-12 py-10"
              >
                <TriangleAlert size={16} aria-hidden className="shrink-0 text-danger" />
                <p className="min-w-0 flex-1 text-small leading-[1.45] text-text-primary">
                  {t("layers.failed")}
                </p>
              </div>
            ) : null}
            <Button
              icon={Layers}
              price={pricing ? tightCost(pricing.estimate) : undefined}
              aria-disabled={!ready || undefined}
              onClick={separate}
              className={cn("w-full", !ready && "cursor-default opacity-40")}
            >
              {t(failed && !problem ? "layers.tryAgain" : "layers.separate")}
            </Button>
          </>
        )}
      </div>
    </>
  );
}

/** Layers Price / Row: the key in 13 secondary, the amount in mono 12. */
function PriceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex w-full items-center justify-between">
      <span className="text-small text-text-secondary">{label}</span>
      <span className="text-mono-12 text-text-primary">{value}</span>
    </div>
  );
}

/** The Model field's select, opening the list of models that split, beside the panel. */
function LayersModelPicker({
  models,
  selected,
  onPick,
}: {
  models: readonly ModelListItem[];
  selected: ModelListItem | undefined;
  onPick: (model: ModelListItem) => void;
}) {
  const field = useFieldControl();
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const logo = logoFor(selected?.providerId);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={field.id}
          className="group flex h-38 w-full min-w-0 cursor-pointer items-center justify-between gap-8 rounded-10 bg-surface px-12 inset-ring inset-ring-border text-small text-text-primary transition-shadow data-[state=open]:inset-ring-accent-line"
        >
          <span className="flex min-w-0 items-center gap-8">
            {logo ? <ProviderLogo provider={logo} /> : null}
            <span className={cn("truncate", !selected && "text-text-tertiary")}>
              {selected?.displayName ?? t("composer.chips.model.empty")}
            </span>
          </span>
          <ChevronDown
            size={14}
            aria-hidden
            className="shrink-0 text-text-tertiary transition-transform group-data-[state=open]:rotate-180"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="left"
        align="start"
        sideOffset={22}
        className="w-402 gap-0 p-0"
        onOpenAutoFocus={focusSelected(list)}
      >
        <div ref={list}>
          <Listbox label={t("composer.chips.model.choose")} className="flex flex-col p-8">
            <GroupLabel>{t("layers.intro.title")}</GroupLabel>
            {models.map((model) => {
              const itemLogo = logoFor(model.providerId);
              const isSelected = model.key === selected?.key;
              return (
                <ModelRow
                  key={model.key}
                  asChild
                  name={model.displayName}
                  description={model.description}
                  logo={itemLogo ? <ProviderLogo provider={itemLogo} variant="tile" /> : undefined}
                  selected={isSelected}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      setOpen(false);
                      onPick(model);
                    }}
                  />
                </ModelRow>
              );
            })}
          </Listbox>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Done

function StackPanel({
  runId,
  tab,
  rows,
  onOpen,
}: {
  runId: string;
  tab: LayersTab;
  rows: StackLayer[];
  onOpen: (assetId: string, tab?: DetailTab) => void;
}) {
  const models = useModels().data ?? [];
  const addReference = useAddReference();
  const [busy, setBusy] = useState<"zip" | "psd" | "flatten" | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const layers = rows.filter((r) => r.role === "layer");
  const base = rows.find((r) => r.role === "base");
  const model = base
    ? models.find((m) => m.providerId === base.asset.providerId && m.modelId === base.asset.modelId)
    : undefined;
  const cost = tab.stack ? stackCost(tab.stack) : null;
  const entries = stackEntries(rows, tab.hidden);
  const nothing = entries.length === 0;

  const select = (id: string) =>
    updateView(runId, (view) => ({ selected: view.selected === id ? null : id }));
  const toggle = (id: string) =>
    updateView(runId, (view) => ({
      hidden: view.hidden.includes(id) ? view.hidden.filter((h) => h !== id) : [...view.hidden, id],
    }));
  const move = (id: string, to: number) => updateView(runId, () => ({ order: moveLayer(rows, id, to) }));

  // A drag on a grip moves its layer to the row under the pointer as it goes.
  const onGripDown = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag(id);
  };
  const onGripMove = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    if (drag !== id) return;
    const over = document
      .elementsFromPoint(event.clientX, event.clientY)
      .map((el) => el.closest<HTMLElement>("[data-layer-row]"))
      .find((el) => el && el.dataset.layerRow !== id);
    const to = over ? layers.findIndex((r) => r.asset.id === over.dataset.layerRow) : -1;
    if (to >= 0) move(id, to);
  };
  const onGripKey = (event: KeyboardEvent<HTMLButtonElement>, id: string, index: number) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    move(id, index + (event.key === "ArrowUp" ? -1 : 1));
  };

  const download = (format: "zip" | "psd") => {
    if (nothing || busy) return;
    setBusy(format);
    exportStack(runId, entries, format)
      .catch((error: unknown) => notifyError(errorMessage(error)))
      .finally(() => setBusy(null));
  };
  const flatten = () => {
    if (nothing || busy) return;
    setBusy("flatten");
    flattenStack(runId, entries)
      .then((asset) => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.allAssets });
        notify(t("layers.flattened"), {
          tone: "success",
          action: { label: t("layers.from.open"), onClick: () => onOpen(asset.id) },
        });
      })
      .catch((error: unknown) => notifyError(errorMessage(error)))
      .finally(() => setBusy(null));
  };

  return (
    <>
      {/* Title row */}
      <div className="flex w-full shrink-0 items-center justify-between gap-8 px-2">
        <span className="text-small font-medium text-text-primary">
          {t("layers.done.title", { count: layers.length })}
        </span>
        {model && cost !== null ? (
          <span className="truncate text-mono-11 text-text-tertiary">
            {t("layers.done.cost", { model: model.displayName, cost: formatPrice(cost) })}
          </span>
        ) : null}
      </div>
      {/* Stack */}
      <ul
        aria-label={t("layers.list")}
        className="flex w-full shrink-0 flex-col gap-2 rounded-14 bg-surface p-4"
      >
        {rows.map((row) => {
          const id = row.asset.id;
          const isBase = row.role === "base";
          const index = layers.indexOf(row);
          const selected = tab.view.selected === id && !isBase;
          const hidden = tab.hidden.has(id);
          const name = row.name ?? (isBase ? t("layers.base") : t("layers.layer", { n: row.zIndex }));
          return (
            <li key={id} className="flex flex-col">
              <div
                data-layer-row={isBase ? undefined : id}
                className={cn(
                  "flex w-full items-center gap-10 rounded-10 px-8 py-6",
                  selected && "bg-accent-soft",
                  drag === id && "bg-elevated-2",
                )}
              >
                {isBase ? (
                  <span title={t("layers.row.locked")} className="flex shrink-0 text-text-tertiary">
                    <Lock size={14} aria-hidden />
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={t("layers.row.drag", { name })}
                    onPointerDown={(event) => onGripDown(event, id)}
                    onPointerMove={(event) => onGripMove(event, id)}
                    onPointerUp={() => setDrag(null)}
                    onPointerCancel={() => setDrag(null)}
                    onKeyDown={(event) => onGripKey(event, id, index)}
                    className={cn(
                      "flex shrink-0 touch-none text-text-tertiary hover:text-text-secondary",
                      drag === id ? "cursor-grabbing" : "cursor-grab",
                    )}
                  >
                    <GripVertical size={14} aria-hidden />
                  </button>
                )}
                <button
                  type="button"
                  aria-pressed={isBase ? undefined : selected}
                  disabled={isBase}
                  onClick={() => select(id)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-10 text-left disabled:cursor-default"
                >
                  <LayerThumb asset={row.asset} dimmed={hidden} />
                  <span className={cn("flex min-w-0 flex-1 flex-col gap-2", hidden && "opacity-40")}>
                    <span className="truncate text-small font-medium text-text-primary">{name}</span>
                    <span className="flex w-full">
                      <span className="truncate text-caption text-text-tertiary">
                        {row.description ?? (isBase ? t("layers.baseDescription") : "")}
                      </span>
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={t(hidden ? "layers.row.show" : "layers.row.hide", { name })}
                  aria-pressed={!hidden}
                  onClick={() => toggle(id)}
                  className="flex size-28 shrink-0 cursor-pointer items-center justify-center rounded-8 text-text-secondary hover:bg-elevated-2 hover:text-text-primary"
                >
                  {hidden ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                </button>
              </div>
              {selected ? (
                <div className="flex w-full flex-wrap items-center gap-6 px-8 pt-2 pb-8">
                  <Button variant="secondary" size="s" icon={Brush} onClick={() => onOpen(id, "edit")}>
                    {t("layers.actions.edit")}
                  </Button>
                  <Button variant="secondary" size="s" icon={ImagePlus} onClick={() => addReference(id)}>
                    {t("layers.actions.reference")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="s"
                    icon={Download}
                    onClick={() =>
                      void downloadOriginal(row.asset).catch((error: unknown) =>
                        notifyError(errorMessage(error)),
                      )
                    }
                  >
                    {t("layers.actions.download")}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="w-full shrink-0 text-caption leading-[1.45] text-text-tertiary">{t("layers.hint")}</p>
      {/* Footer */}
      <div className="flex w-full flex-1 flex-col justify-end gap-8">
        <div className="flex w-full items-center gap-8 px-2">
          <Check size={14} aria-hidden className="shrink-0 text-text-secondary" />
          <p className="min-w-0 flex-1 text-caption text-text-secondary">{t("layers.saved")}</p>
        </div>
        <div className="flex w-full gap-8">
          <ExportButton
            icon={FileArchive}
            busy={busy === "zip"}
            off={nothing}
            onClick={() => download("zip")}
          >
            {t("layers.pngs")}
          </ExportButton>
          <ExportButton icon={Download} busy={busy === "psd"} off={nothing} onClick={() => download("psd")}>
            {t("layers.psd")}
          </ExportButton>
        </div>
        <Button
          icon={Combine}
          loading={busy === "flatten"}
          aria-disabled={nothing || undefined}
          title={nothing ? t("errors.layersAllHidden") : undefined}
          onClick={flatten}
          className={cn("w-full", nothing && "cursor-default opacity-40")}
        >
          {t("layers.flatten")}
        </Button>
      </div>
    </>
  );
}

/**
 * Layers Done / Download PNGs and / PSD: 40 tall, radius 8, a 14 icon and 13/600, unlike any
 * shared button size, so drawn here.
 */
function ExportButton({
  icon: Icon,
  busy,
  off,
  onClick,
  children,
}: {
  icon: typeof Download;
  busy: boolean;
  off: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-busy={busy || undefined}
      aria-disabled={off || undefined}
      title={off ? t("errors.layersAllHidden") : undefined}
      onClick={onClick}
      className={cn(
        "flex h-40 min-w-0 flex-1 cursor-pointer items-center justify-center gap-6 rounded-8 bg-elevated-2 px-12 inset-ring inset-ring-border text-small font-semibold text-text-primary transition-shadow hover:inset-ring-border-strong",
        off && "cursor-default opacity-40",
      )}
    >
      {busy ? <Spinner size={14} /> : <Icon size={14} aria-hidden className="shrink-0" />}
      {children}
    </button>
  );
}

/** Layers Row / Thumb: 40, radius 8, with the layer fit in a 32 crop at its centre. */
function LayerThumb({ asset, dimmed }: { asset: Pick<AssetListItem, "id" | "thumbUrl">; dimmed: boolean }) {
  const image = useAuthedImage(thumbAt(asset, { h: 200 }));
  return (
    <span
      className={cn(
        "relative flex size-40 shrink-0 items-center justify-center rounded-8 bg-elevated-2 inset-ring inset-ring-border",
        dimmed && "opacity-40",
      )}
    >
      <span className="flex size-32 items-center justify-center overflow-hidden">
        {image.status === "ready" ? (
          <img src={image.src} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
        ) : null}
      </span>
    </span>
  );
}
