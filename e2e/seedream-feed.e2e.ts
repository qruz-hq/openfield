import { expect, type Locator, type Page, test } from "@playwright/test";
import { newId } from "../packages/core/src/ids.ts";
import { api, FAKE_KEY, makeImage, sessionToken } from "./support";

// A layer split in the feed and the library (design eD5Y6V9gwF, 9Coal0X7pn): the Image feed and All
// images show the base alone, with a badge counting its layers that opens its Layers tab. A search
// finds the layers themselves, each marked as a layer.

test.describe.configure({ mode: "serial" });

const PRO = "byteplus:dola-seedream-5-0-pro-260628";

async function split(page: Page): Promise<string> {
  const token = await sessionToken(page.request);
  const source = await makeImage(page.request, token, `a still life ${Date.now().toString(36)}`);
  await api(page.request, token, "PUT", "/api/settings/keys/byteplus", { apiKey: FAKE_KEY });
  const accepted = await api<{ jobSet: { id: string } }>(page.request, token, "POST", "/api/layers", {
    idempotencyKey: newId(),
    model: PRO,
    image: source,
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
  return accepted.jobSet.id;
}

/** What the browser drew, for comparing against the design's node values. */
const box = (pill: Locator) =>
  pill.evaluate((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const icon = el.querySelector("svg")!;
    const text = el.querySelector("span")!;
    const t = getComputedStyle(text);
    return {
      height: r.height,
      // A pill's radius is drawn at no more than half its height.
      radius: Math.min(Number.parseFloat(s.borderTopLeftRadius), r.height / 2),
      padding: `${s.paddingLeft} ${s.paddingRight}`,
      gap: s.columnGap,
      background: s.backgroundColor,
      ring: s.boxShadow,
      blur: s.backdropFilter,
      icon: `${icon.getBoundingClientRect().width}x${icon.getBoundingClientRect().height}`,
      iconColor: getComputedStyle(icon).color,
      // The app ships the variable cut of each family.
      font: `${t.fontFamily
        .split(",")[0]!
        .replace(/"/g, "")
        .replace(/ Variable$/, "")} ${t.fontSize}/${t.lineHeight} ${t.fontWeight}`,
      color: t.color,
      iconClass: icon.getAttribute("class"),
    };
  });

test("the feed shows a split's base with its layer count, and the badge opens its layers", async ({
  page,
}) => {
  const runId = await split(page);
  await page.goto("/image");
  const tiles = page.locator(`li[data-job-set="${runId}"]`);
  // The fake makes a base and three layers; only the base is a tile.
  await expect(tiles).toHaveCount(1, { timeout: 15_000 });
  const badge = tiles.getByRole("button", { name: "Open its 3 layers" });
  await expect(badge).toHaveText("3");

  // It stays put on hover, above the scrim, and sits 10 from the tile's top left.
  await tiles.hover();
  await expect(badge).toBeVisible();
  const tile = (await tiles.boundingBox())!;
  const at = (await badge.boundingBox())!;
  expect({ left: at.x - tile.x, top: at.y - tile.y }).toEqual({ left: 10, top: 10 });

  const measured = await box(badge);
  console.log("Layers badge", JSON.stringify(measured));
  expect(measured).toMatchObject({
    height: 22,
    radius: 11,
    padding: "8px 8px",
    gap: "4px",
    blur: "blur(8px)",
    icon: "10x10",
    font: "JetBrains Mono 11px/15px 400",
    color: "rgb(245, 246, 247)",
    iconColor: "rgb(245, 246, 247)",
  });
  expect(measured.iconClass).toContain("lucide-layers");

  await badge.click();
  const dialog = page.getByRole("dialog", { name: "Image details" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/[?&]tab=layers(&|$)/);
  // The URL alone could still open on Info; the Layers tab itself must be the one showing.
  await expect(dialog.getByRole("tab", { name: "Layers" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("tabpanel", { name: "Layers" })).toBeVisible();
});

test("a search lists the layers, each with the Layer pill; All images keeps only the base", async ({
  page,
}) => {
  await split(page);
  await page.goto("/assets");
  const badges = page.getByRole("gridcell").getByRole("button", { name: "Open its 3 layers" });
  await expect(badges.first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("gridcell").getByText("Layer", { exact: true })).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search" }).fill("picture");
  const pills = page.getByRole("gridcell").getByText("Layer", { exact: true });
  // Three layers from this split, and any the test before made.
  await expect.poll(() => pills.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  const pill = pills.first().locator("..");
  const measured = await box(pill);
  console.log("Layer pill", JSON.stringify(measured));
  expect(measured).toMatchObject({
    height: 22,
    radius: 11,
    padding: "8px 8px",
    gap: "4px",
    blur: "blur(8px)",
    icon: "10x10",
    font: "Inter 11px/13px 500",
    color: "rgb(245, 246, 247)",
    iconColor: "rgb(245, 246, 247)",
  });
  expect(measured.iconClass).toContain("lucide-layers-2");
});
