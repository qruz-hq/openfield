import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, makeImage, sessionToken } from "./support";

// The detail view's Edit tab (§4.6, design "Image edit"): paint a mask over an image with the
// brush, eraser, lasso and rectangle, undo and redo it, and never lose it without asking.

let runs = 0;
const unique = (name: string) => `${name} ${Date.now().toString(36)}${runs++}`;

const detail = (page: Page) => page.getByRole("dialog", { name: "Image details" });
const toolbar = (page: Page) => page.getByRole("toolbar", { name: "Mask tools" });
const tool = (page: Page, name: string) => toolbar(page).getByRole("button", { name, exact: true });
const maskLayer = (page: Page) => page.locator("[data-mask-layer]");

/** The tint's alpha at a point given as fractions of the image, 0 where nothing is painted. */
async function tintAt(page: Page, fx: number, fy: number): Promise<number> {
  return maskLayer(page).evaluate(
    (canvas: HTMLCanvasElement, [x, y]) => {
      const context = canvas.getContext("2d")!;
      return context.getImageData(Math.floor(canvas.width * x!), Math.floor(canvas.height * y!), 1, 1)
        .data[3]!;
    },
    [fx, fy],
  );
}

/** A point on the image, as fractions of its box on screen. */
async function at(layer: Locator, fx: number, fy: number) {
  const box = (await layer.boundingBox())!;
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

async function openOnEdit(page: Page, prompt: string): Promise<string> {
  const token = await sessionToken(page.request);
  const id = await makeImage(page.request, token, prompt);
  await page.goto(`/assets?asset=${id}`);
  await expect(detail(page)).toContainText(prompt);
  return id;
}

test("the Edit tab paints a mask, and its tools undo, redo, invert and clear it", async ({ page }) => {
  const prompt = unique("berries in a vase");
  const id = await openOnEdit(page, prompt);
  const view = detail(page);

  // Info and Edit, with Edit in the URL beside the image.
  await expect(view.getByRole("tab", { name: "Info" })).toHaveAttribute("aria-selected", "true");
  await view.getByRole("tab", { name: "Edit" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?asset=${id}&tab=edit$`));
  await expect(view.getByRole("button", { name: "Next image" })).toHaveCount(0);

  // Nothing painted yet: Clear, Undo and Redo are dimmed, and the brush is in hand.
  await expect(tool(page, "Brush")).toHaveAttribute("aria-pressed", "true");
  await expect(tool(page, "Clear the mask")).toBeDisabled();
  await expect(tool(page, "Undo")).toBeDisabled();
  await expect(tool(page, "Redo")).toBeDisabled();
  await expect(view.getByText("Paint over the part you want to change.")).toBeVisible();
  await expect(view.getByRole("group", { name: "Brush options" }).getByText(/^\d+ px$/)).toBeVisible();

  // A stroke across the middle.
  const layer = maskLayer(page);
  await drag(page, await at(layer, 0.3, 0.5), await at(layer, 0.7, 0.5));
  await expect.poll(() => tintAt(page, 0.5, 0.5)).toBe(255);
  expect(await tintAt(page, 0.5, 0.1)).toBe(0);
  await expect(tool(page, "Undo")).toBeEnabled();
  await expect(tool(page, "Clear the mask")).toBeEnabled();
  await expect(view.getByText("Describe the change.")).toBeVisible();

  // ⌘Z and ⇧⌘Z, and the toolbar's own buttons.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => tintAt(page, 0.5, 0.5)).toBe(0);
  await expect(tool(page, "Redo")).toBeEnabled();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(() => tintAt(page, 0.5, 0.5)).toBe(255);

  // The eraser takes part of it back.
  await page.keyboard.press("e");
  await expect(tool(page, "Eraser")).toHaveAttribute("aria-pressed", "true");
  await drag(page, await at(layer, 0.45, 0.5), await at(layer, 0.55, 0.5));
  await expect.poll(() => tintAt(page, 0.5, 0.5)).toBe(0);
  expect(await tintAt(page, 0.35, 0.5)).toBe(255);

  // A lasso placed by clicks, closed with a double-click.
  await page.keyboard.press("a");
  await expect(view.getByText("Drag to draw, or click to add points. Double-click to close.")).toBeVisible();
  await page.mouse.click(...xy(await at(layer, 0.1, 0.1)));
  await page.mouse.click(...xy(await at(layer, 0.3, 0.1)));
  await page.mouse.click(...xy(await at(layer, 0.3, 0.3)));
  await page.mouse.dblclick(...xy(await at(layer, 0.1, 0.3)));
  await expect.poll(() => tintAt(page, 0.2, 0.2)).toBe(255);

  // A box.
  await page.keyboard.press("m");
  await expect(view.getByText("Drag to draw a box.")).toBeVisible();
  await drag(page, await at(layer, 0.6, 0.7), await at(layer, 0.9, 0.9));
  await expect.poll(() => tintAt(page, 0.75, 0.8)).toBe(255);

  // Invert, then clear.
  await tool(page, "Invert").click();
  await expect.poll(() => tintAt(page, 0.5, 0.05)).toBe(255);
  expect(await tintAt(page, 0.75, 0.8)).toBe(0);
  await tool(page, "Clear the mask").click();
  await expect.poll(() => tintAt(page, 0.5, 0.05)).toBe(0);
  await expect(tool(page, "Clear the mask")).toBeDisabled();

  // Back on Info and on to Edit again, the edit is still there to undo.
  await view.getByRole("tab", { name: "Info" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?asset=${id}$`));
  await expect(toolbar(page)).toHaveCount(0);
  await view.getByRole("tab", { name: "Edit" }).click();
  await expect(toolbar(page)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => tintAt(page, 0.5, 0.05)).toBe(255);
});

test("on Edit the view's own keys stay quiet, and Esc drops the tool before it asks to leave", async ({
  page,
}) => {
  const prompt = unique("white vases");
  const id = await openOnEdit(page, prompt);
  const view = detail(page);
  const token = await sessionToken(page.request);

  // A reload on ?tab=edit opens on Edit.
  await page.goto(`/assets?asset=${id}&tab=edit`);
  await expect(toolbar(page)).toBeVisible();

  // F would favourite and D download on Info; here F does nothing and D is the brush.
  await page.keyboard.press("h");
  await expect(tool(page, "Pan")).toHaveAttribute("aria-pressed", "true");
  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });
  await page.keyboard.press("f");
  await page.keyboard.press("d");
  await expect(tool(page, "Brush")).toHaveAttribute("aria-pressed", "true");
  const asset = await api<{ isFavourite: boolean }>(page.request, token, "GET", `/api/assets/${id}`);
  expect(asset.isFavourite).toBe(false);
  expect(downloaded).toBe(false);

  // Space held pans the image whatever the tool, and painting while it's held paints nothing.
  const layer = maskLayer(page);
  const before = (await layer.boundingBox())!;
  await page.keyboard.down("Space");
  await drag(page, await at(layer, 0.5, 0.5), await at(layer, 0.6, 0.5));
  await page.keyboard.up("Space");
  const after = (await layer.boundingBox())!;
  expect(after.x).toBeGreaterThan(before.x + 10);
  await expect(tool(page, "Undo")).toBeDisabled();

  // Esc with the box picked puts the brush back, and a clean edit then closes on the next Esc.
  await page.keyboard.press("m");
  await page.keyboard.press("Escape");
  await expect(tool(page, "Brush")).toHaveAttribute("aria-pressed", "true");
  await expect(view).toBeVisible();

  // With a mask, Esc asks first. Keep editing keeps it; Leave closes the view.
  await drag(page, await at(layer, 0.3, 0.3), await at(layer, 0.6, 0.6));
  await expect(tool(page, "Undo")).toBeEnabled();
  await page.keyboard.press("Escape");
  const leave = page.getByRole("alertdialog", { name: "Leave this edit?" });
  await expect(leave).toContainText("Your mask and prompt will be lost.");
  await leave.getByRole("button", { name: "Keep editing" }).click();
  await expect(leave).toHaveCount(0);
  await expect(tool(page, "Undo")).toBeEnabled();

  // The close button asks too.
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(view).toHaveCount(0);
  await expect(page).toHaveURL(/\/assets$/);

  // Opened again, the edit starts afresh, and a clean one closes on a single Esc.
  await page.goto(`/assets?asset=${id}&tab=edit`);
  await expect(tool(page, "Undo")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
});

const xy = (p: { x: number; y: number }) => [p.x, p.y] as const;
