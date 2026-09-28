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

/** The images a node made, not the reference thumbnails above its prompt (.of-card-refs). */
async function expectImages(node: Locator, count: number) {
  const made = node.locator("img:not(.of-card-refs img)");
  await expect(made).toHaveCount(count, { timeout: 15_000 });
  for (const img of await made.all()) {
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

/** A canvas with these nodes and links, opened in the editor. */
async function openWith(
  page: Page,
  request: APIRequestContext,
  nodes: { id: string; type: string; x: number; y: number; params?: Record<string, unknown> }[],
  edges: CanvasDetail["graph"]["edges"] = [],
) {
  const token = await sessionToken(request);
  const made = await api<CanvasDetail>(request, token, "POST", "/api/canvases", { name: "Links" });
  const graph = {
    ...made.graph,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      typeVersion: 1,
      position: { x: n.x, y: n.y },
      ...(n.type === "prompt" && { size: { w: 296, h: 151 } }),
      parentId: null,
      collapsed: false,
      title: null,
      params: n.params ?? {},
      presetLocks: [],
      result: null,
    })),
    edges,
  };
  await api(request, token, "PATCH", `/api/canvases/${made.id}`, { graph, graphVersion: made.graphVersion });
  await page.goto(`/canvas/${made.id}`);
  await expect(pane(page).locator(".react-flow__node")).toHaveCount(nodes.length);
}

