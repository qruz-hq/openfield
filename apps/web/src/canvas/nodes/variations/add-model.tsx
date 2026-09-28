import { type ModelListItem, t } from "@openfield/core";
import {
  Button,
  Divider,
  GroupLabel,
  ModelRow,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProviderLogo,
  SearchInput,
} from "@openfield/ui";
import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { useProviders } from "../../../api/hooks/keys";
import { useRunSpeed } from "../../../api/hooks/provider-settings";
import { speedPrice } from "../../../lib/cost";
import { focusSelected, Listbox } from "../../../lib/listbox";
import { companyName, logoFor } from "../../../lib/provider";

// "Add model" in Variations' Models mode (design mdu6t): the composer's model list, grouped by
// company and priced at each company's speed, without the models already in the comparison or the
// ones that still need a key.

export function AddModelPicker({
  models,
  exclude,
  disabled,
  onAdd,
}: {
  models: readonly ModelListItem[];
  exclude: readonly string[];
  disabled?: boolean;
  onAdd: (model: ModelListItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const providers = useProviders().data;
  const runSpeed = useRunSpeed();
  const needle = query.trim().toLowerCase();

  const groups: { label: string; models: ModelListItem[] }[] = [];
  for (const model of models) {
    if (!model.ready || exclude.includes(model.key)) continue;
    const label = companyName(providers, model.providerId);
    if (needle && ![model.displayName, label].some((s) => s.toLowerCase().includes(needle))) continue;
    const group = groups.find((g) => g.label === label);
    if (group) group.models.push(model);
    else groups.push({ label, models: [model] });
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="s" icon={Plus} disabled={disabled} className="self-start">
          {t("canvas.nodes.variations.addModel")}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-402 gap-0 p-0" onOpenAutoFocus={focusSelected(list)}>
        <SearchInput
          variant="header"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("composer.chips.model.search")}
          aria-label={t("composer.chips.model.search")}
        />
        <Divider />
        <div ref={list} className="max-h-400 overflow-y-auto">
          <Listbox label={t("canvas.nodes.variations.addModel")} className="flex flex-col gap-8 p-8">
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
                  // At its company's speed, with "· Standard" when it lacks that speed (§0.3).
                  const { price, note, hint } = speedPrice(model, runSpeed(model));
                  return (
                    <ModelRow
                      key={model.key}
                      asChild
                      name={model.displayName}
                      description={model.description}
                      logo={logo ? <ProviderLogo provider={logo} variant="tile" /> : undefined}
                      price={price}
                      priceNote={note}
                    >
                      <button
                        type="button"
                        role="option"
                        title={hint}
                        aria-selected={false}
                        onClick={() => {
                          onAdd(model);
                          setOpen(false);
                        }}
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
