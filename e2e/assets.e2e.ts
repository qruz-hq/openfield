import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, libraryRoot, makeImage, queryDb, SESSION_HEADER, sessionToken } from "./support";

// The Assets tab (§2.8, §4.0): folders nest with no depth limit and move anywhere but into
// themselves, an image can be in several folders at once, the detail view steps through the list
// it was opened from, and the Trash keeps an image's folders and favourite until it's restored or
// deleted for good. The tests share one library, so each one names its own folders and images.

test.describe.configure({ mode: "serial" });

let runs = 0;
/** A name no earlier test used. */
const unique = (name: string) => `${name} ${Date.now().toString(36)}${runs++}`;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const tree = (page: Page) => page.getByRole("tree", { name: "Folders" });
/** A sidebar row. Its accessible name is the folder's name, then its count (⋯ while hovered). */
const row = (page: Page, name: string) =>
  tree(page).getByRole("treeitem", { name: new RegExp(`^${escapeRegExp(name)}(\\s|$)`) });
const card = (page: Page, prompt: string) =>
  page.getByRole("gridcell", { name: new RegExp(`^${escapeRegExp(prompt)} · `) });
const selectionBar = (page: Page) => page.getByRole("toolbar", { name: "Selected images" });
const detail = (page: Page) => page.getByRole("dialog", { name: "Image details" });
const picker = (page: Page) => page.getByRole("dialog", { name: "Add to folder" });
const toasts = (page: Page) => page.getByRole("region", { name: /^Notifications/ });
/**
 * All images, Favorites or Trash in the sidebar, with its count. By CSS, because the detail view is
 * a modal and hides the page behind it from the accessibility tree.
 */
const viewLink = (page: Page, label: "All images" | "Favorites" | "Trash") =>
  page.locator("[data-library-sidebar] nav a").filter({ hasText: label });
/** The count beside it, once the sidebar has one. */
async function viewCount(page: Page, label: "All images" | "Favorites" | "Trash"): Promise<number> {
  await expect(viewLink(page, label)).toHaveText(/\d+$/);
  return Number((await viewLink(page, label).innerText()).replace(/\D/g, ""));
}

interface FolderRow {
  id: string;
  name: string;
  parentId: string | null;
  count: number;
}

async function foldersOf(page: Page, token: string): Promise<FolderRow[]> {
  return api<FolderRow[]>(page.request, token, "GET", "/api/folders");
}

async function folderId(page: Page, token: string, name: string): Promise<string> {
  const folder = (await foldersOf(page, token)).find((f) => f.name === name);
  expect(folder, `folder ${name}`).toBeDefined();
  return folder!.id;
}

/** The + beside the Folders heading (an empty tree has a second New folder under it). */
const sidebarNewFolder = (page: Page) =>
  page.getByRole("complementary").getByRole("button", { name: "New folder" }).first();

/** Names a new folder in the tree's inline field. Nothing is made until Enter. */
async function nameFolder(page: Page, name: string) {
  const field = page.getByRole("textbox", { name: "Folder name" });
  await field.fill(name);
  await field.press("Enter");
  await expect(row(page, name)).toBeVisible();
}

/** Opens a folder from the sidebar and waits for its page. */
async function openFolder(page: Page, name: string) {
  await row(page, name).click();
  await expect(page.getByRole("region", { name })).toBeVisible();
}

/**
 * Drags with the mouse the way a person does: press, move past the 5px threshold, travel to the
 * target and release, checking the hint beside the pointer just before letting go.
 */
async function dragTo(page: Page, from: Locator, to: Locator, expectHint: string | RegExp) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await expect(page.getByText(expectHint)).toBeVisible();
  await page.mouse.up();
  // Off the sidebar, so no row is left in its hover state (⋯ instead of the count).
  await page.mouse.move(720, 20);
}

