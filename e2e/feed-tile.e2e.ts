import { expect, type Page, test } from "@playwright/test";
import { api, libraryRoot, makeImage, queryDb, sessionToken } from "./support";

// The Image workspace feed's hover actions (design sZjeU, FYmuP, nPfg4): favourite, download,
// recreate, add to folder and Use as reference, kept for the mouse behind a hover and reachable by
// Tab either way (§0.15's usual rule for hover chrome).

test.describe.configure({ mode: "serial" });

let runs = 0;
const unique = (name: string) => `${name} ${Date.now().toString(36)}${runs++}`;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const tile = (page: Page, prompt: string) =>
  page.getByRole("listitem", { name: new RegExp(`^${escapeRegExp(prompt)} · `) });
const toasts = (page: Page) => page.getByRole("region", { name: /^Notifications/ });
const picker = (page: Page) => page.getByRole("dialog", { name: "Add to folder" });
/** The scrim itself: its own opacity, not an unstyled descendant's, says whether the hover chrome
 * is showing (opacity isn't inherited, so a button inside it always reports "1" on its own). */
const hoverOverlay = (page: Page, prompt: string) => tile(page, prompt).locator(".bg-scrim");

test("hovering (or tabbing into) a tile reveals its actions; the rest still opens the detail view", async ({
  page,
}) => {
  const token = await sessionToken(page.request);
  const prompt = unique("a lighthouse at dusk");
  await makeImage(page.request, token, prompt);
  await page.goto("/image");
  await expect(tile(page, prompt).locator("img")).toBeVisible({ timeout: 15_000 });

  // At rest the actions are there (for Tab) but not shown.
  await expect(hoverOverlay(page, prompt)).toHaveCSS("opacity", "0");
  await tile(page, prompt).hover();
  await expect(hoverOverlay(page, prompt)).toHaveCSS("opacity", "1");
  await page.mouse.move(4, 4);
  await expect(hoverOverlay(page, prompt)).toHaveCSS("opacity", "0");

  // A keyboard user never hovers: focusing a hidden action reveals the same chrome.
  await tile(page, prompt).getByRole("button", { name: "Favorite", exact: true }).focus();
  await expect(hoverOverlay(page, prompt)).toHaveCSS("opacity", "1");

  // Away from every button, a click still opens the detail view (§4.0).
  await page.keyboard.press("Escape");
  await tile(page, prompt).click({ position: { x: 4, y: 4 } });
  await expect(page.getByRole("dialog", { name: "Image details" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("favourite, download, recreate and add to folder act the same as everywhere else", async ({ page }) => {
  const token = await sessionToken(page.request);
  const home = await libraryRoot(page.request, token);
  const folder = unique("Dusk shots");
  const prompt = unique("a canal in the evening");
  const assetId = await makeImage(page.request, token, prompt);
  await api(page.request, token, "POST", "/api/folders", { name: folder });
  await page.goto("/image");
  await expect(tile(page, prompt).locator("img")).toBeVisible({ timeout: 15_000 });
  await tile(page, prompt).hover();

  // Favourite: on with a filled heart, an entry in the favourites table, off takes it back out.
  const favourite = tile(page, prompt).getByRole("button", { name: "Favorite", exact: true });
  await favourite.click();
  await expect(tile(page, prompt).getByRole("button", { name: "Remove from favorites" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    queryDb<{ asset_id: string }>(home, "select asset_id from favourites where asset_id = ?", assetId),
  ).toHaveLength(1);
  await tile(page, prompt).getByRole("button", { name: "Remove from favorites" }).click();
  expect(
    queryDb<{ asset_id: string }>(home, "select asset_id from favourites where asset_id = ?", assetId),
  ).toHaveLength(0);

  // Download: the same file (and name) the detail view would give.
  await tile(page, prompt).hover();
  const download = page.waitForEvent("download");
  await tile(page, prompt).getByRole("button", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toContain(assetId.slice(-8).toLowerCase());

  // Add to folder: the shared popover. A pick from inside it is silent (the checkbox says it), the
  // same as the Assets grid's own card.
  await tile(page, prompt).hover();
  await tile(page, prompt).getByRole("button", { name: "Add to folder" }).click();
  await picker(page).getByRole("treeitem", { name: folder, exact: true }).click();
  await expect(picker(page).getByRole("treeitem", { name: folder, exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(
    queryDb<{ folder_id: string }>(home, "select folder_id from asset_folders where asset_id = ?", assetId),
  ).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);

  // Recreate: a second run of the same model lands in the job sets the API reports.
  const before = await api<{ items: unknown[] }>(page.request, token, "GET", "/api/job-sets?status=all");
  await tile(page, prompt).hover();
  await tile(page, prompt).getByRole("button", { name: "Recreate" }).click();
  await expect(toasts(page)).toContainText("Recreating 1 image.");
  await expect
    .poll(
      async () =>
        (await api<{ items: unknown[] }>(page.request, token, "GET", "/api/job-sets?status=all")).items
          .length,
    )
    .toBeGreaterThan(before.items.length);
});

test("Use as reference queues the image, and Generate sends it as a $subject reference", async ({ page }) => {
  const token = await sessionToken(page.request);
  const prompt = unique("a market at sunrise");
  const assetId = await makeImage(page.request, token, prompt);
  await page.goto("/image");
  await expect(tile(page, prompt).locator("img")).toBeVisible({ timeout: 15_000 });

  await tile(page, prompt).hover();
  await tile(page, prompt).getByRole("button", { name: "Use as reference" }).click();
  await expect(toasts(page)).toContainText("Added as a reference.");

  const nextPrompt = unique("with morning light");
  const field = page.getByRole("textbox", { name: "Describe the image you want" });
  await field.fill(nextPrompt);
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/generate") && r.method() === "POST");
  await field.press("ControlOrMeta+Enter");
  const body = (await sent).postDataJSON() as { references?: { assetId: string; role: string }[] };
  expect(body.references).toEqual([{ assetId, role: "subject" }]);

  // Undo takes it back off: a second run sends none.
  await toasts(page)
    .getByRole("listitem")
    .filter({ hasText: "Added as a reference." })
    .getByRole("button", { name: "Undo" })
    // CI sometimes shows the toast twice; either one takes the reference back off.
    .first()
    .click();
  await tile(page, prompt).hover();
  await tile(page, prompt).getByRole("button", { name: "Use as reference" }).click();
  await toasts(page)
    .getByRole("listitem")
    .filter({ hasText: "Added as a reference." })
    .getByRole("button", { name: "Undo" })
    .click();
  await field.fill(unique("with no reference"));
  const sentAgain = page.waitForRequest((r) => r.url().endsWith("/api/generate") && r.method() === "POST");
  await field.press("ControlOrMeta+Enter");
  expect((await sentAgain).postDataJSON()).not.toHaveProperty("references");
});
