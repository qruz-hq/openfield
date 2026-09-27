import { expect, type Page, test } from "@playwright/test";

// Higgsfield (§6.15) is an early company (meta.stable false): its card and models show only with
// Settings > Experimental > Show early models on. With it on, a key readies SOUL V2 and a run lands
// from the fake's image host. The tests share one server.

test.describe.configure({ mode: "serial" });

const SOUL_V2 = "higgsfield:soul-v2";
const KEY = "hf-e2e-id:hf-e2e-secret-0000";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const images = (page: Page, prompt: string) =>
  page.getByRole("listitem", { name: new RegExp(`^${escapeRegExp(prompt)} · `) }).locator("img");

test("Higgsfield stays hidden until Show early models is on", async ({ page }) => {
  await page.goto("/settings/api-keys");
  await expect(page.getByRole("group", { name: "OpenAI" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Higgsfield" })).toHaveCount(0);

  await page.goto("/settings/experimental");
  const early = page.getByRole("switch", { name: "Show early models" });
  await expect(early).not.toBeChecked();
  await early.click();
  await expect(early).toBeChecked();

  await page.goto("/settings/api-keys");
  const card = page.getByRole("group", { name: "Higgsfield" });
  await expect(card.getByRole("status")).toHaveText("Not connected");
  await card.getByPlaceholder("Paste your key").fill(KEY);
  await card.getByRole("button", { name: "Check key" }).click();
  await expect(card.getByRole("status")).toHaveText("Connected");
});

test("with a key, SOUL V2 makes an image", async ({ page }) => {
  const prompt = `A red kite over wheat fields ${Date.now().toString(36)}`;
  await page.goto(`/image?model=${encodeURIComponent(SOUL_V2)}`);
  await page.getByRole("textbox", { name: "Describe the image you want" }).fill(prompt);
  await page.getByRole("button", { name: /^Generate/ }).click();
  await expect(images(page, prompt).first()).toBeVisible({ timeout: 20_000 });
});
