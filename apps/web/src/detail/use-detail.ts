import { useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { create } from "zustand";

// Which image the detail view shows. It rides in ?asset=<id> through replaceState, so a reload
// reopens the same image in the same list and closing never adds a history entry (§4.0, §4.5).

export const DETAIL_PARAM = "asset";

/**
 * The attribute a list puts on the element that opens an image (the tile's or card's button). The
 * detail view scrolls it into view while stepping and hands focus back to it on close.
 */
export const DETAIL_TARGET = "data-asset-id";

export const detailTarget = (assetId: string) => ({ [DETAIL_TARGET]: assetId });

export function findDetailTarget(assetId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${DETAIL_TARGET}="${CSS.escape(assetId)}"]`);
}

interface LastViewedState {
  id: string | null;
  set: (id: string | null) => void;
}

/**
 * The image the detail view last closed on: the Last viewed badge (§2.4). It lasts across
 * navigation within the tab and clears when another image opens.
 */
export const useLastViewedStore = create<LastViewedState>((set) => ({
  id: null,
  set: (id) => set({ id }),
}));

export const useLastViewed = () => useLastViewedStore((s) => s.id);

/** Whether this image carries the badge. Each tile subscribes to its own answer only. */
export const useIsLastViewed = (assetId: string) => useLastViewedStore((s) => s.id === assetId);

/** Open, step and close the detail view from any list. */
export function useDetail() {
  const [params, setParams] = useSearchParams();
  const assetId = params.get(DETAIL_PARAM);
  const show = useCallback(
    (id: string | null) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set(DETAIL_PARAM, id);
          else next.delete(DETAIL_PARAM);
          return next;
        },
        { replace: true, preventScrollReset: true },
      ),
    [setParams],
  );
  const open = useCallback(
    (id: string) => {
      useLastViewedStore.getState().set(null);
      show(id);
    },
    [show],
  );
  /** Closes on the image shown now, which becomes Last viewed. */
  const close = useCallback(() => {
    if (assetId) useLastViewedStore.getState().set(assetId);
    show(null);
  }, [assetId, show]);
  return { assetId, open, show, close };
}

/**
 * Just the opener, for a list's tiles: it doesn't follow the URL, so stepping through images
 * doesn't re-render every tile.
 */
export function useOpenDetail() {
  const navigate = useNavigate();
  return useCallback(
    (id: string) => {
      useLastViewedStore.getState().set(null);
      const params = new URLSearchParams(window.location.search);
      params.set(DETAIL_PARAM, id);
      navigate({ search: `?${params}` }, { replace: true, preventScrollReset: true });
    },
    [navigate],
  );
}

// A toast can outlive the view that raised it (Recreate's Show), so the open view registers how to
// close itself here.
let closeOpenView: (() => void) | null = null;

export function registerDetailCloser(close: (() => void) | null) {
  closeOpenView = close;
}

/** Closes the detail view if one is open. */
export function closeDetailView() {
  closeOpenView?.();
}