/** Each row's depth and name, top to bottom, as the tree shows them. */
async function treeShape(page: Page): Promise<string[]> {
  return tree(page)
    .getByRole("treeitem")
    .evaluateAll((rows) =>
      rows.map((r) => `${r.getAttribute("aria-level")}:${r.getAttribute("aria-label") ?? r.textContent}`),
    );
}

test("folders nest with no depth limit, move anywhere but inside themselves, and delete with what's inside", async ({
  page,
}) => {
  const token = await sessionToken(page.request);
  const [clients, acme, spring, shoot, moodboard] = [
    unique("Clients"),
    unique("Acme"),
    unique("Spring 2026"),
    unique("Shoot 1"),
    unique("Moodboard"),
  ];
  const home = await libraryRoot(page.request, token);
  const imageId = await makeImage(page.request, token, unique("a harbour at dawn"));
  await page.goto("/assets");
  const allBefore = await viewCount(page, "All images");

  // Four levels: the sidebar's +, the header's New folder inside the open folder, and ⌘⇧N.
  await sidebarNewFolder(page).click();
  await nameFolder(page, clients);
  await openFolder(page, clients);
  await page.getByRole("region", { name: clients }).getByRole("button", { name: "New folder" }).click();
  await nameFolder(page, acme);
  await openFolder(page, acme);
  await page.getByRole("region", { name: acme }).getByRole("button", { name: "New folder" }).click();
  await nameFolder(page, spring);
  await openFolder(page, spring);
  await page.keyboard.press("ControlOrMeta+Shift+N");
  await nameFolder(page, shoot);
  await sidebarNewFolder(page).click();
  await nameFolder(page, moodboard);

  const levels = async () =>
    Object.fromEntries(
      await Promise.all(
        [clients, acme, spring, shoot, moodboard].map(
          async (name) => [name, await row(page, name).getAttribute("aria-level")] as const,
        ),
      ),
    );
  expect(await levels()).toEqual({
    [clients]: "1",
    [acme]: "2",
    [spring]: "3",
    [shoot]: "4",
    [moodboard]: "1",
  });
  // An image filed deep inside, and in Moodboard too, for the delete at the end.
  for (const name of [spring, moodboard]) {
    await api(
      page.request,
      token,
      "PUT",
      `/api/assets/${imageId}/folders/${await folderId(page, token, name)}`,
    );
  }

  // A folder shows its subfolders as cards on top; deeper than three levels the breadcrumb folds
  // the middle behind ⋯.
  const springView = page.getByRole("region", { name: spring });
  await expect(springView.getByRole("button", { name: new RegExp(`^${escapeRegExp(shoot)}`) })).toBeVisible();
  await openFolder(page, shoot);
  const crumbs = page.getByRole("navigation", { name: "Folder path" });
  await expect(crumbs.getByRole("button", { name: clients })).toBeVisible();
  await expect(crumbs.getByRole("button", { name: "Show the folders in between" })).toBeVisible();
  await expect(crumbs.getByRole("button", { name: spring })).toBeVisible();
  await expect(crumbs).toContainText(shoot);
  await expect(crumbs.getByRole("button", { name: acme })).toHaveCount(0);

  // Drag Moodboard into Acme, then onto the Folders heading to bring it back to the top level.
  await dragTo(page, row(page, moodboard), row(page, acme), `Move into ${acme}`);
  await expect(row(page, moodboard)).toHaveAttribute("aria-level", "3");
  expect((await foldersOf(page, token)).find((f) => f.name === moodboard)?.parentId).toBe(
    await folderId(page, token, acme),
  );
  await dragTo(page, row(page, moodboard), page.locator("[data-drop-top]"), "Move to top level");
  await expect(row(page, moodboard)).toHaveAttribute("aria-level", "1");

  // A folder can't go inside itself: the drop does nothing, and the server refuses it anyway.
  const shapeBefore = await treeShape(page);
  await dragTo(page, row(page, clients), row(page, shoot), "A folder can't go inside itself");
  await expect(row(page, clients)).toHaveAttribute("aria-level", "1");
  expect(await treeShape(page)).toEqual(shapeBefore);
  const refused = await page.request.patch(`/api/folders/${await folderId(page, token, clients)}`, {
    headers: { [SESSION_HEADER]: token },
    data: { parentId: await folderId(page, token, shoot) },
  });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error.code).toBe("conflict");
  expect((await foldersOf(page, token)).find((f) => f.name === clients)?.parentId).toBeNull();

  // Move to: the current parent is checked, the folder and everything inside it can't be picked.
  await row(page, acme).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to" }).hover();
  const moveMenu = page.getByRole("menu").last();
  await expect(moveMenu).toContainText(`Move “${acme}” to`);
  await expect(moveMenu.getByRole("menuitem", { name: clients })).toHaveAttribute("aria-current", "true");
  for (const inside of [acme, spring, shoot]) {
    await expect(moveMenu.getByRole("menuitem", { name: inside })).toHaveAttribute("aria-disabled", "true");
  }
  await moveMenu.getByRole("menuitem", { name: moodboard }).click();
  await expect(row(page, acme)).toHaveAttribute("aria-level", "2");
  await expect(crumbs.getByRole("button", { name: moodboard })).toBeVisible();

  // Moving by card: drag Acme's card from Moodboard's page back onto Clients in the sidebar.
  await openFolder(page, moodboard);
  const acmeCard = page
    .getByRole("region", { name: moodboard })
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(acme)}`) });
  await dragTo(page, acmeCard, row(page, clients), `Move into ${clients}`);
  await expect(page.getByRole("region", { name: moodboard })).toBeVisible();
  await expect
    .poll(async () => (await foldersOf(page, token)).find((f) => f.name === acme)?.parentId)
    .toBe(await folderId(page, token, clients));

  // Delete Clients from inside Shoot 1: the dialog counts what goes with it, the view moves out,
  // and the images stay in the library and in their other folders.
  await openFolder(page, shoot);
  await row(page, clients).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete folder" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(`Delete “${clients}”?`);
  await expect(dialog).toContainText(
    "The 3 folders inside it are deleted too. The images stay in your library.",
  );
  await dialog.getByRole("button", { name: "Delete folder" }).click();
  await expect(page).toHaveURL(/\/assets$/);
  for (const gone of [clients, acme, spring, shoot]) await expect(row(page, gone)).toHaveCount(0);
  await expect(row(page, moodboard)).toBeVisible();
  const names = (await foldersOf(page, token)).map((f) => f.name);
  for (const gone of [clients, acme, spring, shoot]) expect(names).not.toContain(gone);
  await expect(viewLink(page, "All images")).toContainText(String(allBefore));
  const filed = queryDb<{ folder_id: string }>(
    home,
    "select folder_id from asset_folders where asset_id = ?",
    imageId,
  );
  expect(filed.map((f) => f.folder_id)).toEqual([await folderId(page, token, moodboard)]);
  await expect(row(page, moodboard)).toHaveAccessibleName(`${moodboard} 1`);
});

test("an image can be in several folders, and Remove from folder takes it out of one", async ({ page }) => {
  const token = await sessionToken(page.request);
  const home = await libraryRoot(page.request, token);
  const [alpha, beta] = [unique("Alpha"), unique("Beta")];
  const prompts = [unique("a fox in snow"), unique("a paper crane"), unique("a lighthouse")];
  const ids: string[] = [];
  for (const prompt of prompts) ids.push(await makeImage(page.request, token, prompt));
  for (const name of [alpha, beta]) await api(page.request, token, "POST", "/api/folders", { name });

  await page.goto("/assets");
  // The newest is first: select the two older images with a click and a Shift+click.
  await card(page, prompts[1]!).getByRole("checkbox").click();
  await card(page, prompts[0]!).click({ modifiers: ["Shift"] });
  await expect(selectionBar(page)).toContainText("2 selected");

  // Dragging a selected card drags the whole selection.
  await dragTo(page, card(page, prompts[0]!), row(page, alpha), `Add 2 images to ${alpha}`);
  await expect(toasts(page)).toContainText(`Added 2 images to ${alpha}.`);
  await expect(row(page, alpha)).toHaveAccessibleName(`${alpha} 2`);

  // The picker adds the same two to Beta and keeps them in Alpha.
  await selectionBar(page).getByRole("button", { name: "Add to folder" }).click();
  await expect(picker(page).getByRole("treeitem", { name: alpha, exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await picker(page).getByRole("treeitem", { name: beta, exact: true }).click();
  await expect(picker(page).getByRole("treeitem", { name: beta, exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await expect(row(page, beta)).toHaveAccessibleName(`${beta} 2`);
  await expect(row(page, alpha)).toHaveAccessibleName(`${alpha} 2`);
  await page.keyboard.press("Escape");
  await expect(selectionBar(page)).toHaveCount(0);

  // Dragging an unselected card drags just that image.
  await dragTo(page, card(page, prompts[2]!), row(page, alpha), `Add to ${alpha}`);
  await expect(row(page, alpha)).toHaveAccessibleName(`${alpha} 3`);

  const memberships = (id: string) =>
    queryDb<{ folder_id: string }>(home, "select folder_id from asset_folders where asset_id = ?", id)
      .map((r) => r.folder_id)
      .sort();
  const [alphaId, betaId] = [await folderId(page, token, alpha), await folderId(page, token, beta)];
  expect(memberships(ids[0]!)).toEqual([alphaId, betaId].sort());
  expect(memberships(ids[2]!)).toEqual([alphaId]);

  // Inside Alpha, the card menu's Remove from folder takes the fox out of Alpha only, with Undo.
  await openFolder(page, alpha);
  await expect(page.getByRole("gridcell")).toHaveCount(3);
  await card(page, prompts[0]!).hover();
  await card(page, prompts[0]!).getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Remove from folder" }).click();
  await expect(card(page, prompts[0]!)).toHaveCount(0);
  await expect(row(page, alpha)).toHaveAccessibleName(`${alpha} 2`);
  await expect(row(page, beta)).toHaveAccessibleName(`${beta} 2`);
  expect(memberships(ids[0]!)).toEqual([betaId]);
  await toasts(page)
    .getByRole("listitem")
    .filter({ hasText: `Removed 1 image from ${alpha}.` })
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(card(page, prompts[0]!)).toBeVisible();
  await expect(row(page, alpha)).toHaveAccessibleName(`${alpha} 3`);

  // The bar's Remove from folder on everything shown empties Alpha; the images stay in Beta.
  await page.keyboard.press("ControlOrMeta+a");
  await expect(selectionBar(page)).toContainText("3 selected");
  await selectionBar(page).getByRole("button", { name: "Remove from folder" }).click();
  await expect(page.getByText(`No images in ${alpha} yet`)).toBeVisible();
  await expect(row(page, alpha)).toHaveAccessibleName(`${alpha} 0`);
  await expect(row(page, beta)).toHaveAccessibleName(`${beta} 2`);
  expect(memberships(ids[0]!)).toEqual([betaId]);
  expect(memberships(ids[1]!)).toEqual([betaId]);

  // Words typed in the sidebar search come along into a folder, and search only what's in it.
  await viewLink(page, "All images").click();
  await page.getByRole("searchbox", { name: "Search" }).fill(prompts[0]!);
  await expect(page.getByRole("heading", { name: `Results for “${prompts[0]}”` })).toBeVisible();
  await row(page, beta).click();
  await expect(page).toHaveURL(new RegExp(`/assets/folder/${betaId}\\?q=`));
  await expect(page.getByText(`In ${beta}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Search all images" })).toBeVisible();
  await expect(page.getByRole("gridcell")).toHaveCount(1);
  await expect(card(page, prompts[0]!)).toBeVisible();
});

