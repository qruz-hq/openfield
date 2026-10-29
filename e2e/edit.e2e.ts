import { inflateSync } from "node:zlib";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, FAKE_KEY, makeImage, SESSION_HEADER, sessionToken } from "./support";

// The detail view's Edit tab (§4.6, design "Image edit"): paint a mask over an image with the
// brush, eraser, lasso and rectangle, undo and redo it, and never lose it without asking. Then run
// the edit on the fake models: its price on Generate, the mask PNG it uploads, the monthly limit,
// the new image in the results strip and the feed, linked to the image and its mask, comparing it
// with the original, a run that fails, and a phone photo that can't take a mask.

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

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tile = (page: Page, prompt: string) =>
  page.getByRole("listitem", { name: new RegExp(`^${escapeRegExp(prompt)} · `) });

test("Edit opens the Edit tab from a feed tile, at every zoom step, the library's menu and the footer", async ({
  page,
}) => {
  const token = await sessionToken(page.request);
  const prompt = unique("a quiet still life");
  const id = await makeImage(page.request, token, prompt);
  const view = detail(page);
  const onEdit = new RegExp(`\\?asset=${id}&tab=edit$`);

  // The tile's hover: Edit at the bottom left, the model's name after it.
  await page.goto("/image");
  await expect(tile(page, prompt).locator("img")).toBeVisible({ timeout: 15_000 });
  await tile(page, prompt).hover();
  const edit = tile(page, prompt).getByRole("button", { name: "Edit", exact: true });
  await expect(edit).toHaveText("Edit");
  const box = (await edit.boundingBox())!;
  const tileBox = (await tile(page, prompt).boundingBox())!;
  expect(box.x - tileBox.x).toBeCloseTo(10, 0);
  expect(tileBox.y + tileBox.height - (box.y + box.height)).toBeCloseTo(10, 0);
  await edit.click();
  await expect(page).toHaveURL(onEdit);
  await expect(view.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
  await expect(toolbar(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);

  // At the smallest step the buttons are 32 and Edit is an icon, with no caption beside it.
  await api(page.request, token, "PATCH", "/api/settings", { feedZoom: 0 });
  try {
    await page.reload();
    await expect(tile(page, prompt).locator("img")).toBeVisible({ timeout: 15_000 });
    await tile(page, prompt).hover();
    const icon = tile(page, prompt).getByRole("button", { name: "Edit", exact: true });
    await expect(icon).toHaveText("");
    expect((await icon.boundingBox())!.width).toBe(32);
    expect((await tile(page, prompt).getByRole("button", { name: "Download" }).boundingBox())!.width).toBe(
      32,
    );
    await icon.click();
    await expect(page).toHaveURL(onEdit);
    await page.keyboard.press("Escape");
  } finally {
    await api(page.request, token, "PATCH", "/api/settings", { feedZoom: 3 });
  }

  // The library card's menu has it after Reuse.
  await page.goto("/assets");
  const card = page.getByRole("gridcell", { name: new RegExp(`^${escapeRegExp(prompt)} · `) });
  await card.hover();
  await card.getByRole("button", { name: "More" }).click();
  const items = await page.getByRole("menuitem").allInnerTexts();
  expect(items.indexOf("Edit")).toBe(items.indexOf("Reuse") + 1);
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page).toHaveURL(onEdit);

  // On Info, the footer's Edit beside Recreate goes to the Edit tab.
  await view.getByRole("tab", { name: "Info" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?asset=${id}$`));
  await view.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page).toHaveURL(onEdit);
  await expect(toolbar(page)).toBeVisible();
});

test("an uploaded photo says so: no prompt to recreate, and Edit stays on", async ({ page }) => {
  const token = await sessionToken(page.request);
  await page.goto("/assets");
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 128;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#e8d4d0";
    context.fillRect(0, 0, 96, 128);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  const res = await page.request.post("/api/uploads", {
    headers: { [SESSION_HEADER]: token },
    multipart: {
      file: { name: "IMG_2210.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") },
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const { asset } = (await res.json()) as { asset: { id: string } };

  await page.goto(`/assets?asset=${asset.id}`);
  const view = detail(page);
  const info = view.getByRole("tabpanel", { name: "Info" });
  await expect(view.getByText(/^Added /)).toBeVisible();
  await expect(info.getByText("Prompt", { exact: true })).toHaveCount(0);
  await expect(info.getByRole("definition").first()).toHaveText("Uploaded");
  await expect(info.getByRole("term").first()).toHaveText("Source");

  // Recreate and Reuse rest, and Recreate says why; Edit beside it goes to the Edit tab.
  const recreate = info.getByRole("button", { name: /^Recreate/ });
  await expect(recreate).toHaveAttribute("aria-disabled", "true");
  await expect(info.getByRole("button", { name: "Reuse" })).toHaveAttribute("aria-disabled", "true");
  await recreate.hover();
  await expect(page.getByRole("tooltip")).toHaveText("You uploaded this, so there's no prompt to recreate.");
  await info.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`\\?asset=${asset.id}&tab=edit$`));
  await expect(toolbar(page)).toBeVisible();
});

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
  const spacePans = async () => {
    const before = (await layer.boundingBox())!;
    await page.keyboard.down("Space");
    await drag(page, await at(layer, 0.5, 0.5), await at(layer, 0.6, 0.5));
    await page.keyboard.up("Space");
    const after = (await layer.boundingBox())!;
    expect(after.x).toBeGreaterThan(before.x + 10);
    await expect(tool(page, "Undo")).toBeDisabled();
  };
  await spacePans();
  // Also right after the Edit tab is clicked, or a slider is dragged, which keep focus.
  await view.getByRole("tab", { name: "Info" }).click();
  await view.getByRole("tab", { name: "Edit" }).click();
  await spacePans();
  const size = view.getByRole("slider", { name: "Size" });
  await expect(size).toHaveAttribute("aria-valuetext", /^\d+ px$/);
  const track = (await size.boundingBox())!;
  await drag(
    page,
    { x: track.x + track.width / 2, y: track.y + track.height / 2 },
    {
      x: track.x + track.width / 2 + 6,
      y: track.y + track.height / 2,
    },
  );
  await expect(size).toBeFocused();
  await spacePans();

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
  // Focus is back in the view, so its keys still work.
  await expect(view).toBeFocused();
  await page.keyboard.press("a");
  await expect(tool(page, "Lasso")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(tool(page, "Undo")).toBeDisabled();
  // Undo from the keyboard, until it turns itself off, keeps them working too.
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(tool(page, "Undo")).toBeEnabled();
  await tool(page, "Undo").focus();
  await page.keyboard.press("Enter");
  await expect(tool(page, "Undo")).toBeDisabled();
  await expect(tool(page, "Undo")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(tool(page, "Undo")).toBeEnabled();
  await page.keyboard.press("d");
  await expect(tool(page, "Brush")).toHaveAttribute("aria-pressed", "true");

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

test("Add a key in the model picker asks before it leaves a painted edit", async ({ page }) => {
  const token = await sessionToken(page.request);
  // Only Google's key, so OpenAI's models are listed with Add a key (design 3eiWurzdNj).
  await page.request.delete("/api/settings/keys/openai", { headers: { [SESSION_HEADER]: token } });
  const id = await makeImage(page.request, token, unique("figs"));
  await page.goto(`/assets?asset=${id}&tab=edit`);
  await expect(toolbar(page)).toBeVisible();
  await paintAndDescribe(page, "Dried figs");
  const panel = panelOf(page);
  const addKey = async () => {
    await panel.getByRole("button", { name: "Model" }).click();
    await page.getByRole("option", { name: /GPT Image 2\.5 Sunburst/ }).click();
  };

  // Keep editing keeps the mask and the words.
  await addKey();
  const leave = page.getByRole("alertdialog", { name: "Leave this edit?" });
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?asset=${id}&tab=edit$`));
  expect(await tintAt(page, 0.45, 0.45)).toBe(255);
  await expect(panel.getByRole("textbox", { name: "What to change" })).toHaveValue("Dried figs");

  // Leave goes where the key goes.
  await addKey();
  await leave.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/api-keys$/);
});

