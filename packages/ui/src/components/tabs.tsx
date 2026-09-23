import { Tabs as RadixTabs } from "radix-ui";
import { type ComponentProps, createContext, useContext } from "react";
import { cn } from "../lib/cn";
import { segmentedItemClass, segmentedTrackClass } from "./segmented";

type TabsVariant = "pill" | "segmented";
const VariantContext = createContext<TabsVariant>("pill");

export const Tabs = RadixTabs.Root;
export const TabsContent = RadixTabs.Content;

export interface TabsListProps extends ComponentProps<typeof RadixTabs.List> {
  /** `pill` is Tabs / Pill (picker sheets). `segmented` is the detail panel's Info · Edit · History. */
  variant?: TabsVariant;
}

export function TabsList({ variant = "pill", className, ...props }: TabsListProps) {
  return (
    <VariantContext value={variant}>
      <RadixTabs.List
        className={cn(variant === "pill" ? "flex gap-4" : segmentedTrackClass, className)}
        {...props}
      />
    </VariantContext>
  );
}

/** Tabs / Pill / Item / Active and / Idle, or a segment when the list is segmented. */
export function TabsTrigger({ className, ...props }: ComponentProps<typeof RadixTabs.Trigger>) {
  const variant = useContext(VariantContext);
  return (
    <RadixTabs.Trigger
      className={cn(
        variant === "pill"
          ? "inline-flex h-32 shrink-0 cursor-pointer items-center justify-center gap-6 whitespace-nowrap rounded-8 px-12 text-small text-text-secondary transition-colors data-[state=inactive]:hover:text-text-primary data-[state=active]:bg-accent-soft data-[state=active]:font-semibold data-[state=active]:text-accent"
          : cn(
              segmentedItemClass,
              "data-[state=inactive]:hover:text-text-secondary data-[state=active]:bg-segment-on data-[state=active]:font-semibold data-[state=active]:text-text-primary data-[state=active]:inset-ring data-[state=active]:inset-ring-segment-on-line",
            ),
        className,
      )}
      {...props}
    />
  );
}
