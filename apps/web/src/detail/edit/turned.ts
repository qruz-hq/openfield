import type { AssetListItem } from "@openfield/core";
import { useEffect, useState } from "react";
import { rawFetch } from "../../api/raw";
import { EXIF_HEAD_BYTES, isTurnedOrientation, jpegOrientation, swapsSides } from "./exif";
import { useEditSession } from "./session";

// Whether an image can't take a mask because it's a phone photo stored on its side: from its EXIF
// tag, read off the file's first bytes when the Edit tab opens, or from the server having turned
// the mask away. Each image is read once.

const known = new Map<string, Promise<number | null>>();

function readOrientation(item: Pick<AssetListItem, "id" | "fileUrl">): Promise<number | null> {
  let pending = known.get(item.id);
  if (!pending) {
    pending = rawFetch(item.fileUrl, { headers: { Range: `bytes=0-${EXIF_HEAD_BYTES - 1}` } })
      .then(async (res) => (res.ok ? jpegOrientation(new Uint8Array(await res.arrayBuffer())) : null))
      // Unread, it's left to the server, which refuses a turned photo when the mask is saved.
      .catch(() => null);
    known.set(item.id, pending);
  }
  return pending;
}

const isJpeg = (mime: string) => mime === "image/jpeg" || mime === "image/jpg";

type TurnedItem = Pick<AssetListItem, "id" | "fileUrl" | "mime">;

/** The JPEG's EXIF orientation, read while `enabled`; null until it's read, or with none. */
function useOrientation(item: TurnedItem, enabled: boolean): number | null {
  const { id, fileUrl, mime } = item;
  const [read, setRead] = useState<{ id: string; orientation: number | null } | null>(null);

  useEffect(() => {
    if (!enabled || !isJpeg(mime)) return;
    let live = true;
    void readOrientation({ id, fileUrl }).then((orientation) => {
      if (live) setRead({ id, orientation });
    });
    return () => {
      live = false;
    };
  }, [enabled, id, fileUrl, mime]);

  return read?.id === id ? read.orientation : null;
}

/**
 * The browser draws a photo stored a quarter turn round upright, so it shows with its stored width
 * and height swapped.
 */
export const useShownSideways = (item: TurnedItem, enabled: boolean): boolean =>
  swapsSides(useOrientation(item, enabled));

export function useTurnedPhoto(item: TurnedItem, enabled: boolean): boolean {
  const refused = useEditSession((s) => s.turned && s.assetId === item.id);
  return isTurnedOrientation(useOrientation(item, enabled)) || refused;
}
