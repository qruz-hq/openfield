import { expect, type Page, test } from "@playwright/test";

// Higgsfield (§6.15): a regular company, checked live on 2026-09-27. Its prices come from its
// estimate endpoint through the server (§6.9); the fake answers SOUL V2 at $0.004 an image, as the
// real one did. The tests share one server.

test.describe.configure({ mode: "serial" });

const SOUL_V2 = "higgsfield:soul-v2";
const KEY = "hf-e2e-id:hf-e2e-secret-0000";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const images = (page: Page, prompt: string) =>
  page.getByRole("listitem", { name: new RegExp(`^${escapeRegExp(prompt)} · `) }).locator("img");

test("Higgsfield's card shows without Experimental, and a key readies its models with their prices", async ({
  page,
}) => {
  // No company is early, so Experimental has no early models switch to show.
  await page.goto("/settings/experimental");
  await expect(page.getByText("Also save canvases as files")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Show early models" })).toHaveCount(0);

  await page.goto("/settings/api-keys");
  const card = page.getByRole("group", { name: "Higgsfield" });
  await expect(card.getByRole("status")).toHaveText("Not connected");
  await card.getByPlaceholder("Paste your key").fill(KEY);
  await card.getByRole("button", { name: "Check key" }).click();
  await expect(card.getByRole("status")).toHaveText("Connected");
  // Each model's usual price, asked of Higgsfield: SOUL V2 at its defaults.
  await expect(card.getByText("SOUL V2", { exact: true }).locator("..")).toContainText("~$0.004");
});

test("the composer prices SOUL V2 from Higgsfield before generating, then makes an image", async ({
  page,
}) => {
  const prompt = `A red kite over wheat fields ${Date.now().toString(36)}`;
  await page.goto(`/image?model=${encodeURIComponent(SOUL_V2)}`);
  await page.getByRole("textbox", { name: "Describe the image you want" }).fill(prompt);
  const generate = page.getByRole("button", { name: /^Generate/ });
  await expect(generate).toContainText(/About\s*\$0\.004/);
  await generate.click();
  await expect(images(page, prompt).first()).toBeVisible({ timeout: 20_000 });
});
