import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import type { CanvasDetail } from "../packages/core/src/schemas/canvas.ts";
import type { CanvasEditsResponse } from "../packages/core/src/schemas/live.ts";
import { api, FAKE_KEY, SESSION_HEADER, sessionToken } from "./support";

// Live canvases (§7.11) on fake models: an agent's edits appear in the open tab as they're made,
// with who made them; Follow keeps them in view until the person moves; the tab's own unsaved work
// survives them; a run the agent starts is followed like any other; and an agent can open a canvas
// in the tab. The agent here is the fake-mode stand-in at /api/dev (routes/dev-agent.ts).

const AGENT = { name: "Claude Code", sessionId: "e2e-session" };
const pane = (page: Page) => page.locator(".of-canvas:not(.of-capture)");
const pill = (page: Page) => page.getByRole("status").filter({ hasText: /Claude Code/ });

async function newCanvas(request: APIRequestContext, token: string, name: string): Promise<CanvasDetail> {
  return api<CanvasDetail>(request, token, "POST", "/api/canvases", { name });
}

/** With graphVersion, the edits are refused if the canvas changed since that version. */
function agentEdits(
  request: APIRequestContext,
  token: string,
  canvasId: string,
  edits: unknown[],
  graphVersion?: number,
) {
  return api<CanvasEditsResponse>(request, token, "POST", `/api/dev/agent/canvases/${canvasId}/edits`, {
    edits,
    agent: AGENT,
    ...(graphVersion !== undefined && { graphVersion }),
  });
}

async function openCanvas(page: Page, canvasId: string) {
  await page.goto(`/canvas/${canvasId}`);
  await expect(page.getByRole("button", { name: "Canvas menu" })).toBeVisible();
  // The tab has told the server it's here once its stream is open.
  await expect(pane(page)).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  const token = await sessionToken(request);
  await api(request, token, "PUT", "/api/settings/keys/google", { apiKey: FAKE_KEY });
});

test("an agent's edits appear live, with who made them, to the design", async ({ page, request }) => {
  const token = await sessionToken(request);
  const canvas = await newCanvas(request, token, "Live");
  await openCanvas(page, canvas.id);

  const made = await agentEdits(request, token, canvas.id, [
    { op: "add_node", as: "p", type: "prompt", params: { text: "A stoneware mug on linen" } },
    { op: "add_node", as: "g", type: "image.generate" },
    { op: "connect", source: "p", target: "g" },
  ]);
  const nodes = pane(page).locator(".react-flow__node");
  await expect(nodes).toHaveCount(2);
  await expect(page.getByRole("textbox", { name: "Prompt text" })).toHaveValue("A stoneware mug on linen");
  await expect(pane(page).locator(".react-flow__edge")).toHaveCount(1);

  // Canvas / Chrome / Agent (design W4O9c8), top centre.
  await expect(pill(page)).toHaveText(/Claude Code is editing\s*Follow/);
  const box = await pill(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const label = el.children[1]!;
    const ls = getComputedStyle(label);
    return {
      top: r.top,
      centre: r.left + r.width / 2,
      height: r.height,
      radius: s.borderRadius,
      padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft],
      gap: s.columnGap,
      background: s.backgroundColor,
      dot: (() => {
        const d = el.children[0]!.getBoundingClientRect();
        return [d.width, d.height];
      })(),
      label: [ls.fontSize, ls.fontWeight],
      window: window.innerWidth,
    };
  });
  expect(box).toMatchObject({
    top: 12,
    height: 40,
    radius: "10px",
    padding: ["0px", "4px", "0px", "12px"],
    gap: "8px",
    dot: [8, 8],
    label: ["13px", "500"],
  });
  expect(Math.abs(box.centre - box.window / 2)).toBeLessThanOrEqual(1);

  // Canvas / Node / Agent tag (design sgH49) above each node it touched, right-aligned, 8 above.
  const generate = pane(page).locator(`.react-flow__node[data-id="${made.aliases.g}"]`);
  const tag = pane(page).locator(`[data-agent-touch="${made.aliases.g}"]`);
  await expect(tag).toHaveCount(1);
  const measured = await tag.evaluate((el) => {
    const ring = el.children[0] as HTMLElement;
    const label = el.children[1] as HTMLElement;
    const r = label.getBoundingClientRect();
    const host = el.getBoundingClientRect();
    const s = getComputedStyle(label);
    const text = getComputedStyle(label.lastElementChild!);
    return {
      height: r.height,
      rightGap: host.right - r.right,
      bottomGap: host.top - r.bottom,
      radius: s.borderRadius,
      padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft],
      gap: s.columnGap,
      font: [text.fontSize, text.fontWeight],
      ring: getComputedStyle(ring).boxShadow,
      zoom: host.width / (el as HTMLElement).offsetWidth,
    };
  });
  const z = measured.zoom;
  expect(measured.height / z).toBeCloseTo(22, 0);
  expect(measured.rightGap).toBeCloseTo(0, 0);
  expect(measured.bottomGap / z).toBeCloseTo(8, 0);
  expect(measured).toMatchObject({
    radius: "6px",
    padding: ["0px", "8px", "0px", "6px"],
    gap: "5px",
    font: ["12px", "600"],
  });
  expect(measured.ring).toMatch(/0px 0px 0px 4px/);
  // It sits on the node it names.
  const nodeBox = (await generate.boundingBox())!;
  const tagBox = (await tag.boundingBox())!;
  expect(Math.abs(tagBox.x - nodeBox.x)).toBeLessThanOrEqual(1);
  // And goes after 3 s.
  await expect(tag).toHaveCount(0, { timeout: 5_000 });

  // The first change saved the canvas as it was, and says so.
  await expect(page.getByText("Saved a version before Claude Code's changes.")).toBeVisible();
  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.getByText("Before Claude Code").first()).toBeVisible();
});

