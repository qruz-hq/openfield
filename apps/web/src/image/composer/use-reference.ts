import { t } from "@openfield/core";
import { useCallback } from "react";
import { notify } from "../../lib/notify";
import { useComposer } from "./store";

/**
 * Use as reference (a feed tile's hover action): queue the image as a reference for the next run,
 * without touching the prompt or model. Undo takes it back off.
 */
export function useAddReference() {
  return useCallback((assetId: string) => {
    const already = useComposer.getState().references.includes(assetId);
    useComposer.getState().addReference(assetId);
    if (already) return;
    notify(t("feed.tile.actions.referenceAdded"), {
      action: { label: t("actions.undo"), onClick: () => useComposer.getState().removeReference(assetId) },
    });
  }, []);
}
