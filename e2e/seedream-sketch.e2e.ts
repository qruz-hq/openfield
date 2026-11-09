import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, FAKE_KEY, makeImage, sessionToken } from "./support";

// The Edit tab's Sketch & point (design VxRpG1BiE8, dtuXJVDUtn) on the fake BytePlus: the switch on
// Seedream 5.0 Pro's toolbar, marks drawn on the image with their chips and popover, the marks list
// and its prompt preview, Undo, and the edit each Generate asks for, measured against the design.

test.describe.configure({ mode: "serial" });
// The design is drawn in the dark theme.
test.use({ colorScheme: "dark" });

const PRO = "byteplus:dola-seedream-5-0-pro-260628";
const unique = (words: string) => `${words} ${Date.now().toString(36)}`;

const SURFACE = "rgb(14, 16, 18)";
const ELEVATED = "rgb(23, 25, 28)";
const ACCENT_SOFT = "rgba(233, 227, 216, 0.08)";

/** What the browser drew, for comparing against the design's node values. */
const drawn = (el: Locator) =>
  el.evaluate((node) => {
    const s = getComputedStyle(node);
    const r = node.getBoundingClientRect();
    const paint = (color: string) => {
      const probe = document.createElement("i");
      probe.style.color = `color-mix(in srgb, ${color} 100%, transparent)`;
      document.body.append(probe);
      const mixed = getComputedStyle(probe).color;
      probe.remove();
      const n = (mixed.match(/[\d.]+/g) ?? []).map(Number);
      const scale = mixed.startsWith("color(") ? 255 : 1;
      const [red, green, blue] = n.slice(0, 3).map((v) => Math.round(v * scale));
      const alpha = n[3] ?? 1;
      return alpha === 1
        ? `rgb(${red}, ${green}, ${blue})`
        : `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(2)})`;
    };
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      radius: s.borderTopLeftRadius,
      padding: `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`,
      gap: s.flexDirection === "column" ? s.rowGap : s.columnGap,
      direction: s.flexDirection,
      justify: s.justifyContent,
      align: s.alignItems,
      background: paint(s.backgroundColor),
      border: `${s.borderTopWidth} ${s.borderTopStyle} ${paint(s.borderTopColor)}`,
      display: s.display,
    };
  });

const font = (el: Locator) =>
  el.evaluate((node) => {
    const s = getComputedStyle(node);
    const family = s.fontFamily
      .split(",")[0]!
      .replace(/"/g, "")
      .replace(/ Variable$/, "");
    return `${family} ${s.fontSize} ${s.fontWeight}`;
  });

const icons = (el: Locator) =>
  el.locator("svg.lucide").evaluateAll((nodes) =>
    nodes.map(
      (n) =>
        // Lucide also adds an older alias (Trash2 is lucide-trash too): the longest is the icon's name.
        `${n.getBoundingClientRect().width} ${(n.getAttribute("class")?.match(/lucide-[a-z0-9-]+/g) ?? []).sort((a, b) => b.length - a.length)[0]}`,
    ),
  );

const settled = (page: Page) =>
  page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) => a.effect?.getTiming().iterations === Number.POSITIVE_INFINITY || a.playState !== "running",
      ),
  );

const detail = (page: Page) => page.getByRole("dialog", { name: "Image details" });

/** Esc on a popover: focus goes back to the view a moment later, where the tools' keys work. */
async function closePopover(page: Page) {
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("dialog");
}
const panelOf = (page: Page) => detail(page).getByRole("tabpanel", { name: "Edit" });