test("Follow keeps the agent's work in view until the person moves", async ({ page, request }) => {
  const token = await sessionToken(request);
  const canvas = await newCanvas(request, token, "Follow");
  await openCanvas(page, canvas.id);
  await agentEdits(request, token, canvas.id, [{ op: "add_node", type: "note", position: { x: 0, y: 0 } }]);
  await expect(pill(page)).toBeVisible();

  await pill(page).getByRole("button", { name: "Follow" }).click();
  await expect(pill(page)).toHaveText(/Following Claude Code\s*Stop following/);
  const pillStyle = await pill(page).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(pillStyle).not.toBe("rgba(0, 0, 0, 0)");
  // The thin bone frame around the pane.
  const frame = page.locator(".of-canvas > .inset-ring-accent-line");
  await expect(frame).toHaveCount(1);

  // Far off screen: the view goes there.
  const far = await agentEdits(request, token, canvas.id, [
    { op: "add_node", as: "far", type: "note", position: { x: 6000, y: 3000 } },
  ]);
  const farNode = pane(page).locator(`.react-flow__node[data-id="${far.aliases.far}"]`);
  await expect(farNode).toBeInViewport();

  // The person's own scroll ends it.
  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 300);
  await expect(pill(page)).toHaveText(/Claude Code is editing\s*Follow/);
  await expect(frame).toHaveCount(0);
});

test("with Follow on, an agent's edits in a row all land, however the tab moves and measures", async ({
  page,
  request,
}) => {
  const token = await sessionToken(request);
  const canvas = await newCanvas(request, token, "In a row");
  await openCanvas(page, canvas.id);
  const first = await agentEdits(request, token, canvas.id, [
    { op: "add_node", as: "p", type: "prompt", params: { text: "A lighthouse" }, position: { x: 0, y: 0 } },
  ]);
  await pill(page).getByRole("button", { name: "Follow" }).click();
  await expect(pill(page)).toHaveText(/Following Claude Code/);

  // Each edit lands far off, so Follow pans the view there, and reshapes the card before it, which
  // the tab measures again. Both save, and neither makes a new version, so every edit sent with the
  // version the last one answered still lands (the strictest an agent can be).
  const saved = () =>
    page.waitForResponse(
      (r) => r.url().endsWith(`/api/canvases/${canvas.id}`) && r.request().method() === "PATCH",
    );
  let version = first.graphVersion;
  let last: string | null = null;
  let reshaped: string | null = null;
  for (let i = 0; i < 4; i++) {
    const saving = saved();
    const made = await agentEdits(
      request,
      token,
      canvas.id,
      [
        {
          op: "add_node",
          as: "g",
          type: "image.generate",
          params: { prompt: `take ${i}`, size: { kind: "aspect", ratio: "1:1" } },
          position: { x: 1600 * (i + 1), y: 1200 * (i % 2) },
        },
        ...(last
          ? [{ op: "update_node", id: last, params: { size: { kind: "aspect", ratio: "9:16" } } }]
          : []),
      ],
      version,
    );
    version = made.graphVersion;
    await expect(pane(page).locator(`.react-flow__node[data-id="${made.aliases.g}"]`)).toBeInViewport();
    expect((await (await saving).json()).graphVersion).toBe(version);
    reshaped = last;
    last = made.aliases.g!;
  }

  await expect(page.getByText("This canvas changed")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 10_000 });
  const detail = await api<CanvasDetail>(request, token, "GET", `/api/canvases/${canvas.id}`);
  expect(detail.graphVersion).toBe(version);
  expect(detail.graph.nodes).toHaveLength(5);
  // The box the tab measured for the card reshaped last, saved without a version of its own.
  expect(detail.graph.nodes.find((n) => n.id === reshaped)?.size).toEqual({ w: 270, h: 480 });
});

