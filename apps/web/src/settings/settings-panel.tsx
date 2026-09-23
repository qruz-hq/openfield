import {
  CONCURRENCY_CAP_FIELD,
  isLegalSettingValue,
  type ModelListItem,
  type SettingField,
  type SettingsPanel,
  type SettingValue,
  speedSettingField,
  t,
} from "@openfield/core";
import {
  Badge,
  Button,
  Divider,
  Input,
  OptionCard,
  RadioGroup,
  Stepper,
  Surface,
  Switch,
} from "@openfield/ui";
import { Bell, Check, Info, type LucideIcon } from "lucide-react";
import { Fragment, type ReactNode, useId, useState } from "react";
import {
  type Blocked,
  batchExpiryDays,
  dependencyNote,
  fieldAvailability,
  fieldView,
  formatPriceRange,
  isAsyncSpeed,
  isLimitsPanel,
  isSpeedField,
  optionAvailability,
  optionPriceRange,
} from "../lib/provider-settings";
import { SettingRow } from "./section";

// One panel of a company's settings modal: Settings / Panel header, then a control per field
// (design PQIwK, q5RpC, w2OLHG). Selects are option cards, toggles and numbers are rows in a card,
// text is a field. Nothing here knows which company it's drawing.

type Values = Readonly<Record<string, SettingValue>>;

export interface SettingsPanelBodyProps {
  panel: SettingsPanel;
  /** Every panel in the modal, for conditions that read a field elsewhere. */
  panels: readonly SettingsPanel[];
  values: Values;
  models: readonly ModelListItem[];
  company: string;
  /** Show "Saved" in the header for a moment after a change. */
  saved: boolean;
  onChange: (patch: Record<string, SettingValue>) => void;
  /** Open another panel, from a note's action. */
  onJump: (panelId: string) => void;
}

/** Settings / Panel header: title and description, with a quiet "Saved" after a change. */
function PanelHeader({
  id,
  title,
  description,
  saved,
}: {
  id: string;
  title: string;
  description?: string;
  saved: boolean;
}) {
  return (
    <div className="flex w-full items-start justify-between gap-16">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <h3 id={id} className="text-group-title text-text-primary">
          {title}
        </h3>
        {description ? (
          <p className="w-full text-small leading-[1.45] text-text-secondary">{description}</p>
        ) : null}
      </div>
      {saved ? (
        <span aria-hidden className="flex shrink-0 items-center gap-4 py-3 text-caption text-text-tertiary">
          <Check size={12} aria-hidden className="shrink-0" />
          {t("providerSettings.saved")}
        </span>
      ) : null}
      <span role="status" className="sr-only">
        {saved ? t("providerSettings.saved") : ""}
      </span>
    </div>
  );
}

