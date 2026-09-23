import { type ModelListItem, t } from "@openfield/core";
import {
  Divider,
  GroupLabel,
  ModelChip,
  ModelRow,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProviderLogo,
  SearchInput,
} from "@openfield/ui";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useProviders } from "../../api/hooks/keys";
import { useRunSpeed } from "../../api/hooks/provider-settings";
import { speedPrice } from "../../lib/cost";
import { companyName, logoFor } from "../../lib/provider";
import { focusSelected, Listbox } from "./listbox";

// Chip / Setting / Model and its picker: search, one group per company with a key, then the
// models that still need one (§3.4.1). Recent arrives with the full picker (M1-04).

export function ModelSelect({
  models,
  selected,
  onSelect,
}: {
  models: readonly ModelListItem[];
  selected: ModelListItem | undefined;
  onSelect: (model: ModelListItem) => void;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const providers = useProviders().data;
  const runSpeed = useRunSpeed();

  const needle = query.trim().toLowerCase();
  const matches = (model: ModelListItem) =>
    !needle ||
    [model.displayName, companyName(providers, model.providerId), model.description ?? ""].some((text) =>
      text.toLowerCase().includes(needle),
    );

  const groups: { label: string; models: ModelListItem[] }[] = [];
  for (const model of models.filter((m) => m.ready && matches(m))) {
    const label = companyName(providers, model.providerId);
    const group = groups.find((g) => g.label === label);
    if (group) group.models.push(model);
    else groups.push({ label, models: [model] });
  }
  const locked = models.filter((m) => !m.ready && matches(m));
  if (locked.length) groups.push({ label: t("composer.chips.model.needsKey"), models: locked });

  const pick = (model: ModelListItem) => {
    setOpen(false);
    // A model whose company has no key leads to where the key goes (§3.4.1).
    if (!model.ready) navigate("/settings/api-keys", { state: { focusKey: true } });
    else onSelect(model);
  };

  const selectedLogo = logoFor(selected?.providerId);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <ModelChip
          provider={selected ? (selectedLogo ?? null) : null}
          name={selected?.displayName ?? t("composer.chips.model.empty")}
          aria-label={t("composer.chips.model.choose")}
          className="sticky left-0 z-1 shadow-[8px_0_0_var(--of-elevated)]"
        />
      </PopoverTrigger>
      <PopoverContent side="top" className="w-402 gap-0 p-0" onOpenAutoFocus={focusSelected(list)}>
        <SearchInput
          ref={search}
          variant="header"
          aria-label={t("composer.chips.model.search")}
          placeholder={t("composer.chips.model.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // ↓ from the search field moves into the list.
            if (event.key !== "ArrowDown") return;
            event.preventDefault();
            list.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
          }}
        />
        <Divider />
        <div ref={list} className="max-h-593 overflow-y-auto">
          <Listbox
            label={t("composer.chips.model.choose")}
            className="flex flex-col gap-8 p-8"
            // Typing anywhere in the list filters it (§3.4.1).
            onType={() => search.current?.focus()}
          >
            {groups.length === 0 ? (
              <p className="px-12 py-8 text-small text-text-tertiary">
                {t("composer.chips.model.noResults", { query: query.trim() })}
              </p>
            ) : null}
            {groups.map((group) => (
              <div key={group.label} className="flex flex-col">
                <GroupLabel>{group.label}</GroupLabel>
                {group.models.map((model) => {
                  const logo = logoFor(model.providerId);
                  const isSelected = model.key === selected?.key;
                  const { price, note, hint } = speedPrice(model, runSpeed(model));
                  return (
                    <ModelRow
                      key={model.key}
                      asChild
                      name={model.displayName}
                      description={model.ready ? model.description : companyName(providers, model.providerId)}
                      logo={logo ? <ProviderLogo provider={logo} variant="tile" /> : undefined}
                      price={price}
                      priceNote={note}
                      selected={isSelected}
                      addKeyLabel={model.ready ? undefined : t("composer.chips.model.addKey")}
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        title={hint}
                        onClick={() => pick(model)}
                      />
                    </ModelRow>
                  );
                })}
              </div>
            ))}
          </Listbox>
        </div>
      </PopoverContent>
    </Popover>
  );
}
