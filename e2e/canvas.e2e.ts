import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import type { CanvasDetail, CanvasTemplate } from "../packages/core/src/schemas/canvas.ts";
import { api, FAKE_KEY, libraryRoot, queryDb, SESSION_HEADER, sessionToken } from "./support";

// M4 on fake models: a template runs end to end, a second Run all with nothing changed makes no
// new images, a reload keeps the graph, and an uploaded photo reaches the model as a reference.

const generators = (page: Page) => page.locator(".react-flow__node-image\\.generate");
const runAll = (page: Page) => page.getByRole("button", { name: /^Run all/ });

/** Jobs this canvas made, so other tests running beside it don't count. */
const countJobs = (home: string, canvasId: string) =>
  queryDb<{ n: number }>(
    home,
    "select count(*) as n from jobs join job_sets on job_sets.id = jobs.job_set_id where job_sets.canvas_id = ?",
    canvasId,
  )[0]!.n;

const canvasIdOf = (page: Page) => new URL(page.url()).pathname.split("/").pop()!;

/** The editor's own pane: the card picture is drawn off screen from the same canvas. */
const pane = (page: Page) => page.locator(".of-canvas:not(.of-capture)");

/** The canvas's save count, as the server has it. */
const graphVersion = async (request: APIRequestContext, token: string, canvasId: string) =>
  (await api<CanvasDetail>(request, token, "GET", `/api/canvases/${canvasId}`)).graphVersion;

/** Long enough for autosave to have sent anything it was going to: its slowest wait is 2 s. */
const SETTLE_MS = 3_000;

/**
 * A small PNG drawn by the page itself, so the suite ships no image files. One pixel differs every
 * time, so a retry on the same server never meets the last attempt's image.
 */
async function pngBytes(page: Page, width = 120, height = 80): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ({ seed, width, height }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext("2d")!;
      const gradient = g.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, "#e0703a");
      gradient.addColorStop(1, "#3a70e0");
      g.fillStyle = gradient;
      g.fillRect(0, 0, width, height);
      g.fillStyle = `#${(seed % 0xffffff).toString(16).padStart(6, "0")}`;
      g.fillRect(0, 0, 1, 1);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    { seed: Date.now() + Math.floor(Math.random() * 1000), width, height },
  );
  return Buffer.from(bytes);
}

async function useTemplate(page: Page, name: string) {
  await page.goto("/canvas?tab=templates");
  await page.getByRole("button", { name: `Use template: ${name}` }).click();
  await expect(page).toHaveURL(/\/canvas\/[0-9A-HJKMNP-TV-Z]{26}$/);
  await expect(page.getByRole("button", { name: "Canvas menu" })).toHaveText(name);
}

/**
 * Run all, then waits for the run to end. More than one node asks first: the preview's heading is
 * checked and its Run pressed. One node runs straight away.
 */
async function runEverything(page: Page, heading: RegExp | null) {
  await runAll(page).click();
  if (heading) {
    const preview = page.getByRole("dialog");
    await expect(preview.getByRole("heading")).toHaveText(heading);
    await preview.getByRole("button", { name: /^Run/ }).click();
  }
  // The canvas's own Stop: each running card has one too, named for its node.
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  await expect(stop).toBeHidden({ timeout: 30_000 });
}

async function expectImages(node: Locator, count: number) {
  await expect(node.locator("img")).toHaveCount(count, { timeout: 15_000 });
  for (const img of await node.locator("img").all()) {
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  }
}

test.beforeEach(async ({ request }) => {
  const token = await sessionToken(request);
  await api(request, token, "PUT", "/api/settings/keys/google", { apiKey: FAKE_KEY });
});