test("the detail view steps through the list it came from, in the library and in the feed", async ({
  page,
}) => {
  const token = await sessionToken(page.request);
  const folder = unique("Stepping");
  const prompts = [unique("first dune"), unique("second dune"), unique("third dune")];
  const ids: string[] = [];
  for (const prompt of prompts) ids.push(await makeImage(page.request, token, prompt));
  const { id } = await api<{ id: string }>(page.request, token, "POST", "/api/folders", { name: folder });
  for (const assetId of ids) await api(page.request, token, "PUT", `/api/assets/${assetId}/folders/${id}`);

  // Newest first: third, second, first.
  await page.goto(`/assets/folder/${id}`);
  await card(page, prompts[2]!).click();
  const view = detail(page);
  await expect(view).toContainText(prompts[2]!);
  await expect(page).toHaveURL(new RegExp(`\\?asset=${ids[2]}$`));
  await expect(view.getByRole("button", { name: "Previous image" })).toBeHidden();
  await expect(view.getByRole("button", { name: "Next image" })).toBeVisible();
  // The Info panel: the prompt, and the folders the image is in.
  await expect(view.getByText("Prompt", { exact: true })).toBeVisible();
  await expect(view.getByRole("button", { name: folder })).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(view).toContainText(prompts[1]!);
  await view.getByRole("button", { name: "Next image" }).click();
  await expect(view).toContainText(prompts[0]!);
  await expect(page).toHaveURL(new RegExp(`\\?asset=${ids[0]}$`));
  await expect(view.getByRole("button", { name: "Next image" })).toBeHidden();
  await page.keyboard.press("ArrowLeft");
  await expect(view).toContainText(prompts[1]!);

  // A reload reopens the same image in the same list.
  await page.reload();
  await expect(detail(page)).toContainText(prompts[1]!);

  // Favorite from the detail view, then Esc: back to the grid with that card focused.
  const favourites = await viewCount(page, "Favorites");
  await view.getByRole("button", { name: "Favorite", exact: true }).click();
  await expect(view.getByRole("button", { name: "Remove from favorites" })).toBeVisible();
  await expect(viewLink(page, "Favorites")).toContainText(String(favourites + 1));
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/assets/folder/${id}$`));
  await expect(card(page, prompts[1]!)).toBeFocused();

  // In the Image feed, a tile opens the same view, stepping in the feed's order.
  await page.goto("/image");
  await page.getByRole("button", { name: new RegExp(`^${escapeRegExp(prompts[2]!)} · `) }).click();
  await expect(view).toContainText(prompts[2]!);
  await page.keyboard.press("ArrowRight");
  await expect(view).toContainText(prompts[1]!);
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
  await expect(page).toHaveURL(/\/image$/);
});

test("delete moves to the trash, restore puts folders and favourite back, and the trash empties only when asked", async ({
  page,
}) => {
  const token = await sessionToken(page.request);
  const home = await libraryRoot(page.request, token);
  const [one, two] = [unique("Keep one"), unique("Keep two")];
  const prompts = [unique("a vintage car"), unique("coffee on a table"), unique("a snowy cabin")];
  const ids: string[] = [];
  for (const prompt of prompts) ids.push(await makeImage(page.request, token, prompt));
  const folders: string[] = [];
  for (const name of [one, two]) {
    const { id } = await api<{ id: string }>(page.request, token, "POST", "/api/folders", { name });
    folders.push(id);
    await api(page.request, token, "PUT", `/api/assets/${ids[0]}/folders/${id}`);
  }
  await api(page.request, token, "PUT", `/api/assets/${ids[0]}/favourite`);

  // Opened from the first folder, where it's the only image, so the view closes once it's gone.
  await page.goto(`/assets/folder/${folders[0]}`);
  await expect(card(page, prompts[0]!)).toBeVisible();
  const [allBefore, favBefore, trashBefore] = [
    await viewCount(page, "All images"),
    await viewCount(page, "Favorites"),
    await viewCount(page, "Trash"),
  ];

  // Delete from the detail view: it asks, then the image leaves every view but the Trash.
  await card(page, prompts[0]!).click();
  await detail(page).getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Delete this image?");
  await expect(confirm).toContainText("It moves to the trash. You can restore it from there.");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(detail(page)).toHaveCount(0);
  await expect(page.getByText(`No images in ${one} yet`)).toBeVisible();
  await expect(row(page, one)).toHaveAccessibleName(`${one} 0`);
  await expect(row(page, two)).toHaveAccessibleName(`${two} 0`);
  await expect(viewLink(page, "Favorites")).toContainText(String(favBefore - 1));
  await expect(viewLink(page, "Trash")).toContainText(String(trashBefore + 1));

  // Restore from the Trash's detail view: back in both folders and in Favorites.
  await viewLink(page, "Trash").click();
  await expect(page).toHaveURL(/\/assets\/trash$/);
  await card(page, prompts[0]!).click();
  await expect(detail(page)).toContainText("In the trash since today");
  await detail(page).getByRole("button", { name: "Restore" }).click();
  await expect(toasts(page)).toContainText("Restored 1 image.");
  await expect(row(page, one)).toHaveAccessibleName(`${one} 1`);
  await expect(row(page, two)).toHaveAccessibleName(`${two} 1`);
  await expect(viewLink(page, "Favorites")).toContainText(String(favBefore));
  await expect(viewLink(page, "Trash")).toContainText(String(trashBefore));
  if (await detail(page).count()) await page.keyboard.press("Escape");
  await expect(detail(page)).toHaveCount(0);

  // Two more to the Trash from the selection bar.
  await viewLink(page, "All images").click();
  await card(page, prompts[1]!).getByRole("checkbox").click();
  await card(page, prompts[2]!).getByRole("checkbox").click();
  await selectionBar(page).getByRole("button", { name: "Delete" }).click();
  await expect(confirm).toContainText("Delete 2 images?");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(viewLink(page, "Trash")).toContainText(String(trashBefore + 2));
  await expect(viewLink(page, "All images")).toContainText(String(allBefore - 2));

  // Delete for good, from a Trash card: asked first, then the row goes, and its file with it.
  await viewLink(page, "Trash").click();
  const path = queryDb<{ path: string }>(home, "select path from assets where id = ?", ids[1]!)[0]!.path;
  expect(existsSync(join(home, path))).toBe(true);
  await card(page, prompts[1]!).hover();
  await card(page, prompts[1]!).getByRole("button", { name: "Delete for good" }).click();
  await expect(confirm).toContainText("Delete this image for good?");
  await expect(confirm).toContainText("It's removed from your computer. You can't undo this.");
  await confirm.getByRole("button", { name: "Delete for good" }).click();
  await expect(card(page, prompts[1]!)).toHaveCount(0);
  expect(queryDb(home, "select id from assets where id = ?", ids[1]!)).toHaveLength(0);
  // A file another image still uses is kept (§8.6).
  const sharing = queryDb(home, "select id from assets where path = ?", path);
  expect(existsSync(join(home, path))).toBe(sharing.length > 0);

  // Empty trash takes what's left, only when asked.
  await page.getByRole("button", { name: "Empty trash" }).click();
  await expect(confirm).toContainText("Empty the trash?");
  await confirm.getByRole("button", { name: "Empty trash" }).click();
  await expect(page.getByText("The trash is empty")).toBeVisible();
  await expect(page.getByRole("button", { name: "Empty trash" })).toBeDisabled();
  await expect(viewLink(page, "Trash")).toContainText("0");
  expect(queryDb(home, "select id from assets where deleted_at is not null")).toHaveLength(0);
  // The restored image is still live, in both folders and in Favorites.
  expect(queryDb(home, "select id from assets where id = ? and deleted_at is null", ids[0]!)).toHaveLength(1);
  expect(queryDb(home, "select folder_id from asset_folders where asset_id = ?", ids[0]!)).toHaveLength(2);
  expect(queryDb(home, "select asset_id from favourites where asset_id = ?", ids[0]!)).toHaveLength(1);
});
