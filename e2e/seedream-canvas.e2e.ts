import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import type { CanvasDetail } from "../packages/core/src/schemas/canvas.ts";
import { api, FAKE_KEY, makeImage, sessionToken } from "./support";

// Seedream on the canvas, against the fake BytePlus: a Layers node (design AvNxGiFbq7, Ready
// hJET2AMcq3) that splits its image into a base and three layers, one port each, and an Edit node in
// Sketch & point (EB0kxH1YLE, its settings ILw0tWC0ex) whose marks are drawn in the mask window.

test.describe.configure({ mode: "serial" });
// The design is drawn in the dark theme.
test.use({ colorScheme: "dark" });
// Each test runs a split or an edit end to end, and measures as it goes.
test.setTimeout(60_000);

const PRO = "byteplus:dola-seedream-5-0-pro-260628";

/** The editor's own pane: the card picture is drawn off screen from the same canvas. */
const pane = (page: Page) => page.locator(".of-canvas:not(.of-capture)");
const nodeOf = (page: Page, id: string) => pane(page).locator(`.react-flow__node[data-id="${id}"]`);
const handleOf = (page: Page, id: string, side: "source" | "target", port: string) =>
  pane(page).locator(`.react-flow__handle.${side}[data-nodeid="${id}"][data-handleid="${port}"]`);

const unique = (words: string) => `${words} ${Date.now().toString(36)}`;

/** A canvas built through the edits route, with the BytePlus key in place. */
async function canvasOf(request: APIRequestContext, name: string, edits: Record<string, unknown>[]) {
  const token = await sessionToken(request);
  await api(request, token, "PUT", "/api/settings/keys/byteplus", { apiKey: FAKE_KEY });
  const { id } = await api<CanvasDetail>(request, token, "POST", "/api/canvases", { name });
  const { aliases } = await api<{ aliases: Record<string, string> }>(
    request,
    token,
    "POST",
    `/api/canvases/${id}/edits`,
    { edits },
  );
  return { id, aliases, token };
}

/** What the browser drew, for comparing against the design's node values. */
const drawn = (el: Locator) =>
  el.evaluate((node) => {
    const s = getComputedStyle(node);
    const r = node.getBoundingClientRect();
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      top: Math.round(r.top),
      radius: s.borderTopLeftRadius,
      padding: `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`,
      gap: s.flexDirection === "column" ? s.rowGap : s.columnGap,
      align: s.alignItems,
      justify: s.justifyContent,
      background: s.backgroundColor,
      display: s.display,
      opacity: s.opacity,
    };
  });

const font = (el: Locator) =>
  el.evaluate((node) => {
    const s = getComputedStyle(node);
    return `${s.fontSize} ${s.fontWeight}`;
  });

