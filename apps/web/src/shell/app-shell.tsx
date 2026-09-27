import { t } from "@openfield/core";
import { Banner, Button, toasterPosition } from "@openfield/ui";
import { RefreshCw, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { Toaster } from "sonner";
import { useEventStream } from "../api/events";
import { useLive } from "../lib/live";
import { pathFor, useNavigateRequest, usePresence } from "../lib/presence";
import { useReveal } from "../lib/reveal";
import { useThemeSync } from "../lib/theme";
import { TopNav } from "./top-nav";

export function AppShell() {
  useEventStream();
  usePresence();
  useThemeSync();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const onImage = pathname.startsWith("/image");
  // The canvas editor brings its own top bar, and its toolbar owns the bottom 60 px.
  const inEditor = /^\/canvas\/[^/]+/.test(pathname);
  const revealing = useReveal((s) => s.jobSetId);
  const openingCanvas = useReveal((s) => s.canvasId);

  // "Show" on a finished Batch run works from any screen: the feed takes it from there.
  useEffect(() => {
    if (revealing && !onImage) navigate("/image");
  }, [revealing, onImage, navigate]);

  // An agent's "show": the canvas or image it asked this tab to open (§7.11).
  const navigateTo = useNavigateRequest((s) => s.target);
  useEffect(() => {
    if (!navigateTo) return;
    useNavigateRequest.getState().done();
    navigate(pathFor(navigateTo));
  }, [navigateTo, navigate]);

  // A canvas run's Show opens its canvas, where the node has the result.
  useEffect(() => {
    if (!openingCanvas) return;
    useReveal.getState().canvasOpened();
    navigate(`/canvas/${openingCanvas}`);
  }, [openingCanvas, navigate]);

  return (
    <div className="flex h-dvh min-w-0 flex-col bg-surface">
      <a
        href="#main"
        className="fixed top-8 left-8 z-70 -translate-y-80 rounded-8 bg-accent px-12 py-6 text-body-strong text-accent-fg focus-visible:translate-y-0"
      >
        {t("app.skipToContent")}
      </a>
      {inEditor ? null : <TopNav />}
      <main id="main" tabIndex={-1} className="relative flex min-h-0 flex-1 flex-col outline-none">
        <Outlet />
      </main>
      <SessionBanner />
      <ReconnectingBanner />
      <LiveRegion />
      <Toaster
        position={toasterPosition.position}
        gap={toasterPosition.gap}
        // On the Image page toasts sit 12 above the composer (bottom 170); in the canvas editor,
        // 12 above its toolbar (bottom 72).
        offset={onImage ? 170 : inEditor ? 72 : toasterPosition.offset}
        // Every toast renders the design's Toast itself (lib/notify.tsx).
        toastOptions={{ unstyled: true }}
        containerAriaLabel={t("app.notifications")}
      />
    </div>
  );
}

/** After a server restart this page's session token is stale; one reload picks up the new one. */
function SessionBanner() {
  const expired = useLive((s) => s.sessionExpired);
  if (!expired) return null;
  return (
    <div className="fixed top-52 left-1/2 z-40 w-560 max-w-[calc(100vw-32px)] -translate-x-1/2">
      <Banner
        variant="error"
        message={t("app.restarted")}
        actions={
          <Button variant="secondary" size="s" icon={RotateCw} onClick={() => window.location.reload()}>
            {t("app.reload")}
          </Button>
        }
      />
    </div>
  );
}

/** While the event stream is down the feed polls; this says so (§8.4.6). Blips under a second pass silently. */
function ReconnectingBanner() {
  const reconnecting = useLive((s) => s.reconnecting);
  const expired = useLive((s) => s.sessionExpired);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!reconnecting) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), 1000);
    return () => clearTimeout(timer);
  }, [reconnecting]);
  if (!shown || expired) return null;
  return (
    <div className="fixed top-52 left-1/2 z-40 w-560 max-w-[calc(100vw-32px)] -translate-x-1/2">
      <Banner icon={RefreshCw} message={t("banner.reconnecting")} />
    </div>
  );
}

/** One polite region for run announcements: started, ready, failed (§2.11). */
function LiveRegion() {
  const announcement = useLive((s) => s.announcement);
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      <span key={announcement.id}>{announcement.text}</span>
    </div>
  );
}
