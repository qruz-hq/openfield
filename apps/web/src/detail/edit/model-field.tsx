import { modelsForEdit } from "@openfield/canvas/engine/inputs";
import { type ModelListItem, t } from "@openfield/core";
import { type EditBase, editOpFor, estimateRun, resolveValues } from "@openfield/providers/manifest";
import {
  cn,
  Divider,
  Field,
  GroupLabel,
  ModelRow,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProviderLogo,
  SearchInput,
  useFieldControl,
} from "@openfield/ui";
import { ChevronDown, Info } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useProviders } from "../../api/hooks/keys";
import { useRunSpeed } from "../../api/hooks/provider-settings";
import { speedFallbackHint, tightCost } from "../../lib/cost";
import { focusSelected, Listbox } from "../../lib/listbox";
import { companyName, logoFor } from "../../lib/provider";
import { askedPrice, isPricePending } from "../../lib/remote-price";
import { useEditSession } from "./session";

// Image edit / Model field and Model picker (design klZQahlnqa, LEObnHCnKu): the Form / Field /
// Select look, opening the composer's picker to the left of the panel. Models that take a mask come
// first ("Change only what you paint"); the ones that redraw the whole image follow, and picking one
// says so under the field. A model whose company has no key stays listed, dimmed, with Add a key.

/** The picker sits 8 left of the panel: 22 from the trigger, inset 14 in it (design JYJSUrM1XY). */
const PICKER_OFFSET = 22;

export function ModelField({
  models,
  selected,
  base,
  resting,
}: {
  models: readonly ModelListItem[];
  selected: ModelListItem | undefined;
  base: EditBase;
  resting: boolean;
}) {
  const composite = useEditSession((s) => s.composite);
  // A model without a mask input runs over the whole image (§0.9), so the field says what happens.
  const whole = selected && !selected.capabilities.ops.inpaint;
  return (
    // Image edit / Model field: the field, then the note, 6 apart.
    <div inert={resting} className={cn("flex w-full shrink-0 flex-col gap-6", resting && "opacity-45")}>
      <Field label={t("edit.model.label")} className="px-2 py-4">
        <ModelPicker models={models} selected={selected} base={base} />
      </Field>
      {whole ? (
        <div className="flex w-full items-center gap-6 px-2">
          <Info size={12} aria-hidden className="shrink-0 text-text-tertiary" />
          <p className="min-w-0 flex-1 text-caption text-text-tertiary">
            {t(composite ? "edit.model.wholeKept" : "edit.model.wholeNotKept", {
              model: selected.displayName,
            })}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ModelPicker({
  models,
  selected,
  base,
}: {
  models: readonly ModelListItem[];
  selected: ModelListItem | undefined;
  base: EditBase;
}) {
  const navigate = useNavigate();
  const field = useFieldControl();
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
  const { masked, whole } = modelsForEdit(models);
  const groups = [
    { label: t("edit.model.masked"), models: masked.filter(matches) },
    { label: t("edit.model.whole"), models: whole.filter(matches) },
  ].filter((group) => group.models.length > 0);

  const pick = (model: ModelListItem) => {
    setOpen(false);
    // A model whose company has no key leads to where the key goes, as in the composer (§3.4.1).
    if (!model.ready) navigate("/settings/api-keys", { state: { focusKey: true } });
    else useEditSession.getState().setModel(model.key);
  };

  /** One image of this edit at the model's own settings and its company's speed. */
  const priceOf = (model: ModelListItem) => {
    const run = runSpeed(model, editOpFor(model.capabilities, true));
    const estimate = estimateRun(
      model,
      resolveValues(model.capabilities, {}, 1),
      "",
      run.speed,
      { edit: { base, masked: true } },
      askedPrice,
    );
    if (isPricePending(estimate)) return {};
    return run.fellBack
      ? {
          price: tightCost(estimate),
          note: t("speed.suffix", { speed: run.name }),
          hint: speedFallbackHint(model, run),
        }
      : { price: tightCost(estimate) };
  };

  const logo = logoFor(selected?.providerId);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          id={field.id}
          aria-describedby={field["aria-describedby"]}
          className="group flex h-38 w-full min-w-0 cursor-pointer items-center justify-between gap-8 rounded-10 bg-surface px-12 inset-ring inset-ring-border text-small text-text-primary transition-shadow data-[state=open]:inset-ring-accent-line"
        >
          <span className="flex min-w-0 items-center gap-8">
            {logo ? <ProviderLogo provider={logo} /> : null}
            <span className={cn("truncate", !selected && "text-text-tertiary")}>
              {selected?.displayName ?? t("composer.chips.model.empty")}
            </span>
          </span>
          <ChevronDown
            size={14}
            aria-hidden
            className="shrink-0 text-text-tertiary transition-transform group-data-[state=open]:rotate-180"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="left"
        align="start"
        sideOffset={PICKER_OFFSET}
        className="w-402 gap-0 p-0"
        onOpenAutoFocus={focusSelected(list)}
      >
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
                  const itemLogo = logoFor(model.providerId);
                  const isSelected = model.key === selected?.key;
                  const { price, note, hint } = model.ready ? priceOf(model) : {};
                  const company = companyName(providers, model.providerId);
                  return (
                    <ModelRow
                      key={model.key}
                      asChild
                      name={model.displayName}
                      description={
                        model.ready
                          ? model.description
                          : t("edit.model.needsKey", {
                              company,
                              vowel: /^[aeiou]/i.test(company) ? "yes" : "no",
                            })
                      }
                      logo={itemLogo ? <ProviderLogo provider={itemLogo} variant="tile" /> : undefined}
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