test("a template runs, runs again for free, and survives a reload", async ({ page, request }) => {
  const home = await libraryRoot(request, await sessionToken(request));
  await useTemplate(page, "Storyboard");

  // The template opens fitted to its nodes, whatever the screen.
  const nodes = page.locator(".react-flow__node");
  await expect(nodes).toHaveCount(7);
  await expect(generators(page)).toHaveCount(4);
  for (const node of await nodes.all()) await expect(node).toBeInViewport({ ratio: 0.99 });

  const canvasId = canvasIdOf(page);
  expect(countJobs(home, canvasId)).toBe(0);
  await runEverything(page, /^Run 4 nodes · 4 images$/);
  for (const node of await generators(page).all()) await expectImages(node, 1);
  expect(countJobs(home, canvasId)).toBe(4);

  // Nothing changed, so nothing runs: no preview to confirm, no new jobs, every node up to date.
  await runAll(page).click();
  await expect(page.getByText("Up to date")).toHaveCount(4);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(countJobs(home, canvasId)).toBe(4);

  // A changed prompt makes the nodes below it stale, and only those.
  const prompt = page.getByRole("textbox", { name: "Prompt text" });
  await prompt.fill("A lighthouse keeper's first night on the island.");
  await expect(page.getByText("Inputs changed")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await prompt.blur();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(prompt).toHaveValue("A lighthouse keeper's last night on the island.");
  await expect(page.getByText("Inputs changed")).toHaveCount(0);

  // The graph and its images come back from the server after a reload.
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();
  await page.reload();
  await expect(nodes).toHaveCount(7);
  await expect(page.getByRole("button", { name: "Canvas menu" })).toHaveText("Storyboard");
  for (const node of await generators(page).all()) await expectImages(node, 1);
  await expect(prompt).toHaveValue("A lighthouse keeper's last night on the island.");
});

test("opening a canvas saves nothing, on a screen of any density", async ({ page, request }) => {
  const token = await sessionToken(request);
  await page.goto("/canvas");
  // Nearly 16:9, so a thumbnail's rounding gives a slightly different card than the image itself,
  // and a different one again at 2x.
  const upload = await request.post("/api/uploads", {
    headers: { [SESSION_HEADER]: token },
    multipart: { file: { name: "wide.png", mimeType: "image/png", buffer: await pngBytes(page, 1000, 563) } },
  });
  const { asset } = (await upload.json()) as { asset: { id: string } };
  const { id } = await api<CanvasDetail>(request, token, "POST", "/api/canvases", { name: "Reopen" });
  const { graph, graphVersion: version } = await api<CanvasDetail>(
    request,
    token,
    "GET",
    `/api/canvases/${id}`,
  );
  // A card saved at its image's exact box: 320 wide, 320 × 563 ÷ 1000 tall.
  graph.nodes.push({
    id: "n_card",
    type: "image.generate",
    typeVersion: 1,
    position: { x: 0, y: 0 },
    size: { w: 320, h: 180.16 },
    parentId: null,
    collapsed: false,
    title: null,
    params: { prompt: "A harbor at dawn", size: { kind: "aspect", ratio: "16:9" } },
    presetLocks: [],
    result: {
      state: "done",
      assetIds: [asset.id],
      jobSetId: null,
      jobSetIds: [],
      outputs: [{ assetId: asset.id }],
      fingerprint: null,
      costUsd: null,
      ranAt: null,
      error: null,
    },
  });
  await api(request, token, "PATCH", `/api/canvases/${id}`, { graph, graphVersion: version });
  const saved = await graphVersion(request, token, id);

  const open = async (target: Page) => {
    await target.goto(`/canvas/${id}`);
    const card = pane(target).locator('.react-flow__node[data-id="n_card"]');
    await expectImages(card, 1);
    // The card takes the image's own shape, not the thumbnail's.
    expect(await card.evaluate((el) => Number.parseFloat((el as HTMLElement).style.height))).toBeCloseTo(
      180.16,
      2,
    );
    await target.waitForTimeout(SETTLE_MS);
    expect(await graphVersion(request, token, id)).toBe(saved);
  };
  await open(page);
  const dense = await page
    .context()
    .browser()!
    .newContext({
      baseURL: test.info().project.use.baseURL,
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
  try {
    await open(await dense.newPage());
  } finally {
    await dense.close();
  }
});

test("dragging from a port to empty canvas adds a node that fits, already connected", async ({ page }) => {
  await page.goto("/canvas");
  await page.getByRole("button", { name: "New canvas" }).first().click();
  await expect(page).toHaveURL(/\/canvas\/[0-9A-HJKMNP-TV-Z]{26}$/);
  await page.getByText("Write what you want to make").click();
  await page.getByRole("textbox", { name: "Prompt text" }).fill("A red fox in fresh snow");

  const port = page.locator('.react-flow__node-prompt .react-flow__handle.source[data-handleid="text"]');
  const box = (await port.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 20, { steps: 5 });
  await page.mouse.move(box.x + 240, box.y + 40, { steps: 10 });
  await page.mouse.up();

  // Dropped on empty canvas: the menu leads with what takes text.
  const menu = page.getByRole("dialog", { name: "Add node" });
  await expect(menu.getByText("Connects here")).toBeVisible();
  await menu.getByText("Make images from a prompt").click();

  await expect(generators(page)).toHaveCount(1);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  // The card shows the start of the prompt coming in, with Run beside it.
  await expect(generators(page).getByText("A red fox in fresh snow")).toBeVisible();
  await expect(generators(page).getByRole("button", { name: /^Run / })).toBeVisible();
});

test("an uploaded photo lands in the library and reaches the model", async ({ page, request }) => {
  const token = await sessionToken(request);
  const home = await libraryRoot(request, token);
  await page.goto("/canvas");
  const bytes = await pngBytes(page);

  // The route on its own: the type comes from the bytes, and the same file twice is one image.
  const first = await request.post("/api/uploads", {
    headers: { [SESSION_HEADER]: token },
    multipart: { file: { name: "not-really.jpg", mimeType: "image/jpeg", buffer: bytes } },
  });
  expect(first.status()).toBe(201);
  const uploaded = (await first.json()) as { asset: { id: string; mime: string }; duplicate: boolean };
  expect(uploaded.asset.mime).toBe("image/png");
  expect(uploaded.duplicate).toBe(false);
  const again = await request.post("/api/uploads", {
    headers: { [SESSION_HEADER]: token },
    multipart: { file: { name: "copy.png", mimeType: "image/png", buffer: bytes } },
  });
  expect(again.status()).toBe(200);
  expect(((await again.json()) as { duplicate: boolean }).duplicate).toBe(true);

  // Through the canvas: the reference template, a photo chosen from this computer, then a run.
  await useTemplate(page, "Start from a reference");
  const upload = page.locator(".react-flow__node-image\\.upload");
  const chooser = page.waitForEvent("filechooser");
  await upload.getByRole("button", { name: "Choose files" }).click();
  await (await chooser).setFiles({ name: "reference.png", mimeType: "image/png", buffer: bytes });
  await expect(upload.getByText("1 image")).toBeVisible();
  await expectImages(upload, 1);

  await runEverything(page, null);
  await expectImages(generators(page), 1);

  // This canvas's own run: tests beside this one make job sets of their own.
  const [set] = queryDb<{ request_json: string }>(
    home,
    "select request_json from job_sets where source = 'canvas' and canvas_id = ? order by created_at desc limit 1",
    canvasIdOf(page),
  );
  const references = (JSON.parse(set!.request_json) as { references?: { assetId: string }[] }).references;
  expect(references?.map((r) => r.assetId)).toEqual([uploaded.asset.id]);
});

test("a node's price follows Google's speed, and says Standard for a model without it", async ({
  page,
  request,
}) => {
  const token = await sessionToken(request);
  await api(request, token, "PATCH", "/api/providers/google/settings", { values: { speed: "flex" } });
  try {
    await useTemplate(page, "Start from a reference");
    await generators(page).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Settings" }).click();
    const drawer = page.getByRole("complementary");
    const model = drawer.getByRole("combobox", { name: "Model" });
    const run = drawer.getByRole("button", { name: /^Run/ });

    // Nano Banana 2 has no Flex: its Standard price, with a plain note under Run.
    await model.click();
    await expect(page.getByRole("listbox").getByText("· Standard")).toHaveCount(2);
    await page.getByRole("option", { name: "Nano Banana 2", exact: true }).click();
    // To the cent, like Run all and the run preview.
    await expect(run).toContainText("$0.07");
    await expect(drawer.getByText("Standard for this model")).toBeVisible();
    await run.hover();
    await expect(page.getByRole("tooltip")).toContainText(
      "Nano Banana 2 has no Flex, so it runs at Standard.",
    );

    // Nano Banana Pro has it: half its 1K price, the speed named, and no note.
    await model.click();
    await page.getByRole("option", { name: "Nano Banana Pro", exact: true }).click();
    await expect(run).toContainText("$0.07");
    await expect(drawer.getByText("Standard for this model")).toHaveCount(0);
    await run.hover();
    await expect(page.getByRole("tooltip")).toContainText("Speed: Flex.");
  } finally {
    await api(request, token, "PATCH", "/api/providers/google/settings", { values: { speed: "standard" } });
  }
});

test("a node at Batch waits at Google, and its finish toast keeps to the canvas", async ({
  page,
  request,
}) => {
  const token = await sessionToken(request);
  await api(request, token, "PATCH", "/api/providers/google/settings", { values: { speed: "batch" } });
  try {
    await useTemplate(page, "Storyboard");
    const canvasId = canvasIdOf(page);
    const node = generators(page).first();
    await node.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.getByRole("complementary").getByRole("button", { name: /^Run/ }).click();

    // The Image tab's Batch words, not a running timer, while Google has it.
    await expect(node.getByText("Waiting at Google")).toBeVisible({ timeout: 15_000 });
    await expect(node.getByText("Usually done within a few hours")).toBeVisible();
    await expectImages(node, 1);

    // The node already shows the image, so the toast offers no Show that would leave the canvas.
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Your batch is ready" });
    await expect(toast).toHaveCount(1);
    await expect(toast.getByRole("button", { name: "Show" })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/canvas/${canvasId}$`));

    // Anywhere else, Show brings you back to the canvas rather than to the Image feed.
    const next = generators(page).nth(1);
    await next.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.getByRole("complementary").getByRole("button", { name: /^Run/ }).click();
    await expect(next.getByText("Waiting at Google")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Openfield menu" }).click();
    await page.getByRole("menuitem", { name: "All canvases" }).click();
    await expect(page).toHaveURL(/\/canvas$/);
    await page
      .locator("[data-sonner-toast]")
      .getByRole("button", { name: "Show" })
      .click({ timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`/canvas/${canvasId}$`));
    await expectImages(generators(page).nth(1), 1);
  } finally {
    await api(request, token, "PATCH", "/api/providers/google/settings", { values: { speed: "standard" } });
  }
});

test("links into a generating card pulse, and a stop says Canceled on the card", async ({
  page,
  request,
}) => {
  const token = await sessionToken(request);
  const templates = await api<CanvasTemplate[]>(request, token, "GET", "/api/canvas-templates");
  const template = templates.find((t) => t.name === "Start from a reference")!;
  const { id } = await api<CanvasDetail>(request, token, "POST", "/api/canvases", {
    templateId: template.id,
  });
  const { graph, graphVersion: version } = await api<CanvasDetail>(
    request,
    token,
    "GET",
    `/api/canvases/${id}`,
  );
  // A fake call slow enough to watch, and a node that reads from the card, for a link out of it.
  const prompt = graph.nodes.find((n) => n.id === "n_prompt")!;
  prompt.params = { ...prompt.params, text: "#fake:slow A red fox in fresh snow" };
  graph.nodes.push({
    id: "n_vary",
    type: "image.variations",
    typeVersion: 1,
    position: { x: 900, y: 0 },
    parentId: null,
    collapsed: false,
    title: null,
    params: {},
    presetLocks: [],
    result: null,
  });
  graph.edges.push({
    id: "e_out",
    source: "n_generate",
    sourceHandle: "images",
    target: "n_vary",
    targetHandle: "image",
    kind: "data",
  });
  await api(request, token, "PATCH", `/api/canvases/${id}`, { graph, graphVersion: version });
  await page.goto(`/canvas/${id}`);

  const card = pane(page).locator('.react-flow__node[data-id="n_generate"]');
  const line = (edge: string) => pane(page).locator(`.react-flow__edge[data-id="${edge}"] path.of-edge`);
  const pulse = (edge: string) => pane(page).locator(`.react-flow__edge[data-id="${edge}"] .of-pulse-core`);
  await card.getByRole("button", { name: /^Run / }).click();
  await expect(card.locator('.of-card[data-phase="generating"]')).toBeVisible({ timeout: 15_000 });

  // Every link into the generating card pulses; the link out of it stays still.
  for (const edge of ["e_prompt", "e_reference"]) {
    await expect(line(edge)).toHaveAttribute("data-link", "active");
    await expect(pulse(edge)).toHaveCount(1);
  }
  await expect(line("e_out")).toHaveAttribute("data-link", "idle");
  await expect(pulse("e_out")).toHaveCount(0);

  // Its own Stop: the links go still, and the card says so, with Run again (design znre4).
  await card.hover();
  await card.getByRole("button", { name: /^Stop / }).click();
  await expect(card.locator('.of-card[data-phase="canceled"]')).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText("You may still be charged for work that already started.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Run again" })).toBeVisible();
  for (const edge of ["e_prompt", "e_reference"]) {
    await expect(line(edge)).toHaveAttribute("data-link", "idle");
    await expect(pulse(edge)).toHaveCount(0);
  }
});

test("Version history on an index card opens the canvas with its history", async ({ page, request }) => {
  const token = await sessionToken(request);
  const name = `History ${Date.now()}`;
  await api(request, token, "POST", "/api/canvases", { name });
  await page.goto("/canvas");
  await page.getByRole("button", { name: `More for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  await expect(page).toHaveURL(/\/canvas\/[0-9A-HJKMNP-TV-Z]{26}$/);
  await expect(page.getByRole("complementary", { name: "Version history" })).toBeVisible();
});
