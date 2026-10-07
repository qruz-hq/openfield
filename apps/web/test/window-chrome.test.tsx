// biome-ignore lint/style/noRestrictedImports: tests run under Bun, never in the browser.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  windowCommand,
  windowIsMaximized,
  windowPlatform,
  windowPlatformOf,
  windowTopInset,
} from "../src/lib/desktop";
import { TopNav } from "../src/shell/top-nav";
import {
  dragRegion,
  ModalWindowBar,
  markWindowPlatform,
  WindowControls,
  WindowStrip,
} from "../src/shell/window-chrome";

// The desktop app's own title bar (window-chrome.tsx): which one the page draws, and that a browser
// tab gets none of it.

const UA = {
  // WKWebView in the macOS app.
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  // WebView2 on Windows.
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  // WebKitGTK on Linux.
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)",
};

type Internals = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
const g = globalThis as { __TAURI_INTERNALS__?: Internals };

afterEach(() => {
  delete g.__TAURI_INTERNALS__;
});

describe("platform", () => {
  test("a browser draws no title bar, whatever it runs on", () => {
    for (const userAgent of Object.values(UA)) {
      expect(windowPlatformOf({ desktop: false, userAgent })).toBeNull();
    }
  });

  test("the desktop app on a Mac keeps the traffic lights; elsewhere it draws its own buttons", () => {
    expect(windowPlatformOf({ desktop: true, userAgent: UA.mac })).toBe("mac");
    expect(windowPlatformOf({ desktop: true, userAgent: UA.windows })).toBe("other");
    expect(windowPlatformOf({ desktop: true, userAgent: UA.linux })).toBe("other");
  });

  test("without Tauri's internals the page is in a browser", () => {
    expect(windowPlatform()).toBeNull();
    g.__TAURI_INTERNALS__ = { invoke: async () => undefined };
    expect(windowPlatform()).not.toBeNull();
  });

  test("only a Mac window moves floating chrome down, by the strip", () => {
    expect(windowTopInset(null)).toBe(0);
    expect(windowTopInset("other")).toBe(0);
    expect(windowTopInset("mac")).toBe(28);
    expect(windowTopInset()).toBe(0);
  });
});

describe("in a browser", () => {
  test("the strip and the window buttons render nothing", () => {
    for (const floating of [false, true]) {
      expect(renderToStaticMarkup(<WindowStrip floating={floating} />)).toBe("");
      expect(renderToStaticMarkup(<WindowStrip floating={floating} platform={null} />)).toBe("");
    }
    for (const placement of ["nav", "floating"] as const) {
      expect(renderToStaticMarkup(<WindowControls placement={placement} />)).toBe("");
      expect(renderToStaticMarkup(<WindowControls placement={placement} platform={null} />)).toBe("");
    }
    for (const inEditor of [false, true]) {
      expect(renderToStaticMarkup(<ModalWindowBar inEditor={inEditor} />)).toBe("");
    }
  });

  test("the nav is not a drag region and has no window buttons", () => {
    expect(dragRegion()).toEqual({});
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/image"]}>
          <TopNav />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("<header");
    expect(html).not.toContain("data-tauri");
    expect(html).not.toContain("Minimize");
    expect(html).not.toContain("Close");
  });

  test("<html> is left unmarked", () => {
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    markWindowPlatform(root);
    expect(root.dataset).toEqual({});
  });
});

describe("in the desktop app", () => {
  test("on a Mac: an empty, draggable strip above the nav, and see-through over the editor", () => {
    const strip = renderToStaticMarkup(<WindowStrip floating={false} platform="mac" />);
    expect(strip).toContain("data-tauri-drag-region");
    expect(strip).toContain("h-28");
    expect(strip).toContain("bg-surface");
    const floating = renderToStaticMarkup(<WindowStrip floating platform="mac" />);
    expect(floating).toContain("data-tauri-drag-region");
    expect(floating).not.toContain("bg-");
    expect(renderToStaticMarkup(<WindowControls placement="nav" platform="mac" />)).toBe("");
  });

  test("on Windows and Linux: the nav ends with minimize, maximize and close", () => {
    expect(renderToStaticMarkup(<WindowStrip floating={false} platform="other" />)).toBe("");
    expect(renderToStaticMarkup(<WindowStrip floating platform="other" />)).toContain(
      "data-tauri-drag-region",
    );
    const html = renderToStaticMarkup(<WindowControls placement="nav" platform="other" />);
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["Minimize", "Maximize", "Close"]);
    expect(html).toContain("hover:bg-danger");
  });

  test("over a modal's scrim the title bar comes back, where it sits underneath", () => {
    const labels = (html: string) => [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    const mac = renderToStaticMarkup(<ModalWindowBar inEditor={false} platform="mac" />);
    expect(mac).toContain("data-tauri-drag-region");
    expect(mac).toContain("h-28");
    expect(mac).toContain("pointer-events-auto");
    expect(labels(mac)).toEqual([]);
    // On the nav's row, without the nav's hairline.
    const nav = renderToStaticMarkup(<ModalWindowBar inEditor={false} platform="other" />);
    expect(nav).toContain("h-44");
    expect(nav).not.toContain("w-px");
    expect(labels(nav)).toEqual(["Minimize", "Maximize", "Close"]);
    // In the editor's pill, top right.
    const editor = renderToStaticMarkup(<ModalWindowBar inEditor platform="other" />);
    expect(editor).toContain("top-12 right-12");
    expect(editor).toContain("rounded-10");
    expect(labels(editor)).toEqual(["Minimize", "Maximize", "Close"]);
  });

  test("the nav's empty parts move the window", () => {
    expect(dragRegion("mac")).toEqual({ "data-tauri-drag-region": "deep" });
    expect(dragRegion("other")).toEqual({ "data-tauri-drag-region": "deep" });
  });

  test("<html> says which, for the mac-window: classes", () => {
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    markWindowPlatform(root, "mac");
    expect(root.dataset.window).toBe("mac");
  });

  test("the buttons call Tauri's window commands, and close takes the app's close request", async () => {
    const invoke = mock(async (command: string) => (command === "plugin:window|is_maximized" ? true : null));
    g.__TAURI_INTERNALS__ = { invoke };
    windowCommand("minimize");
    windowCommand("internal_toggle_maximize");
    windowCommand("close");
    expect(await windowIsMaximized()).toBe(true);
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      "plugin:window|minimize",
      "plugin:window|internal_toggle_maximize",
      "plugin:window|close",
      "plugin:window|is_maximized",
    ]);
  });

  test("a refused command changes nothing and throws nothing", async () => {
    g.__TAURI_INTERNALS__ = { invoke: async () => Promise.reject(new Error("not allowed")) };
    expect(() => windowCommand("close")).not.toThrow();
    expect(await windowIsMaximized()).toBe(false);
  });
});
