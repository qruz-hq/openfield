import type { AssetDetailResponse, AssetListItem, LayerStackResponse, StackLayer } from "@openfield/core";
import { useLayerStack } from "../../api/hooks/layers";
import { useModels } from "../../api/hooks/models";
import { layerModels, layerOf, rowsTopFirst, stackRunOf } from "./stack";
import { type Separation, type StackView, useLayers, useStackView } from "./store";

// Everything the Layers tab's panel and its image share: the stack this image's tab shows (if it
// was split), how it's shown, and a split on its way.

export interface LayersTab {
  /** The tab is offered: the image was split, or a model that splits is ready to. */
  offered: boolean;
  /** The image is itself one layer of a split: it gets Info and Edit only. */
  isLayer: boolean;
  runId: string | null;
  stack: LayerStackResponse | undefined;
  /** Top first, base last. */
  rows: StackLayer[] | null;
  view: StackView;
  hidden: ReadonlySet<string>;
  selected: StackLayer | null;
  separation: Separation | undefined;
}

export function useLayersTab(
  item: Pick<AssetListItem, "id" | "modality" | "layer">,
  detail: AssetDetailResponse | undefined,
): LayersTab {
  const models = useModels().data ?? [];
  const separation = useLayers((s) => s.runs[item.id]);
  const own = detail ? layerOf(detail.asset) : null;
  const isLayer = own ? own.role === "layer" : item.layer?.role === "layer";
  // A split that just finished names its stack before the image's details are read again.
  const runId =
    (detail ? stackRunOf(detail) : null) ?? (separation?.status === "done" ? separation.runId : null);
  const stack = useLayerStack(runId).data;
  const view = useStackView(runId);
  const rows = stack ? rowsTopFirst(stack, view.order) : null;
  const hidden = new Set(view.hidden);
  const selected = rows?.find((row) => row.role === "layer" && row.asset.id === view.selected) ?? null;
  const ready = layerModels(models).some((m) => m.ready);
  return {
    offered: item.modality !== "video" && !isLayer && (runId !== null || ready),
    isLayer,
    runId,
    stack,
    rows,
    view,
    hidden,
    selected,
    separation,
  };
}
