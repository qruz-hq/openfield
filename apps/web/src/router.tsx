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

// Routes (§2.1). Only screens that work are routed; anything else lands on /image (§0.15).
export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <ToImage /> },
      { path: "/image", element: <ImagePage /> },
      { path: "/settings", element: <Navigate to={`/settings/${DEFAULT_PANE}`} replace /> },
      { path: "/settings/:pane", element: <SettingsPage /> },
      { path: "*", element: <Navigate to="/image" replace /> },
    ],
  },
]);
