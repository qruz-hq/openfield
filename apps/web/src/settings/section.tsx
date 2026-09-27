import { Divider, SectionLabel, SettingText, Surface } from "@openfield/ui";
import { Children, Fragment, isValidElement, type ReactNode, useId } from "react";

/**
 * Settings / Section: a caps label over a card of rows, hairlines between them. `stack` is a card
 * of free content instead, 16px in with 12px between, as in Settings > Agents' Add to an app.
 */
export function SettingsSection({
  label,
  stack = false,
  children,
}: {
  label: string;
  stack?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  if (stack) {
    return (
      <section aria-labelledby={id} className="flex w-full flex-col gap-10">
        <SectionLabel id={id}>{label}</SectionLabel>
        <Surface variant="card" className="gap-12 p-16">
          {children}
        </Surface>
      </section>
    );
  }
  const rows = Children.toArray(children);
  return (
    <section aria-labelledby={id} className="flex w-full flex-col gap-10">
      <SectionLabel id={id}>{label}</SectionLabel>
      <Surface variant="card" className="gap-0 px-16 py-4">
        {rows.map((row, i) => (
          // toArray gives every row a key, from its own key when it has one.
          <Fragment key={isValidElement(row) ? row.key : i}>
            {i > 0 ? <Divider /> : null}
            {row}
          </Fragment>
        ))}
      </Surface>
    </section>
  );
}

/** Settings / Row / *: title and description on the left, the control on the right. */
export function SettingRow({
  title,
  description,
  titleId,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  titleId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-16 py-12">
      <SettingText title={title} description={description} titleId={titleId} className="flex-1" />
      {children}
    </div>
  );
}
