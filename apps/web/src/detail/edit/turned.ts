import type { AssetListItem } from "@openfield/core";
import { useEffect, useState } from "react";
import { rawFetch } from "../../api/raw";
import { EXIF_HEAD_BYTES, isTurnedOrientation, jpegOrientation } from "./exif";
import { useEditSession } from "./session";

// Whether an image can't take a mask because it's a phone photo stored on its side: from its EXIF
// tag, read off the file's first bytes when the Edit tab opens, or from the server having turned
// the mask away. Each image is read once.

const known = new Map<string, Promise<boolean>>();

function readTurned(item: Pick<AssetListItem, "id" | "fileUrl">): Promise<boolean> {
  let pending = known.get(item.id);
  if (!pending) {
    pending = rawFetch(item.fileUrl, { headers: { Range: `bytes=0-${EXIF_HEAD_BYTES - 1}` } })
      .then(async (res) =>
        res.ok ? isTurnedOrientation(jpegOrientation(new Uint8Array(await res.arrayBuffer()))) : false,
      )
      // Unread, it's left to the server, which refuses a turned photo when the mask is saved.
      .catch(() => false);
    known.set(item.id, pending);
  }
  return pending;
}

const isJpeg = (mime: string) => mime === "image/jpeg" || mime === "image/jpg";

export function useTurnedPhoto(
  item: Pick<AssetListItem, "id" | "fileUrl" | "mime">,
  enabled: boolean,
): boolean {
  const { id, fileUrl, mime } = item;
  const [read, setRead] = useState<{ id: string; turned: boolean } | null>(null);
  const refused = useEditSession((s) => s.turned && s.assetId === id);

  useEffect(() => {
    if (!enabled || !isJpeg(mime)) return;
    let live = true;
    void readTurned({ id, fileUrl }).then((turned) => {
      if (live) setRead({ id, turned });
    });
    return () => {
      live = false;
    };
  }, [enabled, id, fileUrl, mime]);

  return refused || (read?.id === id && read.turned);
}
