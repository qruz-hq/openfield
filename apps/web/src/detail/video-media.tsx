import { type AssetListItem, t } from "@openfield/core";
import { cn } from "@openfield/ui";
import { Maximize, Minimize, Pause, Play, Repeat, Volume2, VolumeX } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useAuthedImage } from "../api/hooks/images";
import { useAuthedVideo } from "../api/hooks/videos";
import { BACKDROP_RUNG, thumbAt } from "./format";
import { MEDIA_INSET } from "./media";

// Detail / Video controls (design HFVBj): the video fit inside the media area (never cropped,
// unlike an image's fill), and one 640×40 bar under it: play, time, a scrubber, sound, loop and
// full screen. The poster carries the frame until the file itself has loaded.

export interface VideoMediaHandle {
  togglePlay: () => void;
}

interface VideoMediaProps {
  item: AssetListItem;
  expanded: boolean;
  label: string;
  ref?: Ref<VideoMediaHandle>;
}

const clock = (seconds: number) => {
  const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, "0")}`;
};

export function VideoMedia({ item, expanded, label, ref }: VideoMediaProps) {
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(!(item.hasAudio ?? false));
  const [loop, setLoop] = useState(false);
  const [full, setFull] = useState(false);
  const [time, setTime] = useState({ current: 0, total: (item.durationMs ?? 0) / 1000 });
  const poster = useAuthedImage(thumbAt(item, { h: BACKDROP_RUNG }));
  const clip = useAuthedVideo(item.fileUrl);

  useImperativeHandle(ref, () => ({
    togglePlay: () => {
      const el = video.current;
      if (!el) return;
      if (el.paused) void el.play();
      else el.pause();
    },
  }));

  const seekTo = (clientX: number) => {
    const el = video.current;
    const track = bar.current;
    if (!el || !track || !el.duration) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    el.currentTime = ratio * el.duration;
  };

  const onScrubDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    seekTo(event.clientX);
  };
  const onScrubMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.buttons !== 1) return;
    seekTo(event.clientX);
  };

  // Reset when the panel switches to another video, before the new element has metadata.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh item means a fresh player.
  useEffect(() => {
    setPlaying(false);
    setTime({ current: 0, total: (item.durationMs ?? 0) / 1000 });
  }, [item.id]);

  const playedPct = time.total > 0 ? Math.min(100, (time.current / time.total) * 100) : 0;

  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      style={{ padding: expanded ? 0 : MEDIA_INSET }}
    >
      <div className="relative flex max-h-full max-w-full items-center justify-center">
        {poster.status === "ready" ? (
          <img
            src={poster.src}
            alt=""
            aria-hidden={clip.status === "ready"}
            className={cn(
              "max-h-full max-w-full rounded-4 object-contain",
              clip.status === "ready" && "invisible",
            )}
          />
        ) : null}
        {clip.status === "ready" ? (
          <video
            ref={video}
            src={clip.src}
            aria-label={label}
            loop={loop}
            muted={muted}
            playsInline
            className="absolute inset-0 size-full rounded-4 object-contain"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(event) => {
              // The element itself, not the (possibly since-recycled) event, once inside the updater.
              const el = event.currentTarget;
              setTime({ current: el.currentTime, total: el.duration || 0 });
            }}
            onLoadedMetadata={(event) => {
              const total = event.currentTarget.duration;
              setTime((prev) => ({ ...prev, total: total || prev.total }));
            }}
          />
        ) : null}
      </div>
      <div className="absolute bottom-20 left-1/2 flex h-40 w-640 max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-8 rounded-12 bg-overlay px-6 inset-ring inset-ring-overlay-line backdrop-blur-chip">
        <button
          type="button"
          aria-label={playing ? t("video.controls.pause") : t("video.controls.play")}
          onClick={() => (video.current?.paused ? void video.current.play() : video.current?.pause())}
          className="flex size-28 shrink-0 cursor-pointer items-center justify-center rounded-8 text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
        >
          {playing ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
        </button>
        <span className="shrink-0 text-mono-12 text-text-secondary">
          {clock(time.current)} / {clock(time.total)}
        </span>
        <div
          ref={bar}
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          className="relative h-16 flex-1 cursor-pointer"
        >
          <div className="absolute top-1/2 left-0 h-3 w-full -translate-y-1/2 rounded-2 bg-white/15" />
          <div
            className="absolute top-1/2 left-0 h-3 -translate-y-1/2 rounded-2 bg-accent"
            style={{ width: `${playedPct}%` }}
          />
          <div
            className="absolute top-1/2 size-12 -translate-y-1/2 rounded-full bg-accent"
            style={{ left: `calc(${playedPct}% - 6px)` }}
          />
        </div>
        <button
          type="button"
          aria-label={muted ? t("video.controls.unmute") : t("video.controls.mute")}
          aria-pressed={!muted}
          onClick={() => setMuted((m) => !m)}
          className="flex size-28 shrink-0 cursor-pointer items-center justify-center rounded-8 text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
        >
          {muted ? <VolumeX size={16} aria-hidden /> : <Volume2 size={16} aria-hidden />}
        </button>
        <button
          type="button"
          aria-label={t("video.controls.loop")}
          aria-pressed={loop}
          onClick={() => setLoop((l) => !l)}
          className={cn(
            "flex size-28 shrink-0 cursor-pointer items-center justify-center rounded-8 transition-colors hover:bg-white/10",
            loop ? "text-accent" : "text-text-secondary hover:text-text-primary",
          )}
        >
          <Repeat size={16} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={full ? t("video.controls.exitFullScreen") : t("video.controls.fullScreen")}
          onClick={async () => {
            const el = video.current?.parentElement;
            if (!document.fullscreenElement && el) {
              await el.requestFullscreen();
              setFull(true);
            } else if (document.fullscreenElement) {
              await document.exitFullscreen();
              setFull(false);
            }
          }}
          className="flex size-28 shrink-0 cursor-pointer items-center justify-center rounded-8 text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
        >
          {full ? <Minimize size={16} aria-hidden /> : <Maximize size={16} aria-hidden />}
        </button>
      </div>
    </div>
  );
}
