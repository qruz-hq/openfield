import { expect, type Locator, type Page, type Request, test } from "@playwright/test";
import { newId } from "../packages/core/src/ids.ts";
import { api, FAKE_KEY, makeImage, sessionToken } from "./support";

// The detail view's Layers tab (design YuFQEjr0TW and its states), a layer on its own (lyJVqwC6sG)
// and the Info tab's LAYERS block (A4sok9IYIV), against the fake BytePlus: a base and three layers
// named "Layer 1" to "Layer 3", bottom up.

test.describe.configure({ mode: "serial" });
// The design is drawn in the dark theme.
test.use({ colorScheme: "dark" });

const PRO = "byteplus:dola-seedream-5-0-pro-260628";

interface Stack {
  runId: string;
  layers: { asset: { id: string }; role: "base" | "layer"; name: string | null }[];
}

const unique = (words: string) => `${words} ${Date.now().toString(36)}`;

/** A fresh image to split, with the BytePlus key in place. */
async function source(page: Page): Promise<{ token: string; id: string }> {
  const token = await sessionToken(page.request);
  const id = await makeImage(page.request, token, unique("a still life"));
  await api(page.request, token, "PUT", "/api/settings/keys/byteplus", { apiKey: FAKE_KEY });
  return { token, id };
}

/** Splits an image through the API and waits for its stack. */
async function split(page: Page, token: string, image: string): Promise<Stack> {
  const accepted = await api<{ jobSet: { id: string } }>(page.request, token, "POST", "/api/layers", {
    idempotencyKey: newId(),
    model: PRO,
    image,
    size: "1K",
  });
  await expect
    .poll(
      async () => {
        const sets = await api<{ items: { jobSet: { id: string; status: string } }[] }>(
          page.request,
          token,
          "GET",
          "/api/job-sets?status=all",
        );
        return sets.items.find((s) => s.jobSet.id === accepted.jobSet.id)?.jobSet.status;
      },
      { timeout: 20_000 },
    )
    .toBe("succeeded");
  return api<Stack>(page.request, token, "GET", `/api/layers/${accepted.jobSet.id}`);
}

const idOf = (stack: Stack, name: string | null) =>
  stack.layers.find((l) => (name === null ? l.role === "base" : l.name === name))!.asset.id;

/** What the browser drew, for comparing against the design's node values. */
const drawn = (el: Locator) =>
  el.evaluate((node) => {
    const s = getComputedStyle(node);
    const r = node.getBoundingClientRect();
    // Tailwind's /10 colours compute as oklab(); mixed into sRGB they read back as plain numbers.
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
      w: Math.round(r.width),
      h: Math.round(r.height),
      radius: s.borderTopLeftRadius,
      padding: `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`,
      // Along the main axis, as a node's gap is.
      gap: s.flexDirection === "column" ? s.rowGap : s.columnGap,
      direction: s.flexDirection,
      justify: s.justifyContent,
      align: s.alignItems,
      background: paint(s.backgroundColor),
      opacity: s.opacity,
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
    return `${family} ${s.fontSize}/${s.lineHeight} ${s.fontWeight} ${s.color}`;
  });

const icon = (el: Locator) =>
  el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return `${r.width}x${r.height} ${node.getAttribute("class")?.match(/lucide-[a-z0-9-]+/)?.[0]}`;
  });

/** Waits out the view's opening animation, so boxes are measured at their full size. */
const settled = (page: Page) =>
  page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) => a.effect?.getTiming().iterations === Number.POSITIVE_INFINITY || a.playState !== "running",
      ),
  );

const SURFACE = "rgb(14, 16, 18)";
const ELEVATED = "rgb(32, 35, 39)";
const ACCENT = "rgb(233, 227, 216)";

/** The rows of the stack, top first, by name. */
const rowNames = (list: Locator) =>
  list.locator("li").evaluateAll((items) => items.map((li) => li.querySelector(".truncate")?.textContent));

const isPost = (path: RegExp) => (request: Request) =>
  request.method() === "POST" && path.test(new URL(request.url()).pathname);

