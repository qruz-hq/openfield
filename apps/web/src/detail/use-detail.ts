import { useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { create } from "zustand";

// Which image the detail view shows. It rides in ?asset=<id> through replaceState, so a reload
// reopens the same image in the same list and closing never adds a history entry (§4.0, §4.5).
// The Edit tab rides beside it as &tab=edit; Info is the default and leaves no trace.

export const DETAIL_PARAM = "asset";

/** The panel's column, right of the image's area: 352 wide, 8 from the window's edge (design x7y6U). */
export const PANEL_GUTTER = 360;
export const TAB_PARAM = "tab";

export type DetailTab = "info" | "edit";

const tabOf = (value: string | null): DetailTab => (value === "edit" ? "edit" : "info");

/** The search params with `id` shown on `tab`, or with neither when `id` is null. */
function withDetail(prev: URLSearchParams, id: string | null, tab: DetailTab = "info"): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (id) next.set(DETAIL_PARAM, id);
  else next.delete(DETAIL_PARAM);
  if (id && tab === "edit") next.set(TAB_PARAM, tab);
  else next.delete(TAB_PARAM);
  return next;
}

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
  const tab = tabOf(params.get(TAB_PARAM));
  /** Shows `id` on its Info tab, or on `tab`; null closes the view. */
  const show = useCallback(
    (id: string | null, tab?: DetailTab) =>
      setParams((prev) => withDetail(prev, id, tab), { replace: true, preventScrollReset: true }),
    [setParams],
  );
  /** Switches the open image's tab. */
  const setTab = useCallback(
    (next: DetailTab) =>
      setParams((prev) => withDetail(prev, prev.get(DETAIL_PARAM), next), {
        replace: true,
        preventScrollReset: true,
      }),
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
  return { assetId, tab, open, show, setTab, close };
}

/**
 * Just the opener, for a list's tiles: it doesn't follow the URL, so stepping through images
 * doesn't re-render every tile.
 */
export function useOpenDetail() {
  const navigate = useNavigate();
  return useCallback(
    (id: string, tab: DetailTab = "info") => {
      useLastViewedStore.getState().set(null);
      const params = withDetail(new URLSearchParams(window.location.search), id, tab);
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
