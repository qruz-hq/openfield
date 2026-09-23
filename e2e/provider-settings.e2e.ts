import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, FAKE_KEY, libraryRoot, queryDb, restartServer, SESSION_HEADER, sessionToken } from "./support";

// M0.5-14: Google's settings modal from each key card state, Batch runs end to end (a restart while
// one waits, the finish toast and system notification, cancel), Flex on a model without it, the
// Flex busy rule both ways, and Runs at once. Fake models answer every call; "#fake:" prompt tags
// pick the outcome. The tests share one server, so each sets the speed it needs.

test.describe.configure({ mode: "serial" });

const PRO = "google:gemini-3-pro-image";
const NB2 = "google:gemini-3.1-flash-image";

interface Recorded {
  asks: number;
  shown: { title: string; body?: string; tag?: string }[];
}

/**
 * Stands in for the browser's Notification, so the suite sees what Openfield asks for and shows.
 * `answer` is what the permission prompt answers; "denied" starts denied, as after a past refusal.
 */
async function recordNotifications(page: Page, answer: "granted" | "denied") {
  await page.addInitScript((answer) => {
    const w = window as unknown as { __notifications: Recorded };
    const saved = sessionStorage.getItem("e2e.notifications");
    w.__notifications = saved ? JSON.parse(saved) : { asks: 0, shown: [] };
    const keep = () => sessionStorage.setItem("e2e.notifications", JSON.stringify(w.__notifications));
    const state = () =>
      (sessionStorage.getItem("e2e.permission") ??
        (answer === "denied" ? "denied" : "default")) as NotificationPermission;
    class RecordingNotification {
      onclick: (() => void) | null = null;
      static get permission() {
        return state();
      }
      static requestPermission() {
        w.__notifications.asks++;
        keep();
        sessionStorage.setItem("e2e.permission", answer);
        return Promise.resolve(answer);
      }
      constructor(title: string, options?: NotificationOptions) {
        w.__notifications.shown.push({ title, body: options?.body, tag: options?.tag });
        keep();
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", { value: RecordingNotification, configurable: true });
  }, answer);
}

const notifications = (page: Page) =>
  page.evaluate(() => (window as unknown as { __notifications: Recorded }).__notifications);

/** Google's settings, through the API: for tests whose subject is something else. */
async function setGoogle(page: Page, values: Record<string, string | number>) {
  const token = await sessionToken(page.request);
  await api(page.request, token, "PUT", "/api/settings/keys/google", { apiKey: FAKE_KEY });
  await api(page.request, token, "PATCH", "/api/providers/google/settings", { values });
}

/** Opens Google's settings from its key card and returns the modal. */
async function openGoogleSettings(page: Page): Promise<Locator> {
  await page.getByRole("group", { name: "Google" }).getByRole("button", { name: "Google settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Google settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Opens the Image tab with a model, a prompt and an image count, ready to Generate. */
async function compose(page: Page, opts: { model?: string; prompt: string; images?: number }) {
  await page.goto(opts.model ? `/image?model=${encodeURIComponent(opts.model)}` : "/image");
  const prompt = page.getByRole("textbox", { name: "Describe the image you want" });
  await prompt.fill(opts.prompt);
  const count = page.getByRole("group", { name: "Images" }).getByRole("status");
  const wanted = opts.images ?? 1;
  // The composer keeps the last count, so step either way.
  for (let n = Number(await count.textContent()); n !== wanted; ) {
    const up = n < wanted;
    await page.getByRole("button", { name: up ? "More images" : "Fewer images" }).click();
    n += up ? 1 : -1;
    await expect(count).toHaveText(String(n));
  }
  return page.getByRole("button", { name: /^Generate/ });
}

let prompts = 0;
/** A prompt no earlier run used, so a repeat of the suite on the same library finds only its own images. */
const unique = (prompt: string) => `${prompt} ${Date.now().toString(36)}${prompts++}`;

/** The run's finished images in the feed. */
const images = (page: Page, prompt: string) =>
  page.getByRole("listitem", { name: new RegExp(`^${escapeRegExp(prompt)} · `) }).locator("img");

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The newest run's id, from its first tile. */
const runId = async (tile: Locator) => (await tile.first().getAttribute("data-job-set"))!;

// Set outside Openfield is covered by key-outside.e2e.ts, on a server with the key in its environment.
test("Google's settings open in a modal from every key card state: Speed, When it's busy, then Limits", async ({
  page,
}) => {
  // Start from no key and the default settings, whatever ran before.
  const token = await sessionToken(page.request);
  await api(page.request, token, "DELETE", "/api/settings/keys/google");
  await api(page.request, token, "PATCH", "/api/providers/google/settings", {
    values: { speed: "standard", flexBusy: "wait", concurrencyCap: 4 },
  });
  await page.goto("/settings/api-keys");
  const google = page.getByRole("group", { name: "Google" });
  const status = google.getByRole("status");
  const settingsButton = google.getByRole("button", { name: "Google settings" });

  // Not connected: the modal works before there's a key.
  await expect(status).toHaveText("Not connected");
  let dialog = await openGoogleSettings(page);
  await expect(dialog.getByRole("tab")).toHaveText(["Speed", "When it's busy", "Limits"]);
  await expect(dialog.getByRole("tab", { name: "Speed" })).toHaveAttribute("aria-selected", "true");
  const speed = (name: string) => dialog.getByRole("radio", { name, exact: true });
  await expect(dialog.getByRole("radio")).toHaveCount(4);
  await expect(speed("Standard")).toBeChecked();
  await expect(speed("Standard")).toHaveAccessibleDescription(/\$0\.034–0\.24 per image/);
  await expect(speed("Flex")).toHaveAccessibleDescription(/^Nano Banana Pro only \$0\.067–0\.12 per image/);
  await expect(speed("Batch")).toHaveAccessibleDescription(/^\$0\.017–0\.12 per image Half price\./);
  await expect(speed("Priority")).toHaveAccessibleDescription(
    /^Nano Banana Pro only \$0\.24–0\.43 per image/,
  );

  // When it's busy is its own panel: in use at Flex, priced at what each choice bills.
  await speed("Flex").click();
  await expect(dialog.getByRole("status").filter({ hasText: "Saved" })).toHaveCount(1);
  const busyTab = dialog.getByRole("tab", { name: "When it's busy" });
  await busyTab.click();
  const keepTrying = dialog.getByRole("radio", { name: "Keep trying at Flex price" });
  await expect(keepTrying).toBeChecked();
  await expect(keepTrying).toBeEnabled();
  await expect(keepTrying).toHaveAccessibleDescription(/^\$0\.067–0\.12 per image/);
  await expect(dialog.getByRole("radio", { name: "Switch to Standard" })).toHaveAccessibleDescription(
    /^\$0\.13–0\.24 per image/,
  );

  // Batch leaves it in view but still, with a note that jumps back to Speed.
  await dialog.getByRole("tab", { name: "Speed" }).click();
  await speed("Batch").click();
  await expect(
    dialog.getByText(/^Batch runs keep going at Google even if you close Openfield/),
  ).toBeVisible();
  await busyTab.click();
  await expect(dialog.getByText("Only used when Speed is Flex. Your speed is Batch.")).toBeVisible();
  await expect(keepTrying).toBeChecked();
  await expect(keepTrying).toBeDisabled();
  await dialog.getByRole("button", { name: "Change speed" }).click();
  await expect(dialog.getByRole("tab", { name: "Speed" })).toBeFocused();
  await expect(speed("Batch")).toBeChecked();

  // Limits is Openfield's own panel, last, with Runs at once. Arrow keys move between panels.
  await dialog.getByRole("tab", { name: "Speed" }).press("ArrowDown");
  await expect(busyTab).toBeFocused();
  await busyTab.press("ArrowDown");
  await expect(dialog.getByRole("tab", { name: "Limits" })).toBeFocused();
  await expect(dialog.getByRole("tab", { name: "Limits" })).toHaveAttribute("aria-selected", "true");
  const runs = dialog.getByRole("group", { name: "Runs at once" });
  await expect(runs.getByRole("status")).toHaveText("4");
  await expect(
    dialog.getByText("Openfield's own limits for your Google key. Google doesn't see these."),
  ).toBeVisible();

  // Closing hands focus back, and the choice was saved.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(settingsButton).toBeFocused();
  const saved = await api<{ values: Record<string, unknown> }>(
    page.request,
    token,
    "GET",
    "/api/providers/google/settings",
  );
  expect(saved.values).toMatchObject({ speed: "batch", flexBusy: "wait", concurrencyCap: 4 });
  // Nothing about the company's settings sits under the card any more.
  await expect(google.getByText("Runs at once")).toHaveCount(0);
  // The model tags follow the speed: Batch halves Nano Banana Pro's 1K price.
  await expect(google.getByText("~$0.067").first()).toBeVisible();

  // Key rejected: a saved key that stopped working.
  await api(page.request, token, "PUT", "/api/settings/keys/google", {
    apiKey: "AIza-this-key-is-invalid-000",
  });
  await api(page.request, token, "POST", "/api/settings/keys/google/test", {});
  await page.reload();
  await expect(status).toHaveText("Key rejected");
  dialog = await openGoogleSettings(page);
  await expect(speed("Batch")).toBeChecked();
  await page.keyboard.press("Escape");

  // Checking: the modal opens while a key is being checked.
  await google.getByRole("button", { name: "Change key" }).click();
  await google.getByRole("textbox", { name: "API key" }).fill(FAKE_KEY);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const checkRoute = "**/api/settings/keys/google/test";
  await page.route(checkRoute, async (route) => {
    await held;
    await route.continue();
  });
  await google.getByRole("button", { name: "Check key" }).click();
  await expect(status).toHaveText("Checking");
  dialog = await openGoogleSettings(page);
  await expect(speed("Batch")).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  release();

  // Connected: the card also shows the speed that isn't the default.
  await expect(status).toHaveText("Connected");
  await page.unroute(checkRoute);
  await expect(google.getByText("Batch", { exact: true })).toBeVisible();
  // Screen readers hear which setting the pill is.
  await expect(google.getByText("Speed: Batch")).toHaveCount(1);
  dialog = await openGoogleSettings(page);
  await speed("Standard").click();
  await expect(speed("Standard")).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(google.getByText("Batch", { exact: true })).toHaveCount(0);
});

test("a Batch run waits at Google, survives a restart, then lands with a toast and a notification", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await recordNotifications(page, "granted");
  await setGoogle(page, { speed: "standard" });

  // Batch is picked in the modal, and the Generate label halves with it.
  await page.goto("/settings/api-keys");
  const dialog = await openGoogleSettings(page);
  await dialog.getByRole("radio", { name: "Batch", exact: true }).click();
  await page.keyboard.press("Escape");

  // Slow keeps the run at Google long enough to restart the server under it.
  const prompt = unique("A lighthouse on a cliff at dusk #fake:batch_slow");
  const generate = await compose(page, { prompt, images: 2 });
  await expect(generate).toContainText(/About\s*\$0\.13/);
  await expect(generate).toContainText("Batch");
  await generate.click();

  const waiting = page.locator('main li[aria-busy="true"]').filter({ hasText: "Waiting at Google" });
  await expect(waiting).toHaveCount(2, { timeout: 15_000 });
  await expect(waiting.first()).toContainText("Nano Banana Pro · 1:1 · 1K · Batch");
  await expect(waiting.first().getByRole("button", { name: "Cancel" })).toBeVisible();
  // The first Batch run asks once to notify when it's done.
  expect((await notifications(page)).asks).toBe(1);

  const id = await runId(waiting);
  const token = await sessionToken(page.request);
  const home = await libraryRoot(page.request, token);
  const [batch] = queryDb<{ remote_id: string | null; state: string; item_count: number }>(
    home,
    "SELECT remote_id, state, item_count FROM provider_batches WHERE job_set_id = ?",
    id,
  );
  expect(batch?.remote_id).toBeTruthy();
  expect(batch?.item_count).toBe(2);

  // Restart while it waits: the run picks up from the stored batch, never sent again or interrupted.
  await restartServer(page.request, home);
  const jobs = queryDb<{ status: string }>(home, "SELECT status FROM jobs WHERE job_set_id = ?", id);
  expect(jobs.map((j) => j.status).every((s) => s === "queued" || s === "running")).toBe(true);
  await expect(waiting).toHaveCount(2);

  // Both images land, with one toast and one system notification.
  await expect(images(page, prompt)).toHaveCount(2, { timeout: 60_000 });
  await expect(waiting).toHaveCount(0);
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Your batch is ready" });
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText("2 images from Nano Banana Pro");
  await expect
    .poll(async () => (await notifications(page)).shown.filter((n) => n.tag === id))
    .toEqual([{ title: "Openfield", body: "Your batch is ready. 2 images from Nano Banana Pro.", tag: id }]);

  const [done] = queryDb<{ state: string; remote_id: string; notified: number }>(
    home,
    "SELECT state, remote_id, notified_at IS NOT NULL AS notified FROM provider_batches WHERE job_set_id = ?",
    id,
  );
  expect(done).toEqual({ state: "succeeded", remote_id: batch!.remote_id!, notified: 1 });
  expect(queryDb(home, "SELECT COUNT(*) AS n FROM provider_batches WHERE job_set_id = ?", id)).toEqual([
    { n: 1 },
  ]);

  // Logged at the Batch price, but fake runs cost nothing and never count as spent.
  const usage = queryDb<{ speed: string; simulated: number; cost_usd: number; estimate_min: number }>(
    home,
    "SELECT speed, simulated, cost_usd, estimate_min FROM usage_log WHERE job_set_id = ?",
    id,
  );
  expect(usage).toEqual([
    { speed: "batch", simulated: 1, cost_usd: 0, estimate_min: 0.067 },
    { speed: "batch", simulated: 1, cost_usd: 0, estimate_min: 0.067 },
  ]);
  await expect(page.getByRole("banner")).toContainText(/Spent today\s*\$0\.00/);
});

test("with notifications turned down, a finished Batch run still shows its toast", async ({ page }) => {
  await recordNotifications(page, "denied");
  await setGoogle(page, { speed: "batch" });
  const prompt = unique("A foggy pine forest at sunrise");
  await (await compose(page, { prompt })).click();

  await expect(images(page, prompt)).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Your batch is ready" })).toContainText(
    "1 image from Nano Banana Pro",
  );
  expect(await notifications(page)).toEqual({ asks: 0, shown: [] });
});

test("Cancel stops the whole Batch run at Google", async ({ page }) => {
  await recordNotifications(page, "granted");
  await setGoogle(page, { speed: "batch" });
  const prompt = unique("An old fisherman on a quiet harbor #fake:batch_slow");
  await (await compose(page, { prompt, images: 2 })).click();

  const waiting = page
    .locator('main li[aria-busy="true"]')
    .filter({ hasText: /(Sending to|Waiting at) Google/ });
  await expect(waiting).toHaveCount(2, { timeout: 15_000 });
  const id = await runId(waiting);

  // The confirm opens on the safe choice and hands focus back to the tile's Cancel.
  const cancelPill = waiting.first().getByRole("button", { name: "Cancel" });
  await cancelPill.click();
  const confirm = page.getByRole("alertdialog", { name: "Cancel this Batch run?" });
  await expect(confirm).toContainText(
    "Both images stop together. You may still be charged for work that already started.",
  );
  await expect(confirm.getByRole("button", { name: "Keep waiting" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(cancelPill).toBeFocused();

  await cancelPill.click();
  await confirm.getByRole("button", { name: "Cancel run" }).click();
  // Sent images end when Google stops: the toast and tiles say so, and Cancel is off meanwhile.
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Stopping at Google. You may still be charged" }),
  ).toBeVisible();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: /^Canceled\./ })).toHaveCount(0);
  await expect(
    page.locator(`main li[data-job-set="${id}"]`).filter({ hasText: "Waiting at Google" }),
  ).toHaveCount(0);

  // Both tiles of this run end canceled, once Google has stopped the batch.
  const canceled = page.locator(`main li[data-job-set="${id}"]`).and(
    page.getByRole("listitem", {
      name: "Canceled. You may still be charged for work that already started.",
    }),
  );
  await expect(canceled).toHaveCount(2, { timeout: 20_000 });
  await expect(canceled.first().getByRole("button", { name: "Recreate" })).toBeVisible();

  const home = await libraryRoot(page.request, await sessionToken(page.request));
  await expect
    .poll(() => queryDb(home, "SELECT state, error_code FROM provider_batches WHERE job_set_id = ?", id))
    .toEqual([{ state: "canceled", error_code: "canceled" }]);
  expect(queryDb(home, "SELECT status FROM jobs WHERE job_set_id = ? ORDER BY idx", id)).toEqual([
    { status: "canceled" },
    { status: "canceled" },
  ]);
  // A run the person stopped doesn't announce itself as done.
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Your batch" })).toHaveCount(0);
  expect((await notifications(page)).shown).toEqual([]);
});

test("Flex on Nano Banana 2 runs at Standard and says so where the price shows", async ({ page }) => {
  await setGoogle(page, { speed: "flex", flexBusy: "wait" });

  // The key card's model tags: the two models without Flex say they run at Standard.
  await page.goto("/settings/api-keys");
  const google = page.getByRole("group", { name: "Google" });
  await expect(google.getByText("· Standard", { exact: true })).toHaveCount(2);
  await expect(google.getByTitle("Nano Banana 2 has no Flex, so it runs at Standard.")).toHaveCount(1);

  // Nano Banana Pro offers Flex: half its 1K price, with the speed named.
  let generate = await compose(page, { model: PRO, prompt: "A red kite over the dunes" });
  await expect(generate).toContainText(/About\s*\$0\.067/);
  await expect(generate).toContainText("Flex");
  await expect(generate).not.toContainText("Standard for this model");

  // Nano Banana 2 doesn't: its Standard price, and a plain note.
  const prompt = unique("A red kite over the dunes, Nano Banana 2");
  generate = await compose(page, { model: NB2, prompt });
  await expect(generate).toContainText(/About\s*\$0\.067/);
  await expect(generate).toContainText("Standard for this model");
  await generate.hover();
  await expect(page.getByRole("tooltip")).toContainText("Nano Banana 2 has no Flex, so it runs at Standard.");

  await generate.click();
  await expect(images(page, prompt)).toHaveCount(1, { timeout: 20_000 });
  const home = await libraryRoot(page.request, await sessionToken(page.request));
  expect(
    queryDb(
      home,
      `SELECT s.speed, j.speed_used, u.speed AS logged FROM job_sets s
       JOIN jobs j ON j.job_set_id = s.id JOIN usage_log u ON u.job_id = j.id WHERE s.prompt = ?`,
      prompt,
    ),
  ).toEqual([{ speed: "standard", speed_used: "standard", logged: "standard" }]);
});

test("when Flex is busy, Openfield keeps trying at Flex or switches to Standard, as set", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await setGoogle(page, { speed: "flex", flexBusy: "wait" });
  const home = await libraryRoot(page.request, await sessionToken(page.request));
  const ran = (prompt: string) =>
    queryDb<{ speed: string; speed_used: string; logged: string; cost_usd: number; estimate_min: number }>(
      home,
      `SELECT s.speed, j.speed_used, u.speed AS logged, u.cost_usd, u.estimate_min FROM job_sets s
       JOIN jobs j ON j.job_set_id = s.id JOIN usage_log u ON u.job_id = j.id WHERE s.prompt = ?`,
      prompt,
    );

  // Keep trying: the fake answers busy once, the tile says so, then the image comes at Flex.
  const waitPrompt = unique("A windmill in fog #fake:flex_busy");
  await (await compose(page, { prompt: waitPrompt })).click();
  await expect(
    page.locator("main li").filter({ hasText: /Flex is busy\. Trying again in \d+s\./ }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(images(page, waitPrompt)).toHaveCount(1, { timeout: 30_000 });
  expect(ran(waitPrompt)).toEqual([
    { speed: "flex", speed_used: "flex", logged: "flex", cost_usd: 0, estimate_min: 0.067 },
  ]);

  // Switch to Standard, set in the modal: the busy answer is resent at once at Standard.
  await page.goto("/settings/api-keys");
  const dialog = await openGoogleSettings(page);
  await expect(dialog.getByRole("radio", { name: "Flex", exact: true })).toBeChecked();
  await dialog.getByRole("tab", { name: "When it's busy" }).click();
  await dialog.getByRole("radio", { name: "Switch to Standard" }).click();
  await expect(dialog.getByRole("radio", { name: "Switch to Standard" })).toBeChecked();
  await page.keyboard.press("Escape");

  const switchPrompt = unique("A windmill in the rain #fake:flex_busy");
  await (await compose(page, { prompt: switchPrompt })).click();
  await expect(images(page, switchPrompt)).toHaveCount(1, { timeout: 30_000 });
  expect(ran(switchPrompt)).toEqual([
    { speed: "flex", speed_used: "standard", logged: "standard", cost_usd: 0, estimate_min: 0.134 },
  ]);
  await expect(page.getByRole("banner")).toContainText(/Spent today\s*\$0\.00/);
});

test("Runs at once, set in the Limits panel, holds Google to that many at a time", async ({ page }) => {
  await setGoogle(page, { speed: "standard", concurrencyCap: 4 });
  await page.goto("/settings/api-keys");
  const dialog = await openGoogleSettings(page);
  await dialog.getByRole("tab", { name: "Limits" }).click();
  const runs = dialog.getByRole("group", { name: "Runs at once" });
  for (const expected of ["3", "2", "1"]) {
    await runs.getByRole("button", { name: "Fewer at once" }).click();
    await expect(runs.getByRole("status")).toHaveText(expected);
  }
  await expect(runs.getByRole("button", { name: "Fewer at once" })).toBeDisabled();
  await page.keyboard.press("Escape");
  const token = await sessionToken(page.request);
  await expect
    .poll(async () => {
      const res = await page.request.get("/api/providers", { headers: { [SESSION_HEADER]: token } });
      return ((await res.json()) as { id: string; concurrencyCap: number }[]).find((p) => p.id === "google")
        ?.concurrencyCap;
    })
    .toBe(1);

  const prompt = unique("Three paper boats on a pond");
  await (await compose(page, { prompt, images: 3 })).click();
  // One at a time: the others wait their turn in line.
  await expect(page.locator("main li").filter({ hasText: "1st in line" })).toBeVisible({ timeout: 10_000 });
  await expect(images(page, prompt)).toHaveCount(3, { timeout: 30_000 });

  const home = await libraryRoot(page.request, token);
  const jobs = queryDb<{ started_at: string; finished_at: string }>(
    home,
    `SELECT j.started_at, j.finished_at FROM jobs j JOIN job_sets s ON s.id = j.job_set_id
     WHERE s.prompt = ? ORDER BY j.started_at`,
    prompt,
  );
  expect(jobs).toHaveLength(3);
  for (let i = 1; i < jobs.length; i++) {
    expect(Date.parse(jobs[i]!.started_at)).toBeGreaterThanOrEqual(Date.parse(jobs[i - 1]!.finished_at));
  }
  await setGoogle(page, { concurrencyCap: 4 });
});