test("an image splits from the Layers tab: Start, Separating, then the stack", async ({ page }) => {
  const { token, id } = await source(page);

  // Hold the split's request, so the Separating state stays long enough to measure.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sent: Record<string, unknown> | undefined;
  await page.route("**/api/layers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    sent = route.request().postDataJSON();
    await held;
    await route.continue();
  });

  await page.goto(`/assets?asset=${id}&tab=layers`);
  const dialog = page.getByRole("dialog", { name: "Image details" });
  const panel = dialog.getByRole("tabpanel", { name: "Layers" });
  await expect(panel.getByText("Split into layers")).toBeVisible({ timeout: 15_000 });

  // Start (Y9i4rJZWjE)
  await settled(page);
  const column = await drawn(panel);
  console.log("Layers column", JSON.stringify(column));
  expect(column).toMatchObject({ w: 328, gap: "12px", direction: "column" });
  const intro = panel.getByText("Split into layers").locator("../..");
  expect(await drawn(intro)).toMatchObject({
    radius: "14px",
    padding: "14px 14px 14px 14px",
    gap: "6px",
    background: SURFACE,
  });
  expect(await icon(intro.locator("svg"))).toBe("16x16 lucide-layers");
  expect(await font(panel.getByText("Split into layers"))).toMatch(/^Inter 13px\/\S+ 600 /);
  expect(await font(intro.locator("p"))).toMatch(/^Inter 12px\/17\.4px 400 /);

  const what = panel.getByRole("textbox", { name: "What to separate" });
  // The shared Input draws its box round the bare <input>.
  expect(await drawn(what.locator(".."))).toMatchObject({
    h: 38,
    radius: "10px",
    padding: "0px 12px 0px 12px",
    background: SURFACE,
  });
  expect(await font(what)).toMatch(/^Inter 13px\/\S+ 400 /);
  const picker = panel.getByRole("button", { name: "Model" });
  const pickerBox = await drawn(picker);
  console.log("Model select", JSON.stringify(pickerBox));
  expect(pickerBox).toMatchObject({
    h: 38,
    radius: "10px",
    padding: "0px 12px 0px 12px",
    justify: "space-between",
  });
  expect(await icon(picker.locator("svg.lucide-chevron-down"))).toBe("14x14 lucide-chevron-down");

  const auto = panel.getByRole("radio", { name: "Auto" });
  await expect(auto).toHaveAttribute("aria-checked", "true");
  const segmented = auto.locator("..");
  expect(await drawn(segmented)).toMatchObject({
    radius: "10px",
    padding: "3px 3px 3px 3px",
    gap: "4px",
    background: SURFACE,
  });
  expect(await drawn(auto)).toMatchObject({ h: 30, radius: "8px", background: ELEVATED });
  expect(await font(auto)).toMatch(/^Inter 12px\/\S+ 600 /);
  expect(await font(panel.getByRole("radio", { name: "1K" }))).toMatch(/^Inter 12px\/\S+ 500 /);
  await panel.getByRole("radio", { name: "1K" }).click();
  await expect(panel.getByText("The layers come out at 1K, in the image's shape.")).toBeVisible();

  const price = panel.getByText("Base image").locator("../..");
  expect(await drawn(price)).toMatchObject({
    radius: "14px",
    padding: "12px 12px 12px 12px",
    gap: "8px",
    background: SURFACE,
  });
  expect(await font(panel.getByText("Base image"))).toMatch(/^Inter 13px\/\S+ 400 /);
  expect(await font(panel.getByText("Up to 16 layers").locator("+ span"))).toMatch(
    /^JetBrains Mono 12px\/\S+ 400 rgb\(245, 246, 247\)/,
  );

  const separate = panel.getByRole("button", { name: /^Separate layers/ });
  const button = await drawn(separate);
  console.log("Separate", JSON.stringify(button));
  expect(button).toMatchObject({ h: 40, radius: "10px", gap: "8px", background: ACCENT });
  expect(button.padding).toMatch(/^0px 16px 0px 16px$/);
  expect(await font(separate)).toMatch(/^Inter 14px\/\S+ 600 rgb\(20, 22, 26\)/);

  // Separating (xYNaPyLK2h)
  await separate.click();
  const progress = panel.getByRole("status").filter({ hasText: "Separating layers" });
  await expect(progress).toBeVisible();
  expect(await drawn(progress)).toMatchObject({
    radius: "14px",
    padding: "14px 14px 14px 14px",
    gap: "10px",
    background: SURFACE,
  });
  expect(await drawn(intro)).toMatchObject({ opacity: "0.5" });
  expect(await drawn(price)).toMatchObject({ opacity: "0.5" });
  const scan = dialog.locator(".layers-scan");
  const band = await drawn(scan);
  console.log("Scan band", JSON.stringify(band));
  expect(band.h).toBeGreaterThan(0);
  expect(band.display).not.toBe("none");
  expect(band.background).toBe("rgba(233, 227, 216, 0.10)");

  release();
  expect(sent).toMatchObject({ model: PRO, image: id, size: "1K", source: "detail_editor" });
  expect(sent).not.toHaveProperty("prompt");

  // Done (SG1CFJi1oP)
  await expect(panel.getByText("3 layers and a base")).toBeVisible({ timeout: 20_000 });
  await expect(scan).toHaveCount(0);
  await expect(panel.getByText(/^Seedream .* · \$/)).toBeVisible();
  const list = panel.getByRole("list", { name: "Layers, top first" });
  await expect.poll(() => rowNames(list)).toEqual(["Layer 3", "Layer 2", "Layer 1", "Base"]);
  expect(await drawn(list)).toMatchObject({
    radius: "14px",
    padding: "4px 4px 4px 4px",
    gap: "2px",
    background: SURFACE,
  });
  const row = (name: string) => list.locator("[data-layer-row]").filter({ hasText: name });
  const rowBox = await drawn(row("Layer 2"));
  console.log("Layer row", JSON.stringify(rowBox));
  expect(rowBox).toMatchObject({ radius: "10px", padding: "6px 8px 6px 8px", gap: "10px", align: "center" });
  expect(await icon(row("Layer 2").locator("svg").first())).toBe("14x14 lucide-grip-vertical");
  expect(await icon(list.locator("li").last().locator("svg").first())).toBe("14x14 lucide-lock");
  const eye = list.getByRole("button", { name: "Hide Layer 2" });
  expect(await drawn(eye)).toMatchObject({ w: 28, h: 28, radius: "8px" });
  expect(await icon(eye.locator("svg"))).toBe("16x16 lucide-eye");
  expect(await font(row("Layer 2").getByText("Layer 2", { exact: true }))).toMatch(/^Inter 13px\/\S+ 500 /);
  expect(await font(row("Layer 2").getByText("Part 2 of the picture"))).toMatch(/^Inter 12px\/\S+ 400 /);

  // Selecting a layer shows its actions under it, and its bounds and label over the image.
  const pick = list.getByRole("button", { name: /^Layer 2/, pressed: false });
  await pick.click();
  await expect(list.getByRole("button", { name: /^Layer 2/, pressed: true })).toBeVisible();
  expect(await drawn(row("Layer 2"))).toMatchObject({ background: "rgba(233, 227, 216, 0.08)" });
  const actions = list.getByRole("button", { name: "Edit this layer" }).locator("..");
  expect(await drawn(actions)).toMatchObject({ padding: "2px 8px 8px 8px", gap: "6px" });
  for (const [name, glyph] of [
    ["Edit this layer", "lucide-brush"],
    ["Use as reference", "lucide-image-plus"],
    ["Download", "lucide-download"],
  ] as const) {
    const action = actions.getByRole("button", { name });
    expect(await drawn(action)).toMatchObject({
      h: 32,
      radius: "8px",
      padding: "0px 12px 0px 12px",
      gap: "6px",
      background: ELEVATED,
    });
    expect(await icon(action.locator("svg"))).toBe(`14x14 ${glyph}`);
  }
  const bounds = dialog.getByTestId("layer-bounds");
  const label = dialog.getByTestId("layer-label");
  await expect(label).toHaveText("Layer 2");
  const outline = await drawn(bounds);
  console.log("Layer bounds", JSON.stringify(outline));
  expect(outline).toMatchObject({ radius: "4px", background: "rgba(233, 227, 216, 0.06)" });
  expect(outline.h).toBeGreaterThan(0);
  const tag = await drawn(label);
  expect(tag).toMatchObject({
    h: 24,
    radius: "6px",
    padding: "0px 8px 0px 8px",
    gap: "6px",
    background: ACCENT,
  });
  expect(await icon(label.locator("svg"))).toBe("12x12 lucide-layers-2");
  const [b, l] = [(await bounds.boundingBox())!, (await label.boundingBox())!];
  expect({ left: l.x - b.x, above: b.y - (l.y + l.height) }).toEqual({ left: 0, above: 6 });

  // Hide Layer 1, move Layer 3 below Layer 2.
  await list.getByRole("button", { name: "Hide Layer 1" }).click();
  await expect(list.getByRole("button", { name: "Show Layer 1" })).toHaveAttribute("aria-pressed", "false");
  expect(await icon(list.getByRole("button", { name: "Show Layer 1" }).locator("svg"))).toBe(
    "16x16 lucide-eye-off",
  );
  await list.getByRole("button", { name: /^Move Layer 3/ }).press("Alt+ArrowDown");
  await expect.poll(() => rowNames(list)).toEqual(["Layer 2", "Layer 3", "Layer 1", "Base"]);

  // Flatten and the downloads send what's shown, bottom first, without the hidden layer.
  const runId = await runOf(page, token, id);
  const stack = await api<Stack>(page.request, token, "GET", `/api/layers/${runId}`);
  const shown = [
    { assetId: idOf(stack, null) },
    { assetId: idOf(stack, "Layer 3") },
    { assetId: idOf(stack, "Layer 2") },
  ];

  await settled(page);
  const footer = panel
    .getByText("Each layer is saved to your library, linked to this image.")
    .locator("../..");
  expect(await drawn(footer)).toMatchObject({ gap: "8px", direction: "column", justify: "flex-end" });
  const zip = panel.getByRole("button", { name: "PNGs (ZIP)" });
  expect(await drawn(zip)).toMatchObject({
    h: 40,
    radius: "8px",
    padding: "0px 12px 0px 12px",
    gap: "6px",
    background: ELEVATED,
  });
  expect(await icon(zip.locator("svg"))).toBe("14x14 lucide-file-archive");
  const flatten = panel.getByRole("button", { name: "Flatten into a new image" });
  expect(await drawn(flatten)).toMatchObject({ h: 40, radius: "10px", gap: "8px", background: ACCENT });
  expect(await icon(flatten.locator("svg"))).toBe("16x16 lucide-combine");

  const flattening = page.waitForRequest(isPost(/\/api\/layers\/[^/]+\/flatten$/));
  await flatten.click();
  expect((await flattening).postDataJSON()).toEqual({ layers: shown });
  await expect(page.getByText("Saved as a new image.")).toBeVisible();

  for (const [name, format] of [
    ["PNGs (ZIP)", "zip"],
    ["PSD", "psd"],
  ] as const) {
    const exporting = page.waitForRequest(isPost(/\/api\/layers\/[^/]+\/export$/));
    const download = page.waitForEvent("download");
    await panel.getByRole("button", { name, exact: true }).click();
    expect((await exporting).postDataJSON()).toEqual({ layers: shown, format });
    expect((await download).suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));
  }
});

