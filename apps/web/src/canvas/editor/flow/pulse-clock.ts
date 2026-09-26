import { clockAt, PULSE, pulseEnds, pulseHead, pulseLength } from "./pulse";

// One requestAnimationFrame loop moves every pulse on the canvas (motion spec IMRkA). Links share
// the clock, so pulses into the same node land together whatever their length. Each frame writes
// a few SVG attributes straight onto the elements: no React state, and nothing runs while no link
// is pulsing. Under reduced motion no link ever joins, so the loop never starts.

export interface PulseParts {
  /** The link's own path: its length and points come from here. */
  line: SVGPathElement;
  core: SVGPathElement;
  glow: SVGPathElement | null;
  /** Runs tail to head along the pulse, moved every frame. */
  gradient: SVGLinearGradientElement;
}

interface Pulse extends PulseParts {
  /** The first cycle it may run in: a link that turns active waits for the next cycle's start. */
  from: number;
  /** Measured lazily, and again after the path changes. */
  total: number;
  shown: boolean;
}

const pulses = new Set<Pulse>();
let frame = 0;

const set = (el: Element, name: string, value: string) => {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
};

function hide(pulse: Pulse) {
  if (!pulse.shown) return;
  pulse.shown = false;
  set(pulse.core, "visibility", "hidden");
  if (pulse.glow) set(pulse.glow, "visibility", "hidden");
}

function draw(pulse: Pulse, cycle: number, phase: number, glow: boolean) {
  if (cycle < pulse.from) return hide(pulse);
  if (!(pulse.total > 0)) pulse.total = pulse.line.getTotalLength();
  const total = pulse.total;
  const head = pulseHead(phase, total);
  if (head === null) return hide(pulse);
  const length = pulseLength(total);
  // One dash P long, then a gap longer than the link: only [head - P, head] is ever drawn.
  const dash = `${length} ${total + length}`;
  const offset = String(length - head);
  // The gradient spans the whole pulse, even the part still under a port.
  const { line, gradient } = pulse;
  const [a, b] = pulseEnds(head, total, (distance) => line.getPointAtLength(distance));
  set(gradient, "x1", String(a.x));
  set(gradient, "y1", String(a.y));
  set(gradient, "x2", String(b.x));
  set(gradient, "y2", String(b.y));
  for (const el of [pulse.core, glow ? pulse.glow : null]) {
    if (!el) continue;
    set(el, "stroke-dasharray", dash);
    set(el, "stroke-dashoffset", offset);
    set(el, "visibility", "visible");
  }
  if (pulse.glow && !glow) set(pulse.glow, "visibility", "hidden");
  pulse.shown = true;
}

function tick(now: number) {
  frame = 0;
  if (!pulses.size) return;
  const { cycle, phase } = clockAt(now);
  const glow = pulses.size <= PULSE.glowMax;
  for (const pulse of pulses) draw(pulse, cycle, phase, glow);
  frame = requestAnimationFrame(tick);
}

export interface PulseHandle {
  /** The link's path changed (a node moved): measure it again next frame. */
  remeasure(): void;
  /** Stops moving it where it is (the fade out keeps the last frame). */
  stop(): void;
}

/** Starts a link's pulse at the next cycle of the shared clock. */
export function startPulse(parts: PulseParts): PulseHandle {
  const now = performance.now();
  const { cycle, phase } = clockAt(now);
  // Just past the start of a cycle still counts as its start; otherwise wait for the next one.
  const pulse: Pulse = { ...parts, from: phase < 50 ? cycle : cycle + 1, total: 0, shown: true };
  hide(pulse);
  pulses.add(pulse);
  if (!frame) frame = requestAnimationFrame(tick);
  return {
    remeasure: () => {
      pulse.total = 0;
    },
    stop: () => {
      pulses.delete(pulse);
      if (!pulses.size && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    },
  };
}
