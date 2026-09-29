import type { AssetListItem, ModelListItem } from "@openfield/core";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { modelsQuery } from "../api/hooks/models";

// Small pieces the library's cards, menus and ghosts share: thumbnail paths and model names.

/** The thumbnail at a height rung, doubled on a high-density screen (§0.10). */
export function thumbPath(asset: Pick<AssetListItem, "id" | "thumbUrl">, rung: number): string {
  const url = new URL(asset.thumbUrl || `/files/thumb/${asset.id}`, window.location.origin);
  url.searchParams.set("h", String(rung));
  if (window.devicePixelRatio > 1) url.searchParams.set("dpr", "2");
  else url.searchParams.delete("dpr");
  return `${url.pathname}${url.search}`;
}

/** Every model the server knows, enabled or not: an old image or video may come from one turned off since. */
export function useModelNames() {
  const models = useQuery({ ...modelsQuery("all"), select: (data) => data.models });
  return useCallback(
    (providerId: string | null, modelId: string | null): string | undefined => {
      if (!modelId) return undefined;
      const found = models.data?.find(
        (m: ModelListItem) => m.modelId === modelId && (providerId === null || m.providerId === providerId),
      );
      return found?.displayName ?? modelId;
    },
    [models.data],
  );
}
