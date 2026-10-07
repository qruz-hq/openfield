import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import type { UsageSeriesResponse } from "../packages/core/src/schemas/usage.ts";
import { libraryRoot, sessionToken } from "./support";

// Settings > Spending (§6.9): an empty library says so, and a busy one charts its runs by day,
// week and month, adds up to what the log says, hides a model on a legend click, opens a month's
// weeks on a bar click, and keeps the monthly limit. The runs come from the seed script, written
// into this suite's own library.

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "America/Los_Angeles" });

const root = fileURLToPath(new URL("..", import.meta.url));
const money = (usd: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(usd);

/** A summary tile's figure, found from its label. */
const tile = (page: Page, label: string) =>
  page.getByText(label, { exact: true }).locator("xpath=..").locator(".text-mono-24");
const chartTitle = (page: Page) => page.getByRole("heading", { level: 3 });
const datesButton = (page: Page) => page.getByRole("button", { name: "Dates" });

/** The chart's own answer for the dates on show, as the page asked for it. */
function seriesResponse(page: Page, step: string) {
  return page.waitForResponse(
    (r) => r.url().includes("/api/usage/series") && r.url().includes(`step=${step}`) && r.ok(),
  );
}

test("a library with nothing spent says so, and still offers the limit", async ({ page }) => {
  await page.goto("/settings/spending");
  await expect(page.getByText("Nothing spent yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Set a limit" })).toBeVisible();
});

test("the tiles, chart and table add up to the log, and a legend click hides a model", async ({ page }) => {
  const token = await sessionToken(page.request);
  const home = await libraryRoot(page.request, token);
  execFileSync("bun", ["scripts/seed-usage.ts", "--home", home, "--days", "60", "--seed", "3"], {
    cwd: root,
  });

  const answer = seriesResponse(page, "day");
  await page.goto("/settings/spending");
  const data = (await (await answer).json()) as UsageSeriesResponse;
  expect(data.totals.images).toBeGreaterThan(0);

  await expect(datesButton(page)).toHaveText("Last 30 days");
  await expect(chartTitle(page)).toHaveText("Spent each day");
  await expect(tile(page, "Spent")).toHaveText(money(data.totals.usd));
  await expect(tile(page, "Images made")).toHaveText(
    new Intl.NumberFormat("en-US").format(data.totals.images),
  );
  const table = page.getByRole("table");
  await expect(table.locator("tfoot td").first()).toHaveText(money(data.totals.usd));
  await expect(table.locator("tbody tr")).toHaveCount(Math.min(data.groups.length, 8));

  // Hiding the biggest model takes it out of every total, and keeps it listed.
  const biggest = data.groups[0]!;
  const legend = page.getByRole("button", { name: /^Hide / }).first();
  await legend.click();
  await expect(page.getByRole("button", { name: /^Show / })).toHaveAttribute("aria-pressed", "false");
  await expect(tile(page, "Spent")).toHaveText(money(data.totals.usd - biggest.usd));
  await expect(table.locator("tbody tr")).toHaveCount(Math.min(data.groups.length, 8));
  await page.getByRole("button", { name: /^Show / }).click();
  await expect(tile(page, "Spent")).toHaveText(money(data.totals.usd));
});

test("months draw as bars under the limit line, and a month opens its weeks", async ({ page }) => {
  await page.goto("/settings/spending");
  await page.getByRole("button", { name: "Set a limit" }).click();
  await page.getByRole("textbox", { name: "Monthly limit in dollars" }).fill("20");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText("$20.00 a month. Openfield asks first when a run would go past it."),
  ).toBeVisible();

  await datesButton(page).click();
  await page.getByRole("option", { name: "Last 12 months" }).click();
  // Too long for days: the step moves to months on its own.
  const steps = page.getByRole("radiogroup", { name: "Step" });
  await expect(steps.getByRole("radio", { name: "Day" })).toBeDisabled();
  await expect(steps.getByRole("radio", { name: "Month" })).toBeChecked();
  await page.getByRole("radiogroup", { name: "Chart" }).getByRole("radio", { name: "Bars" }).click();
  await expect(chartTitle(page)).toHaveText("Spent each month");
  await expect(page.getByText("Monthly limit", { exact: true })).toBeVisible();

  // This month's bar is the last one: hover it, then open it.
  const plot = page.getByRole("group", { name: /^Spent each month\./ });
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width - 40, box.y + 150);
  await expect(page.getByText("Click to see its weeks")).toBeVisible();
  await page.mouse.click(box.x + box.width - 40, box.y + 150);
  // A month's weeks, or its days when this month is under a week old (the first days of a month).
  await expect(chartTitle(page)).toHaveText(/^Spent each (week|day)$/);
  await expect(datesButton(page)).not.toHaveText("Last 12 months");
});

test("Spent today in the top nav opens today's figures", async ({ page }) => {
  await page.goto("/image");
  await page.getByRole("link", { name: /Spent today/ }).click();
  await expect(page).toHaveURL(/\/settings\/spending$/);
  await expect(datesButton(page)).toHaveText("Today");
  await expect(chartTitle(page)).toHaveText("Spent each hour");
});
