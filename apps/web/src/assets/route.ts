import { type LibraryQuery, type LibraryView, libraryHref, parseLibraryUrl } from "@openfield/core";
import { useCallback, useMemo } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";

// Which library view is open and what it asks for. Everything but the open image rides in the
// path and the query string (§2.1), so a reload or a shared link shows the same thing.

export function viewOf(pathname: string): LibraryView {
  if (pathname.startsWith("/assets/folder/")) return "folder";
  if (pathname.startsWith("/assets/favourites")) return "favourites";
  if (pathname.startsWith("/assets/trash")) return "trash";
  return "all";
}

export function useLibraryRoute() {
  const { pathname } = useLocation();
  const { folderId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const view = viewOf(pathname);
  // Only the library's own params count: opening an image (?asset=) mustn't make a new query.
  const words = ["q", "model", "provider", "date", "modality"].map((key) => params.get(key) ?? "").join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `words` stands for the params read here.
  const query = useMemo(() => parseLibraryUrl(view, params, folderId), [view, words, folderId]);

  /** Opens another view or changes words and filters. Typing and filters replace the history entry. */
  const go = useCallback(
    (next: LibraryQuery, opts: { replace?: boolean } = {}) =>
      navigate(libraryHref(next), { replace: opts.replace ?? false }),
    [navigate],
  );

  return { view, folderId: view === "folder" ? folderId : undefined, query, go };
}

export type LibraryRoute = ReturnType<typeof useLibraryRoute>;

/** The words and filters without the view, to carry them to another view. */
export const searchOf = (query: LibraryQuery): Omit<LibraryQuery, "view" | "folderId"> => ({
  ...(query.q && { q: query.q }),
  ...(query.model && { model: query.model }),
  ...(query.provider && { provider: query.provider }),
  ...(query.date && { date: query.date }),
  ...(query.modality && { modality: query.modality }),
});

/** Whether the view is showing search results: words, or any filter. */
export const isFiltered = (query: LibraryQuery) =>
  Boolean(query.q || query.model || query.provider || query.date || query.modality);
