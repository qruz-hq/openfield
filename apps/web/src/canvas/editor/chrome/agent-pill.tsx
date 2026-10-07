import { t } from "@openfield/core";
import { Button, cn, Divider } from "@openfield/ui";
import { LocateFixed, X } from "lucide-react";
import { useEffect, useState } from "react";
import "../agents.css";
import { useEditorUi, useSession } from "../session";

// Canvas / Chrome / Agent (design W4O9c8, and Xv2Wi while following), top centre while an agent is
// at work on this canvas (§7.11). Follow moves the view along with it; the thin bone frame around
// the pane says the view isn't the person's to steer until they move it or stop following.

/** The pill stays this long after the agent was last heard from. */
export const AGENT_SHOWN_MS = 30_000;

export function AgentPill() {
  const session = useSession();
  const agent = useEditorUi((s) => s.agent);
  const following = useEditorUi((s) => s.following);
  const previewing = useEditorUi((s) => s.preview !== null);
  const [, rerender] = useState(0);

  // When the agent goes quiet the pill goes, and Follow with it.
  useEffect(() => {
    if (!agent) return;
    const left = agent.at + AGENT_SHOWN_MS - Date.now();
    const done = () => {
      if (session.ui.getState().following) session.ui.setState({ following: false });
      rerender((n) => n + 1);
    };
    if (left <= 0) return done();
    const timer = setTimeout(done, left);
    return () => clearTimeout(timer);
  }, [agent, session]);

  if (!agent || previewing || Date.now() - agent.at >= AGENT_SHOWN_MS) return null;
  const { name } = agent;
  return (
    <div className="pointer-events-none absolute top-12 left-1/2 z-10 -translate-x-1/2 mac-window:top-40">
      <div
        role="status"
        className={cn(
          "pointer-events-auto flex h-40 items-center gap-8 rounded-10 pr-4 pl-12 inset-ring",
          following ? "bg-accent-soft inset-ring-accent-line" : "bg-elevated inset-ring-border",
        )}
      >
        <span aria-hidden className="of-agent-dot size-8 shrink-0 rounded-full bg-accent" />
        <span className="text-small font-medium whitespace-nowrap text-text-primary">
          {following ? t("canvas.agents.following", { name }) : t("canvas.agents.editing", { name })}
        </span>
        <Divider orientation="vertical" size={20} />
        <Button
          variant="ghost"
          size="s"
          icon={following ? X : LocateFixed}
          aria-pressed={following}
          onClick={() => session.ui.setState({ following: !following })}
        >
          {following ? t("canvas.agents.stopFollowing") : t("canvas.agents.follow")}
        </Button>
      </div>
    </div>
  );
}

/** The thin bone frame around the pane while the view follows the agent (design Z5icBr). */
export function FollowFrame() {
  const following = useEditorUi((s) => s.following);
  const previewing = useEditorUi((s) => s.preview !== null);
  if (!following || previewing) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 inset-ring-2 inset-ring-accent-line"
    />
  );
}
