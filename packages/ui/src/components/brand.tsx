import {
  type ComponentProps,
  type RefObject,
  type SVGProps,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn";

// The aperture mark ("rebuilt"): four rounded blades turning around the center at 28,28. It looks
// the same every quarter turn, which the generating spin relies on. Smaller sizes scale the paths.
const BLADES = [
  "M9.595 28.276L16.92 17.778A3.911 3.911 0 0 1 23.334 22.254L16.009 32.751A3.911 3.911 0 0 1 9.595 28.276Z",
  "M27.724 9.595L38.222 16.92A3.911 3.911 0 0 1 33.746 23.334L23.249 16.009A3.911 3.911 0 0 1 27.724 9.595Z",
  "M46.405 27.724L39.08 38.222A3.911 3.911 0 0 1 32.666 33.746L39.991 23.249A3.911 3.911 0 0 1 46.405 27.724Z",
  "M28.276 46.405L17.778 39.08A3.911 3.911 0 0 1 22.254 32.666L32.751 39.991A3.911 3.911 0 0 1 28.276 46.405Z",
];

const BRAND_NAME = "Openfield";

/** One full turn while generating. */
const TURN_MS = 6000;
const DEG_PER_MS = 360 / TURN_MS;
// Starts at twice its average speed, so a settle that lasts 2 × distance / speed picks up exactly
// where the spin left off and eases to a stop.
const SETTLE_EASING = "cubic-bezier(0.25, 0.5, 0.5, 1)";

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Where the spinning group is right now, in degrees from 0 to 360. */
function currentAngle(el: Element): number {
  const transform = getComputedStyle(el).transform;
  if (!transform || transform === "none") return 0;
  const m = new DOMMatrixReadOnly(transform);
  return ((Math.atan2(m.b, m.a) * 180) / Math.PI + 360) % 360;
}

/**
 * Spins the group while `on`. When it turns off, the mark carries on to the next quarter turn and
 * eases to a stop there instead of snapping back. True until it has stopped.
 */
function useSpin(ref: RefObject<SVGGElement | null>, on: boolean): boolean {
  const [settling, setSettling] = useState(false);
  const animation = useRef<Animation | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    const from = currentAngle(el);
    animation.current?.cancel();
    animation.current = null;
    setSettling(false);
    if (on) {
      if (reducedMotion()) return;
      animation.current = el.animate(
        [{ transform: `rotate(${from}deg)` }, { transform: `rotate(${from + 360}deg)` }],
        { duration: TURN_MS, iterations: Number.POSITIVE_INFINITY },
      );
      return;
    }
    const to = Math.ceil(from / 90) * 90;
    const duration = (2 * (to - from)) / DEG_PER_MS;
    // Already at rest, or within a frame of it.
    if (duration < 16) return;
    const settle = el.animate([{ transform: `rotate(${from}deg)` }, { transform: `rotate(${to}deg)` }], {
      duration,
      easing: SETTLE_EASING,
    });
    animation.current = settle;
    setSettling(true);
    settle.onfinish = () => {
      if (animation.current === settle) animation.current = null;
      setSettling(false);
    };
  }, [on, ref]);

  useEffect(() => () => animation.current?.cancel(), []);
  return on || settling;
}

export interface BrandMarkProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  /** 18 in the nav, 24 in canvas chrome, 56 on empty states. */
  size?: 18 | 24 | 56;
  /** Gives the mark an accessible name. Leave it out when a visible name sits next to it. */
  title?: string;
  /**
   * Something is being made: the mark turns slowly with a soft pulsing glow, then settles back.
   * With reduced motion it only glows. Pass it, true or false, wherever the mark can come alive.
   */
  generating?: boolean;
}

export function BrandMark({ size = 18, title, generating, className, ...props }: BrandMarkProps) {
  const animated = generating !== undefined;
  const on = generating === true;
  const spinRef = useRef<SVGGElement>(null);
  const active = useSpin(spinRef, on);
  const glowId = `brand-glow-${useId().replace(/[^\w-]/g, "")}`;
  const blades = BLADES.map((d) => <path key={d} d={d} />);
  const shared = {
    viewBox: "0 0 56 56",
    width: size,
    height: size,
    // The glow spreads past the 56 box.
    overflow: animated ? "visible" : undefined,
    className: cn("shrink-0 fill-accent", className),
  };
  const content = animated ? (
    <>
      <defs>
        <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
      </defs>
      <g ref={spinRef} style={{ transformOrigin: "28px 28px" }}>
        {/* The glow fades in and out here; the pulse runs inside it so stopping never snaps. */}
        <g className={cn("opacity-0 transition-opacity duration-600", on && "opacity-100")}>
          <g filter={`url(#${glowId})`} className={cn("opacity-60", active && "animate-brand-glow")}>
            {blades}
          </g>
        </g>
        {blades}
      </g>
    </>
  ) : (
    blades
  );
  if (title) {
    return (
      <svg role="img" {...shared} {...props}>
        <title>{title}</title>
        {content}
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" {...shared} {...props}>
      {content}
    </svg>
  );
}

export interface BrandLockupProps extends ComponentProps<"span"> {
  /** See BrandMark. */
  generating?: boolean;
}

/** Brand / Lockup: the 18px mark and the wordmark, gap 8. */
export function BrandLockup({ generating, className, ...props }: BrandLockupProps) {
  return (
    <span className={cn("inline-flex items-center gap-8", className)} {...props}>
      <BrandMark size={18} generating={generating} />
      <span className="text-body-strong text-text-primary">{BRAND_NAME}</span>
    </span>
  );
}
