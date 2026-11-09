import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, FAKE_KEY, sessionToken } from "./support";

// Seedream in the composer and in BytePlus's settings, with only a BytePlus key: Lite's Images chip
// and its related set (design Zn3DlLHTxJ, h2bPH8Zad4), "· Fast" on Generate for 5.0 Pro (DcHKBZVXLW)
// with no "Priority" anywhere, and the Speed panel (GGmHeIoPpk). The fake BytePlus answers every call.

const LITE = "byteplus:seedream-5-0-260128";
const PRO = "byteplus:dola-seedream-5-0-pro-260628";

async function byteplusOnly(page: Page, speed: "standard" | "priority") {
  const token = await sessionToken(page.request);
  await api(page.request, token, "PUT", "/api/settings/keys/byteplus", { apiKey: FAKE_KEY });
  await api(page.request, token, "PATCH", "/api/providers/byteplus/settings", { values: { speed } });
}

let prompts = 0;
const unique = (prompt: string) => `${prompt} ${Date.now().toString(36)}${prompts++}`;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The box a node describes, as the browser drew it. */
const drawn = (el: Locator) =>
  el.evaluate((node) => {
    const s = getComputedStyle(node);
    const r = node.getBoundingClientRect();
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
      display: s.display,
    };
  });

const font = (el: Locator) =>
  el.evaluate((node) => {
    const s = getComputedStyle(node);
    return `${s.fontSize}/${s.lineHeight} ${s.fontWeight}`;
  });

const icon = (el: Locator) =>
  el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return `${r.width}x${r.height} ${node.getAttribute("class")?.match(/lucide-[a-z-]+/)?.[0]}`;
  });

test("Lite's Images chip turns on a related set, priced up to the count and sent as one set", async ({
  page,
}) => {
  await byteplusOnly(page, "standard");
  await page.goto(`/image?model=${encodeURIComponent(LITE)}`);
  const prompt = unique("four frames of a paper boat");
  await page.getByRole("textbox", { name: "Describe the image you want" }).fill(prompt);

  // Off, the chip is the count; its popover holds the stepper and the switch.
  const chip = page.getByRole("button", { name: /^Images: / });
  await expect(chip).toHaveText("1");
  await chip.click();
  const popover = page.getByRole("dialog").filter({ hasText: "Related set" });
  await expect(popover).toBeVisible();
  // At one image there's no set to make, so the switch waits and says why.
  const toggle = popover.getByRole("switch", { name: "Related set" });
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAccessibleDescription("A set needs 2 or more images.");
  for (let n = 1; n < 4; n++) await popover.getByRole("button", { name: "More images" }).click();
  await expect(popover.getByRole("status")).toHaveText("4");
  await expect(chip).toHaveText("4");
  const generate = page.getByRole("button", { name: /^Generate/ });
  await expect(generate).toHaveAccessibleName("Generate About $0.14");

  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(popover).toContainText(
    "You get up to 4 images in one go and pay only for the ones that come back.",
  );
  await expect(chip).toHaveText("Up to 4");
  await expect(generate).toHaveAccessibleName("Generate Up to $0.14");

  // Measured against the nodes, open as the design draws it.
  expect(await drawn(chip)).toMatchObject({
    h: 40,
    radius: "12px",
    padding: "0px 12px 0px 12px",
    gap: "6px",
    align: "center",
  });
  const [lead, chevron] = [chip.locator("svg").first(), chip.locator("svg").last()];
  expect(await icon(lead)).toBe("14x14 lucide-gallery-horizontal");
  expect(await icon(chevron)).toBe("12x12 lucide-chevron-up");
  expect(await font(chip.locator("span"))).toBe("14px/17px 500");
  // The icon is primary like the value; the chevron tertiary like the popover's description.
  const color = (el: Locator) => el.evaluate((node) => getComputedStyle(node).color);
  expect(await color(lead)).toBe(await color(chip.locator("span")));
  expect(await color(chevron)).toBe(await color(popover.getByText(/^Images that belong together/)));
  expect(await popover.evaluate((node) => getComputedStyle(node).boxShadow)).toContain("0px 16px 40px");
  expect(await drawn(popover)).toMatchObject({
    w: 300,
    radius: "16px",
    padding: "8px 8px 8px 8px",
    gap: "4px",
    direction: "column",
  });
  const count = popover.locator("> div").first();
  expect(await drawn(count)).toMatchObject({
    padding: "4px 10px 4px 10px",
    justify: "space-between",
    align: "center",
  });
  expect(await font(count.locator("> span"))).toBe("13px/16px 500");
  expect(await drawn(popover.getByRole("group", { name: "Images" }))).toMatchObject({
    h: 38,
    radius: "10px",
  });
  expect(await drawn(popover.locator("hr"))).toMatchObject({ h: 1 });
  const row = popover.locator("> div").last();
  expect(await drawn(row)).toMatchObject({
    padding: "8px 10px 8px 10px",
    gap: "16px",
    justify: "space-between",
    align: "flex-start",
  });
  expect(await drawn(row.locator("> div"))).toMatchObject({ gap: "2px", direction: "column" });
  expect(await font(row.getByText("Related set", { exact: true }))).toBe("13px/16px 500");
  expect(await font(row.getByText(/^Images that belong together/))).toBe("12px/17.4px 400");
  expect(await drawn(toggle)).toMatchObject({ w: 32, h: 18 });
  await page.keyboard.press("Escape");

  const sent = page.waitForRequest((r) => r.url().endsWith("/api/generate") && r.method() === "POST");
  await generate.click();
  const body = (await sent).postDataJSON() as { batch: number; providerOptions?: Record<string, unknown> };
  expect(body.batch).toBe(4);
  expect(body.providerOptions).toEqual({ relatedSet: true });
  const images = page
    .getByRole("listitem", { name: new RegExp(`^${escapeRegExp(prompt)} · `) })
    .locator("img");
  await expect(images).toHaveCount(4, { timeout: 20_000 });

  // The switch is Lite's own, and it's still on after a reload.
  await page.reload();
  await expect(page.getByRole("button", { name: /^Images: / })).toHaveText("Up to 4");
});

