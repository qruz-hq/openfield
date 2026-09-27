import { expect, type Page, test } from "@playwright/test";
import { api, FAKE_KEY, libraryRoot, queryDb, sessionToken } from "./support";

// OpenAI (§6.14): a key on its own card, GPT Image 2.5 Flare priced from OpenAI's token table and
// run end to end, GPT Image 2 at Batch waiting at OpenAI and landing, and a 2.5 model at Batch
// running at Standard and saying so. Fake models answer every call. The tests share one server.

test.describe.configure({ mode: "serial" });

const FLARE = "openai:gpt-image-2.5-flare";
const GPT2 = "openai:gpt-image-2";

let prompts = 0;
const unique = (prompt: string) => `${prompt} ${Date.now().toString(36)}${prompts++}`;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const images = (page: Page, prompt: string) =>
  page.getByRole("listitem", { name: new RegExp(`^${escapeRegExp(prompt)} · `) }).locator("img");

async function setOpenAi(page: Page, values: Record<string, string | number>) {
  const token = await sessionToken(page.request);
  await api(page.request, token, "PUT", "/api/settings/keys/openai", { apiKey: FAKE_KEY });
  await api(page.request, token, "PATCH", "/api/providers/openai/settings", { values });
}

/** Opens the Image tab with a model, a prompt and an image count, ready to Generate. */
async function compose(page: Page, opts: { model: string; prompt: string; images?: number }) {
  await page.goto(`/image?model=${encodeURIComponent(opts.model)}`);
  await page.getByRole("textbox", { name: "Describe the image you want" }).fill(opts.prompt);
  const count = page.getByRole("group", { name: "Images" }).getByRole("status");
  const wanted = opts.images ?? 1;
  for (let n = Number(await count.textContent()); n !== wanted; ) {
    const up = n < wanted;
    await page.getByRole("button", { name: up ? "More images" : "Fewer images" }).click();
    n += up ? 1 : -1;
    await expect(count).toHaveText(String(n));
  }
  return page.getByRole("button", { name: /^Generate/ });
}

test("a key on OpenAI's card readies its models, and Flare makes two images at its token price", async ({
  page,
}) => {
  await page.goto("/settings/api-keys");
  const card = page.getByRole("group", { name: "OpenAI" });
  await expect(card.getByRole("status")).toHaveText("Not connected");
  await card.getByPlaceholder("Paste your key").fill(FAKE_KEY);
  await card.getByRole("button", { name: "Check key" }).click();
  await expect(card.getByRole("status")).toHaveText("Connected");

  // Medium at 1:1 and 1K is 439 output tokens at $30 per million: about $0.013 an image.
  const prompt = unique("A lighthouse at dusk, film grain");
  const generate = await compose(page, { model: FLARE, prompt, images: 2 });
  await expect(generate).toContainText(/About\s*\$0\.026/);
  await generate.click();
  await expect(images(page, prompt)).toHaveCount(2, { timeout: 20_000 });

  // The run is priced from the tokens the answer reported, not the estimate.
  const home = await libraryRoot(page.request, await sessionToken(page.request));
  const rows = queryDb<{ outcome: string; cost_source: string }>(
    home,
    `SELECT u.outcome, u.cost_source FROM usage_log u JOIN job_sets s ON s.id = u.job_set_id WHERE s.prompt = ?`,
    prompt,
  );
  expect(rows).toEqual([
    { outcome: "succeeded", cost_source: "reconciled" },
    { outcome: "succeeded", cost_source: "reconciled" },
  ]);
});

test("OpenAI's settings offer Standard and Batch, and Batch is GPT Image 2's only", async ({ page }) => {
  await setOpenAi(page, { speed: "standard" });
  await page.goto("/settings/api-keys");
  await page.getByRole("group", { name: "OpenAI" }).getByRole("button", { name: "OpenAI settings" }).click();
  const dialog = page.getByRole("dialog", { name: "OpenAI settings" });
  await expect(dialog.getByRole("tab")).toHaveText(["Speed", "Limits"]);
  await expect(dialog.getByRole("radio")).toHaveCount(2);
  await expect(dialog.getByRole("radio", { name: "Batch", exact: true })).toHaveAccessibleDescription(
    /^GPT Image 2 only/,
  );
});

test("GPT Image 2 at Batch waits at OpenAI at half price, then lands", async ({ page }) => {
  test.setTimeout(120_000);
  await setOpenAi(page, { speed: "batch" });
  const prompt = unique("Ceramic bowls on linen, soft light");
  const generate = await compose(page, { model: GPT2, prompt });
  // Medium at 1:1 and 1K is 1,756 output tokens, at Batch's $15 per million.
  await expect(generate).toContainText(/About\s*\$0\.026/);
  await expect(generate).toContainText("Batch");
  await generate.click();
  await expect(
    page.locator('main li[aria-busy="true"]').filter({ hasText: "Waiting at OpenAI" }),
  ).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(images(page, prompt)).toHaveCount(1, { timeout: 90_000 });

  const home = await libraryRoot(page.request, await sessionToken(page.request));
  expect(
    queryDb(
      home,
      `SELECT s.speed, u.speed AS logged FROM job_sets s JOIN usage_log u ON u.job_set_id = s.id WHERE s.prompt = ?`,
      prompt,
    ),
  ).toEqual([{ speed: "batch", logged: "batch" }]);
});

test("GPT Image 2.5 Flare has no Batch, so it runs at Standard and says so where the price shows", async ({
  page,
}) => {
  await setOpenAi(page, { speed: "batch" });
  const prompt = unique("A fox in fresh snow, Flare at Standard");
  const generate = await compose(page, { model: FLARE, prompt });
  await expect(generate).toContainText(/About\s*\$0\.013/);
  await expect(generate).toContainText("Standard for this model");
  await generate.hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "GPT Image 2.5 Flare has no Batch, so it runs at Standard.",
  );
  await generate.click();
  await expect(images(page, prompt)).toHaveCount(1, { timeout: 20_000 });
});
