import type { ActiveTab, NavigateTarget, PresenceBody } from "@openfield/core";
import type { EventHub } from "../events/hub";

// Where each open tab is (§7.11), in memory only: its route, the canvas it shows and what's selected
// there. An agent's "the canvas I have open" means the tab focused last. A tab reports itself on
// every route, selection and focus change, and is forgotten when its event stream closes. Only a
// tab whose stream is open can be asked to open something: the request travels on that stream.

interface Tab extends ActiveTab {
  /** Last report, for ties between tabs that were never focused. */
  seenAt: number;
}

export class PresenceService {
  readonly #tabs = new Map<string, Tab>();
  /** Tabs with their event stream open. */
  readonly #streaming = new Set<string>();

  constructor(
    private readonly events: EventHub,
    private readonly now: () => number = Date.now,
  ) {}

  report(body: PresenceBody): void {
    const previous = this.#tabs.get(body.tabId);
    const at = this.now();
    this.#tabs.set(body.tabId, {
      ...body,
      // Focus is what counts: a background tab reporting a route change doesn't take over.
      focusedAt: body.focused ? new Date(at).toISOString() : (previous?.focusedAt ?? null),
      seenAt: at,
    });
  }

  /** Its event stream opened: ui.navigate can reach it now. */
  connected(tabId: string): void {
    this.#streaming.add(tabId);
  }

  /** Its event stream closed: the tab is gone, or will report again when it reconnects. */
  drop(tabId: string): void {
    this.#tabs.delete(tabId);
    this.#streaming.delete(tabId);
  }

  /** The tab focused last, else the one heard from last. */
  active(): ActiveTab | null {
    return this.#pick([...this.#tabs.values()]);
  }

  #pick(tabs: readonly Tab[]): ActiveTab | null {
    const later = (a: Tab, b: Tab) => {
      const [fa, fb] = [a.focusedAt ?? "", b.focusedAt ?? ""];
      return fa !== fb ? fa > fb : a.seenAt > b.seenAt;
    };
    const best = tabs.reduce<Tab | null>(
      (winner, tab) => (!winner || later(tab, winner) ? tab : winner),
      null,
    );
    if (!best) return null;
    const { seenAt: _seen, ...tab } = best;
    return tab;
  }

  /** Every tab showing this canvas. */
  tabsOn(canvasId: string): ActiveTab[] {
    return [...this.#tabs.values()].filter((t) => t.canvasId === canvasId).map(({ seenAt: _s, ...t }) => t);
  }

  /**
   * Asks the active tab (or this one) to open something. The tab id it went to, or null when no tab
   * is open.
   */
  navigate(to: NavigateTarget, tabId?: string): string | null {
    const reachable = [...this.#tabs.values()].filter((t) => this.#streaming.has(t.tabId));
    const tab = tabId === undefined ? this.#pick(reachable) : reachable.find((t) => t.tabId === tabId);
    if (!tab) return null;
    this.events.publish("ui.navigate", { tabId: tab.tabId, to });
    return tab.tabId;
  }
}