/** The run that split this image, from its details. */
async function runOf(page: Page, token: string, id: string): Promise<string> {
  const detail = await api<{ lineage: { children: { jobSetId: string | null; op: string }[] } }>(
    page.request,
    token,
    "GET",
    `/api/assets/${id}`,
  );
  return detail.lineage.children.find((c) => c.op === "decompose")!.jobSetId!;
}

test("a split that fails says so, and Try again splits it", async ({ page }) => {
  const { id } = await source(page);
  await page.goto(`/assets?asset=${id}&tab=layers`);
  const panel = page.getByRole("dialog", { name: "Image details" }).getByRole("tabpanel", { name: "Layers" });
  const what = panel.getByRole("textbox", { name: "What to separate" });
  await what.fill("the vases #fake:failed");
  await panel.getByRole("button", { name: /^Separate layers/ }).click();

  // Failed (Gq0Rg9cTl3)
  const alert = panel.getByRole("alert");
  await expect(alert).toHaveText("Couldn't split this image into layers. You weren't charged.", {
    timeout: 20_000,
  });
  const box = await drawn(alert);
  console.log("Failed", JSON.stringify(box));
  expect(box).toMatchObject({
    radius: "10px",
    padding: "10px 12px 10px 12px",
    gap: "10px",
    align: "flex-start",
    background: "rgba(243, 90, 97, 0.14)",
  });
  expect(await icon(alert.locator("svg"))).toBe("16x16 lucide-triangle-alert");
  expect(await font(alert.locator("p"))).toMatch(/^Inter 13px\/18\.85px 400 rgb\(245, 246, 247\)/);
  const again = panel.getByRole("button", { name: /^Try again/ });
  await expect(again).toBeVisible();

  await what.fill("the vases");
  await again.click();
  await expect(panel.getByText("3 layers and a base")).toBeVisible({ timeout: 20_000 });
  await expect(alert).toHaveCount(0);
});

