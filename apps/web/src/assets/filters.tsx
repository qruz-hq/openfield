import {
  type FolderTree,
  hasLibraryFilters,
  LIBRARY_DATE_PRESETS,
  type LibraryDatePreset,
  type LibraryQuery,
  type LibrarySummary,
  type ModelKey,
  t,
} from "@openfield/core";
import {
  Button,
  cn,
  Divider,
  GroupLabel,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
  ProviderLogo,
} from "@openfield/ui";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { useProviders } from "../api/hooks/keys";
import { focusSelected, Listbox, Option } from "../lib/listbox";
import { companyName, logoFor } from "../lib/provider";
import { useModelNames } from "./media";
import { type LibraryRoute, searchOf } from "./route";

// Library / Filter row (design HjXAH, nvzy5): the search scope, then Model, Company and Date, then
// Clear all once anything is set. Words, filters and scope all ride in the URL (§2.8).

const DATE_LABELS = {
  today: "assets.filters.dates.today",
  "7d": "assets.filters.dates.7d",
  "30d": "assets.filters.dates.30d",
  "12m": "assets.filters.dates.12m",
} as const satisfies Record<LibraryDatePreset, string>;

export function FilterRow({
  route,
  tree,
  summary,
}: {
  route: LibraryRoute;
  tree: FolderTree | undefined;
  summary: LibrarySummary | undefined;
}) {
  const { query, go } = route;
  const providers = useProviders();
  const modelName = useModelNames();
  const set = (patch: Partial<LibraryQuery>) => go({ ...query, ...patch }, { replace: true });

  // Searching inside a folder or Favorites: the scope comes first, and its × searches everything.
  const scope =
    query.q && query.view === "folder" && query.folderId
      ? tree?.byId.get(query.folderId)?.folder.name
      : query.q && query.view === "favourites"
        ? t("assets.views.favorites")
        : undefined;

  const models = useMemo(() => groupModels(summary?.models ?? []), [summary?.models]);
  const company = (id: string) => companyName(providers.data, id);
  const modelLabel = (key: ModelKey) => {
    const [providerId, ...rest] = key.split(":");
    return modelName(providerId ?? null, rest.join(":")) ?? key;
  };

  return (
    <div className="flex h-40 w-full shrink-0 items-center gap-8">
      {scope ? (
        <>
          <SetPill
            label={t("assets.filters.scope", { folder: scope })}
            clearLabel={t("assets.filters.searchAll")}
            onClear={() => go({ view: "all", ...searchOf(query) })}
          />
          <Divider orientation="vertical" className="h-16" />
        </>
      ) : null}
      <FilterMenu
        label={t("assets.filters.type")}
        value={query.modality ? t(`assets.filters.${query.modality}s` as const) : undefined}
        onClear={() => set({ modality: undefined })}
        width="w-200"
      >
        {(close) => (
          <>
            <Option
              title={t("assets.filters.anyType")}
              selected={!query.modality}
              onPick={() => {
                set({ modality: undefined });
                close();
              }}
            />
            <Option
              title={t("assets.filters.images")}
              selected={query.modality === "image"}
              onPick={() => {
                set({ modality: "image" });
                close();
              }}
            />
            <Option
              title={t("assets.filters.videos")}
              selected={query.modality === "video"}
              onPick={() => {
                set({ modality: "video" });
                close();
              }}
            />
          </>
        )}
      </FilterMenu>
      <FilterMenu
        label={t("assets.filters.model")}
        value={query.model ? modelLabel(query.model) : undefined}
        onClear={() => set({ model: undefined })}
        width="w-280"
      >
        {(close) => (
          <>
            <Option
              title={t("assets.filters.anyModel")}
              selected={!query.model}
              onPick={() => {
                set({ model: undefined });
                close();
              }}
            />
            {models.map(({ providerId, models: list }) => (
              <div key={providerId} className="flex flex-col gap-2">
                <GroupLabel>{company(providerId)}</GroupLabel>
                {list.map((model) => {
                  const key = `${providerId}:${model.modelId}` as ModelKey;
                  return (
                    <Option
                      key={key}
                      title={modelName(providerId, model.modelId) ?? model.modelId}
                      leading={<Glyph providerId={providerId} />}
                      selected={query.model === key}
                      onPick={() => {
                        set({ model: key });
                        close();
                      }}
                    />
                  );
                })}
              </div>
            ))}
          </>
        )}
      </FilterMenu>
      <FilterMenu
        label={t("assets.filters.company")}
        value={query.provider ? company(query.provider) : undefined}
        onClear={() => set({ provider: undefined })}
        width="w-240"
      >
        {(close) => (
          <>
            <Option
              title={t("assets.filters.anyCompany")}
              selected={!query.provider}
              onPick={() => {
                set({ provider: undefined });
                close();
              }}
            />
            {(summary?.providers ?? []).map(({ providerId }) => (
              <Option
                key={providerId}
                title={company(providerId)}
                leading={<Glyph providerId={providerId} />}
                selected={query.provider === providerId}
                onPick={() => {
                  set({ provider: providerId });
                  close();
                }}
              />
            ))}
          </>
        )}
      </FilterMenu>
      <FilterMenu
        label={t("assets.filters.date")}
        value={query.date ? t(DATE_LABELS[query.date]) : undefined}
        onClear={() => set({ date: undefined })}
        width="w-240"
      >
        {(close) => (
          <>
            <Option
              title={t("assets.filters.dates.any")}
              selected={!query.date}
              onPick={() => {
                set({ date: undefined });
                close();
              }}
            />
            {LIBRARY_DATE_PRESETS.map((preset) => (
              <Option
                key={preset}
                title={t(DATE_LABELS[preset])}
                selected={query.date === preset}
                onPick={() => {
                  set({ date: preset });
                  close();
                }}
              />
            ))}
          </>
        )}
      </FilterMenu>
      {hasLibraryFilters(query) ? (
        <Button
          variant="ghost"
          size="s"
          onClick={() => set({ model: undefined, provider: undefined, date: undefined, modality: undefined })}
        >
          {t("assets.filters.clearAll")}
        </Button>
      ) : null}
    </div>
  );
}