const panelOf = (page: Page) => detail(page).getByRole("tabpanel", { name: "Edit" });
const generateIn = (page: Page) => panelOf(page).getByRole("button", { name: /^Generate/ });

/** An image with OpenAI's fake key added too, so models that take a mask are ready. Opened on Edit. */
async function editable(page: Page, prompt: string): Promise<{ id: string; token: string }> {
  const token = await sessionToken(page.request);
  await api(page.request, token, "PUT", "/api/settings/keys/openai", { apiKey: FAKE_KEY });
  const id = await makeImage(page.request, token, prompt);
  await page.goto(`/assets?asset=${id}&tab=edit`);
  await expect(toolbar(page)).toBeVisible();
  return { id, token };
}

/** A box over the middle of the image, then the words. */
async function paintAndDescribe(page: Page, words: string) {
  await page.keyboard.press("m");
  const layer = maskLayer(page);
  await drag(page, await at(layer, 0.3, 0.3), await at(layer, 0.6, 0.6));
  await expect.poll(() => tintAt(page, 0.45, 0.45)).toBe(255);
  await panelOf(page).getByRole("textbox", { name: "What to change" }).fill(words);
}

test("Generate runs the painted edit at its price, and the new image comes from the image and its mask", async ({
  page,
}) => {
  const { id, token } = await editable(page, unique("white vases"));
  const panel = panelOf(page);
  const generate = generateIn(page);

  // Nothing painted: Generate waits and says why, with no price.
  await expect(generate).toBeDisabled();
  await expect(generate).not.toContainText("$");
  await expect(panel.getByText("Paint over the part you want to change.")).toBeVisible();
  await expect(panel.getByText("1:1, same as the image")).toBeVisible();
  await expect(panel.getByText(/^New image keeps the original size, \d+ × \d+\.$/)).toBeVisible();

  // The model picked takes a mask: its group comes first, the whole-image models after.
  await panel.getByRole("button", { name: "Model" }).click();
  const list = page.getByRole("listbox", { name: "Choose model" });
  const text = await list.innerText();
  expect(text.indexOf("Change only what you paint")).toBeGreaterThanOrEqual(0);
  expect(text.indexOf("Change only what you paint")).toBeLessThan(text.indexOf("Redraw the whole image"));
  const picked = (await list.getByRole("option", { selected: true }).innerText()).split("\n")[0]!;
  expect(text.indexOf(picked)).toBeLessThan(text.indexOf("Redraw the whole image"));
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);

  // A box, then the words: Generate shows the price, as the composer does.
  await page.keyboard.press("m");
  const layer = maskLayer(page);
  await drag(page, await at(layer, 0.3, 0.3), await at(layer, 0.6, 0.6));
  await expect(panel.getByText("Describe the change.")).toBeVisible();
  await expect(generate).toBeDisabled();
  await panel.getByRole("textbox", { name: "What to change" }).fill("Make the berries pale and dried");
  await expect(generate).toBeEnabled();
  await expect(generate).toContainText(/~\$\d/);

  // It saves the mask, then asks for the edit with it, kept to the painted area.
  const masks = page.waitForResponse(
    (r) => r.url().endsWith("/api/masks") && r.request().method() === "POST",
  );
  const edits = page.waitForRequest((r) => r.url().endsWith("/api/edit") && r.method() === "POST");
  await generate.click();
  const saved = (await (await masks).json()) as { asset: { id: string } };
  const body = (await edits).postDataJSON() as {
    op: string;
    source: string;
    base: { assetId: string };
    mask: { assetId: string; composite: boolean; featherPx: number; expandPx: number };
  };
  expect(body).toMatchObject({
    op: "inpaint",
    source: "detail_editor",
    base: { assetId: id },
    mask: { assetId: saved.asset.id, composite: true, featherPx: 8, expandPx: 4 },
  });

  // The new image lands in the results strip, and the note says the original is untouched.
  await expect(panel.getByText("Saved as 1 new image. The original stays as it is.")).toBeVisible({
    timeout: 20_000,
  });
  const strip = detail(page).getByRole("group", { name: "New images" });
  await expect(strip.getByRole("button", { name: "Original" })).toBeVisible();
  await expect(strip.getByRole("button", { name: "New image 1" })).toHaveAttribute("aria-pressed", "true");
  await expect(generate).toHaveText(/^Generate again/);
  await expect(panel.getByText("Softens the edge on your next Generate.")).toBeVisible();

  // Generate again sends the same mask by its id.
  const again = page.waitForRequest((r) => r.url().endsWith("/api/edit") && r.method() === "POST");
  let resaved = false;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/masks")) resaved = true;
  });
  await generate.click();
  expect(((await again).postDataJSON() as { mask: { assetId: string } }).mask.assetId).toBe(saved.asset.id);
  expect(resaved).toBe(false);
  await expect(panel.getByText("Saved as 1 new image. The original stays as it is.")).toBeVisible({
    timeout: 20_000,
  });

  // Open new image shows it, nothing lost, and it was made from the image and the mask.
  await panel.getByRole("button", { name: "Open new image" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page).not.toHaveURL(new RegExp(`asset=${id}`));
  const shown = new URL(page.url()).searchParams.get("asset")!;
  const detailOf = await api<{ asset: { parentAssetId: string; maskAssetId: string; op: string } }>(
    page.request,
    token,
    "GET",
    `/api/assets/${shown}`,
  );
  expect(detailOf.asset).toMatchObject({ parentAssetId: id, maskAssetId: saved.asset.id, op: "inpaint" });

  // Its Info says where it came from in place of the prompt: the original, the mask and the words.
  const info = detail(page).getByRole("tabpanel", { name: "Info" });
  await expect(info.getByText("Edited from", { exact: true })).toBeVisible();
  await expect(info.getByText("Prompt", { exact: true })).toHaveCount(0);
  await expect(info.getByText("The original, unchanged")).toBeVisible();
  await expect(info.getByText("Feather 8 px · Expand 4 px")).toBeVisible();
  await expect(info.getByText("Make the berries pale and dried", { exact: true })).toBeVisible();
  await expect(page.locator("[data-mask-thumb]")).toBeVisible();

  // Open shows the original.
  await info.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`\\?asset=${id}$`));

  // Edit the original with this mask: the original on Edit, with the mask painted in and the words.
  await page.goto(`/assets?asset=${shown}`);
  await info.getByRole("button", { name: "Edit the original with this mask" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?asset=${id}&tab=edit$`));
  await expect(
    page.getByText("Your mask and prompt are back. Change anything, then Generate."),
  ).toBeVisible();
  await expect.poll(() => tintAt(page, 0.45, 0.45)).toBe(255);
  expect(await tintAt(page, 0.1, 0.9)).toBe(0);
  await expect(panel.getByRole("textbox", { name: "What to change" })).toHaveValue(
    "Make the berries pale and dried",
  );
  await expect(panel.getByRole("slider", { name: "Feather" })).toHaveAttribute("aria-valuenow", "8");

  // The mask is already saved, so Generate sends it by its id.
  resaved = false;
  const reopened = page.waitForRequest((r) => r.url().endsWith("/api/edit") && r.method() === "POST");
  await generate.click();
  expect(((await reopened).postDataJSON() as { mask: { assetId: string } }).mask.assetId).toBe(
    saved.asset.id,
  );
  expect(resaved).toBe(false);
});

/**
 * A PNG's alpha, decoded here with zlib rather than by the browser that encoded it, so the test
 * checks the bytes the server gets. 8 bits a channel, not interlaced, as a canvas writes it.
 */
function pngAlpha(png: Buffer): { width: number; height: number; alpha: Uint8Array } {
  let width = 0;
  let height = 0;
  let channels = 4;
  const data: Buffer[] = [];
  for (let at = 8; ; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect([body[8], body[12]], "8 bits a channel, not interlaced").toEqual([8, 0]);
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[body[9]!]!;
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  // Each row is a filter byte, then the row as a difference from its left, upper or both.
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const row = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const predicted = [0, a, b, (a + b) >> 1, paeth][filter]!;
      pixels[y * stride + x] = (raw[row + x]! + predicted) & 0xff;
    }
  }
  const alpha = new Uint8Array(width * height).fill(255);
  if (channels === 2 || channels === 4)
    for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * channels + channels - 1]!;
  return { width, height, alpha };
}

/**
 * Keeps what the app posts to /api/masks. Chromium doesn't hand a multipart body holding a file to
 * Playwright (postDataBuffer() is null), so the page's fetch keeps the form it was given.
 */
async function keepMaskUploads(page: Page) {
  await page.addInitScript(() => {
    const send = window.fetch;
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/masks") && init?.body instanceof FormData)
        Object.assign(window, { maskUpload: init.body });
      return send(input, init);
    }) as typeof fetch;
  });
}

/** The last mask the app posted: the image it names and the PNG's bytes. */
async function maskUpload(page: Page): Promise<{ baseAssetId: string; png: Buffer }> {
  await page.waitForFunction(() => "maskUpload" in window);
  const { baseAssetId, base64 } = await page.evaluate(async () => {
    const form = (window as unknown as { maskUpload: FormData }).maskUpload;
    const bytes = new Uint8Array(await (form.get("mask") as File).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { baseAssetId: String(form.get("baseAssetId")), base64: btoa(binary) };
  });
  return { baseAssetId, png: Buffer.from(base64, "base64") };
}

/** Every alpha value in a box given as fractions of the mask: [left, top, right, bottom]. */
function alphasIn(mask: ReturnType<typeof pngAlpha>, [l, t, r, b]: [number, number, number, number]) {
  const seen = new Set<number>();
  for (let y = Math.floor(mask.height * t); y < Math.ceil(mask.height * b); y++)
    for (let x = Math.floor(mask.width * l); x < Math.ceil(mask.width * r); x++)
      seen.add(mask.alpha[y * mask.width + x]!);
  return [...seen].sort((p, q) => p - q);
}

test("from a feed tile: a box and a stroke, the words, the price, and the new image in the strip and the feed", async ({
  page,
}) => {
  const token = await sessionToken(page.request);
  await api(page.request, token, "PUT", "/api/settings/keys/openai", { apiKey: FAKE_KEY });
  const prompt = unique("a linen dress");
  const id = await makeImage(page.request, token, prompt);
  const base = await api<{ asset: { width: number; height: number } }>(
    page.request,
    token,
    "GET",
    `/api/assets/${id}`,
  );
  const view = detail(page);
  const panel = panelOf(page);
  await keepMaskUploads(page);

  // The feed tile's Edit opens the image on the Edit tab.
  await page.goto("/image");
  await expect(tile(page, prompt).locator("img")).toBeVisible({ timeout: 15_000 });
  await tile(page, prompt).hover();
  await tile(page, prompt).getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/image\\?asset=${id}&tab=edit$`));
  await expect(toolbar(page)).toBeVisible();

  // D, E, A and M pick the brush, the eraser, the lasso and the box.
  const tools = { d: "Brush", e: "Eraser", a: "Lasso", m: "Rectangle" };
  for (const [key, name] of Object.entries(tools)) {
    await page.keyboard.press(key);
    for (const other of Object.values(tools))
      await expect(tool(page, other)).toHaveAttribute("aria-pressed", String(other === name));
  }

  // A brush stroke along the bottom right, then a box at the top left.
  const layer = maskLayer(page);
  await page.keyboard.press("d");
  await drag(page, await at(layer, 0.55, 0.75), await at(layer, 0.85, 0.75));
  await expect.poll(() => tintAt(page, 0.7, 0.75)).toBe(255);
  await page.keyboard.press("m");
  await drag(page, await at(layer, 0.1, 0.1), await at(layer, 0.4, 0.4));
  await expect.poll(() => tintAt(page, 0.25, 0.25)).toBe(255);
  expect(await tintAt(page, 0.7, 0.25)).toBe(0);

  // The words, typed: their letters stay in the prompt and leave the box in hand.
  const words = unique("Make the dress deep red");
  await panel.getByRole("textbox", { name: "What to change" }).pressSequentially(words);
  await expect(panel.getByRole("textbox", { name: "What to change" })).toHaveValue(words);
  await expect(tool(page, "Rectangle")).toHaveAttribute("aria-pressed", "true");

  // GPT Image 2.5 Sunburst takes the mask. Medium at 1:1 and 1K is 439 output tokens at $30 per
  // million, and the 768 px image going in counts as 1,024 tokens at $8 per million: about $0.021.
  await expect(panel.getByRole("button", { name: "Model" })).toContainText("GPT Image 2.5 Sunburst");
  const generate = generateIn(page);
  await expect(generate).toHaveText(/^Generate\s*~\$0\.021$/);
  await generate.hover();
  await expect(page.getByRole("tooltip")).toContainText("1 × $0.013 + the image you're editing ($0.008)");

  // The mask goes up as a PNG the image's exact size: alpha 0 where painted, 255 everywhere else.
  const savedMask = page.waitForResponse(
    (r) => r.url().endsWith("/api/masks") && r.request().method() === "POST",
  );
  const edits = page.waitForRequest((r) => r.url().endsWith("/api/edit") && r.method() === "POST");
  await generate.click();
  const upload = await maskUpload(page);
  expect(upload.baseAssetId).toBe(id);
  const mask = pngAlpha(upload.png);
  expect([mask.width, mask.height]).toEqual([base.asset.width, base.asset.height]);
  expect(alphasIn(mask, [0.12, 0.12, 0.38, 0.38]), "inside the box").toEqual([0]);
  expect(alphasIn(mask, [0.58, 0.74, 0.82, 0.76]), "along the stroke").toEqual([0]);
  expect(alphasIn(mask, [0.45, 0, 1, 0.68]), "top right").toEqual([255]);
  expect(alphasIn(mask, [0, 0.45, 0.48, 1]), "bottom left").toEqual([255]);
  expect(alphasIn(mask, [0, 0.84, 1, 1]), "below the stroke").toEqual([255]);

  // The edit runs on Sunburst with that mask, kept to the painted areas.
  const saved = (await (await savedMask).json()) as { asset: { id: string } };
  expect((await edits).postDataJSON()).toMatchObject({
    model: "openai:gpt-image-2.5-sunburst",
    op: "inpaint",
    prompt: words,
    base: { assetId: id },
    mask: { assetId: saved.asset.id, composite: true },
  });

  // The new image is in the results strip, picked and compared with the original.
  await expect(panel.getByText("Saved as 1 new image. The original stays as it is.")).toBeVisible({
    timeout: 20_000,
  });
  const strip = view.getByRole("group", { name: "New images" });
  const made = strip.getByRole("button", { name: "New image 1" });
  await expect(made).toHaveAttribute("aria-pressed", "true");
  await expect(made.locator("img")).toBeVisible();
  await expect(view.getByRole("radiogroup", { name: "Compare" })).toBeVisible();

  // The mask and the words went into the new image, so leaving doesn't ask; then it's in the feed.
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/image$/);
  await expect(tile(page, words).locator("img")).toBeVisible({ timeout: 15_000 });

  // Its tile opens its details, which say it was edited from the image and its mask.
  await tile(page, words)
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(words)} · `) })
    .click();
  const info = view.getByRole("tabpanel", { name: "Info" });
  await expect(info.getByText("Edited from", { exact: true })).toBeVisible();
  await expect(info.getByText(prompt, { exact: true })).toBeVisible();
  await expect(info.getByText("The original, unchanged")).toBeVisible();
  await expect(page.locator("[data-mask-thumb]")).toBeVisible();
  await expect(info.getByText(words, { exact: true })).toBeVisible();
});

/** The Difference view's mark at a point given as fractions of the image: 0 where nothing changed. */
async function changeAt(page: Page, fx: number, fy: number): Promise<number> {
  return page
    .locator("[data-difference][data-ready]")
    .evaluate(
      (canvas: HTMLCanvasElement, [x, y]) =>
        canvas
          .getContext("2d")!
          .getImageData(Math.floor(canvas.width * x!), Math.floor(canvas.height * y!), 1, 1).data[3]!,
      [fx, fy],
    );
}

test("the new image is compared with the original, before and after or by what changed", async ({ page }) => {
  const { id } = await editable(page, unique("dried berries"));
  const view = detail(page);
  await paintAndDescribe(page, "Pale, dried berries");
  await generateIn(page).click();
  await expect(panelOf(page).getByText(/^Saved as 1 new image/)).toBeVisible({ timeout: 20_000 });

  // Before and after takes the toolbar's place, with the handle where the design has it.
  const compare = view.getByRole("radiogroup", { name: "Compare" });
  await expect(compare.getByRole("radio", { name: "Before and after" })).toBeChecked();
  await expect(toolbar(page)).toHaveCount(0);
  await expect(view.getByText("Before", { exact: true })).toBeVisible();
  await expect(view.getByText("After", { exact: true })).toBeVisible();
  const handle = view.getByRole("slider", { name: "Drag to compare" });
  await expect(handle).toHaveAttribute("aria-valuenow", "53");
  const after = page.locator("[data-compare-after]");
  await expect(after).toHaveAttribute("style", /inset\(0px 0px 0px 52\.94/);

  // Dragged left it shows more of the new image; the image under it doesn't pan.
  const image = (await after.boundingBox())!;
  const knob = (await handle.boundingBox())!;
  await drag(
    page,
    { x: knob.x + knob.width / 2, y: knob.y + knob.height / 2 },
    { x: knob.x + knob.width / 2 - image.width * 0.2, y: knob.y + knob.height / 2 },
  );
  await expect(handle).toHaveAttribute("aria-valuenow", "33");
  expect((await after.boundingBox())!.x).toBeCloseTo(image.x, 0);

  // The arrows move it rather than stepping to another image, and the tools' keys rest.
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "44");
  await expect(page).toHaveURL(new RegExp(`\\?asset=${id}&tab=edit$`));
  await page.keyboard.press("e");
  await expect(toolbar(page)).toHaveCount(0);

  // Difference: worked out in a worker, marking the painted box and nothing outside it.
  await compare.getByRole("radio", { name: "Difference" }).click();
  await expect(view.getByText("Changed", { exact: true })).toBeVisible();
  await expect(view.getByText("Same as the original", { exact: true })).toBeVisible();
  await expect.poll(() => changeAt(page, 0.45, 0.45)).toBeGreaterThan(0);
  expect(await changeAt(page, 0.1, 0.9)).toBe(0);
  expect(await changeAt(page, 0.9, 0.1)).toBe(0);
  expect(page.workers().some((worker) => worker.url().includes("difference"))).toBe(true);

  // Edit the mask goes back to painting the original, with the mask and the box still in hand.
  await view.getByRole("button", { name: "Edit the mask" }).click();
  await expect(tool(page, "Rectangle")).toHaveAttribute("aria-pressed", "true");
  await expect(compare).toHaveCount(0);
  const strip = view.getByRole("group", { name: "New images" });
  await expect(strip.getByRole("button", { name: "Original" })).toHaveAttribute("aria-pressed", "true");
  expect(await tintAt(page, 0.45, 0.45)).toBe(255);

  // Picking the new image compares again, as it was left; picking the original paints again.
  await strip.getByRole("button", { name: "New image 1" }).click();
  await expect(compare.getByRole("radio", { name: "Difference" })).toBeChecked();
  await strip.getByRole("button", { name: "Original" }).click();
  await expect(toolbar(page)).toBeVisible();
});

test("a whole-image model says so, Keep the rest can be turned off, and the monthly limit asks first", async ({
  page,
}) => {
  // A limit of a cent, set before the page opens so the edit set up below is the one that runs.
  const token = await sessionToken(page.request);
  await api(page.request, token, "PATCH", "/api/settings", { spendGuardUsd: 0.01 });
  try {
    await editable(page, unique("red berries"));
    const panel = panelOf(page);

    await panel.getByRole("button", { name: "Model" }).click();
    await page.getByRole("option", { name: /Nano Banana 2 Lite/ }).click();
    await expect(panel.getByRole("button", { name: "Model" })).toContainText("Nano Banana 2 Lite");
    await expect(
      panel.getByText(
        "Nano Banana 2 Lite redraws the whole image, then everything outside your mask is put back.",
      ),
    ).toBeVisible();

    // Off, the model may change anything, and Feather and Expand rest.
    await panel.getByRole("switch", { name: "Keep the rest of the image" }).click();
    await expect(
      panel.getByText("Nano Banana 2 Lite redraws the whole image, so anything can change."),
    ).toBeVisible();
    await expect(panel.getByText("The model may change other parts too.")).toBeVisible();
    await expect(panel.getByRole("slider", { name: "Feather" })).toHaveAttribute("data-disabled", "");

    // Generate asks first, starting on Cancel, and Cancel sends nothing and hands focus back.
    await paintAndDescribe(page, "Dry the berries");
    let sent = false;
    page.on("request", (r) => {
      if (r.url().endsWith("/api/edit")) sent = true;
    });
    await generateIn(page).click();
    const ask = page.getByRole("dialog", { name: /^This run costs about/ });
    await expect(ask).toContainText("It would pass your monthly limit of $0.01.");
    await expect(ask.getByRole("button", { name: "Cancel" })).toBeFocused();
    await ask.getByRole("button", { name: "Cancel" }).click();
    await expect(ask).toHaveCount(0);
    expect(sent).toBe(false);
    await expect(generateIn(page)).toBeFocused();

    // Run anyway runs it on the model picked, with the rest of the image left to the model.
    await generateIn(page).click();
    const edits = page.waitForRequest((r) => r.url().endsWith("/api/edit") && r.method() === "POST");
    await ask.getByRole("button", { name: "Run anyway" }).click();
    expect((await edits).postDataJSON()).toMatchObject({
      model: "google:gemini-3.1-flash-lite-image",
      op: "inpaint",
      mask: { composite: false },
    });
    await expect(panelOf(page).getByText(/^Saved as 1 new image/)).toBeVisible({ timeout: 20_000 });
  } finally {
    await api(page.request, token, "PATCH", "/api/settings", { spendGuardUsd: null });
  }
});

test("with a monthly limit, a double click runs once, and Try again asks first too", async ({ page }) => {
  const token = await sessionToken(page.request);
  // Well under the limit: Generate runs without asking, once however fast it's clicked.
  await api(page.request, token, "PATCH", "/api/settings", { spendGuardUsd: 1000 });
  try {
    await editable(page, unique("plums"));
    await paintAndDescribe(page, "Ripe plums");
    // The month's spending answers slowly, so a second click lands while it's checked.
    await page.route("**/api/usage**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      // Already let through if the route was taken away meanwhile.
      await route.continue().catch(() => {});
    });
    const edits: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/edit") && r.method() === "POST") edits.push(r.url());
    });
    await generateIn(page).dblclick();
    await expect(panelOf(page).getByText(/^Saved as 1 new image/)).toBeVisible({ timeout: 20_000 });
    expect(edits).toHaveLength(1);
    await page.unrouteAll({ behavior: "ignoreErrors" });

    // A cent: a run that fails, then Try again asks before it spends again.
    await api(page.request, token, "PATCH", "/api/settings", { spendGuardUsd: 0.01 });
    await page.reload();
    await expect(toolbar(page)).toBeVisible();
    await paintAndDescribe(page, "Ripe plums #fake:refused");
    const ask = page.getByRole("dialog", { name: /^This run costs about/ });
    await generateIn(page).click();
    await ask.getByRole("button", { name: "Run anyway" }).click();
    await expect(page.getByText("Couldn't make this edit. Your mask is still here.")).toBeVisible({
      timeout: 20_000,
    });
    const before = edits.length;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "Cancel" }).click();
    await expect(ask).toHaveCount(0);
    expect(edits).toHaveLength(before);
  } finally {
    await api(page.request, token, "PATCH", "/api/settings", { spendGuardUsd: null });
  }
});

test("while it runs the form rests and Stop stops it; a run that fails keeps the mask to try again", async ({
  page,
}) => {
  await editable(page, unique("stems"));
  const panel = panelOf(page);

  // The slow fake keeps it running long enough to see.
  await paintAndDescribe(page, "Pale berries #fake:slow");
  await generateIn(page).click();
  await expect(panel.getByText("Generating 1 image")).toBeVisible();
  await expect(detail(page).getByText("Generating", { exact: true })).toBeVisible();
  await expect(detail(page).getByRole("group", { name: "New images" })).toBeVisible();
  await expect(toolbar(page)).toHaveCSS("opacity", "0.4");
  // The form rests at 45%, out of reach.
  const card = panel.getByRole("textbox", { name: "What to change" }).locator("xpath=..");
  await expect(card).toHaveCSS("opacity", "0.45");
  await expect(card).toHaveAttribute("inert", "");
  // The tools' keys rest too: the box stays in hand.
  await page.keyboard.press("e");
  await expect(tool(page, "Rectangle")).toHaveAttribute("aria-pressed", "true");
  await expect(tool(page, "Eraser")).toHaveAttribute("aria-pressed", "false");
  await panel.getByRole("button", { name: "Stop" }).click();
  await expect(generateIn(page)).toBeEnabled({ timeout: 15_000 });
  await expect(detail(page).getByRole("group", { name: "New images" })).toHaveCount(0);

  // Stop while the edit is still being asked for: the run stops as soon as it has an id.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/edit", async (route) => {
    await held;
    await route.continue();
  });
  await generateIn(page).click();
  await expect(panel.getByRole("button", { name: "Stop" })).toBeVisible();
  await panel.getByRole("button", { name: "Stop" }).click();
  const cancelled = page.waitForRequest((r) => /\/api\/job-sets\/[^/]+\/cancel$/.test(r.url()));
  release();
  await cancelled;
  await expect(generateIn(page)).toBeEnabled({ timeout: 15_000 });
  await expect(panel.getByText(/^Saved as/)).toHaveCount(0);
  await page.unroute("**/api/edit");

  // The fake refuses: none of it worked, the toast says the mask is still here, and Try again
  // sends it once more.
  await panel.getByRole("textbox", { name: "What to change" }).fill("Pale berries #fake:refused");
  await generateIn(page).click();
  const failed = page.getByText("Couldn't make this edit. Your mask is still here.");
  await expect(failed).toBeVisible({ timeout: 20_000 });
  expect(await tintAt(page, 0.45, 0.45)).toBe(255);
  await expect(generateIn(page)).toHaveText(/^Generate/);
  const again = page.waitForRequest((r) => r.url().endsWith("/api/edit") && r.method() === "POST");
  await page.getByRole("button", { name: "Try again" }).click();
  await again;
});

/** A JPEG that says it's stored turned (EXIF orientation 6), as a phone saves a portrait photo. */
async function turnedJpeg(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#c87850";
    context.fillRect(0, 0, 64, 48);
    return canvas.toDataURL("image/jpeg").split(",")[1]!;
  });
  const jpeg = Buffer.from(base64, "base64");
  // TIFF, big-endian: one IFD entry, Orientation (0x0112), SHORT, 1, value 6.
  const tiff = Buffer.from([
    0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0,
  ]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

test("a phone photo stored on its side says it can't be edited yet, and can still be a reference", async ({
  page,
}) => {
  const token = await sessionToken(page.request);
  await page.goto("/assets");
  const res = await page.request.post("/api/uploads", {
    headers: { [SESSION_HEADER]: token },
    multipart: { file: { name: "IMG_4821.jpg", mimeType: "image/jpeg", buffer: await turnedJpeg(page) } },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const { asset } = (await res.json()) as { asset: { id: string } };

  await page.goto(`/assets?asset=${asset.id}&tab=edit`);
  const panel = panelOf(page);
  await expect(panel.getByText("This photo can't be edited yet")).toBeVisible();
  // Stored 64 × 48 on its side, it shows upright, in a box the same way round.
  const picture = detail(page).locator("[role='img'] > div > div > img").first();
  await expect
    .poll(async () => {
      const box = await picture.boundingBox();
      return box ? [Math.round(box.width), Math.round(box.height)] : null;
    })
    .toEqual([48, 64]);
  await expect(
    panel.getByText("Your phone saved it sideways, so what you paint wouldn't line up with the photo."),
  ).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "What to change" })).toHaveCount(0);
  await expect(generateIn(page)).toBeDisabled();
  await expect(toolbar(page)).toHaveCSS("opacity", "0.4");
  await panel.getByRole("button", { name: "Use as reference" }).click();
  await expect(page.getByText("Added as a reference.")).toBeVisible();
});
