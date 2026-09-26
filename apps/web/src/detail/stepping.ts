import type { AssetListItem } from "@openfield/core";

// Previous and Next through the list the detail view was opened from (§4.0). Pure, so the paging
// rules are unit tested without a browser.

export interface Nav {
  /** Where the image sits in the loaded list, or -1 when it isn't there. */
  index: number;
  /**
   * Where the list's next image will be once another page loads: after the image, or where it
   * used to be when it left the list while open. -1 when the list can't tell (a reload with
   * ?asset= of an image no loaded page holds; the server's neighbours step instead).
   */
  nextAt: number;
  previous: AssetListItem | null;
  next: AssetListItem | null;
  /** Nothing loaded after it, but the list has more pages: Next loads one first. */
  nextUnloaded: boolean;
}

export interface Outside {
  previous: AssetListItem | null;
  next: AssetListItem | null;
}

/**
 * `lastIndex` is where the image was the last time the list held it. When it leaves the list while
 * open (taken out of this folder, deleted in another tab), the arrows step from that place.
 * `outside` is the server's answer for an image the list never loaded.
 */
export function navFor(
  items: readonly AssetListItem[],
  id: string | null,
  hasMore: boolean,
  lastIndex = -1,
  outside: Outside | null = null,
): Nav {
  const index = id === null ? -1 : items.findIndex((item) => item.id === id);
  if (index >= 0) {
    const next = items[index + 1] ?? null;
    return {
      index,
      nextAt: index + 1,
      previous: items[index - 1] ?? null,
      next,
      nextUnloaded: next === null && hasMore,
    };
  }
  if (lastIndex >= 0 && lastIndex <= items.length && items.length > 0) {
    const next = items[lastIndex] ?? null;
    return {
      index: -1,
      nextAt: lastIndex,
      previous: items[lastIndex - 1] ?? null,
      next,
      nextUnloaded: next === null && hasMore,
    };
  }
  return {
    index: -1,
    nextAt: -1,
    previous: outside?.previous ?? null,
    next: outside?.next ?? null,
    nextUnloaded: false,
  };
}

/**
 * A step that waits for the list to load further: Next on the last loaded image, or moving on after
 * the last loaded image left the list. `skip` is the image being left, which can still be at
 * `index` until the list catches up.
 */
export interface PendingStep {
  index: number;
  skip: string;
  /** Where to go when the list ends before `index`: an image id, "close", or "stay". */
  otherwise: string;
}

export type PendingOutcome =
  | { kind: "show"; id: string }
  | { kind: "close" }
  | { kind: "stay" }
  | { kind: "load" }
  | { kind: "wait" };

export function resolvePending(
  items: readonly AssetListItem[],
  pending: PendingStep,
  hasMore: boolean,
  loadingMore: boolean,
): PendingOutcome {
  const target = items[pending.index];
  if (target && target.id !== pending.skip) return { kind: "show", id: target.id };
  // The image being left is still there: its removal hasn't landed yet.
  if (target) return { kind: "wait" };
  if (loadingMore) return { kind: "wait" };
  if (hasMore) return { kind: "load" };
  if (pending.otherwise === "close") return { kind: "close" };
  if (pending.otherwise === "stay") return { kind: "stay" };
  return { kind: "show", id: pending.otherwise };
}

export type Step = { kind: "show"; id: string } | { kind: "pending"; step: PendingStep } | { kind: "none" };

/** Next: the loaded image after it, or a page load first. */
export function stepNext(nav: Nav, id: string): Step {
  if (nav.next) return { kind: "show", id: nav.next.id };
  if (nav.nextUnloaded) return { kind: "pending", step: { index: nav.nextAt, skip: id, otherwise: "stay" } };
  return { kind: "none" };
}

export function stepPrevious(nav: Nav): Step {
  return nav.previous ? { kind: "show", id: nav.previous.id } : { kind: "none" };
}

/**
 * Where to go after the image leaves the list (deleted, restored, deleted for good): the next
 * image, else the previous one, and nothing when none is left (§4.0).
 */
export function afterLeaving(
  nav: Nav,
  id: string,
): { kind: "show"; id: string } | { kind: "pending"; step: PendingStep } | { kind: "close" } {
  if (nav.next) return { kind: "show", id: nav.next.id };
  if (nav.nextUnloaded) {
    // Once it's gone, what comes after it takes its place.
    const index = nav.index >= 0 ? nav.index : nav.nextAt;
    return { kind: "pending", step: { index, skip: id, otherwise: nav.previous?.id ?? "close" } };
  }
  return nav.previous ? { kind: "show", id: nav.previous.id } : { kind: "close" };
}