const centreOf = async (locator: Locator) => {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

async function dragBetween(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test("a link's × removes it, on hover and while it's selected", async ({ page, request }) => {
  const link = {
    id: "e_1",
    source: "p",
    sourceHandle: "text",
    target: "g",
    targetHandle: "prompt",
    kind: "data" as const,
  };
  const nodes = [
    { id: "p", type: "prompt", x: 200, y: 200, params: { text: "A red fox" } },
    { id: "g", type: "image.generate", x: 760, y: 200 },
  ];
  const links = pane(page).locator(".react-flow__edge");
  const midpoint = () =>
    page.evaluate(() => {
      const path = document.querySelector(
        ".of-canvas:not(.of-capture) .react-flow__edge-interaction",
      ) as SVGPathElement;
      const at = path.getPointAtLength(path.getTotalLength() / 2);
      const m = path.getScreenCTM()!;
      return { x: at.x * m.a + m.e, y: at.y * m.d + m.f };
    });
  const remove = page.getByRole("button", { name: "Delete" });

  await openWith(page, request, nodes, [link]);
  const mid = await midpoint();
  await page.mouse.move(mid.x, mid.y, { steps: 4 });
  await remove.click();
  await expect(links).toHaveCount(0);

  // Selected, the link stays under the nodes, so it never covers a port's circle; the × sits above
  // it all, and stays without hover.
  await openWith(page, request, nodes, [link]);
  const again = await midpoint();
  await page.mouse.click(again.x + 40, again.y + 10);
  await page.mouse.move(40, 800);
  await expect(pane(page).locator(".react-flow__edge.selected")).toHaveCount(1);
  for (const [id, handle, side] of [
    ["p", "text", "source"],
    ["g", "prompt", "target"],
  ] as const) {
    const at = await centreOf(
      pane(page).locator(`.react-flow__handle.${side}[data-nodeid="${id}"][data-handleid="${handle}"]`),
    );
    const top = await page.evaluate(
      ({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".react-flow__handle"),
      at,
    );
    expect(top, `the ${handle} port on ${id} is on top of its link`).toBe(true);
  }
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(links).toHaveCount(0);
});

test("with several nodes selected, a link dragged from one of their ports connects them all", async ({
  page,
  request,
}) => {
  await openWith(page, request, [
    { id: "u1", type: "image.upload", x: 300, y: 120 },
    { id: "u2", type: "image.upload", x: 300, y: 380 },
    { id: "p1", type: "prompt", x: 300, y: 620, params: { text: "A red fox" } },
    { id: "p2", type: "prompt", x: 300, y: 800, params: { text: "In fresh snow" } },
    { id: "g", type: "image.generate", x: 900, y: 240 },
  ]);
  const node = (id: string) => pane(page).locator(`.react-flow__node[data-id="${id}"]`);
  const port = (id: string, handle: string, side: "source" | "target") =>
    pane(page).locator(`.react-flow__handle.${side}[data-nodeid="${id}"][data-handleid="${handle}"]`);

  // A box selection: React Flow puts a group-drag box over the selection, which must not cover its ports.
  const first = (await node("u1").boundingBox())!;
  const last = (await node("p2").boundingBox())!;
  await dragBetween(
    page,
    { x: first.x - 30, y: first.y - 30 },
    { x: last.x + last.width + 20, y: last.y + last.height + 20 },
  );
  await expect(pane(page).locator(".react-flow__node.selected")).toHaveCount(4);

  // While it's dragged, every selected node draws its own pending line to the cursor.
  const from = await centreOf(port("u2", "images", "source"));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 120, from.y - 40, { steps: 6 });
  await expect(pane(page).locator(".react-flow__connectionline path.of-pending")).toHaveCount(4);
  const to = await centreOf(port("g", "input_images", "target"));
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  // Both images into Reference images, the first prompt into Prompt; the second has nowhere to go.
  await expect(pane(page).locator(".react-flow__edge")).toHaveCount(3);
  await expect(pane(page).locator('.react-flow__edge[aria-label="Upload to Generate"]')).toHaveCount(2);
  await expect(pane(page).locator('.react-flow__edge[aria-label="Prompt to Generate"]')).toHaveCount(1);
  await expect(page.getByText("1 node didn't connect: Prompt takes one link.")).toBeVisible();

  // One undo takes them all back.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(pane(page).locator(".react-flow__edge")).toHaveCount(0);

  // Dropped on the card's body instead of a port, the group connects the same way.
  const card = (await node("g").boundingBox())!;
  await dragBetween(page, await centreOf(port("u2", "images", "source")), {
    x: card.x + card.width / 2,
    y: card.y + card.height * 0.3,
  });
  await expect(pane(page).locator('.react-flow__edge[aria-label="Upload to Generate"]')).toHaveCount(2);
  await expect(pane(page).locator('.react-flow__edge[aria-label="Prompt to Generate"]')).toHaveCount(1);
});

test("a link dropped on a card goes to the port that fits, or says why it can't", async ({
  page,
  request,
}) => {
  await openWith(page, request, [
    { id: "p", type: "prompt", x: 200, y: 200, params: { text: "A red fox" } },
    { id: "u", type: "image.upload", x: 200, y: 480 },
    { id: "g", type: "image.generate", x: 800, y: 200 },
  ]);
  const node = (id: string) => pane(page).locator(`.react-flow__node[data-id="${id}"]`);
  const port = (id: string, handle: string, side: "source" | "target") =>
    pane(page).locator(`.react-flow__handle.${side}[data-nodeid="${id}"][data-handleid="${handle}"]`);
  const card = (await node("g").boundingBox())!;
  const body = { x: card.x + card.width / 2, y: card.y + card.height * 0.3 };

  // Over the card, off its ports: the port it would use is filled and the card gets a dashed ring.
  const from = await centreOf(port("p", "text", "source"));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + body.x) / 2, (from.y + body.y) / 2, { steps: 6 });
  await page.mouse.move(body.x, body.y, { steps: 6 });
  await expect(pane(page).locator(".of-port-target")).toHaveAttribute("data-handleid", "prompt");
  await expect(node("g").locator("[data-drop-target]")).toHaveCount(1);
  await page.mouse.up();
  await expect(pane(page).locator('.react-flow__edge[aria-label="Prompt to Generate"]')).toHaveCount(1);

  // Images onto the Prompt card, which takes only text: nothing connects, and the toast says why.
  const prompt = (await node("p").boundingBox())!;
  await dragBetween(page, await centreOf(port("u", "images", "source")), {
    x: prompt.x + prompt.width / 2,
    y: prompt.y + prompt.height / 2,
  });
  await expect(page.getByText("An image can't go into a text input on Prompt.")).toBeVisible();
  await expect(pane(page).locator(".react-flow__edge")).toHaveCount(1);
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

/** A canvas built through the edits route, opened. Returns the node ids by alias. */
async function buildCanvas(page: Page, request: APIRequestContext, name: string, edits: unknown[]) {
  const token = await sessionToken(request);
  const { id } = await api<CanvasDetail>(request, token, "POST", "/api/canvases", { name });
  const { aliases } = await api<{ aliases: Record<string, string> }>(
    request,
    token,
    "POST",
    `/api/canvases/${id}/edits`,
    { edits },
  );
  await page.goto(`/canvas/${id}`);
  return { id, aliases, home: await libraryRoot(request, token) };
}

test("a Generate card fed by Variations gets every one of its images", async ({ page, request }) => {
  const model = "google:gemini-3.1-flash-image";
  const { id, aliases, home } = await buildCanvas(page, request, "Every take", [
    {
      op: "add_node",
      as: "words",
      type: "prompt",
      position: { x: 0, y: 0 },
      params: { text: "a lighthouse" },
    },
    {
      op: "add_node",
      as: "takes",
      type: "image.variations",
      position: { x: 400, y: 0 },
      params: { model, count: 4 },
    },
    { op: "connect", source: "words", target: "takes" },
    {
      op: "add_node",
      as: "card",
      type: "image.generate",
      position: { x: 800, y: 0 },
      params: { model, prompt: "in watercolour" },
    },
    { op: "connect", source: "takes", target: "card" },
  ]);
  await runEverything(page, /^Run 2 nodes · 5 images$/);
  const references = () =>
    queryDb<{ n: number }>(
      home,
      "select json_array_length(json_extract(request_json, '$.references')) as n from job_sets where canvas_id = ? and canvas_node_id = ? order by created_at",
      id,
      aliases.card!,
    ).map((row) => row.n);
  expect(references()).toEqual([4]);

  // Run again on the card alone: Variations is left out, and its four images still go in.
  const card = pane(page).locator(`.react-flow__node[data-id="${aliases.card}"]`);
  await card.hover();
  await card.getByRole("button", { name: /^Run / }).click({ modifiers: ["Alt"] });
  await expect.poll(references, { timeout: 30_000 }).toEqual([4, 4]);
});

test("Variations on a model with seeds is up to date after a run, and ⌥ makes new takes", async ({
  page,
  request,
}) => {
  const token = await sessionToken(request);
  await api(request, token, "PUT", "/api/settings/keys/higgsfield", {
    apiKey: "hf-e2e-id:hf-e2e-secret-0000",
  });
  const { id, aliases, home } = await buildCanvas(page, request, "Seeded takes", [
    { op: "add_node", as: "words", type: "prompt", position: { x: 0, y: 0 }, params: { text: "a portrait" } },
    {
      op: "add_node",
      as: "takes",
      type: "image.variations",
      position: { x: 400, y: 0 },
      params: { model: "higgsfield:soul", count: 2 },
    },
    { op: "connect", source: "words", target: "takes" },
  ]);
  await runEverything(page, null);
  expect(countJobs(home, id)).toBe(2);

  // Nothing changed: Run all keeps the takes it has.
  await runAll(page).click();
  const takes = pane(page).locator(`.react-flow__node[data-id="${aliases.takes}"]`);
  await expect(takes.getByText("Up to date")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(countJobs(home, id)).toBe(2);

  // ⌥ on its own Run: new takes.
  await takes.getByRole("button", { name: /^Run / }).click({ modifiers: ["Alt"] });
  await expect.poll(() => countJobs(home, id), { timeout: 30_000 }).toBe(4);
});

test("the generating swarm fills a card of any shape, and Variations' images too", async ({
  page,
  request,
}) => {
  const webgl = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl"));
  test.skip(!webgl, "Without WebGL the cards keep their glyph");
  const token = await sessionToken(request);
  const { id } = await api<CanvasDetail>(request, token, "POST", "/api/canvases", { name: "Swarm shapes" });
  const model = "google:gemini-3.1-flash-image";
  // 16:9 is 80 by 45 cells and 3:4 is 80 by 107: an odd count of cells either way once lost the
  // whole swarm to the gaps between cells.
  const card = (as: string, ratio: string, x: number) => ({
    op: "add_node",
    as,
    type: "image.generate",
    position: { x, y: 0 },
    params: { model, prompt: `#fake:slow ${as} a lighthouse`, size: { kind: "aspect", ratio } },
  });
  const { aliases } = await api<{ aliases: Record<string, string> }>(
    request,
    token,
    "POST",
    `/api/canvases/${id}/edits`,
    {
      edits: [
        card("wide", "16:9", 0),
        card("tall", "3:4", 400),
        {
          op: "add_node",
          as: "words",
          type: "prompt",
          position: { x: 800, y: 0 },
          params: { text: "#fake:slow a lighthouse" },
        },
        {
          op: "add_node",
          as: "takes",
          type: "image.variations",
          position: { x: 1200, y: 0 },
          params: { model },
        },
        { op: "connect", source: "words", target: "takes" },
      ],
    },
  );
  await page.goto(`/canvas/${id}`);
  await runAll(page).click();
  await page.getByRole("dialog").getByRole("button", { name: /^Run/ }).click();

  // Share of the swarm's pixels that are lit: every cell draws something, the gaps between don't.
  const lit = (node: Locator) =>
    node.locator("canvas.of-card-voxels").evaluate((el: HTMLCanvasElement) => {
      const { data } = el.getContext("2d")!.getImageData(0, 0, el.width, el.height);
      let on = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) on++;
      return on / (data.length / 4);
    });
  for (const as of ["wide", "tall", "takes"]) {
    const node = pane(page).locator(`.react-flow__node[data-id="${aliases[as]}"]`);
    await expect(node.locator("canvas.of-card-voxels")).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => lit(node), { timeout: 10_000 }).toBeGreaterThan(0.4);
  }
  await page.getByRole("button", { name: "Stop", exact: true }).click();
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
