import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { FAKE_KEY, libraryRoot, queryDb, SESSION_HEADER, sessionToken, sha256File } from "./support";

// M0-15 and M0-16: the first-run path (§2.10) on a fresh library, then proof the image is real:
// a file on disk, a row in SQLite and a thumbnail in the feed. Fake models answer every call.

interface AssetRow {
  id: string;
  kind: string;
  path: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  prompt: string;
  provider_id: string;
  model_id: string;
  job_set_id: string;
}

const PROMPT = "A lighthouse on a cliff at dusk";

test("first run: add a key, make an image, and find it on disk, in SQLite and in the feed", async ({
  page,
  request,
}) => {
  // 1. Launch: the app opens on /image with the no-key welcome, and Generate waits for a key.
  await page.goto("/");
  await expect(page).toHaveURL(/\/image$/);
  await expect(page.getByRole("heading", { name: "Let's make your first image" })).toBeVisible();
  const generate = page.getByRole("button", { name: /^Generate/ });
  await expect(generate).toBeDisabled();
  await expect(generate).toContainText("Add a key first");

  // 2. Add a key: Settings opens on API keys with the key field focused.
  await page.getByRole("button", { name: "Add a key", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/api-keys$/);
  const google = page.getByRole("group", { name: "Google" });
  const keyField = google.getByRole("textbox", { name: "API key" });
  await expect(keyField).toBeFocused();
  await expect(google.getByRole("status")).toHaveText("Not connected");

  // 3. A rejected key says so, and stays in the field so it can be fixed.
  await keyField.fill("AIza-this-key-is-invalid-000000");
  await google.getByRole("button", { name: "Check key" }).click();
  await expect(google.getByText("This key was rejected.")).toBeVisible();
  await expect(keyField).toHaveValue("AIza-this-key-is-invalid-000000");
  // It was never saved, so nothing counts as ready and first run still holds (§2.10 step 5).
  const token = await sessionToken(request);
  const listed = await request.get("/api/models", { headers: { [SESSION_HEADER]: token } });
  expect(((await listed.json()) as { models: { ready: boolean }[] }).models.some((m) => m.ready)).toBe(false);

  // 4. A good key connects, says how many models are ready, and offers the way back.
  await keyField.fill(FAKE_KEY);
  await google.getByRole("button", { name: "Check key" }).click();
  await expect(google.getByRole("status")).toHaveText("Connected");
  await expect(google.getByText(/^This key works\. \d+ models are ready\.$/)).toBeVisible();
  await expect(page.getByText("Connected to Google.")).toBeVisible();
  await page.getByRole("button", { name: "Start creating" }).click();

  // 5. Back on /image: the default model is picked and the prompt has focus.
  await expect(page).toHaveURL(/\/image$/);
  const prompt = page.getByRole("textbox", { name: "Describe the image you want" });
  await expect(prompt).toBeFocused();
  await expect(page.getByRole("button", { name: "Choose model" })).toHaveText("Nano Banana Pro");
  await expect(generate).toBeDisabled();

  // 6. Type a prompt and press Cmd/Ctrl+Enter: a placeholder shows at once, then the image.
  await prompt.fill(PROMPT);
  await expect(generate).toBeEnabled();
  const thumbResponse = page.waitForResponse((res) =>
    new URL(res.url()).pathname.startsWith("/files/thumb/"),
  );
  await prompt.press("ControlOrMeta+Enter");
  await expect(page.locator('main li[aria-busy="true"]')).toBeVisible();

  const tile = page.getByRole("listitem", { name: new RegExp(`^${PROMPT} · Nano Banana Pro · `) });
  await expect(tile.locator("img")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('main li[aria-busy="true"]')).toHaveCount(0);
  await expect(prompt).toHaveValue(PROMPT);

  // The feed shows a real thumbnail: a WebP from /files/thumb, sized for the default row height.
  const thumb = await thumbResponse;
  expect(thumb.status()).toBe(200);
  expect(thumb.headers()["content-type"]).toBe("image/webp");
  const thumbUrl = new URL(thumb.url());
  expect(thumbUrl.searchParams.get("h")).toBe("456");
  const assetId = thumbUrl.pathname.split("/").pop()!;
  expect(await tile.locator("img").evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(456);

  // 7. The image is real: a row in SQLite, the file under assets/YYYY/MM/DD, a cached thumbnail.
  const home = await libraryRoot(request, token);
  const [row] = queryDb<AssetRow>(home, "SELECT * FROM assets WHERE id = ?", assetId);
  expect(row).toMatchObject({
    kind: "generated",
    mime: "image/png",
    prompt: PROMPT,
    provider_id: "google",
    model_id: "gemini-3-pro-image",
  });
  expect(row!.path).toMatch(new RegExp(`^assets/\\d{4}/\\d{2}/\\d{2}/${assetId}\\.png$`));
  const file = join(home, row!.path);
  expect(statSync(file).size).toBe(row!.bytes);
  expect(sha256File(file)).toBe(row!.sha256);
  expect(readFileSync(file).subarray(1, 4).toString()).toBe("PNG");
  expect(existsSync(join(home, "thumbs", row!.sha256.slice(0, 2), `${row!.sha256}@h456.webp`))).toBe(true);

  const [run] = queryDb<{ status: string; batch_size: number }>(
    home,
    "SELECT status, batch_size FROM job_sets WHERE id = ?",
    row!.job_set_id,
  );
  expect(run).toEqual({ status: "succeeded", batch_size: 1 });

  // The first working key set the default model (§2.10 step 5).
  const settings = await request.get("/api/settings", { headers: { [SESSION_HEADER]: token } });
  expect((await settings.json()).defaultModel).toBe("google:gemini-3-pro-image");

  // The key stays on this computer: in config.json, readable by this user only, never in the database.
  const config = join(home, "config.json");
  expect(statSync(config).mode & 0o777).toBe(0o600);
  expect(readFileSync(config, "utf8")).toContain(FAKE_KEY);
  for (const name of ["openfield.db", "openfield.db-wal"]) {
    const db = join(home, name);
    if (existsSync(db)) expect(readFileSync(db).includes(FAKE_KEY)).toBe(false);
  }

  // 8. A reload keeps the image in the feed.
  await page.reload();
  await expect(tile.locator("img")).toBeVisible();
});
