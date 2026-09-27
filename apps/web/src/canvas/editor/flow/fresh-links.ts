// Links a group drop just made, so they draw in from their source ports one after another as they
// appear (editor.css, of-link-draw) instead of all at once. Kept briefly outside React: a link reads
// its own entry once, when it mounts.

const STAGGER_MS = 50;
const KEEP_MS = 1000;
const fresh = new Map<string, number>();

/** Marks links as just made, in the order they should draw in. */
export function markFreshLinks(ids: readonly string[]): void {
  if (ids.length < 2) return;
  ids.forEach((id, i) => {
    fresh.set(id, i * STAGGER_MS);
  });
  setTimeout(() => {
    for (const id of ids) fresh.delete(id);
  }, KEEP_MS);
}

/** How long after it appears a just-made link starts drawing in; null for any other link. */
export function freshLinkDelay(id: string): number | null {
  return fresh.get(id) ?? null;
}