function groupModels(models: LibrarySummary["models"]) {
  const byProvider = new Map<string, LibrarySummary["models"]>();
  for (const model of models) {
    const list = byProvider.get(model.providerId) ?? [];
    list.push(model);
    byProvider.set(model.providerId, list);
  }
  return [...byProvider].map(([providerId, list]) => ({ providerId, models: list }));
}

/** The company's 16px glyph, or an empty slot for one without a logo so names still line up. */
function Glyph({ providerId }: { providerId: string }) {
  const logo = logoFor(providerId);
  return (
    <span className="flex size-16 shrink-0 items-center justify-center text-text-primary">
      {logo ? <ProviderLogo provider={logo} /> : null}
    </span>
  );
}

const pillBase =
  "inline-flex h-23 shrink-0 items-center gap-6 whitespace-nowrap rounded-full py-4 text-caption font-medium inset-ring";

/** Pill / Filter menu / Set without a menu: the search scope (design a7PkXJ). */
function SetPill({ label, clearLabel, onClear }: { label: string; clearLabel: string; onClear: () => void }) {
  return (
    <span className={cn(pillBase, "bg-elevated-2 pr-8 pl-10 text-text-primary inset-ring-border-strong")}>
      <span className="max-w-200 truncate">{label}</span>
      <ClearButton label={clearLabel} onClick={onClear} />
    </span>
  );
}

function ClearButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="-m-4 inline-flex shrink-0 cursor-pointer rounded-full p-4 text-text-secondary transition-colors hover:text-text-primary"
    >
      <X size={12} aria-hidden />
    </button>
  );
}

/**
 * Pill / Filter menu / {Idle, Open, Set} (design n2kse, S2n92, a7PkXJ) with its popover
 * (design lOHwD, c0TOf, uhG8m). A set pill shows the value, and its × clears it.
 */
function FilterMenu({
  label,
  value,
  onClear,
  width,
  children,
}: {
  label: string;
  value: string | undefined;
  onClear: () => void;
  width: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const isSet = value !== undefined;
  const Chevron = open ? ChevronUp : ChevronDown;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span
          className={cn(
            pillBase,
            isSet
              ? "bg-elevated-2 pr-8 pl-10 inset-ring-border-strong"
              : open
                ? "bg-elevated-2 px-10 inset-ring-border-strong"
                : "px-10 inset-ring-border",
          )}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={isSet ? `${label}: ${value}` : undefined}
              className={cn(
                "inline-flex cursor-pointer items-center gap-6 rounded-full outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent",
                isSet || open ? "text-text-primary" : "text-text-secondary hover:text-text-primary",
              )}
            >
              <span className="max-w-200 truncate">{value ?? label}</span>
              {isSet ? null : (
                <Chevron
                  size={12}
                  aria-hidden
                  className={cn("shrink-0", open ? "text-text-secondary" : "text-text-tertiary")}
                />
              )}
            </button>
          </PopoverTrigger>
          {isSet ? (
            <ClearButton label={t("assets.filters.clear", { filter: label })} onClick={onClear} />
          ) : null}
        </span>
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        onOpenAutoFocus={focusSelected(list)}
        className={cn("max-h-420 overflow-y-auto", width)}
      >
        <div ref={list}>
          <Listbox label={label} className="flex flex-col gap-2 outline-none">
            {children(() => setOpen(false))}
          </Listbox>
        </div>
      </PopoverContent>
    </Popover>
  );
}
