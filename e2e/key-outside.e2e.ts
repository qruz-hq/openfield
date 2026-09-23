import { expect, test } from "@playwright/test";

// M0.5-14: a Google key set in the environment (OPENFIELD_GOOGLE_API_KEY, playwright.config.ts). Its
// key card says so, and Google's settings still open from it, like every other card state.

test("Google's settings open from a key card whose key is set outside Openfield", async ({ page }) => {
  await page.goto("/settings/api-keys");
  const google = page.getByRole("group", { name: "Google" });
  await expect(google.getByRole("status")).toHaveText("Set outside Openfield");
  const settingsButton = google.getByRole("button", { name: "Google settings" });
  await settingsButton.click();
  const dialog = page.getByRole("dialog", { name: "Google settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab")).toHaveText(["Speed", "When it's busy", "Limits"]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(settingsButton).toBeFocused();
});
