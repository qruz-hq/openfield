// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { beforeEach, describe, expect, test } from "bun:test";
import type { ModelListItem } from "@openfield/core";
import {
  type ComposerValues,
  type ControlId,
  resolveControl,
  resolveValues,
} from "@openfield/providers/manifest";
import { TooltipProvider } from "@openfield/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create } from "zustand";
import { ControlChip } from "../src/image/composer/control-chip";
import { ReferenceRow } from "../src/image/composer/references";
import { type ReferenceSlice, referenceSlice, useComposer } from "../src/image/composer/store";
import { banana, flare } from "./fixtures";

// The reference row and the setting chips keep no state of their own, so a second surface (the
// Edit view) can show them over its own store while the composer's stays as it was.

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );

const withMax = (max: number): ModelListItem => ({
  ...banana,
  capabilities: {
    ...banana.capabilities,
    references: { ...banana.capabilities.references, supported: max > 0, max },
  },
});

/** A store like the Edit view's: a reference list of its own. */
const otherStore = () => create<ReferenceSlice>()((set) => referenceSlice(set));

const tiles = (html: string) => [...html.matchAll(/data-reference="([^"]+)"/g)].map((m) => m[1]);

describe("the reference row over a store that isn't the composer's", () => {
  beforeEach(() => useComposer.setState({ references: ["COMPOSER"] }));

  test("shows that store's references in its order, and none of the composer's", () => {
    const store = otherStore();
    store.getState().addReferences(["A", "B"]);
    const html = render(
      <ReferenceRow store={store.getState()} model={withMax(1)} pending={["UP"]} onUpload={() => {}} />,
    );
    expect(tiles(html)).toEqual(["A", "B"]);
    expect(html).not.toContain("COMPOSER");
    expect(html).toContain('aria-label="Reference images"');
    // Past the model's limit: kept, but marked as not going with the run.
    expect(html.match(/title="([^"]+)"/g)).toEqual(['title="Won&#x27;t be sent"']);
    // The upload still going up holds a place after them.
    expect(html).toContain('<span class="sr-only">Loading</span></span></li></ol>');
  });

  test("an empty store shows only the +, and a full one holds it back", () => {
    const store = otherStore();
    const empty = render(
      <ReferenceRow store={store.getState()} model={withMax(2)} pending={[]} onUpload={() => {}} />,
    );
    expect(tiles(empty)).toEqual([]);
    expect(empty).not.toContain('aria-label="Reference images"');
    expect(empty).toContain('aria-label="Add images"');
    expect(empty).not.toContain('aria-disabled="true"');

    store.getState().setReferences(["A", "B"]);
    const full = render(
      <ReferenceRow store={store.getState()} model={withMax(2)} pending={[]} onUpload={() => {}} />,
    );
    expect(full).toContain('aria-label="Add images"');
    expect(full).toContain('aria-disabled="true"');
  });

  test("the slice's actions change only the store they belong to", () => {
    const store = otherStore();
    const { addReference, addReferences, moveReference, removeReference, setReferences } = store.getState();
    addReferences(["A", "B", "C", "A"]);
    moveReference("C", 0);
    removeReference("A");
    expect(store.getState().references).toEqual(["C", "B"]);
    // Already there: the same state back, so nothing re-renders.
    const before = store.getState();
    addReference("B");
    expect(store.getState()).toBe(before);
    setReferences(["B", "D", "B"]);
    expect(store.getState().references).toEqual(["B", "D"]);
    expect(useComposer.getState().references).toEqual(["COMPOSER"]);
  });
});

describe("the setting chips over another surface's values", () => {
  const caps = flare.capabilities;
  const resolved = resolveValues(caps, { resolution: "1.5K", quality: "high" }, 3);
  const values: ComposerValues[] = [];
  const batches: number[] = [];
  const chip = (id: ControlId) => (
    <ControlChip
      control={{ id, ...resolveControl(caps, id) }}
      caps={caps}
      resolved={resolved}
      model={flare}
      speed="standard"
      onValues={(next) => values.push(next)}
      onBatch={(next) => batches.push(next)}
    />
  );

  test("they show the values they're given", () => {
    expect(render(chip("resolution"))).toContain('aria-label="Resolution: 1.5K"');
    expect(render(chip("quality"))).toContain('aria-label="Quality: High"');
    const batch = render(chip("batch"));
    expect(batch).toContain('aria-label="Images"');
    expect(batch).toContain(">3</output>");
    // Nothing for a control with no chip yet.
    expect(render(chip("promptEnhance"))).toBe("");
  });

  test("changes go back through the callbacks, never to the composer", () => {
    const composerBefore = useComposer.getState();
    // ControlChip has no hooks, so its element can be read without a DOM.
    const pick = <V,>(id: ControlId, prop: string, value: V) => {
      const element = ControlChip(chip(id).props) as ReactElement<Record<string, (value: V) => void>>;
      element.props[prop]!(value);
    };
    pick("resolution", "onChange", "1K");
    pick("quality", "onChange", "low");
    pick("aspect", "onChange", "3:2");
    pick("batch", "onValueChange", 2);
    expect(values).toEqual([{ resolution: "1K" }, { quality: "low" }, { aspect: "3:2" }]);
    expect(batches).toEqual([2]);
    expect(useComposer.getState()).toBe(composerBefore);
  });
});
