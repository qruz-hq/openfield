import { expect, type Locator, type Page, test } from "@playwright/test";
import { api, FAKE_KEY, libraryRoot, queryDb, restartServer, sessionToken } from "./support";

// M0.6: no image lost to a restart (§0.4, §0.12, §8.4.5). A stop drains the calls that can't
// resume and leaves resumable ones at the company; after a crash, a resumable call is picked up by
// the same id and one that can't resume runs again, once, with a note on its tile and in the usage
// log. This suite's server runs its slow fakes for 8 seconds (playwright.config.ts): "#fake:slow" on
// Google, which can't resume, and "#fake:resume_slow" on the test company's resumable model.

test.describe.configure({ mode: "serial" });

const GOOGLE = "google:gemini-3.1-flash-image";
const RESUMABLE = "fake:resumable-image";
const RERUN_SETTING = "Run interrupted images again after a restart";

let prompts = 0;
/** A prompt no earlier run used, so each test finds only its own tiles and rows. */
const unique = (prompt: string) => `${prompt} ${Date.now().toString(36)}${prompts++}`;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A finished image's tile, by the prompt that made it. */
const imageTile = (page: Page, prompt: string) =>
  page.getByRole("listitem", { name: new RegExp(`^${escapeRegExp(prompt)} · `) });

/** Every tile of one run, whatever its state. */
const runTiles = (page: Page, id: string) => page.locator(`main li[data-job-set="${id}"]`);

async function setup(page: Page): Promise<{ token: string; home: string }> {
  const token = await sessionToken(page.request);
  await api(page.request, token, "PUT", "/api/settings/keys/google", { apiKey: FAKE_KEY });
  await api(page.request, token, "PUT", "/api/settings/keys/fake", { apiKey: "fake-e2e-resume-key" });
  await api(page.request, token, "PATCH", "/api/providers/google/settings", {
    values: { speed: "standard" },
  });
  await api(page.request, token, "PATCH", "/api/settings", { rerunInterrupted: true });
  return { token, home: await libraryRoot(page.request, token) };
}

/** Starts one image of `model` from the composer and returns its run id once its tile is working. */
async function generate(page: Page, model: string, prompt: string): Promise<string> {
  await page.goto(`/image?model=${encodeURIComponent(model)}`);
  await page.getByRole("textbox", { name: "Describe the image you want" }).fill(prompt);
  const count = page.getByRole("group", { name: "Images" }).getByRole("status");
  while (Number(await count.textContent()) > 1) {
    await page.getByRole("button", { name: "Fewer images" }).click();
  }
  const accepted = page.waitForResponse((res) => res.url().endsWith("/api/generate") && res.ok());
  await page.getByRole("button", { name: /^Generate/ }).click();
  const id = ((await (await accepted).json()) as { jobSet: { id: string } }).jobSet.id;
  await expect(page.locator(`main li[data-job-set="${id}"][aria-busy="true"]`)).toBeVisible({
    timeout: 10_000,
  });
  return id;
}

interface JobRow {
  status: string;
  attempt: number;
  resumable: number;
  ref: string | null;
  resumed: number;
  rerun: number;
}

const jobOf = (home: string, id: string) =>
  queryDb<JobRow>(
    home,
    `SELECT status, attempt, resumable, provider_job_id AS ref, resumed_at IS NOT NULL AS resumed,
       rerun_at IS NOT NULL AS rerun FROM jobs WHERE job_set_id = ?`,
    id,
  )[0];

const usageOf = (home: string, id: string) =>
  queryDb<{ outcome: string; rerun: number }>(
    home,
    "SELECT outcome, rerun FROM usage_log WHERE job_set_id = ?",
    id,
  );

/** Waits until the call is at the company with its id stored: from here a crash can't lose it. */
async function storedId(home: string, id: string): Promise<string> {
  let ref: string | null = null;
  await expect
    .poll(
      () => {
        ref =
          queryDb<{ ref: string | null }>(
            home,
            "SELECT provider_job_id AS ref FROM jobs WHERE job_set_id = ? AND handle IS NOT NULL",
            id,
          )[0]?.ref ?? null;
        return ref;
      },
      { timeout: 15_000 },
    )
    .not.toBeNull();
  return ref!;
}

/** Waits until a Google call is out: its job is past pending, so a stop now cuts into it. */
async function sent(home: string, id: string) {
  await expect.poll(() => jobOf(home, id)?.status).toBe("submitting");
}

async function expectInterrupted(tile: Locator) {
  await expect(tile).toHaveAccessibleName("Interrupted.", { timeout: 20_000 });
  await expect(tile.getByRole("button", { name: "Try again" })).toBeVisible();
}