test("a layer on its own: where it sits, what it was split from, and its own actions", async ({ page }) => {
  const { token, id } = await source(page);
  const stack = await split(page, token, id);
  const layer = idOf(stack, "Layer 2");
  await page.goto(`/assets?asset=${layer}`);
  const dialog = page.getByRole("dialog", { name: "Image details" });

  // Info and Edit only: a layer isn't split again.
  await expect(dialog.getByRole("tab")).toHaveText(["Info", "Edit"], { timeout: 15_000 });
  await settled(page);
  await expect(dialog.locator(".text-body-strong").first()).toHaveText("Layer 2");

  // Media: the stack's square canvas, with the layer at its box.
  const canvas = await drawn(dialog.locator(".bg-\\[\\#1b1d21\\]"));
  console.log("Layer canvas", JSON.stringify(canvas));
  expect(canvas).toMatchObject({ radius: "4px", background: "rgb(27, 29, 33)" });
  expect(Math.abs(canvas.w - canvas.h)).toBeLessThanOrEqual(1);

  // Layers from, in Prompt's place.
  const from = dialog.getByText("Layers from", { exact: true }).locator("../..");
  expect(await drawn(from)).toMatchObject({ padding: "12px 12px 12px 12px", gap: "8px" });
  await expect(from.getByText("Layer 2 of 3 · Layer 2")).toBeVisible();
  await expect(from.getByText("Part 2 of the picture", { exact: true })).toBeVisible();
  expect(await font(from.getByText("Part 2 of the picture", { exact: true }))).toMatch(
    /^Inter 13px\/18\.85px 400 rgba\(245, 246, 247, 0\.62\)/,
  );
  expect(await drawn(from.getByRole("button", { name: "Open", exact: true }))).toMatchObject({ h: 32 });
  const all = from.getByRole("button", { name: "Open all layers" });
  expect(await drawn(all)).toMatchObject({ h: 40, radius: "10px" });
  expect(await icon(all.locator("svg"))).toBe("15x15 lucide-layers");
  await expect(dialog.getByText(/^\d+ × \d+ · PNG$/)).toBeVisible();

  // Its own actions: no Recreate or Reuse, since a layer has no prompt of its own to run again.
  await expect(dialog.getByRole("button", { name: "Recreate" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Reuse" })).toHaveCount(0);
  const edit = dialog.getByRole("button", { name: "Edit this layer" });
  expect(await drawn(edit)).toMatchObject({ h: 40, background: ACCENT });
  expect(await icon(edit.locator("svg"))).toBe("16x16 lucide-pencil");
  expect(await icon(dialog.getByRole("button", { name: "Use as reference" }).locator("svg"))).toBe(
    "15x15 lucide-image",
  );

  await all.click();
  await expect(page).toHaveURL(new RegExp(`[?&]asset=${id}(&|$)`));
  await expect(page).toHaveURL(/[?&]tab=layers(&|$)/);
  await expect(dialog.getByText("3 layers and a base")).toBeVisible();
});

test("the split image's Info tab lists its layers and opens them", async ({ page }) => {
  const { token, id } = await source(page);
  await split(page, token, id);
  await page.goto(`/assets?asset=${id}`);
  const dialog = page.getByRole("dialog", { name: "Image details" });
  const section = dialog.getByText("3 and a base").locator("../..");
  await expect(section).toBeVisible({ timeout: 15_000 });
  await settled(page);
  expect(await drawn(section)).toMatchObject({ padding: "12px 12px 12px 12px", gap: "10px" });

  const thumbs = section.getByRole("button", { name: /^Open Layer|^Open Base/ });
  await expect(thumbs).toHaveCount(4);
  const thumb = await drawn(thumbs.first());
  expect(thumb).toMatchObject({ w: 54, h: 54, radius: "8px", background: ELEVATED });
  expect(await drawn(thumbs.first().locator("..")).then((s) => s.gap)).toBe("6px");

  const open = section.getByRole("button", { name: "Open in Layers" });
  expect(await drawn(open)).toMatchObject({ h: 40, radius: "10px" });
  await open.click();
  await expect(page).toHaveURL(/[?&]tab=layers(&|$)/);
  await expect(dialog.getByText("3 layers and a base")).toBeVisible();

  // A thumb opens that layer.
  await dialog.getByRole("tab", { name: "Info" }).click();
  await thumbs.first().click();
  await expect(dialog.getByText("Layer 1 of 3 · Layer 3")).toBeVisible();
});
