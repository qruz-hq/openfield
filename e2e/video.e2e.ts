import { expect, type Page, test } from "@playwright/test";
import type { CanvasDetail } from "../packages/core/src/schemas/canvas.ts";
import { api, FAKE_KEY, makeImage, makeVideo, SEEDANCE, sessionToken } from "./support";

// The Video workspace end to end on fake models: adding the BytePlus key, making a video from
// words and from a start frame, the feed tile's hover preview, the detail player, the Assets
// library's type filter, and the canvas Video node.

// 400×400: BytePlus's own frame limits are 300 to 6000 px a side (video.frameSize).
async function pngBytes(page: Page, width = 400, height = 400): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ({ width, height }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext("2d")!;
      g.fillStyle = "#3a70e0";
      g.fillRect(0, 0, width, height);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    { width, height },
  );
  return Buffer.from(bytes);
}

test("add the BytePlus key from the Video page's first run", async ({ page }) => {
  await page.goto("/video");
  await expect(page).toHaveURL(/\/video$/);
  await expect(page.getByRole("heading", { name: "Let's make your first video" })).toBeVisible();

  await page.getByRole("button", { name: "Add a key", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/api-keys$/);
  const byteplus = page.getByRole("group", { name: "BytePlus" });
  await expect(byteplus).toBeVisible();
  await expect(byteplus.getByText("Seedance 2.0 and 2.5 need turning on")).toBeVisible();

  const keyField = byteplus.getByRole("textbox", { name: "API key" });
  await keyField.fill(FAKE_KEY);
  await byteplus.getByRole("button", { name: "Check key" }).click();
  await expect(byteplus.getByRole("status")).toHaveText("Connected");

  await page.goto("/video");
  await expect(page.getByRole("textbox", { name: "Describe the video you want" })).toBeVisible();
});

test("generate a video from words, then from a start frame", async ({ page, request }) => {
  const token = await sessionToken(request);
  await api(request, token, "PUT", "/api/settings/keys/byteplus", { apiKey: FAKE_KEY });

  await page.goto("/video");
  const prompt = page.getByRole("textbox", { name: "Describe the video you want" });

  // Pick Seedance 2.0 Fast, so the rest of this test knows what it's asking of (720p max, no
  // forced auto shape on a start frame).
  await page.getByRole("button", { name: "Choose model" }).click();
  await page.getByRole("option", { name: "Seedance 2.0 Fast" }).click();
  await expect(page.getByRole("button", { name: "Choose model" })).toHaveText("Seedance 2.0 Fast");

  await prompt.fill("A kite climbs over a green hill");
  const generate = page.getByRole("button", { name: /^Generate/ });
  await expect(generate).toBeEnabled();
  await prompt.press("ControlOrMeta+Enter");
  await expect(page.locator('main li[aria-busy="true"]').first()).toBeVisible();

  const tile = page.getByRole("listitem", { name: /^A kite climbs over a green hill · /i });
  await expect(tile).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('main li[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });

  // A start frame: upload a photo into the Start tile, then generate with no words at all.
  await prompt.fill("");
  const startInput = page.locator('input[type="file"]').first();
  await startInput.setInputFiles({
    name: "frame.png",
    mimeType: "image/png",
    buffer: await pngBytes(page),
  });
  await expect(page.getByText("1 image", { exact: true })).toBeVisible();
  await expect(generate).toBeEnabled();
  await prompt.press("ControlOrMeta+Enter");
  await expect(page.locator('main li[aria-busy="true"]').first()).toBeVisible();
  await expect(page.locator('main li[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
});

test("a feed tile plays muted on hover, with a duration pill and sound toggle", async ({ page, request }) => {
  const token = await sessionToken(request);
  await makeVideo(request, token, "Waves roll over dark sand");
  await page.goto("/video");

  const tile = page.getByRole("listitem", { name: /^Waves roll over dark sand · /i });
  await expect(tile).toBeVisible();
  await expect(tile.getByText(/^0:0\d$/)).toBeVisible();

  await tile.hover();
  await expect(tile.locator("video")).toBeVisible();
  const sound = tile.getByRole("button", { name: /^(Mute|Unmute)$/ });
  await expect(sound).toBeVisible();
  await sound.click();
  await expect(tile.getByRole("button", { name: "Mute" })).toBeVisible();
});

test("the detail view plays a video with its own controls", async ({ page, request }) => {
  const token = await sessionToken(request);
  const assetId = await makeVideo(request, token, "A train pulls away at night", { audio: true });
  await page.goto(`/video?asset=${assetId}`);

  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  await expect(page.getByText("Length")).toBeVisible();
  await expect(page.getByText("5 s · with sound")).toBeVisible();
  await expect(page.getByText("Cost")).toBeVisible();
  // No image-only actions on a video.
  await expect(page.getByRole("button", { name: "Copy image" })).toHaveCount(0);

  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.keyboard.press(" ");
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();

  for (const label of ["Mute", "Loop", "Full screen"]) {
    await expect(page.getByRole("button", { name: label })).toBeVisible();
  }
});

test("the Assets library's Type filter shows only videos, or only images", async ({ page, request }) => {
  const token = await sessionToken(request);
  await makeImage(request, token, "A ceramic teapot for the type filter");
  await makeVideo(request, token, "A kite over a hill for the type filter");
  await page.goto("/assets");
  const image = page.getByRole("gridcell", { name: /^A ceramic teapot for the type filter · /i });
  const video = page.getByRole("gridcell", { name: /^A kite over a hill for the type filter · /i });
  await expect(image).toBeVisible();
  await expect(video).toBeVisible();

  // Other suites' servers are their own, but earlier tests in this file share this one: check
  // presence and absence, not an exact count that assumes nothing else is in the library.
  await page.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("button", { name: "Type" }).click();
  await page.getByRole("option", { name: "Videos" }).click();
  await expect(video).toBeVisible();
  await expect(image).toHaveCount(0);

  await page.getByRole("button", { name: "Type: Videos" }).click();
  await page.getByRole("option", { name: "Images" }).click();
  await expect(image).toBeVisible();
  await expect(video).toHaveCount(0);
});

test("a Video node on the canvas runs and shows its poster", async ({ page, request }) => {
  const token = await sessionToken(request);
  await api(request, token, "PUT", "/api/settings/keys/byteplus", { apiKey: FAKE_KEY });
  const made = await api<CanvasDetail>(request, token, "POST", "/api/canvases", { name: "Video node" });
  const graph = {
    ...made.graph,
    nodes: [
      {
        id: "vid1",
        type: "video.generate",
        typeVersion: 1,
        position: { x: 200, y: 200 },
        parentId: null,
        collapsed: false,
        title: null,
        params: { model: SEEDANCE, prompt: "A river reflecting the sky" },
        presetLocks: [],
        result: null,
      },
    ],
    edges: [],
  };
  await api(request, token, "PATCH", `/api/canvases/${made.id}`, { graph, graphVersion: made.graphVersion });
  await page.goto(`/canvas/${made.id}`);

  const node = page.locator(".react-flow__node-video\\.generate");
  await expect(node).toBeVisible();
  await expect(node.getByText("A river reflecting the sky")).toBeVisible();
  await node.hover();
  await node.getByRole("button", { name: /^Run/ }).click();
  await expect(node.locator("img")).toBeVisible({ timeout: 20_000 });
});
