import { type ComponentProps, createContext, type ReactNode, useContext, useId } from "react";
import { cn } from "../lib/cn";

interface FieldContextValue {
  controlId: string;
  labelId: string;
  descriptionId: string | undefined;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/**
 * Ids a control inside a <Field> should use, so its label and description are announced.
 * Native inputs take `id`; controls that aren't labelable (sliders, segmented) take `aria-labelledby`.
 */
export function useFieldControl(
  own: { id?: string; "aria-describedby"?: string; "aria-labelledby"?: string } = {},
) {
  const field = useContext(FieldContext);
  return {
    id: own.id ?? field?.controlId,
    "aria-describedby": own["aria-describedby"] ?? field?.descriptionId,
    "aria-labelledby": own["aria-labelledby"] ?? field?.labelId,
  };
}

export interface FieldProps extends Omit<ComponentProps<"div">, "children"> {
  label: ReactNode;
  description?: ReactNode;
  /** `stack` puts the control under the text (select, textarea, segmented, slider). `inline` puts it on the right (switch). */
  layout?: "stack" | "inline";
  /** Id for the control. Generated when left out. */
  controlId?: string;
  children: ReactNode;
}

/** Form / Field / *: label, optional description, then the control. */
export function Field({
  label,
  description,
  layout = "stack",
  controlId,
  className,
  children,
  ...props
}: FieldProps) {
  const base = useId();
  const value: FieldContextValue = {
    controlId: controlId ?? `${base}control`,
    labelId: `${base}label`,
    descriptionId: description ? `${base}description` : undefined,
  };
  return (
    <FieldContext value={value}>
      <div
        className={cn(
          "flex w-full px-10 py-8",
          layout === "inline" ? "items-center justify-between gap-16" : "flex-col gap-8",
          className,
        )}
        {...props}
      >
        <div className={cn("flex flex-col gap-2", layout === "inline" && "min-w-0 flex-1")}>
          <label
            id={value.labelId}
            htmlFor={value.controlId}
            className="text-small font-medium text-text-primary"
          >
            {label}
          </label>
          {description ? (
            <p id={value.descriptionId} className="text-caption text-text-tertiary">
              {description}
            </p>
          ) : null}
        </div>
        {children}
      </div>
    </FieldContext>
  );
}
