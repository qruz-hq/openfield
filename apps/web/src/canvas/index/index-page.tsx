import { type CanvasSummary, t } from "@openfield/core";
import {
  Banner,
  Button,
  cn,
  EmptyStateInline,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  SearchInput,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@openfield/ui";
import { ArrowUpDown, Check, RotateCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  fetchCanvas,
  useCanvases,
  useCreateCanvas,
  useDeleteCanvas,
  useDuplicateCanvas,
  useRenameCanvas,
} from "../../api/hooks/canvases";
import { errorMessage } from "../../api/raw";
import { notify, notifyError } from "../../lib/notify";
import { fitOnOpen } from "../fit-on-open";
import { CanvasCard, type CardActions, canvasPath } from "./canvas-card";
import { useMinuteClock } from "./edited";
import { IndexEmptyState } from "./empty-state";
import { downloadCanvasFile, readCanvasFile } from "./file";
import { NewCanvasCard } from "./new-canvas-card";
import { CANVAS_SORTS, matchesQuery, SORT_LABELS, sortCanvases, useCanvasSort } from "./sort";
import { TemplatesGrid } from "./templates";

// Canvas index (§7.3; design KkAp5, empty O5bcdk, templates MF9Sm). /canvas lists canvases;
// /canvas?tab=templates shows the templates. New canvas, a template and an imported file all make
// a canvas and open it.

type IndexTab = "all" | "templates";

/** The editor opens its version history drawer for this. */
export const VERSIONS_PARAM = { panel: "versions" } as const;

/** Grid columns: 4 from 1280, 3 from 1024, 2 from 768 (§7.3), 18 apart. */
const grid = "grid w-full grid-cols-1 gap-18 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

export function CanvasIndexPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab: IndexTab = params.get("tab") === "templates" ? "templates" : "all";
  const setTab = (next: string) =>
    setParams(next === "templates" ? { tab: "templates" } : {}, { replace: true });

  const [query, setQuery] = useState("");
  const [templateQuery, setTemplateQuery] = useState("");
  const sort = useCanvasSort((s) => s.sort);
  const now = useMinuteClock();

  const canvases = useCanvases();
  const create = useCreateCanvas();
  const duplicate = useDuplicateCanvas();
  const rename = useRenameCanvas();
  const remove = useDeleteCanvas();
  const [pendingTemplate, setPendingTemplate] = useState<string | null>(null);

  const list = canvases.data;
  const empty = canvases.isSuccess && list?.length === 0;
  const visible = useMemo(
    () =>
      sortCanvases(
        (list ?? []).filter((c) => matchesQuery(c.name, query)),
        sort,
      ),
    [list, query, sort],
  );

  const open = (id: string) => navigate(canvasPath(id));
  const creatingBlank = create.isPending && !create.variables?.templateId && !create.variables?.graph;
  const createBlank = () => {
    if (!create.isPending) create.mutate({}, { onSuccess: (detail) => open(detail.id) });
  };
  const openFitted = (id: string) => {
    fitOnOpen(id);
    open(id);
  };
  const fromTemplate = (templateId: string) => {
    setPendingTemplate(templateId);
    create.mutate(
      { templateId },
      { onSuccess: (detail) => openFitted(detail.id), onSettled: () => setPendingTemplate(null) },
    );
  };
  const importFile = async (file: File) => {
    const graph = await readCanvasFile(file);
    const name = graph.name.trim().slice(0, 200);
    const detail = await create.mutateAsync({ graph, ...(name && { name }) });
    openFitted(detail.id);
  };

  const actions: CardActions = {
    open,
    openVersions: (id) =>
      navigate({ pathname: canvasPath(id), search: `?${new URLSearchParams(VERSIONS_PARAM)}` }),
    rename: (summary, name) => rename.mutate({ id: summary.id, name, graphVersion: summary.graphVersion }),
    duplicate: (id) =>
      duplicate.mutate(id, {
        onSuccess: (copy) =>
          notify(t("canvas.index.card.duplicated", { name: copy.name }), {
            action: { label: t("canvas.index.card.openCopy"), onClick: () => open(copy.id) },
          }),
      }),
    exportFile: (id) =>
      void fetchCanvas(id).then(
        (detail) => downloadCanvasFile(detail.graph, detail.name),
        (error) => notifyError(errorMessage(error)),
      ),
    remove: async (summary: CanvasSummary) => {
      await remove.mutateAsync(summary.id);
    },
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          "flex min-h-full flex-col items-center px-16 pt-28 md:px-53",
          !(empty && tab === "all") && "pb-40",
        )}
      >
        <div className="flex w-full max-w-1334 flex-1 flex-col gap-24">
          <header className="flex w-full flex-col gap-6">
            <h1 className="text-page-title text-text-primary">{t("canvas.index.title")}</h1>
            <p className="w-full max-w-720 text-small leading-[1.5] text-text-secondary">
              {t("canvas.index.subtitle")}
            </p>
          </header>
          <Tabs value={tab} onValueChange={setTab} className="contents">
            <div className="flex min-h-32 w-full flex-wrap items-center justify-between gap-x-16 gap-y-8 md:flex-nowrap">
              <TabsList aria-label={t("canvas.index.title")}>
                <TabsTrigger value="all">{t("canvas.index.tabs.all")}</TabsTrigger>
                <TabsTrigger value="templates">{t("canvas.index.tabs.templates")}</TabsTrigger>
              </TabsList>
              {tab === "all" && list?.length ? (
                <div className="flex min-w-0 items-center gap-8">
                  <SearchInput
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    onClear={() => setQuery("")}
                    clearLabel={t("canvas.index.clearSearch")}
                    placeholder={t("canvas.index.search")}
                    aria-label={t("canvas.index.search")}
                    boxClassName="w-240 max-w-full"
                  />
                  <SortMenu />
                </div>
              ) : null}
              {tab === "templates" ? (
                <div className="flex min-w-0 items-center gap-8">
                  <SearchInput
                    value={templateQuery}
                    onChange={(event) => setTemplateQuery(event.currentTarget.value)}
                    onClear={() => setTemplateQuery("")}
                    clearLabel={t("canvas.index.clearSearch")}
                    placeholder={t("canvas.index.templates.search")}
                    aria-label={t("canvas.index.templates.search")}
                    boxClassName="w-240 max-w-full"
                  />
                </div>
              ) : null}
            </div>
            <TabsContent value="all" className="flex w-full flex-1 flex-col gap-24 outline-none">
              {canvases.isError && !list ? (
                <Banner
                  variant="error"
                  message={t("canvas.index.loadFailed")}
                  actions={
                    <Button
                      variant="secondary"
                      size="s"
                      icon={RotateCw}
                      onClick={() => void canvases.refetch()}
                    >
                      {t("actions.tryAgain")}
                    </Button>
                  }
                />
              ) : empty ? (
                <div className="flex w-full flex-1 flex-col items-center justify-center pb-160">
                  <IndexEmptyState
                    onCreate={createBlank}
                    creating={creatingBlank}
                    onTemplates={() => setTab("templates")}
                  />
                </div>
              ) : list ? (
                <div className={grid}>
                  <NewCanvasCard onCreate={createBlank} busy={creatingBlank} />
                  {visible.map((summary) => (
                    <CanvasCard key={summary.id} summary={summary} now={now} actions={actions} />
                  ))}
                  {query.trim() && !visible.length ? (
                    <div className="col-span-full flex justify-center py-40">
                      <EmptyStateInline
                        icon={Search}
                        title={t("canvas.index.noMatches", { query: query.trim() })}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </TabsContent>
            <TabsContent value="templates" className="flex w-full flex-col gap-24 outline-none">
              <TemplatesGrid
                query={templateQuery}
                pending={pendingTemplate}
                onUse={fromTemplate}
                onImport={importFile}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

/** Sort (QhmLs): Last edited, Name or Created. */
function SortMenu() {
  const sort = useCanvasSort((s) => s.sort);
  const setSort = useCanvasSort((s) => s.setSort);
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          variant="ghost"
          size="s"
          icon={ArrowUpDown}
          aria-label={`${t("canvas.index.sort.label")}: ${t(SORT_LABELS[sort])}`}
        >
          {t(SORT_LABELS[sort])}
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        {CANVAS_SORTS.map((option) => (
          <MenuItem
            key={option}
            role="menuitemradio"
            aria-checked={option === sort}
            onSelect={() => setSort(option)}
          >
            <span className="flex w-full items-center justify-between gap-10">
              {t(SORT_LABELS[option])}
              {option === sort ? (
                <Check size={16} aria-hidden className="shrink-0 text-text-secondary" />
              ) : null}
            </span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
