import { type Asset, type LayerStackResponse, type ModelListItem, t } from "@openfield/core";
import { Button, SectionLabel, Surface } from "@openfield/ui";
import { Layers } from "lucide-react";
import { useAuthedImage } from "../../api/hooks/images";
import { CopyChip, ReferenceThumb } from "../detail-panel";
import { thumbAt, titleOf } from "../format";
import { layerPosition, rowsTopFirst } from "./stack";

// The Info tab's blocks for a split: LAYERS on the image that was split (design A4sok9IYIV), and
// LAYERS FROM on one of its layers, in Prompt's place (design pUyc1u79i9).

/** Detail / Section / Layers: a thumb per layer, top first, then the base, and Open in Layers. */
export function LayersSection({
  stack,
  onOpenLayer,
  onOpenTab,
}: {
  stack: LayerStackResponse;
  onOpenLayer: (asset: Asset) => void;
  onOpenTab: () => void;
}) {
  const rows = rowsTopFirst(stack);
  const count = rows.filter((r) => r.role === "layer").length;
  return (
    <Surface variant="block" className="w-full shrink-0 gap-10">
      <div className="flex w-full items-center justify-between">
        <SectionLabel>{t("layers.section.label")}</SectionLabel>
        <span className="shrink-0 text-caption text-text-tertiary">
          {t("layers.section.count", { count })}
        </span>
      </div>
      {/* Strip: one row; more than fit scroll sideways, as references do. */}
      <div className="flex w-full gap-6 overflow-x-auto">
        {rows.map((row) => {
          const name =
            row.name ?? (row.role === "base" ? t("layers.base") : t("layers.layer", { n: row.zIndex }));
          return (
            <StripThumb
              key={row.asset.id}
              asset={row.asset}
              label={t("layers.section.openLayer", { name })}
              onOpen={() => onOpenLayer(row.asset)}
            />
          );
        })}
      </div>
      <Button variant="secondary" size="l" icon={Layers} onClick={onOpenTab} className="w-full">
        {t("layers.section.open")}
      </Button>
    </Surface>
  );
}

/** A layer in the strip: 54, radius 8, the layer fit in a 46 crop at its centre. */
function StripThumb({
  asset,
  label,
  onOpen,
}: {
  asset: Pick<Asset, "id" | "thumbUrl">;
  label: string;
  onOpen: () => void;
}) {
  const image = useAuthedImage(thumbAt(asset, { h: 200 }));
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onOpen}
      className="flex size-54 shrink-0 cursor-pointer items-center justify-center rounded-8 bg-elevated-2 inset-ring inset-ring-border"
    >
      <span className="flex size-46 items-center justify-center overflow-hidden">
        {image.status === "ready" ? (
          <img src={image.src} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
        ) : null}
      </span>
    </button>
  );
}

/**
 * Detail / Section / Layers from: the image it was split from with Open, this layer's place and
 * name, its description, and Open all layers.
 */
export function LayersFromSection({
  layerId,
  stack,
  models,
  onOpen,
  onOpenAll,
}: {
  layerId: string;
  stack: LayerStackResponse;
  models: readonly ModelListItem[] | undefined;
  onOpen: (asset: Asset) => void;
  onOpenAll: () => void;
}) {
  const own = stack.layers.find((l) => l.asset.id === layerId);
  const position = layerPosition(stack, layerId);
  const source = stack.source;
  const description = own?.description ?? "";
  const name = own?.name ?? (position ? t("layers.layer", { n: position.index }) : "");
  const modelOf = (asset: Asset) =>
    models?.find((m) => m.providerId === asset.providerId && m.modelId === asset.modelId)?.displayName ??
    asset.modelId ??
    undefined;
  return (
    <Surface variant="block" className="w-full shrink-0">
      <div className="flex w-full items-center justify-between">
        <SectionLabel>{t("layers.from.label")}</SectionLabel>
        {description ? <CopyChip text={description} /> : null}
      </div>
      {source ? (
        <div className="flex w-full items-center gap-10">
          <ReferenceThumb asset={source} primary={false} />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="truncate text-small font-medium text-text-primary">
              {titleOf(source.prompt, modelOf(source))}
            </span>
            {position ? (
              <span className="w-full text-caption text-text-tertiary">
                {t("layers.from.position", { index: position.index, count: position.count, name })}
              </span>
            ) : null}
          </div>
          <Button variant="ghost" size="s" onClick={() => onOpen(source)}>
            {t("layers.from.open")}
          </Button>
        </div>
      ) : null}
      {description ? (
        <p className="w-full whitespace-pre-wrap break-words text-small leading-[1.45] text-text-secondary">
          {description}
        </p>
      ) : null}
      <Button variant="secondary" size="l" icon={Layers} onClick={onOpenAll} className="w-full">
        {t("layers.from.openAll")}
      </Button>
    </Surface>
  );
}
