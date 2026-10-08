import type { LibraryQuery } from "@openfield/core";

// Pure picker logic (design q31cb): which place is open, what it asks the library for, and the
// picked list's order. No React here, so the ordering rules are unit tested on their own.

/** Which column of the Places panel is open. */
export type Place = { kind: "favourites" } | { kind: "all" } | { kind: "folder"; folderId: string };

export const FAVOURITES_PLACE: Place = { kind: "favourites" };
export const ALL_PLACE: Place = { kind: "all" };

export const samePlace = (a: Place, b: Place): boolean =>
  a.kind === b.kind && (a.kind !== "folder" || (b as { folderId: string }).folderId === a.folderId);

/** The library query a place browses, search words included. */
export function placeQuery(place: Place, q: string): LibraryQuery {
  if (place.kind === "favourites") return { view: "favourites", q };
  if (place.kind === "folder") return { view: "folder", folderId: place.folderId, q };
  return { view: "all", q };
}

/**
 * Picking again toggles: new, it joins at the end; already picked, it drops out. At `max`, a new
 * one is turned away, except with a max of 1, where it takes the only place.
 */
export function togglePick(ids: readonly string[], id: string, max = Number.POSITIVE_INFINITY): string[] {
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  if (ids.length < max) return [...ids, id];
  return max === 1 ? [id] : [...ids];
}

/** Moves one picked id to a new spot, clamped to the list. A no-op id, or nowhere to go, changes nothing. */
export function movePick(ids: readonly string[], id: string, to: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const at = Math.max(0, Math.min(ids.length - 1, to));
  if (at === from) return [...ids];
  const next = ids.filter((x) => x !== id);
  next.splice(at, 0, id);
  return next;
}