/** The image's rectangle on screen, from the element inside its zoomed box. */
const imageBox = (page: Page) =>
  page.locator("[data-sketch-anchor]").evaluate((n) => {
    const r = n.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

async function at(page: Page, fx: number, fy: number) {
  const box = await imageBox(page);
  return { x: box.x + fx * box.width, y: box.y + fy * box.height };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

/** A 3:4 image with the BytePlus key in place, opened on Edit with Seedream 5.0 Pro picked. */
async function sketchable(page: Page): Promise<string> {
  const token = await sessionToken(page.request);
  const id = await makeImage(page.request, token, unique("white vases, red berries"), "3:4");
  await api(page.request, token, "PUT", "/api/settings/keys/byteplus", { apiKey: FAKE_KEY });
  await page.goto(`/assets?asset=${id}&tab=edit`);
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "Model" }).click();
  const list = page.getByRole("listbox", { name: "Choose model" });
  const text = await list.innerText();
  // Sketch and point sits between the models that take a mask and the ones that redraw.
  expect(text.indexOf("Sketch and point")).toBeGreaterThan(-1);
  expect(text.indexOf("Sketch and point")).toBeLessThan(text.indexOf("Redraw the whole image"));
  expect(text.indexOf("Seedream 5.0 Pro")).toBeGreaterThan(text.indexOf("Sketch and point"));
  expect(text.indexOf("Seedream 5.0 Pro")).toBeLessThan(text.indexOf("Redraw the whole image"));
  await list.getByRole("option", { name: /Seedream 5\.0 Pro/ }).click();
  return id;
}

test("Paint area on Seedream points to Sketch & point, and the switch opens it", async ({ page }) => {
  await sketchable(page);
  const panel = panelOf(page);
  await expect(
    panel.getByText(
      "Seedream 5.0 Pro redraws the whole image, then everything outside your mask is put back. For a precise change, try Sketch & point.",
    ),
  ).toBeVisible();
  const paint = detail(page).getByRole("toolbar", { name: "Mask tools" });
  const modes = paint.getByRole("radiogroup", { name: "How to show the change" });
  await expect(modes.getByRole("radio", { name: "Paint area" })).toHaveAttribute("aria-checked", "true");

  // Image edit / Toolbar / Paint area (DU19ExJcxQ): the switch first, then the mask's tools.
  await settled(page);
  await expect.poll(async () => (await paint.boundingBox())?.y).toBe(900 - 16 - 44);
  const bar = await drawn(paint);
  console.log("Paint toolbar", JSON.stringify(bar));
  expect(bar).toMatchObject({
    h: 44,
    radius: "12px",
    padding: "4px 4px 4px 4px",
    gap: "2px",
    align: "center",
    background: ELEVATED,
  });
  expect(await drawn(modes)).toMatchObject({
    w: 236,
    radius: "10px",
    padding: "3px 3px 3px 3px",
    gap: "4px",
    background: SURFACE,
  });
  expect(await drawn(modes.locator("+ div"))).toMatchObject({ w: 9, h: 36 });
  expect(await icons(paint)).toEqual([
    "18 lucide-hand",
    "18 lucide-brush",
    "18 lucide-eraser",
    "18 lucide-lasso",
    "18 lucide-square-dashed",
    "18 lucide-contrast",
    "18 lucide-trash-2",
    "18 lucide-undo-2",
    "18 lucide-redo-2",
  ]);
  const note = panel.getByText(/redraws the whole image/);
  expect(await font(note)).toBe("Inter 12px 400");
  expect(await icons(note.locator(".."))).toEqual(["12 lucide-info"]);
  await modes.getByRole("radio", { name: "Sketch & point" }).click();
  await expect(detail(page).getByRole("toolbar", { name: "Sketch tools" })).toBeVisible();
  await expect(paint).toHaveCount(0);
  // The whole-image note gives way to the marks.
  await expect(panel.getByText(/redraws the whole image/)).toHaveCount(0);
  await expect(panel.getByText("No marks yet")).toBeVisible();
});

test("marks drawn on the image, measured against the design, then sent with the edit", async ({ page }) => {
  const id = await sketchable(page);
  const view = detail(page);
  const panel = panelOf(page);
  // The mode carries on from the last edit; this one opens on Sketch & point.
  const toolbar = view.getByRole("toolbar", { name: "Sketch tools" });
  if (!(await toolbar.isVisible())) await view.getByRole("radio", { name: "Sketch & point" }).click();
  await settled(page);
  // The chrome slides in with the tab: measure once it's at rest, 16 from the bottom.
  await expect.poll(async () => (await toolbar.boundingBox())?.y).toBe(900 - 16 - 44);

  // Image edit / Toolbar / Sketch & point (gE73OxCUB4): radius 12, 4 in, 2 between, on #17191C.
  const bar = await drawn(toolbar);
  console.log("Sketch toolbar", JSON.stringify(bar));
  expect(bar).toMatchObject({
    radius: "12px",
    padding: "4px 4px 4px 4px",
    gap: "2px",
    align: "center",
    background: ELEVATED,
  });
  expect(bar.h).toBe(44);
  expect(bar.y + bar.h).toBe(900 - 16);
  const modes = toolbar.getByRole("radiogroup", { name: "How to show the change" });
  expect(await drawn(modes)).toMatchObject({
    w: 236,
    radius: "10px",
    padding: "3px 3px 3px 3px",
    gap: "4px",
    background: SURFACE,
  });
  const on = modes.getByRole("radio", { name: "Sketch & point" });
  expect(await drawn(on)).toMatchObject({ h: 30, radius: "8px" });
  expect(await font(on)).toBe("Inter 12px 600");
  expect(await font(modes.getByRole("radio", { name: "Paint area" }))).toBe("Inter 12px 500");
  expect(await icons(toolbar)).toEqual([
    "18 lucide-hand",
    "18 lucide-brush",
    "18 lucide-circle",
    "18 lucide-square",
    "18 lucide-move-up-right",
    "18 lucide-crosshair",
    "18 lucide-undo-2",
    "18 lucide-redo-2",
    "18 lucide-trash-2",
  ]);
  const brush = toolbar.getByRole("button", { name: "Sketch" });
  expect(await drawn(brush)).toMatchObject({ w: 36, h: 36, radius: "8px", background: ACCENT_SOFT });
  const swatch = toolbar.locator("[data-color-swatch]");
  expect(await drawn(swatch)).toMatchObject({ w: 18, h: 18, background: "rgb(200, 16, 46)" });
  // Nothing drawn: Undo and Clear rest at 40%.
  for (const name of ["Undo", "Redo", "Clear all marks"])
    await expect(toolbar.getByRole("button", { name })).toHaveAttribute("aria-disabled", "true");

  // Image edit / Sketch hint (YDcIyHcwgu): 44 tall over the toolbar, the tool's words.
  const hint = view.getByRole("status").filter({ hasText: "Sketch what you want added." });
  const hintBox = await drawn(hint);
  console.log("Sketch hint", JSON.stringify(hintBox));
  expect(hintBox).toMatchObject({
    h: 44,
    radius: "12px",
    padding: "0px 14px 0px 14px",
    background: ELEVATED,
  });
  // At 788, as the design places it: 8 above the toolbar.
  expect(hintBox.y).toBe(788);
  expect(hintBox.w).toBe(483);
  expect(await font(hint.locator("span"))).toBe("Inter 12px 400");

  // Image edit / Marks list / Empty (fVYLRNCACZ).
  const empty = panel.locator("[data-marks-empty]");
  const emptyBox = await drawn(empty);
  console.log("Marks empty", JSON.stringify(emptyBox));
  expect(emptyBox).toMatchObject({
    radius: "14px",
    padding: "14px 16px 14px 16px",
    gap: "4px",
    align: "center",
  });
  expect(emptyBox.border).toMatch(/^1px dashed /);
  expect(await font(empty.getByText("No marks yet"))).toBe("Inter 13px 500");
  const words = panel.getByRole("textbox", { name: "What to change" });
  await expect(words).toHaveAttribute(
    "placeholder",
    "Describe the change. Point to a mark by its number, like mark 1.",
  );
  // The placeholder runs to two lines, as drawn (13/1.5).
  expect((await words.boundingBox())?.height).toBe(39);
  await expect(panel.getByText("Off, so the change can blend in.", { exact: false })).toBeVisible();
  await expect(panel.getByRole("slider", { name: "Feather" })).toHaveCount(0);

  // Mark 1: a box, drawn bottom right to top left. It's picked, with its popover open.
  await toolbar.getByRole("button", { name: "Box" }).click();
  await expect(hint).toHaveCount(0);
  await expect(
    view.getByText("Drag a box around what to change, then say what to do in the prompt."),
  ).toBeVisible();
  await drag(page, await at(page, 0.5, 0.95), await at(page, 0.23, 0.5));
  const popover = page.getByRole("dialog", { name: "Mark 1 · Box" });
  await expect(popover).toBeVisible();
  await settled(page);
  const pop = await drawn(popover);
  console.log("Mark popover", JSON.stringify(pop));
  expect(pop).toMatchObject({
    w: 264,
    radius: "14px",
    padding: "12px 12px 12px 12px",
    gap: "12px",
    background: ELEVATED,
  });
  // It hangs 14 right of the box, level with its top.
  const shown = await imageBox(page);
  expect(pop.x).toBe(Math.round(shown.x + 0.5 * shown.width + 14));
  const chip = view.locator('[data-mark-chip="1"]').first();
  const chipBox = await drawn(chip);
  expect(chipBox).toMatchObject({ w: 22, h: 22, radius: "11px", background: "rgb(200, 16, 46)" });
  // The chip is centred on the box's top left corner, and it's lit while its mark is picked.
  expect(chipBox.x + 11).toBe(Math.round(shown.x + 0.23 * shown.width));
  expect(chipBox.border).toBe("2px solid rgb(233, 227, 216)");
  expect(await font(chip)).toBe("Inter 11px 600");
  await expect(popover.getByText("Added to your prompt with this mark.")).toBeVisible();
  const hex = popover.getByRole("textbox", { name: "Hex color" });
  await expect(hex).toHaveValue("#C8102E");
  expect(await drawn(hex.locator(".."))).toMatchObject({ h: 32, radius: "10px", background: SURFACE });
  expect(await font(hex)).toBe("JetBrains Mono 13px 400");
  const presets = popover.getByRole("button", { name: /^Use #/ });
  await expect(presets).toHaveCount(8);
  expect(await drawn(presets.first())).toMatchObject({ w: 20, h: 20 });
  expect(await drawn(presets.first().locator(".."))).toMatchObject({ justify: "space-between" });
  await popover.getByRole("textbox", { name: "Material" }).fill("Brushed steel");
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);

  // Mark 2: an amber point, its colour set on the toolbar's swatch first.
  await toolbar.getByRole("button", { name: "Mark color" }).click();
  await page.getByRole("button", { name: "Use #E8A33D" }).click();
  await closePopover(page);
  await page.keyboard.press("p");
  const point = await at(page, 0.6, 0.3);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByRole("dialog", { name: "Mark 2 · Point" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Mark 3: a white sketch.
  await toolbar.getByRole("button", { name: "Mark color" }).click();
  await page.getByRole("button", { name: "Use #F5F6F7" }).click();
  await closePopover(page);
  await page.keyboard.press("d");
  await drag(page, await at(page, 0.12, 0.15), await at(page, 0.3, 0.17));
  await expect(page.getByRole("dialog", { name: "Mark 3 · Sketch" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Image edit / Marks list (dGmKS7RNNK).
  const marks = panel.getByRole("region", { name: "Marks" });
  const rows = marks.locator("[data-mark-row]");
  await expect(rows).toHaveCount(3);
  expect(await drawn(marks)).toMatchObject({ gap: "8px", direction: "column" });
  const rowsBox = await drawn(rows.first().locator(".."));
  expect(rowsBox).toMatchObject({
    radius: "14px",
    padding: "4px 4px 4px 4px",
    gap: "2px",
    background: SURFACE,
  });
  expect(await drawn(rows.first())).toMatchObject({
    radius: "10px",
    padding: "8px 10px 8px 10px",
    gap: "10px",
  });
  await expect(marks.getByText("#C8102E · brushed steel", { exact: true })).toBeVisible();
  const preview = marks.getByText("Sent with your prompt").locator("..");
  const previewBox = await drawn(preview);
  expect(previewBox).toMatchObject({ radius: "10px", padding: "10px 12px 10px 12px", gap: "6px" });
  expect(previewBox.border).toMatch(/^1px dashed /);
  await expect(preview).toContainText("Mark 1 · box · #C8102E · brushed steel");
  await expect(preview).toContainText("Mark 2 · point · #E8A33D");
  await expect(preview).toContainText("Mark 3 · sketch · #F5F6F7");
  expect(await font(preview.locator("p").first())).toBe("JetBrains Mono 11px 400");

  // Picking a row picks the mark: its row lights and its popover opens on the image.
  await rows.first().click();
  await expect(marks.getByRole("button", { pressed: true })).toHaveCount(1);
  expect(await drawn(marks.getByRole("button", { pressed: true }))).toMatchObject({
    background: ACCENT_SOFT,
  });
  await expect(page.getByRole("dialog", { name: "Mark 1 · Box" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Undo takes the sketch away, Redo brings it back.
  await toolbar.getByRole("button", { name: "Undo" }).click();
  await expect(preview.locator("p")).toHaveCount(2);
  await toolbar.getByRole("button", { name: "Redo" }).click();
  await expect(preview.locator("p")).toHaveCount(3);

  // Generate: the marks go with the prompt, with no mask while the rest isn't kept.
  const generate = panel.getByRole("button", { name: /^Generate/ });
  await expect(generate).toBeDisabled();
  await panel
    .getByRole("textbox", { name: "What to change" })
    .fill("Turn the vase in mark 1 into red brushed steel, make the berries at mark 2 amber.");
  await expect(generate).toBeEnabled();
  await expect(generate).toContainText(/~\$0\.045/);
  const firstEdit = page.waitForRequest((r) => r.url().endsWith("/api/edit") && r.method() === "POST");
  await generate.click();
  const body = (await firstEdit).postDataJSON() as {
    op: string;
    model: string;
    base: { assetId: string };
    mask?: unknown;
    marks: {
      kind: string;
      from?: { x: number; y: number };
      to?: { x: number; y: number };
      color?: string;
      material?: string;
      points?: unknown[];
    }[];
  };
  expect(body).toMatchObject({ op: "edit", model: PRO, base: { assetId: id } });
  expect(body.mask).toBeUndefined();
  expect(body.marks.map((m) => m.kind)).toEqual(["box", "point", "stroke"]);
  const box = body.marks[0]!;
  expect(box).toMatchObject({ color: "#C8102E", material: "Brushed steel" });
  // Drawn bottom right to top left, sent top left first, as fractions of the image.
  expect(box.from!.x).toBeCloseTo(0.23, 1);
  expect(box.from!.y).toBeCloseTo(0.5, 1);
  expect(box.to!.x).toBeCloseTo(0.5, 1);
  expect(box.to!.y).toBeCloseTo(0.95, 1);
  expect(body.marks[1]).toMatchObject({ kind: "point", color: "#E8A33D" });
  expect(body.marks[2]!.points!.length).toBeGreaterThan(2);
  await expect(panel.getByText("Saved as 1 new image. The original stays as it is.")).toBeVisible({
    timeout: 20_000,
  });

  // Keep the rest on: the marks' area is saved as the mask, and the original goes back outside it.
  await view.getByRole("button", { name: "Edit the marks" }).click();
  await panel.getByRole("switch", { name: "Keep the rest of the image" }).click();
  await expect(panel.getByText("Everything outside your marks stays exactly the same.")).toBeVisible();
  const masks = page.waitForResponse(
    (r) => r.url().endsWith("/api/masks") && r.request().method() === "POST",
  );
  const secondEdit = page.waitForRequest((r) => r.url().endsWith("/api/edit") && r.method() === "POST");
  await panel.getByRole("button", { name: /^Generate/ }).click();
  const saved = (await (await masks).json()) as { asset: { id: string } };
  const kept = (await secondEdit).postDataJSON() as { op: string; mask: unknown; marks: unknown[] };
  expect(kept).toMatchObject({
    op: "inpaint",
    mask: { assetId: saved.asset.id, composite: true, featherPx: 8, expandPx: 4 },
  });
  expect(kept.marks).toHaveLength(3);
  await expect(panel.getByText(/^Saved as 1 new image/)).toBeVisible({ timeout: 20_000 });
});
