import { formatMoney, t } from "@openfield/core";
import { BrandLockup, IconButton, SpendPill, TopNavItem } from "@openfield/ui";
import { Settings } from "lucide-react";
import { Link, useLocation } from "react-router";
import { useSpentToday } from "../api/hooks/usage";
import { useIsGenerating } from "../lib/live";
import { useSpendingPrefs } from "../settings/spending/prefs";
import { dragRegion, WindowControls } from "./window-chrome";

// App / Nav: 44 tall, hairline at the bottom. Only screens that work get a link (§0.15). In the
// desktop app its empty parts move the window, and on Windows and Linux it ends with the window's
// own buttons (window-chrome.tsx).

const ITEMS = [
  { to: "/image", label: "app.nav.image", match: (path: string) => path.startsWith("/image") },
  { to: "/video", label: "app.nav.video", match: (path: string) => path.startsWith("/video") },
  { to: "/assets", label: "app.nav.assets", match: (path: string) => path.startsWith("/assets") },
  { to: "/canvas", label: "app.nav.canvas", match: (path: string) => path.startsWith("/canvas") },
] as const;

export function TopNav() {
  const { pathname } = useLocation();
  const onSettings = pathname.startsWith("/settings");
  const spent = useSpentToday();
  const showToday = useSpendingPrefs((s) => s.showToday);
  const generating = useIsGenerating();

  return (
    <header
      className="relative z-30 flex h-44 w-full shrink-0 items-center justify-between gap-16 bg-surface px-16"
      {...dragRegion()}
    >
      <div className="flex items-center gap-20">
        <Link to="/image" className="inline-flex rounded-8">
          <BrandLockup generating={generating} />
        </Link>
        <nav aria-label={t("app.name")} className="flex items-center gap-4">
          {ITEMS.map((item) => (
            <TopNavItem key={item.to} asChild active={item.match(pathname)}>
              <Link to={item.to}>{t(item.label)}</Link>
            </TopNavItem>
          ))}
        </nav>
      </div>
      <div className="flex items-center gap-8">
        {spent.data ? (
          // Opens Settings > Spending on today's figures (§2.1).
          <Link
            to="/settings/spending"
            onClick={showToday}
            className="rounded-full [&>span]:transition-shadow hover:[&>span]:inset-ring-border-strong"
          >
            <SpendPill
              label={t("app.nav.spentToday")}
              amount={formatMoney(spent.data.totalUsd, spent.data.currency)}
            />
          </Link>
        ) : null}
        <IconButton asChild icon={Settings} label={t("app.nav.settings")} active={onSettings}>
          <Link to="/settings/api-keys" aria-current={onSettings ? "page" : undefined} />
        </IconButton>
        <WindowControls placement="nav" />
      </div>
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-border" />
    </header>
  );
}