test("a graceful restart saves a running Google image first, and picks a resumable one up by id", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { home } = await setup(page);
  const googlePrompt = unique("A lighthouse at dusk #fake:slow");
  const resumablePrompt = unique("A harbor at night #fake:resume_slow");
  const google = await generate(page, GOOGLE, googlePrompt);
  await sent(home, google);
  const resumable = await generate(page, RESUMABLE, resumablePrompt);
  const ref = await storedId(home, resumable);

  // The old server exits only once the Google image is saved, so it's there before the new one starts.
  await restartServer(page.request, home);
  expect(jobOf(home, google)).toMatchObject({ status: "succeeded", attempt: 1, rerun: 0 });
  expect(usageOf(home, google)).toEqual([{ outcome: "succeeded", rerun: 0 }]);

  // The resumable call kept going at the company: the new server follows the same id.
  const working = runTiles(page, resumable);
  await expect(working).toContainText("Picking up where it left off", { timeout: 15_000 });
  await expect(imageTile(page, resumablePrompt)).toHaveCount(1, { timeout: 30_000 });
  expect(jobOf(home, resumable)).toEqual({
    status: "succeeded",
    attempt: 1,
    resumable: 1,
    ref,
    resumed: 1,
    rerun: 0,
  });
  expect(usageOf(home, resumable)).toEqual([{ outcome: "succeeded", rerun: 0 }]);

  // Neither image was cut off, so neither carries a restart note.
  await expect(imageTile(page, googlePrompt)).toHaveCount(1);
  for (const prompt of [googlePrompt, resumablePrompt]) {
    await expect(imageTile(page, prompt)).not.toHaveAccessibleName(/Ran again after a restart/);
  }
});

test("killed mid-call, a resumable image picks up by the same id and a Google image runs again once", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { home } = await setup(page);
  const resumablePrompt = unique("A foggy pier #fake:resume_slow");
  const googlePrompt = unique("A red kite over the dunes #fake:slow");
  const resumable = await generate(page, RESUMABLE, resumablePrompt);
  const ref = await storedId(home, resumable);
  const google = await generate(page, GOOGLE, googlePrompt);
  await sent(home, google);

  await restartServer(page.request, home, { crash: true });

  // Resumable: the same call at the company, never sent again.
  await expect(runTiles(page, resumable)).toContainText("Picking up where it left off", {
    timeout: 15_000,
  });
  // Can't resume: sent again, and the tile says it may cost twice while it runs.
  const rerunning = runTiles(page, google);
  await expect(rerunning).toContainText("Running again after a restart", { timeout: 15_000 });
  await expect(rerunning).toContainText("You may be charged twice.");

  await expect(imageTile(page, resumablePrompt)).toHaveCount(1, { timeout: 30_000 });
  await expect(imageTile(page, googlePrompt)).toHaveCount(1, { timeout: 30_000 });
  expect(jobOf(home, resumable)).toMatchObject({
    status: "succeeded",
    attempt: 1,
    ref,
    resumed: 1,
    rerun: 0,
  });
  expect(jobOf(home, google)).toMatchObject({ status: "succeeded", attempt: 1, resumed: 0, rerun: 1 });
  expect(usageOf(home, resumable)).toEqual([{ outcome: "succeeded", rerun: 0 }]);
  expect(usageOf(home, google)).toEqual([{ outcome: "succeeded", rerun: 1 }]);

  // The image keeps a note, and its name tells a screen reader what the note leaves out.
  const ranAgain = imageTile(page, googlePrompt);
  await expect(ranAgain).toContainText("Ran again after a restart");
  await expect(ranAgain).toHaveAccessibleName(/Ran again after a restart\. You may be charged twice\.$/);
  await expect(imageTile(page, resumablePrompt)).not.toContainText("Ran again after a restart");

  // Spending says it too.
  await page.goto("/settings/spending");
  await expect(
    page.getByText(/^Ran \d+ images? again after a restart\. You may be charged twice\.$/),
  ).toBeVisible();
});

test("killed again while it runs again, an image ends interrupted instead of running a third time", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { home } = await setup(page);
  const prompt = unique("Three paper boats on a pond #fake:slow");
  const id = await generate(page, GOOGLE, prompt);
  await sent(home, id);
  await restartServer(page.request, home, { crash: true });
  await expect.poll(() => jobOf(home, id)).toMatchObject({ status: "submitting", rerun: 1 });

  await restartServer(page.request, home, { crash: true });
  const tile = runTiles(page, id);
  await expectInterrupted(tile);
  expect(jobOf(home, id)).toMatchObject({ status: "interrupted", rerun: 1 });
  // The company may have billed both calls: the usage log says it ran again, at no known cost.
  expect(usageOf(home, id)).toEqual([{ outcome: "failed", rerun: 1 }]);

  // Details says it already ran again, and what that may cost.
  await tile.getByRole("button", { name: "Details" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Openfield stopped before this image was done. It ran again after a restart. You may be charged twice.",
  );
});

test("with the setting off, an image a crash cut off ends interrupted and never runs again", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { home, token } = await setup(page);

  // Settings > Defaults > Restarts: on by default, and the choice is saved.
  await page.goto("/settings/defaults");
  const toggle = page.getByRole("switch", { name: RERUN_SETTING });
  await expect(toggle).toBeChecked();
  await expect(toggle).toHaveAccessibleDescription(
    "Only for images that can't pick up where they left off. You may be charged twice.",
  );
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect
    .poll(
      async () =>
        (await api<{ rerunInterrupted: boolean }>(page.request, token, "GET", "/api/settings"))
          .rerunInterrupted,
    )
    .toBe(false);

  const prompt = unique("A windmill in the rain #fake:slow");
  const id = await generate(page, GOOGLE, prompt);
  await sent(home, id);
  const fresh = await restartServer(page.request, home, { crash: true });

  await expectInterrupted(runTiles(page, id));
  expect(jobOf(home, id)).toMatchObject({ status: "interrupted", attempt: 1, rerun: 0 });
  // It had been sent, so Google may bill it: the usage log says so, at no known cost.
  expect(usageOf(home, id)).toEqual([{ outcome: "failed", rerun: 0 }]);
  await api(page.request, fresh, "PATCH", "/api/settings", { rerunInterrupted: true });
});
