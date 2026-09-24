import { t } from "@openfield/core";
import { Spinner } from "@openfield/ui";
import { createBrowserRouter, Navigate, useLocation } from "react-router";
import { ImagePage } from "./image/image-page";
import { DEFAULT_PANE } from "./settings/panes";
import { SettingsPage } from "./settings/settings-page";
import { AppShell } from "./shell/app-shell";

/** /image is where the app opens (§2.1). The query rides along, so /?model=… still deep links. */
function ToImage() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/image", search }} replace />;
}

/** What a canvas link opened straight from the address bar shows while its page loads. */
function EditorLoading() {
  return (
    <div className="flex size-full items-center justify-center bg-canvas text-text-tertiary">
      <Spinner size={18} label={t("app.loading")} />
    </div>
  );
}

// Routes (§2.1). Only screens that work are routed; anything else lands on /image (§0.15).
export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <ToImage /> },
      { path: "/image", element: <ImagePage /> },
      // ?tab=templates opens the Templates tab. Canvas code loads only when it's opened.
      {
        path: "/canvas",
        lazy: async () => ({ Component: (await import("./canvas/index/index-page")).CanvasIndexPage }),
        HydrateFallback: EditorLoading,
      },
      {
        path: "/canvas/:id",
        // The editor brings React Flow with it, so it loads only when a canvas opens.
        lazy: async () => ({ Component: (await import("./canvas/editor/editor-page")).EditorPage }),
        HydrateFallback: EditorLoading,
      },
      { path: "/settings", element: <Navigate to={`/settings/${DEFAULT_PANE}`} replace /> },
      { path: "/settings/:pane", element: <SettingsPage /> },
      { path: "*", element: <Navigate to="/image" replace /> },
    ],
  },
]);
