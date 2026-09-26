import {
  type FolderNode,
  type FolderTree,
  folderPath,
  formatNumber,
  type LibraryQuery,
  t,
} from "@openfield/core";
import {
  Button,
  Divider,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  ZoomSlider,
} from "@openfield/ui";
import { ChevronRight, Ellipsis, Folder, FolderPlus, ListFilter } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { startNewFolder } from "./folder-actions";
import { openFolderMenu } from "./folder-menu";
import { COLUMNS_BY_ZOOM } from "./layout";

// Library / Header / {Folder, Folder / Deep, Trash, Search} (design PEPQO, y3xNHk, TYC2O, X2HLS):
// 64 tall, the title and its count on the left, the view's tools on the right.

export interface LibraryHeaderProps {
  query: LibraryQuery;
  tree: FolderTree | undefined;
  /** The number beside the title. */
  count: number | undefined;
  filtersOpen: boolean;
  onToggleFilters: () => void;
  zoom: number;
  onZoom: (zoom: number) => void;
  /** Trash only. */
  trashNote?: string;
  onEmptyTrash?: () => void;
  onOpenFolder: (id: string) => void;
}

export function LibraryHeader({
  query,
  tree,
  count,
  filtersOpen,
  onToggleFilters,
  zoom,
  onZoom,
  trashNote,
  onEmptyTrash,
  onOpenFolder,
}: LibraryHeaderProps) {
  const searching = Boolean(query.q);
  const path = query.view === "folder" && query.folderId && tree ? folderPath(tree, query.folderId) : [];
  const folder = path.at(-1);

  const zoomSlider = (
    <ZoomSlider
      thumbLabel={t("feed.zoom.label")}
      min={0}
      max={COLUMNS_BY_ZOOM.length - 1}
      step={1}
      value={[zoom]}
      onValueChange={([next]) => next !== undefined && onZoom(next)}
    />
  );
  const filterButton = (
    <IconButton
      icon={ListFilter}
      label={t("assets.header.filter")}
      active={filtersOpen}
      aria-expanded={filtersOpen}
      onClick={onToggleFilters}
    />
  );

  let title: ReactNode;
  let tools: ReactNode;
  if (query.view === "trash") {
    title = <Title>{t("assets.views.trash")}</Title>;
    tools = (
      <>
        <span className="text-small text-text-tertiary">{trashNote}</span>
        <Button variant="danger-ghost" size="m" disabled={!count} onClick={onEmptyTrash}>
          {t("assets.header.emptyTrash")}
        </Button>
        <Divider orientation="vertical" />
        {zoomSlider}
      </>
    );
  } else if (searching) {
    title = <Title>{t("assets.header.resultsFor", { query: query.q! })}</Title>;
    tools = (
      <>
        {filterButton}
        {zoomSlider}
      </>
    );
  } else if (query.view === "folder") {
    title = folder ? <Breadcrumb path={path} onOpen={onOpenFolder} /> : null;
    tools = (
      <>
        <Button
          variant="secondary"
          size="s"
          icon={FolderPlus}
          disabled={!folder}
          onClick={() => folder && startNewFolder(folder.folder.id)}
        >
          {t("assets.folder.newFolder")}
        </Button>
        <IconButton
          icon={Ellipsis}
          label={t("assets.folder.menu")}
          disabled={!folder}
          onClick={(event) => folder && openFolderMenu(folder.folder.id, event.currentTarget)}
        />
        <Divider orientation="vertical" />
        {filterButton}
        {zoomSlider}
      </>
    );
  } else {
    title = <Title>{t(query.view === "favourites" ? "assets.views.favorites" : "assets.views.all")}</Title>;
    tools = (
      <>
        {filterButton}
        {zoomSlider}
      </>
    );
  }

  return (
    <header className="flex h-64 w-full shrink-0 items-center justify-between gap-16">
      <div className="flex min-w-0 items-center gap-10">
        {title}
        {count !== undefined ? (
          <span className="shrink-0 text-mono-13 text-text-tertiary">{formatNumber(count)}</span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-12">{tools}</div>
    </header>
  );
}

const titleClass = "text-page-title tracking-[-0.2px]";

function Title({ children }: { children: ReactNode }) {
  return <h1 className={`min-w-0 truncate text-text-primary ${titleClass}`}>{children}</h1>;
}

/**
 * Ancestors open their folder; the current folder is plain. Deeper than three levels it shows the
 * first level, a ⋯ that lists the ones in between, the parent and the current folder (§2.8).
 */
function Breadcrumb({ path, onOpen }: { path: FolderNode[]; onOpen: (id: string) => void }) {
  const current = path.at(-1)!;
  const deep = path.length > 3;
  const hidden = deep ? path.slice(1, -2) : [];
  const shown: (FolderNode | "hidden")[] = deep ? [path[0]!, "hidden", ...path.slice(-2)] : path;

  return (
    <nav aria-label={t("assets.folder.breadcrumb")} className="flex min-w-0 items-center gap-6">
      {shown.map((crumb, index) => (
        <Fragment key={crumb === "hidden" ? "hidden" : crumb.folder.id}>
          {index > 0 ? <ChevronRight size={16} aria-hidden className="shrink-0 text-text-tertiary" /> : null}
          {crumb === "hidden" ? (
            <Menu>
              <MenuTrigger asChild>
                <IconButton
                  icon={Ellipsis}
                  label={t("assets.folder.hiddenLevels")}
                  className="text-text-tertiary"
                />
              </MenuTrigger>
              <MenuContent>
                {hidden.map((node) => (
                  <MenuItem key={node.folder.id} icon={Folder} onSelect={() => onOpen(node.folder.id)}>
                    {node.folder.name}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          ) : crumb === current ? (
            <h1
              aria-current="page"
              title={crumb.folder.name}
              className={`max-w-200 min-w-0 truncate text-text-primary ${titleClass}`}
            >
              {crumb.folder.name}
            </h1>
          ) : (
            <button
              type="button"
              title={crumb.folder.name}
              onClick={() => onOpen(crumb.folder.id)}
              className={`max-w-200 min-w-0 shrink cursor-pointer truncate rounded-6 text-text-tertiary transition-colors hover:text-text-secondary ${titleClass}`}
            >
              {crumb.folder.name}
            </button>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