/** Settings / Panel note: a boxed line, with an optional ghost action. */
function PanelNote({
  icon: Icon = Info,
  message,
  action,
}: {
  icon?: LucideIcon;
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex w-full items-center gap-10 rounded-10 bg-surface px-12 py-10">
      <Icon size={14} aria-hidden className="shrink-0 text-text-tertiary" />
      <p className="min-w-0 flex-1 text-caption leading-[1.45] text-text-secondary">{message}</p>
      {action ? (
        <Button variant="ghost" size="s" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

/** A field's own label, when the panel holds more than one field. */
function FieldHeading({
  id,
  field,
  availability,
}: {
  id: string;
  field: SettingField;
  availability?: string;
}) {
  return (
    <div className="flex w-full flex-col gap-4">
      <span className="flex items-center gap-8">
        <span id={id} className="text-body-medium text-text-primary">
          {field.label}
        </span>
        {availability ? <Badge variant="neutral">{availability}</Badge> : null}
      </span>
      {field.description ? (
        <span className="text-small leading-[1.45] text-text-secondary">{field.description}</span>
      ) : null}
    </div>
  );
}

const isRow = (field: SettingField) =>
  field.kind === "toggle" || (field.kind === "number" && field.control === "stepper");

export function SettingsPanelBody({
  panel,
  panels,
  values,
  models,
  company,
  saved,
  onChange,
  onJump,
}: SettingsPanelBodyProps) {
  const titleId = useId();
  const speedFieldId = speedSettingField({ panels })?.id;
  const solo = panel.fields.length === 1 ? panel.fields[0] : undefined;
  const description =
    panel.description ??
    (isLimitsPanel(panel) ? t("providerSettings.limits.description", { company }) : solo?.description);

  const blocks: ReactNode[] = [];
  let rows: { field: SettingField; blocked?: Blocked }[] = [];
  const flushRows = () => {
    if (!rows.length) return;
    const group = rows;
    rows = [];
    for (const { field, blocked } of group) {
      if (blocked) blocks.push(blockedNote(field, blocked));
    }
    blocks.push(
      <Surface key={`rows-${group[0]!.field.id}`} variant="card" className="gap-0 px-16 py-4">
        {group.map(({ field, blocked }, i) => (
          <Fragment key={field.id}>
            {i > 0 ? <Divider /> : null}
            <RowField field={field} value={values[field.id]} disabled={!!blocked} onChange={onChange} />
          </Fragment>
        ))}
      </Surface>,
    );
  };

  function blockedNote(field: SettingField, blocked: Blocked) {
    const note = dependencyNote(blocked, values);
    return (
      <PanelNote
        key={`note-${field.id}`}
        message={note.message}
        action={{ label: note.action, onClick: () => onJump(blocked.targetPanel) }}
      />
    );
  }

  for (const field of panel.fields) {
    const view = fieldView(field, panel.id, panels, values);
    if (view.mode === "hidden") continue;
    const blocked = view.mode === "muted" ? view.blocked : undefined;
    if (isRow(field)) {
      rows.push({ field, blocked });
      continue;
    }
    flushRows();
    if (blocked) blocks.push(blockedNote(field, blocked));
    // A lone field is the panel: the header names it.
    const heading = !solo && field.label !== panel.label;
    blocks.push(
      <BlockField
        key={field.id}
        field={field}
        heading={heading}
        labelledBy={titleId}
        value={values[field.id]}
        disabled={!!blocked}
        models={models}
        speedFieldId={speedFieldId}
        onChange={onChange}
      />,
    );
    if (field.kind === "select" && isSpeedField(field) && isAsyncSpeed(String(values[field.id]), models)) {
      blocks.push(
        <PanelNote
          key={`batch-${field.id}`}
          icon={Bell}
          message={t("providerSettings.batchNote", { company, days: batchExpiryDays(models) ?? 2 })}
        />,
      );
    }
  }
  flushRows();

  return (
    <div className="flex w-full flex-1 flex-col gap-20">
      <PanelHeader id={titleId} title={panel.label} description={description} saved={saved} />
      {blocks}
    </div>
  );
}

interface FieldProps {
  field: SettingField;
  value: SettingValue | undefined;
  /** A condition in another panel doesn't hold: keep the value in view, but still. */
  disabled: boolean;
  onChange: (patch: Record<string, SettingValue>) => void;
}

/** A select as option cards, or a text field, with its heading when the panel has several fields. */
function BlockField({
  field,
  heading,
  labelledBy,
  value,
  disabled,
  models,
  speedFieldId,
  onChange,
}: FieldProps & {
  heading: boolean;
  labelledBy: string;
  models: readonly ModelListItem[];
  speedFieldId: string | undefined;
}) {
  const headingId = useId();
  const availability = fieldAvailability(field, models);
  const title = heading ? <FieldHeading id={headingId} field={field} availability={availability} /> : null;
  const labelId = heading ? headingId : labelledBy;

  let control: ReactNode = null;
  if (field.kind === "select") {
    control = (
      <RadioGroup
        value={String(value ?? field.default)}
        onValueChange={(next) => onChange({ [field.id]: next })}
        disabled={disabled}
        aria-labelledby={labelId}
      >
        {field.options.map((option) => {
          const range = optionPriceRange(field, option, models, speedFieldId);
          return (
            <OptionCard
              key={option.value}
              value={option.value}
              title={option.label}
              badge={optionAvailability(field, option, models)}
              price={range ? formatPriceRange(range) : undefined}
              unit={range ? t("providerSettings.perImage") : undefined}
              description={option.description}
            />
          );
        })}
      </RadioGroup>
    );
  } else if (field.kind === "text" || field.kind === "number") {
    control = (
      <DraftInput field={field} value={value} disabled={disabled} labelId={labelId} onChange={onChange} />
    );
  }

  return title ? (
    <div className="flex w-full flex-col gap-12">
      {title}
      {control}
    </div>
  ) : (
    control
  );
}

/** Settings / Row / Toggle and / Stepper, inside the panel's card. */
function RowField({ field, value, disabled, onChange }: FieldProps) {
  const titleId = useId();
  if (field.kind === "toggle") {
    return (
      <SettingRow title={field.label} description={field.description} titleId={titleId}>
        <Switch
          aria-labelledby={titleId}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ [field.id]: checked })}
        />
      </SettingRow>
    );
  }
  if (field.kind !== "number") return null;
  const limits = field.id === CONCURRENCY_CAP_FIELD;
  return (
    <SettingRow title={field.label} description={field.description} titleId={titleId}>
      <Stepper
        aria-labelledby={titleId}
        value={typeof value === "number" ? value : field.default}
        min={field.min}
        max={field.max}
        step={field.step}
        disabled={disabled}
        onValueChange={(next) => onChange({ [field.id]: next })}
        decrementLabel={limits ? t("runsAtOnce.fewer") : t("providerSettings.lower", { field: field.label })}
        incrementLabel={limits ? t("runsAtOnce.more") : t("providerSettings.raise", { field: field.label })}
      />
    </SettingRow>
  );
}

/** Text, or a number typed in: saved when it's left or Enter is pressed, and only if it fits. */
function DraftInput({ field, value, disabled, labelId, onChange }: FieldProps & { labelId: string }) {
  const saved = value === undefined ? "" : String(value);
  const [draft, setDraft] = useState<string | null>(null);
  const number = field.kind === "number";

  const commit = () => {
    if (draft === null) return;
    const next: SettingValue = number ? Number(draft) : draft;
    setDraft(null);
    if (draft === saved || (number && draft.trim() === "") || !isLegalSettingValue(field, next)) return;
    onChange({ [field.id]: next });
  };

  return (
    <Input
      aria-labelledby={labelId}
      mono={number}
      type={number ? "number" : "text"}
      inputMode={number ? "decimal" : undefined}
      value={draft ?? saved}
      placeholder={field.kind === "text" ? field.placeholder : undefined}
      maxLength={field.kind === "text" ? field.maxLength : undefined}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}
