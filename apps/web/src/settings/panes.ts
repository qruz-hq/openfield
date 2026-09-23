import type { MessageKey } from "@openfield/core";
import {
  CircleHelp,
  FlaskConical,
  HardDrive,
  Key,
  Layers,
  type LucideIcon,
  Receipt,
  Shield,
  SlidersHorizontal,
  Sun,
} from "lucide-react";

// The nine panes of Settings, in the order of §6.17, with the icons the design puts on the rail.

export interface Pane {
  slug: string;
  icon: LucideIcon;
  label: MessageKey;
  title: MessageKey;
  intro: MessageKey;
}

export const PANES: readonly Pane[] = [
  {
    slug: "api-keys",
    icon: Key,
    label: "settings.rail.apiKeys",
    title: "settings.apiKeys.title",
    intro: "settings.apiKeys.intro",
  },
  {
    slug: "models",
    icon: Layers,
    label: "settings.rail.models",
    title: "settings.models.title",
    intro: "settings.models.intro",
  },
  {
    slug: "defaults",
    icon: SlidersHorizontal,
    label: "settings.rail.defaults",
    title: "settings.defaults.title",
    intro: "settings.defaults.intro",
  },
  {
    slug: "appearance",
    icon: Sun,
    label: "settings.rail.appearance",
    title: "settings.appearance.title",
    intro: "settings.appearance.intro",
  },
  {
    slug: "storage",
    icon: HardDrive,
    label: "settings.rail.storage",
    title: "settings.storage.title",
    intro: "settings.storage.intro",
  },
  {
    slug: "spending",
    icon: Receipt,
    label: "settings.rail.spending",
    title: "settings.spending.title",
    intro: "settings.spending.intro",
  },
  {
    slug: "privacy",
    icon: Shield,
    label: "settings.rail.privacy",
    title: "settings.privacy.title",
    intro: "settings.privacy.intro",
  },
  {
    slug: "help",
    icon: CircleHelp,
    label: "settings.rail.help",
    title: "settings.help.title",
    intro: "settings.help.intro",
  },
  {
    slug: "experimental",
    icon: FlaskConical,
    label: "settings.rail.experimental",
    title: "settings.experimental.title",
    intro: "settings.experimental.intro",
  },
];

export const DEFAULT_PANE = "api-keys";