test("5.0 Pro at Fast says so on Generate, and nothing reads Priority", async ({ page }) => {
  await byteplusOnly(page, "priority");
  await page.goto(`/image?model=${encodeURIComponent(PRO)}`);
  const prompt = unique("a lighthouse at dusk");
  await page.getByRole("textbox", { name: "Describe the image you want" }).fill(prompt);
  // Pro has no related set, so it keeps the plain stepper.
  await expect(page.getByRole("group", { name: "Images" })).toBeVisible();
  const generate = page.getByRole("button", { name: /^Generate/ });
  await expect(generate).toHaveAccessibleName("Generate About $0.045 · Fast");
  expect(await drawn(generate)).toMatchObject({
    w: 144,
    h: 84,
    radius: "12px",
    gap: "3px",
    direction: "column",
  });
  const estimate = generate.locator("> span").nth(1);
  expect(await drawn(estimate)).toMatchObject({ gap: "4px" });
  // Mono 11 sits on a 15px line, as the node's text box does.
  expect(await font(estimate.getByText("$0.045"))).toBe("11px/15px 400");
  await generate.hover();
  await expect(page.getByRole("tooltip")).toContainText("Speed: Fast. Change it in BytePlus settings.");
  await expect(page.locator("body")).not.toContainText("Priority");

  await generate.click();
  const tile = page.getByRole("listitem", { name: new RegExp(`^${escapeRegExp(prompt)} · `) });
  await expect(tile.locator("img")).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator("body")).not.toContainText("Priority");
});

test("BytePlus's Speed panel: Seedream's words, no prices, and which models always use Standard", async ({
  page,
}) => {
  await byteplusOnly(page, "standard");
  await page.goto("/settings/api-keys");
  const card = page.getByRole("group", { name: "BytePlus" });
  await expect(card).toContainText("Makes images and videos");
  await card.getByRole("button", { name: "BytePlus settings" }).click();
  const dialog = page.getByRole("dialog", { name: "BytePlus settings" });
  await expect(dialog).toContainText(
    "How Seedream reads your prompt before it draws. Speed doesn't change the price.",
  );
  const standard = dialog.getByRole("radio", { name: "Standard" });
  const fast = dialog.getByRole("radio", { name: "Fast" });
  await expect(standard).toContainText("Best results. Takes a little longer.");
  await expect(fast).toContainText("Quicker, and follows your prompt a little less closely.");
  await expect(fast).toContainText("5.0 Pro and 4.0 only");
  await expect(standard).not.toContainText("only");
  await expect(dialog).not.toContainText("per image");
  const note = dialog.getByText("Seedream 5.0 Flash, 5.0 Lite, and 4.5 always use Standard.");
  await expect(note).toBeVisible();

  // Measured against Ea88MDLWAj and the Fast card's badge, once the dialog has finished opening.
  await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  const box = note.locator("..");
  expect(await drawn(box)).toMatchObject({
    radius: "10px",
    padding: "10px 12px 10px 12px",
    gap: "10px",
    align: "center",
  });
  expect(await icon(box.locator("svg"))).toBe("14x14 lucide-info");
  expect(await font(note)).toBe("12px/17.4px 400");
  const badge = fast.getByText("5.0 Pro and 4.0 only");
  expect(await drawn(badge)).toMatchObject({ h: 18, radius: "6px", padding: "0px 6px 0px 6px" });
  expect(await font(badge)).toBe("11px/13px 500");
  expect(await drawn(fast)).toMatchObject({ radius: "12px", padding: "14px 16px 14px 16px", gap: "12px" });

  // Picking Fast saves at once.
  await fast.click();
  await expect(fast).toBeChecked();
  await expect(dialog.getByRole("status")).toHaveText("Saved");
});
