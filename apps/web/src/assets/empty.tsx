import { hasLibraryFilters, type LibraryQuery, t } from "@openfield/core";
import { Button, EmptyStateInline } from "@openfield/ui";
import { Folder, Heart, Image, Search, Trash2 } from "lucide-react";
import { useNavigate } from "react-router";
import type { LibraryRoute } from "./route";
import { searchOf } from "./route";

// Empty state / Inline for each library view (design yReeG, Qjd4b, G47AI5, Z7qfu, uBOvG, §2.7).

export function LibraryEmpty({ route, folderName }: { route: LibraryRoute; folderName: string | undefined }) {
  const navigate = useNavigate();
  const { query, go } = route;
  const filtered = hasLibraryFilters(query);
  const action = (label: string, onClick: () => void) => (
    <Button variant="ghost" size="s" onClick={onClick}>
      {label}
    </Button>
  );

  if (query.q && query.view === "folder") {
    return (
      <EmptyStateInline
        icon={Search}
        title={t("assets.emptyStates.searchFolder.title", { folder: folderName ?? "", query: query.q })}
        body={t(
          filtered ? "assets.emptyStates.searchFolder.bodyFiltered" : "assets.emptyStates.searchFolder.body",
        )}
        actions={action(t("assets.emptyStates.searchFolder.action"), () =>
          go({ view: "all", ...searchOf(query) }),
        )}
      />
    );
  }
  if (query.q) {
    return (
      <EmptyStateInline
        icon={Search}
        title={t("assets.emptyStates.search.title", { query: query.q })}
        body={t(filtered ? "assets.emptyStates.search.body" : "assets.emptyStates.search.bodyWords")}
        actions={action(t("assets.emptyStates.search.action"), () => go(withoutSearch(query)))}
      />
    );
  }
  if (filtered) {
    return (
      <EmptyStateInline
        icon={Search}
        title={t("assets.emptyStates.filtered.title")}
        body={t("assets.emptyStates.filtered.body")}
        actions={action(t("assets.emptyStates.filtered.action"), () => go(withoutSearch(query)))}
      />
    );
  }
  switch (query.view) {
    case "trash":
      return (
        <EmptyStateInline
          icon={Trash2}
          title={t("assets.emptyStates.trash.title")}
          body={t("assets.emptyStates.trash.body")}
        />
      );
    case "favourites":
      return (
        <EmptyStateInline
          icon={Heart}
          title={t("assets.emptyStates.favorites.title")}
          body={t("assets.emptyStates.favorites.body")}
        />
      );
    case "folder":
      return (
        <EmptyStateInline
          icon={Folder}
          title={t("assets.emptyStates.folder.title", { folder: folderName ?? "" })}
          body={t("assets.emptyStates.folder.body")}
        />
      );
    default:
      return (
        <EmptyStateInline
          icon={Image}
          title={t("assets.empty.title")}
          body={t("assets.empty.body")}
          actions={action(t("assets.empty.goToImage"), () => navigate("/image"))}
        />
      );
  }
}

/** The same view with no words and no filters. */
const withoutSearch = (query: LibraryQuery): LibraryQuery =>
  query.view === "folder" && query.folderId
    ? { view: "folder", folderId: query.folderId }
    : { view: query.view };