test("unsaved work in the tab survives the agent's edits", async ({ page, request }) => {
  const token = await sessionToken(request);
  const canvas = await newCanvas(request, token, "Together");
  const first = await agentEdits(request, token, canvas.id, [
    { op: "add_node", as: "p", type: "prompt", params: { text: "first" } },
  ]);
  await openCanvas(page, canvas.id);
  const prompt = page.getByRole("textbox", { name: "Prompt text" });
  await expect(prompt).toHaveValue("first");

  // The person types; the agent adds a node before the tab has saved it.
  await prompt.fill("mine");
  await agentEdits(request, token, canvas.id, [{ op: "add_node", as: "n", type: "note" }]);
  await expect(pane(page).locator(".react-flow__node")).toHaveCount(2);
  await expect(prompt).toHaveValue("mine");

  // Both reach the server, with no conflict on the way.
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("This canvas changed")).toHaveCount(0);
  const saved = await api<CanvasDetail>(request, token, "GET", `/api/canvases/${canvas.id}`);
  expect(saved.graph.nodes).toHaveLength(2);
  expect(saved.graph.nodes.find((n) => n.id === first.aliases.p)?.params.text).toBe("mine");
});

test("a run the agent starts is followed in the tab", async ({ page, request }) => {
  const token = await sessionToken(request);
  const canvas = await newCanvas(request, token, "Agent run");
  const made = await agentEdits(request, token, canvas.id, [
    { op: "add_node", as: "g", type: "image.generate", params: { prompt: "a lighthouse at dusk" } },
  ]);
  await openCanvas(page, canvas.id);
  const run = await api<{ outcome: string; runId: string | null }>(
    request,
    token,
    "POST",
    `/api/dev/agent/canvases/${canvas.id}/run`,
    { scope: "all", agent: AGENT },
  );
  expect(run.outcome).toBe("plan");
  const node = pane(page).locator(`.react-flow__node[data-id="${made.aliases.g}"]`);
  await expect(node.locator("img")).toHaveCount(1, { timeout: 20_000 });
  await expect(pill(page)).toBeVisible();
});

test("an agent can open a canvas, with its nodes in view, in the tab in use", async ({ page, request }) => {
  const token = await sessionToken(request);
  const target = await newCanvas(request, token, "Shown");
  const made = await agentEdits(request, token, target.id, [
    { op: "add_node", as: "far", type: "note", position: { x: 5000, y: 5000 } },
  ]);
  // The tab says where it is as it opens; its id is how the agent reaches it.
  const reported = page.waitForRequest((r) => r.url().endsWith("/api/presence") && r.method() === "POST");
  await page.goto("/image");
  const { tabId } = (await reported).postDataJSON() as { tabId: string };
  await expect
    .poll(async () => {
      const res = await request.post("/api/dev/agent/navigate", {
        headers: { [SESSION_HEADER]: token },
        data: { tabId, to: { kind: "canvas", id: target.id, nodeIds: [made.aliases.far] } },
      });
      return (await res.json()).tabId;
    })
    .toBe(tabId);
  await expect(page).toHaveURL(new RegExp(`/canvas/${target.id}$`));
  const far = pane(page).locator(`.react-flow__node[data-id="${made.aliases.far}"]`);
  await expect(far).toBeInViewport();
  await expect(far).toHaveClass(/selected/);
});
