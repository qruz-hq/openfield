import { type DifferenceRequest, drawDifference } from "./difference";

// Works out the Difference view's mask away from the page, so decoding two previews and comparing
// a million or so pixels never holds up a stroke or the slider. Each answer carries its request's id.

export interface DifferenceMessage extends DifferenceRequest {
  id: number;
}

export type DifferenceReply = { id: number; mask: ImageBitmap } | { id: number; error: string };

self.onmessage = async (event: MessageEvent<DifferenceMessage>) => {
  const { id, ...request } = event.data;
  try {
    const surface = await drawDifference(request, (width, height) => new OffscreenCanvas(width, height));
    const mask = (surface as OffscreenCanvas).transferToImageBitmap();
    self.postMessage({ id, mask } satisfies DifferenceReply, { transfer: [mask] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ id, error: message } satisfies DifferenceReply);
  }
};
