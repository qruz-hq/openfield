import { formatBytes, type MessageKey, tParts } from "@openfield/core";
import { Surface } from "@openfield/ui";
import type { ReactNode } from "react";

// Settings / Storage meter (design JQQ1v): space used, free space on the right, then one bar and
// a legend for images, thumbnails and trash.

export interface MeterSegment {
  label: string;
  bytes: number;
}

const TONES = ["bg-text-primary", "bg-text-secondary", "bg-text-tertiary"];

/** A catalogue line with its size in mono, in whatever order the language puts them. */
function Sized({
  id,
  bytes,
  number,
  words,
}: {
  id: MessageKey;
  bytes: number;
  number: string;
  words: string;
}) {
  const parts = tParts<ReactNode>(id, {
    size: (
      <span key="size" className={number}>
        {formatBytes(bytes)}
      </span>
    ),
  });
  return parts.map((part) =>
    typeof part === "string" ? (
      part.trim() ? (
        <span key={part} className={words}>
          {part.trim()}
        </span>
      ) : null
    ) : (
      part
    ),
  );
}

export function StorageMeter({
  segments,
  freeBytes,
}: {
  segments: MeterSegment[];
  freeBytes: number | null;
}) {
  const used = segments.reduce((sum, s) => sum + s.bytes, 0);
  // Shares of the whole disk when free space is known, so the bar reads as room left.
  const whole = Math.max(1, used + (freeBytes ?? 0));

  return (
    <Surface variant="card">
      <div className="flex w-full items-end justify-between">
        <div className="flex items-end gap-6">
          <Sized
            id="settings.storage.used"
            bytes={used}
            number="text-mono-24 text-text-primary"
            words="text-small text-text-secondary"
          />
        </div>
        {freeBytes === null ? null : (
          <div className="flex items-center gap-4">
            <Sized
              id="settings.storage.free"
              bytes={freeBytes}
              number="text-mono-12 text-text-tertiary"
              words="text-caption text-text-tertiary"
            />
          </div>
        )}
      </div>
      <div aria-hidden className="flex h-8 w-full overflow-hidden rounded-full bg-elevated-2">
        {segments.map((segment, i) => (
          <div
            key={segment.label}
            className={`h-8 shrink-0 ${TONES[i]}`}
            style={{ width: `${(segment.bytes / whole) * 100}%` }}
          />
        ))}
      </div>
      <dl className="flex items-center gap-16">
        {segments.map((segment, i) => (
          <div key={segment.label} className="flex items-center gap-6">
            <span aria-hidden className={`size-8 rounded-2 ${TONES[i]}`} />
            <dt className="text-caption text-text-secondary">{segment.label}</dt>
            <dd className="text-mono-12 text-text-primary">{formatBytes(segment.bytes)}</dd>
          </div>
        ))}
      </dl>
    </Surface>
  );
}
