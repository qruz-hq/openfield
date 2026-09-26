import { type AssetListItem, t } from "@openfield/core";
import { rawFetch, toApiError } from "../api/raw";
import { focusPrompt } from "../image/composer/focus";
import { useComposer } from "../image/composer/store";
import { notify } from "../lib/notify";
import { downloadName, type FrozenSettings } from "./format";

// The detail view's footer actions that don't go through a cache hook: the file itself, the
// clipboard and the composer.

async function originalOf(asset: Pick<AssetListItem, "fileUrl">): Promise<Blob> {
  const res = await rawFetch(asset.fileUrl);
  if (!res.ok) throw await toApiError(res);
  return res.blob();
}

/** Download: the original, under openfield_{date}_{model}_{id}.{ext} (§4.4). */
export async function downloadOriginal(
  asset: Pick<AssetListItem, "id" | "createdAt" | "modelId" | "mime" | "fileUrl">,
): Promise<void> {
  const blob = await originalOf(asset);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = downloadName(asset);
  document.body.append(link);
  link.click();
  link.remove();
  // The browser has the file once the click is handled; the URL can go on the next task.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("PNG encode failed"))), "image/png"),
  );
}

/**
 * Copy image: the image on the clipboard as PNG, the one type every app pastes. The item takes a
 * promise so the write starts inside the click, which Safari requires.
 */
export async function copyImage(asset: Pick<AssetListItem, "fileUrl">): Promise<void> {
  const png = originalOf(asset).then(toPng);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** Focus the prompt once the composer is on screen: after a route change it mounts a frame or two later. */
export function focusPromptSoon(frames = 10) {
  requestAnimationFrame(() => {
    const before = document.activeElement;
    focusPrompt();
    if (document.activeElement === before && frames > 0) focusPromptSoon(frames - 1);
  });
}

/**
 * Reuse (§0.1, §4.4): the prompt, model and settings into the composer, without running. Values the
 * model can't take fall back to its defaults when the composer resolves them. What was there before
 * comes back with Undo.
 */
export function reuseSettings(settings: FrozenSettings & { prompt: string }) {
  const before = useComposer.getState();
  const snapshot = {
    prompt: before.prompt,
    model: before.model,
    aspect: before.aspect,
    resolution: before.resolution,
    quality: before.quality,
  };
  useComposer.setState({
    prompt: settings.prompt,
    ...(settings.model ? { model: settings.model } : {}),
    aspect: settings.aspect,
    resolution: settings.resolution,
    quality: settings.quality,
  });
  if (snapshot.prompt.trim() && snapshot.prompt !== settings.prompt) {
    notify(t("assets.detail.reused"), {
      duration: 8000,
      action: { label: t("actions.undo"), onClick: () => useComposer.setState(snapshot) },
    });
  }
}