/** A box's middle on screen, in canvas units from the top of `from` (the zoom read off the pane). */
async function middleBelow(page: Page, el: Locator, from: Locator) {
  const zoom = await page.evaluate(() => {
    const viewport = document.querySelector(".of-canvas:not(.of-capture) .react-flow__viewport");
    return new DOMMatrix(getComputedStyle(viewport!).transform).a;
  });
  const a = (await el.boundingBox())!;
  const b = (await from.boundingBox())!;
  return (a.y + a.height / 2 - b.y) / zoom;
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

const centreOf = async (locator: Locator) => {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/** Fits the view, at a zoom of 1 so boxes read in canvas units. */
async function actualSize(page: Page) {
  await pane(page).click({ position: { x: 20, y: 400 } });
  await page.keyboard.press("Shift+0");
  await page.waitForTimeout(400);
}

test("a Layers node splits its image, a port per layer, and a layer goes into an Edit node", async ({
  page,
  request,
}) => {
  const token = await sessionToken(request);
  const photo = await makeImage(request, token, unique("a still life"), "1:1");
  const { id, aliases } = await canvasOf(request, "Layers", [
    {
      op: "add_node",
      as: "u",
      type: "image.upload",
      position: { x: 0, y: 0 },
      params: { assetIds: [photo] },
    },
    {
      op: "add_node",
      as: "l",
      type: "image.layers",
      position: { x: 400, y: 0 },
      // The fake takes 3 seconds, so the split can be seen under way.
      params: { model: PRO, prompt: "#fake-layers-slow" },
    },
    { op: "connect", source: "u", sourceHandle: "images", target: "l", targetHandle: "image" },
    {
      op: "add_node",
      as: "e",
      type: "image.edit",
      position: { x: 860, y: 0 },
      params: { model: PRO, prompt: "Make it blue", mode: "sketch" },
    },
  ]);
  await page.goto(`/canvas/${id}`);
  const layers = nodeOf(page, aliases.l!);
  await expect(layers).toBeVisible();
  await actualSize(page);
  const card = layers.locator(".of-layers");

  // Ready (hJET2AMcq3): the image under the scrim with Run in the middle, the hint below, and a
  // dimmed port where the layers will come out. Nothing to drag from yet.
  await expect(layers.getByText("Layers show up here after a run.")).toBeVisible();
  const media = await drawn(card.locator(".of-layers-media"));
  // Ready centres Run, 8 apart, with no padding of its own.
  expect(media).toMatchObject({ w: 320, h: 240, padding: "0px 0px 0px 0px", gap: "8px", justify: "center" });
  const scrim = await drawn(card.locator(".of-layers-scrim"));
  expect(scrim.display).not.toBe("none");
  expect(scrim.h).toBe(240);
  expect(scrim.background).toBe("rgba(0, 0, 0, 0.55)");
  expect((await drawn(card.locator(".of-layers-foot"))).h).toBe(48);
  expect(await layers.locator(".of-port.react-flow__handle.source").count()).toBe(0);
  // The input port sits in the image's middle.
  expect(await middleBelow(page, handleOf(page, aliases.l!, "target", "image"), card)).toBeCloseTo(120, 0);

  const run = layers.getByRole("button", { name: /^Run/ });
  const pill = await drawn(run);
  expect(pill).toMatchObject({ h: 32, padding: "0px 12px 0px 10px", gap: "6px" });
  await run.click();

  // Separating (wTRrNWjboM): the scrim stays, a band of light sweeps the image, the pill counts up
  // and two bars wait where the rows will be.
  await expect(layers.getByText("Separating")).toBeVisible();
  const sweep = await drawn(card.locator(".of-layers-sweep"));
  expect(sweep.display).not.toBe("none");
  expect(sweep).toMatchObject({ w: 90, h: 240 });
  const busyScrim = await drawn(card.locator(".of-layers-scrim"));
  expect(busyScrim.display).not.toBe("none");
  expect(busyScrim.h).toBe(240);
  const bars = card.locator(".of-layers-foot > span");
  expect(await drawn(bars.nth(0))).toMatchObject({ w: 120, h: 8 });
  expect(await drawn(bars.nth(1))).toMatchObject({ w: 64, h: 8 });
  expect(await drawn(card.locator(".of-layers-foot"))).toMatchObject({ h: 48, gap: "8px" });

  // Done: a row and a port for each layer, top first, then the base.
  const rows = card.locator(".of-layers-row");
  await expect(rows).toHaveCount(4, { timeout: 20_000 });
  expect(await rows.locator(".truncate.font-medium").allTextContents()).toEqual([
    "Layer 3",
    "Layer 2",
    "Layer 1",
    "Base",
  ]);
  await expect(layers.getByText("3 layers and a base")).toBeVisible();
  // Done, the media is a column padded 10, the pill first.
  expect(await drawn(card.locator(".of-layers-media"))).toMatchObject({
    h: 240,
    padding: "10px 10px 10px 10px",
  });
  const row = await drawn(rows.first());
  expect(row).toMatchObject({ h: 40, gap: "10px", padding: "0px 28px 0px 12px", align: "center" });
  expect(await drawn(rows.first().locator(".of-layers-thumb"))).toMatchObject({ w: 28, h: 28 });
  expect(await font(rows.first().locator(".truncate.font-medium"))).toBe("12px 500");
  expect(await font(rows.first().locator(".text-micro"))).toBe("11px 400");
  expect(await drawn(card.locator(".of-layers-outputs"))).toMatchObject({ padding: "4px 0px 4px 0px" });
  // The status pill (h24, 0 10 in, 6 between).
  const status = card.locator(".of-layers-top > *").first();
  expect(await drawn(status)).toMatchObject({ h: 24, padding: "0px 10px 0px 10px", gap: "6px" });
  // Each output port at its row's middle: 264, then 40 apart.
  for (const [i, port] of ["layer-3", "layer-2", "layer-1", "base"].entries()) {
    expect(await middleBelow(page, handleOf(page, aliases.l!, "source", port), card)).toBeCloseTo(
      264 + 40 * i,
      0,
    );
  }

  // Layer 2 into the Edit node's image.
  await drag(
    page,
    await centreOf(handleOf(page, aliases.l!, "source", "layer-2")),
    await centreOf(handleOf(page, aliases.e!, "target", "image")),
  );
  await expect(pane(page).locator(".react-flow__edge-interaction")).toHaveCount(2);
  await expect
    .poll(async () => {
      const { graph } = await api<CanvasDetail>(request, token, "GET", `/api/canvases/${id}`);
      return graph.edges.find((e) => e.target === aliases.e)?.sourceHandle;
    })
    .toBe("layer-2");
  // The Edit card now shows the layer it edits.
  await expect(nodeOf(page, aliases.e!).locator("img").first()).toBeVisible();

  // Canvas / Inspector / Layers (GCugSMFGGB), measured against its nodes.
  await layers.dblclick({ position: { x: 160, y: 300 } });
  const sheet = page.getByRole("complementary", { name: "Layers" });
  await expect(sheet.getByText("What to separate")).toBeVisible();
  const boxes = sheet.locator("div.rounded-14.bg-surface");
  const input = boxes.first();
  expect(await drawn(input)).toMatchObject({
    padding: "12px 12px 12px 12px",
    gap: "12px",
    radius: "14px",
    align: "center",
  });
  expect(await drawn(input.locator("span.size-40"))).toMatchObject({ w: 40, h: 40, radius: "8px" });
  const what = sheet.getByRole("textbox", { name: "What to separate" });
  await expect(what).toHaveAttribute("maxlength", "4000");
  // What to separate: a column 4 2 in, 8 between, the label row over the 38 tall input.
  const field = what.locator("xpath=ancestor::div[contains(@class, 'py-4')][1]");
  expect(await drawn(field)).toMatchObject({ padding: "4px 2px 4px 2px", gap: "8px" });
  const sizes = sheet.getByRole("radiogroup", { name: "Size" });
  expect(await drawn(sizes)).toMatchObject({ radius: "10px", padding: "3px 3px 3px 3px", gap: "4px" });
  const price = boxes.filter({ hasText: "You pay for the layers you get" });
  expect(await drawn(price)).toMatchObject({ padding: "12px 12px 12px 12px", gap: "8px", radius: "14px" });
  const sheetRun = sheet.getByRole("button", { name: /^Run/ });
  expect(await drawn(sheetRun)).toMatchObject({
    h: 40,
    radius: "10px",
    gap: "8px",
    padding: "0px 16px 0px 16px",
  });
});

test("an Edit node in Sketch & point: marks drawn in the window, listed in its settings, then run", async ({
  page,
  request,
}) => {
  const token = await sessionToken(request);
  const photo = await makeImage(request, token, unique("white vases, red berries"), "3:4");
  const { id, aliases } = await canvasOf(request, "Sketch", [
    {
      op: "add_node",
      as: "u",
      type: "image.upload",
      position: { x: 0, y: 0 },
      params: { assetIds: [photo] },
    },
    {
      op: "add_node",
      as: "e",
      type: "image.edit",
      position: { x: 420, y: 0 },
      params: { model: PRO, prompt: "Turn the vase in mark 1 into red brushed steel" },
    },
    { op: "connect", source: "u", sourceHandle: "images", target: "e", targetHandle: "image" },
  ]);
  await page.goto(`/canvas/${id}`);
  const edit = nodeOf(page, aliases.e!);
  await expect(edit).toBeVisible();
  await expect(handleOf(page, aliases.e!, "target", "mask")).toHaveCount(1);
  await edit.dblclick({ position: { x: 160, y: 40 } });
  const settings = page.getByRole("complementary", { name: "Edit" });
  // A model that reads marks offers Sketch & point in the window's toolbar.
  await settings.getByRole("button", { name: "Paint", exact: true }).click();
  const paintWindow = page.getByRole("dialog", { name: "Paint the mask" });
  await expect(paintWindow).toBeVisible();
  await paintWindow.getByRole("radio", { name: "Sketch & point" }).click();
  const window = page.getByRole("dialog", { name: "Mark the image" });
  await expect(window).toBeVisible();
  await expect(window.getByRole("button", { name: "Save marks" })).toBeEnabled();

  // A box, then Save marks.
  await window.getByRole("toolbar").getByRole("button", { name: "Box" }).click();
  const image = (await window.locator("[data-sketch-anchor]").boundingBox())!;
  await drag(
    page,
    { x: image.x + image.width * 0.2, y: image.y + image.height * 0.3 },
    { x: image.x + image.width * 0.5, y: image.y + image.height * 0.6 },
  );
  await expect(window.locator("[data-mark-row]")).toHaveCount(1);
  // The list beside the stage leaves out the lines sent with the prompt.
  await expect(window.getByText("Sent with your prompt")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await window.getByRole("button", { name: "Save marks" }).click();
  await expect(window).toBeHidden();

  // The node: Mask input hidden, Edit marks beside Run, and its settings list the mark.
  await expect(handleOf(page, aliases.e!, "target", "mask")).toHaveCount(0);
  await edit.hover();
  const editMarks = edit.getByRole("button", { name: "Edit marks" });
  await expect(editMarks).toBeVisible();
  // Edit marks (EB0kxH1YLE): h32, radius 8, 0 12 in, 6 between, the pencil at 14.
  expect(await drawn(editMarks)).toMatchObject({
    h: 32,
    radius: "8px",
    gap: "6px",
    padding: "0px 12px 0px 12px",
  });
  expect(await font(editMarks)).toBe("13px 600");
  expect(await editMarks.locator("svg.lucide-pencil").boundingBox()).toMatchObject({ width: 14, height: 14 });
  await expect(settings.getByText("1 mark on the input image")).toBeVisible();
  await expect(settings.locator("[data-mark-row]")).toHaveCount(1);
  await expect(settings.getByText("Sent with your prompt")).toHaveCount(0);
  await expect(settings.getByText(/^Off, so the change can blend in/)).toBeVisible();
  await expect(settings.getByRole("switch", { name: "Keep the rest of the image" })).toHaveAttribute(
    "aria-checked",
    "false",
  );

  // Canvas / Inspector / Image edit / Sketch & point, measured against its nodes.
  const marksCard = settings.locator("div.rounded-14.bg-surface").filter({ hasText: "1 mark on" }).first();
  expect(await drawn(marksCard)).toMatchObject({
    padding: "12px 12px 12px 12px",
    gap: "12px",
    radius: "14px",
  });
  expect(await drawn(marksCard.locator("[data-paint]"))).toMatchObject({ w: 40, h: 40, radius: "8px" });
  const mark = marksCard.getByRole("button", { name: "Mark", exact: true });
  expect(await drawn(mark)).toMatchObject({ h: 32, radius: "8px", gap: "6px", padding: "0px 12px 0px 12px" });
  expect(await mark.locator("svg.lucide-pencil").boundingBox()).toMatchObject({ width: 14, height: 14 });
  const markRow = settings.locator("[data-mark-row]").first();
  expect(await drawn(markRow)).toMatchObject({ padding: "8px 10px 8px 10px", gap: "10px", radius: "10px" });
  expect(await drawn(markRow.locator(".."))).toMatchObject({
    padding: "4px 4px 4px 4px",
    gap: "2px",
    radius: "14px",
  });
  await expect(marksCard.locator("[data-marks-thumb] rect")).toHaveCount(1);

  // Saved on the node: its mode and its mark.
  await expect
    .poll(async () => {
      const saved = await api<CanvasDetail>(request, token, "GET", `/api/canvases/${id}`);
      const node = saved.graph.nodes.find((n) => n.id === aliases.e)!;
      return [node.params.mode, (node.params.marks as unknown[] | undefined)?.length];
    })
    .toEqual(["sketch", 1]);

  // A row opens the window on its mark, its popover open.
  await markRow.click();
  await expect(window).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Mark 1 · Box" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(window).toBeHidden();

  // Run: a sketch edit, no mask.
  await settings.getByRole("button", { name: /^Run/ }).click();
  await expect(edit.getByText("Done").or(edit.locator("img").first())).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      async () => {
        const saved = await api<CanvasDetail>(request, token, "GET", `/api/canvases/${id}`);
        return saved.graph.nodes.find((n) => n.id === aliases.e)?.result?.assetIds.length ?? 0;
      },
      { timeout: 20_000 },
    )
    .toBe(1);
});

test("an Edit node's settings switch to Sketch & point: the wired mask goes, references stay home", async ({
  page,
  request,
}) => {
  const token = await sessionToken(request);
  const photo = await makeImage(request, token, unique("white vases, red berries"), "3:4");
  const mask = await makeImage(request, token, unique("a mask"), "3:4");
  const reference = await makeImage(request, token, unique("a brass kettle"), "1:1");
  const { id, aliases } = await canvasOf(request, "Sketch switch", [
    {
      op: "add_node",
      as: "u",
      type: "image.upload",
      position: { x: 0, y: 0 },
      params: { assetIds: [photo] },
    },
    {
      op: "add_node",
      as: "m",
      type: "image.upload",
      position: { x: 0, y: 420 },
      params: { assetIds: [mask] },
    },
    {
      op: "add_node",
      as: "r",
      type: "image.upload",
      position: { x: 0, y: 840 },
      params: { assetIds: [reference] },
    },
    {
      op: "add_node",
      as: "e",
      type: "image.edit",
      position: { x: 420, y: 0 },
      params: { model: PRO, prompt: "Turn the vase into red brushed steel" },
    },
    { op: "connect", source: "u", sourceHandle: "images", target: "e", targetHandle: "image" },
    { op: "connect", source: "m", sourceHandle: "images", target: "e", targetHandle: "mask" },
    { op: "connect", source: "r", sourceHandle: "images", target: "e", targetHandle: "input_images" },
  ]);
  const savedNode = async () => {
    const saved = await api<CanvasDetail>(request, token, "GET", `/api/canvases/${id}`);
    const node = saved.graph.nodes.find((n) => n.id === aliases.e)!;
    const into = saved.graph.edges.filter((e) => e.target === aliases.e).map((e) => e.targetHandle);
    return { mode: node.params.mode ?? null, into: into.sort() };
  };

  await page.goto(`/canvas/${id}`);
  const edit = nodeOf(page, aliases.e!);
  await expect(edit).toBeVisible();
  await edit.dblclick({ position: { x: 160, y: 40 } });
  const settings = page.getByRole("complementary", { name: "Edit" });
  const modes = settings.getByRole("radiogroup", { name: "How to show the change" });
  await expect(modes).toBeVisible();
  await expect(modes.getByRole("radio", { name: "Paint area" })).toHaveAttribute("aria-checked", "true");
  await expect(settings.getByText("From the Mask input")).toBeVisible();
  await expect(settings.getByRole("button", { name: "Add a reference image" })).toBeVisible();

  // Mode (RIMVE6Wb5c): column, 4 2 in, 8 between, its label 12/500, then the switch at full width:
  // radius 10, 3 in, 4 between, segments h30 radius 8, the picked one 600.
  const field = modes.locator("..");
  const fieldBox = await drawn(field);
  expect(fieldBox).toMatchObject({ padding: "4px 2px 4px 2px", gap: "8px", display: "flex" });
  expect(await font(field.getByText("How to show the change"))).toBe("12px 500");
  const track = await drawn(modes);
  expect(track).toMatchObject({
    radius: "10px",
    padding: "3px 3px 3px 3px",
    gap: "4px",
    h: 36,
    w: fieldBox.w - 4,
  });
  const picked = modes.getByRole("radio", { name: "Paint area" });
  const other = modes.getByRole("radio", { name: "Sketch & point" });
  expect(await drawn(picked)).toMatchObject({ h: 30, radius: "8px" });
  expect(await drawn(other)).toMatchObject({ h: 30, radius: "8px", w: (track.w - 6 - 4) / 2 });
  expect(await font(picked)).toBe("12px 600");
  expect(await font(other)).toBe("12px 500");
  // It comes first, above the Mask card: 12 apart, as the inspector's column.
  const maskCard = settings.locator("div.rounded-14.bg-surface").first();
  expect((await maskCard.boundingBox())!.y - ((await field.boundingBox())!.y + fieldBox.h)).toBeCloseTo(
    12,
    0,
  );

  // Sketch & point: the link into the Mask input goes with it, and the references are left out.
  await other.click();
  await expect(other).toHaveAttribute("aria-checked", "true");
  await expect(handleOf(page, aliases.e!, "target", "mask")).toHaveCount(0);
  await expect(settings.getByText("No marks yet. Add them to point at what to change.")).toBeVisible();
  await expect(settings.getByRole("button", { name: "Add a reference image" })).toHaveCount(0);
  const refs = handleOf(page, aliases.e!, "target", "input_images");
  await expect(refs).toHaveAttribute(
    "aria-label",
    "Reference images ×n. Sketch & point doesn't use reference images",
  );
  await expect(refs).toHaveClass(/of-port-off/);
  await expect.poll(savedNode).toEqual({ mode: "sketch", into: ["image", "input_images"] });

  // One undo brings back painting and the mask's link together. Keys pressed in the settings never
  // reach the canvas (inspector.tsx), so focus leaves them first.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+z");
  await expect(modes.getByRole("radio", { name: "Paint area" })).toHaveAttribute("aria-checked", "true");
  await expect(handleOf(page, aliases.e!, "target", "mask")).toHaveCount(1);
  await expect(settings.getByRole("button", { name: "Add a reference image" })).toBeVisible();
  await expect.poll(savedNode).toEqual({ mode: null, into: ["image", "input_images", "mask"] });

  // Again, then run: the prompt alone, on the image alone.
  await other.click();
  await expect.poll(savedNode).toEqual({ mode: "sketch", into: ["image", "input_images"] });
  await settings.getByRole("button", { name: /^Run/ }).click();
  await expect
    .poll(
      async () => {
        const saved = await api<CanvasDetail>(request, token, "GET", `/api/canvases/${id}`);
        return saved.graph.nodes.find((n) => n.id === aliases.e)?.result?.assetIds.length ?? 0;
      },
      { timeout: 20_000 },
    )
    .toBe(1);

  // Painting again from the switch lets Sketch & point's settings go.
  await modes.getByRole("radio", { name: "Paint area" }).click();
  await expect.poll(savedNode).toEqual({ mode: null, into: ["image", "input_images"] });
  await expect(handleOf(page, aliases.e!, "target", "mask")).toHaveCount(1);
});
