import { type CanvasTemplate, hasMessage, type MessageKey, t } from "@openfield/core";
import { Badge, Banner, Button, EmptyStateInline } from "@openfield/ui";
import { RotateCw, Search } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef } from "react";
import { useCanvasTemplates } from "../../api/hooks/canvases";
import { errorMessage } from "../../api/raw";
import { isDesktop, openDialog } from "../../lib/desktop";
import { notifyError } from "../../lib/notify";
import { archiveFilter, type ImportSource } from "../archive-flow";
import { CanvasFileError, importSelection } from "./file";
import { GraphSketch } from "./graph-sketch";
import { matchesQuery } from "./sort";

// Canvas · Templates (MF9Sm): the same grid, each card a sketch badged Template with Use template,
// then "Have a canvas export? Import a file or a folder". Bundled templates take their words from
// the catalogue; ones a person saved show their own name.

/** Bundled templates in the design's order; anything else follows, by name. */
const BUNDLED_ORDER = ["from-a-reference", "edit-an-image", "storyboard", "compare-two-styles"];

/** The graph sits under the badge: 34 above, 12 on the other sides (tZyGf). */
const TEMPLATE_PADDING = [34, 12, 12, 12] as const;

interface TemplateCopy {
  name: string;
  body: string | null;
}

export function templateCopy(template: Pick<CanvasTemplate, "id" | "source" | "name">): TemplateCopy {
  const base = `canvas.index.templates.${template.id}`;
  if (template.source === "bundled" && hasMessage(`${base}.name`)) {
    return {
      name: t(`${base}.name` as MessageKey),
      body: hasMessage(`${base}.body`) ? t(`${base}.body` as MessageKey) : null,
    };
  }
  return { name: template.name, body: null };
}

function order(template: CanvasTemplate): number {
  const at = BUNDLED_ORDER.indexOf(template.id);
  return template.source === "bundled" && at >= 0 ? at : BUNDLED_ORDER.length;
}

export function TemplatesGrid({
  query,
  pending,
  onUse,
  onImport,
}: {
  query: string;
  /** The template being created from, if any. */
  pending: string | null;
  onUse: (templateId: string) => void;
  onImport: (source: ImportSource) => void;
}) {
  const templates = useCanvasTemplates();
  const visible = useMemo(() => {
    const list = (templates.data ?? []).map((template) => ({ template, copy: templateCopy(template) }));
    return list
      .filter(({ copy }) => matchesQuery(`${copy.name} ${copy.body ?? ""}`, query))
      .sort((a, b) => order(a.template) - order(b.template) || a.copy.name.localeCompare(b.copy.name));
  }, [templates.data, query]);

  return (
    <>
      {templates.isError ? (
        <Banner
          variant="error"
          message={t("canvas.index.templates.loadFailed")}
          actions={
            <Button variant="secondary" size="s" icon={RotateCw} onClick={() => void templates.refetch()}>
              {t("actions.tryAgain")}
            </Button>
          }
        />
      ) : templates.isSuccess ? (
        <div className="grid grid-cols-1 gap-18 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map(({ template, copy }) => (
            <TemplateCard
              key={template.id}
              template={template}
              copy={copy}
              busy={pending === template.id}
              disabled={pending !== null}
              onUse={() => onUse(template.id)}
            />
          ))}
          {query.trim() && !visible.length ? (
            <div className="col-span-full flex justify-center py-40">
              <EmptyStateInline icon={Search} title={t("canvas.index.noMatches", { query: query.trim() })} />
            </div>
          ) : null}
        </div>
      ) : null}
      <ImportLine onImport={onImport} />
    </>
  );
}

function TemplateCard({
  template,
  copy,
  busy,
  disabled,
  onUse,
}: {
  template: CanvasTemplate;
  copy: TemplateCopy;
  busy: boolean;
  disabled: boolean;
  onUse: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-12">
      <div className="flex w-full min-w-0 flex-col gap-10">
        <div className="relative aspect-video w-full overflow-hidden rounded-12 bg-canvas inset-ring inset-ring-border">
          <GraphSketch graph={template.graph} padding={TEMPLATE_PADDING} />
          <Badge variant="neutral" className="absolute top-10 left-10">
            {t("canvas.index.templates.badge")}
          </Badge>
        </div>
        <div className="flex w-full min-w-0 flex-col gap-2">
          <p className="w-full text-body-medium text-text-primary">{copy.name}</p>
          {copy.body ? (
            <p className="w-full text-small leading-[1.45] text-text-secondary">{copy.body}</p>
          ) : null}
        </div>
      </div>
      <Button
        variant="secondary"
        size="s"
        loading={busy}
        disabled={disabled}
        onClick={onUse}
        aria-label={`${t("canvas.index.templates.use")}: ${copy.name}`}
      >
        {t("canvas.index.templates.use")}
      </Button>
    </div>
  );
}

/**
 * CZxse: "Have a canvas export? Import a file or a folder". A file is a .ofcanvas.zip (or an older
 * .ofcanvas.json); a folder is one a zip was unzipped to. Neither a browser's file input nor the
 * desktop app's open dialog picks a file and a folder at once, hence two links.
 */
function ImportLine({ onImport }: { onImport: (source: ImportSource) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  // React has no prop for it.
  useEffect(() => {
    if (folderInput.current) folderInput.current.webkitdirectory = true;
  }, []);

  const choose = async (directory: boolean) => {
    if (!isDesktop()) return (directory ? folderInput : fileInput).current?.click();
    try {
      const path = await openDialog({
        directory,
        ...(!directory && { filters: [{ ...archiveFilter(), extensions: ["zip", "json"] }] }),
      });
      if (path) onImport({ kind: "path", path });
    } catch (error) {
      notifyError(errorMessage(error));
    }
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.currentTarget.files ?? [])];
    // Clear it, so picking the same file again still fires.
    event.currentTarget.value = "";
    if (!files.length) return;
    try {
      onImport({ kind: "upload", selection: importSelection(files) });
    } catch (error) {
      notifyError(error instanceof CanvasFileError ? error.message : errorMessage(error));
    }
  };

  return (
    <div className="flex items-center gap-6">
      <span className="text-caption text-text-tertiary">{t("canvas.index.templates.importLead")}</span>
      <Button variant="link" size="s" onClick={() => void choose(false)} className="text-text-secondary">
        {t("canvas.index.templates.importFile")}
      </Button>
      <span className="text-caption text-text-tertiary">{t("canvas.index.templates.importOr")}</span>
      <Button
        variant="link"
        size="s"
        onClick={() => void choose(true)}
        aria-label={t("canvas.index.templates.importFolderLabel")}
        className="text-text-secondary"
      >
        {t("canvas.index.templates.importFolder")}
      </Button>
      <input
        ref={fileInput}
        type="file"
        accept=".zip,.json,application/zip,application/json"
        hidden
        onChange={onChange}
      />
      <input ref={folderInput} type="file" hidden onChange={onChange} />
    </div>
  );
}
