import { EMPTY_ENGINE_CONTEXT } from "@openfield/canvas/engine/context-base";
import { assetsSpec } from "@openfield/canvas/nodes/assets/spec";
import type { ImageListParams } from "@openfield/canvas/nodes/upload/spec";
import { t } from "@openfield/core";
import { Button } from "@openfield/ui";
import { Images } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { useCanvasActions, useLocked, useReadOnly } from "../../store/context";
import { takeOpenPicker } from "../picker-intent";
import type { NodeComponentProps } from "../registry";
import { NodeShell } from "../shell/node-shell";
import { AssetImage } from "../shell/thumb";
import { useNodeBasics, useParsedParams } from "../shell/use-node";
import { LibraryPicker } from "./library-picker";

// Canvas / Node / Assets (design x3MoC) and / Empty (pRq6B): images picked from the library, the
// first four in a 2×2 grid. The folder line and folder source wait for folders; until then the
// footer says how many images and offers Change.

export const AssetsNode = memo(function AssetsNode(props: NodeComponentProps) {
  const { id } = props;
  const basics = useNodeBasics(id);
  const params = useParsedParams<ImageListParams>(id, assetsSpec, basics?.ctx ?? EMPTY_ENGINE_CONTEXT);
  const actions = useCanvasActions();
  // Its images are its settings: a locked Assets node keeps them as they are (§7.9).
  const locked = useLocked(id);
  const readOnly = useReadOnly() || locked;
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (takeOpenPicker(id)) setPicking(true);
  }, [id]);

  if (!basics) return null;
  const { frame } = basics;
  const ids = params.assetIds;
  const count = t("canvas.nodes.images.count", { count: ids.length });
  const rows = [ids.slice(0, 2), ids.slice(2, 4)].filter((row) => row.length);

  return (
    <NodeShell
      {...props}
      spec={assetsSpec}
      title={frame.title}
      collapsed={frame.collapsed}
      collapsedMeta={<span className="truncate text-caption text-text-secondary">{count}</span>}
      thumbs={ids}
      frameClassName={ids.length ? undefined : "p-8"}
    >
      <LibraryPicker
        open={picking && !readOnly}
        initial={ids}
        onOpenChange={setPicking}
        onPick={(assetIds) =>
          actions.apply([{ op: "setParams", id, patch: { assetIds } }], { label: "images" })
        }
      />
      {ids.length ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            {rows.map((row) => (
              <div key={row[0]} className="flex min-h-0 flex-1 gap-2">
                {row.map((assetId) => (
                  <div key={assetId} className="relative min-w-0 flex-1">
                    <AssetImage assetId={assetId} height={112} className="absolute inset-0" />
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="flex h-56 shrink-0 items-center gap-6 pr-6 pl-12">
            <span className="min-w-0 flex-1 truncate text-caption text-text-secondary">{count}</span>
            <Button
              variant="ghost"
              size="s"
              className="nodrag"
              disabled={readOnly}
              onClick={() => setPicking(true)}
            >
              {t("canvas.nodes.assets.change")}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-12 rounded-10 bg-surface p-16 inset-ring inset-ring-border-strong">
          <span className="flex size-40 items-center justify-center rounded-full bg-elevated-2">
            <Images size={18} aria-hidden className="text-text-tertiary" />
          </span>
          <span className="text-center text-body-strong text-text-primary">
            {t("canvas.nodes.assets.emptyTitle")}
          </span>
          <Button
            variant="secondary"
            size="s"
            className="nodrag"
            disabled={readOnly}
            onClick={() => setPicking(true)}
          >
            {t("canvas.nodes.assets.choose")}
          </Button>
        </div>
      )}
    </NodeShell>
  );
});
