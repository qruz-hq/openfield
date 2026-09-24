import { type CanvasVersion, formatDate, formatLocale, t } from "@openfield/core";

// Version history rows (design mM53x pmK69): grouped by day ("Today", "Yesterday", then the date),
// newest first, with the current canvas on top of Today. A named version shows its name; the rest
// show their time, and snapshots taken before something big say what it was.

export interface VersionRow {
  /** null for the current canvas. */
  version: CanvasVersion | null;
  title: string;
  meta: string;
  coverAssetId: string | null;
}

export interface VersionGroup {
  key: string;
  label: string;
  rows: VersionRow[];
}

export interface CurrentCanvas {
  nodeCount: number;
  edgeCount: number;
  coverAssetId: string | null;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function versionTime(at: string | Date): string {
  return new Intl.DateTimeFormat(formatLocale(), { timeStyle: "short" }).format(new Date(at));
}

const counts = (nodes: number, edges: number) => t("canvas.editor.versions.counts", { nodes, edges });

export function versionRow(version: CanvasVersion): VersionRow {
  const time = versionTime(version.createdAt);
  const tally = counts(version.nodeCount, version.edgeCount);
  if (version.label) {
    return {
      version,
      title: version.label,
      meta: t("canvas.editor.versions.withTime", { time, counts: tally }),
      coverAssetId: version.coverAssetId,
    };
  }
  const meta =
    version.kind === "auto" || version.kind === "named"
      ? tally
      : t("canvas.editor.versions.withKind", {
          kind: t(`canvas.editor.versions.kind.${version.kind}`),
          counts: tally,
        });
  return { version, title: time, meta, coverAssetId: version.coverAssetId };
}

export function groupVersions(
  versions: readonly CanvasVersion[],
  current: CurrentCanvas,
  now: Date = new Date(),
): VersionGroup[] {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groups: VersionGroup[] = [
    {
      key: today,
      label: t("canvas.editor.versions.today"),
      rows: [
        {
          version: null,
          title: t("canvas.editor.versions.current"),
          meta: t("canvas.editor.versions.withTime", {
            time: t("canvas.editor.versions.now"),
            counts: counts(current.nodeCount, current.edgeCount),
          }),
          coverAssetId: current.coverAssetId,
        },
      ],
    },
  ];
  const sorted = [...versions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const version of sorted) {
    const at = new Date(version.createdAt);
    const key = dayKey(at);
    let group = groups.find((g) => g.key === key);
    if (!group) {
      const label = key === yesterday ? t("canvas.editor.versions.yesterday") : formatDate(at);
      group = { key, label, rows: [] };
      groups.push(group);
    }
    group.rows.push(versionRow(version));
  }
  return groups;
}
