precision mediump float;

// Generating card, voxel pulse. Small square cells fill the whole card.
// Pulse (mode 0), once per period: scattered voxels gather in the middle into a small flat circle,
// bright at its edge and dimmer inside, then it spreads, fills the card and carries on out past its
// edges while its middle empties, dissolving as it goes. The next one gathers as the last one leaves.
// Idle (mode 1): the small circle stays in the middle and slowly breathes, dimmer.
// Set Phase to 0..1 to freeze a frame (keyframes, reduced motion); -1 plays.
// Backing puts a dark cell under each lit one, so the pulse still reads over a dimmed image.

/** @resolution */
uniform vec2 u_resolution;

/** @time */
uniform float u_time;

/**
 * @label Color
 * @color
 * @default #E9E3D8
 */
uniform vec3 u_color;

/**
 * @label Mode (0 pulse, 1 idle)
 * @default 0
 * @range 0, 1
 */
uniform float u_mode;

/**
 * @label Cells across (width / 4 px)
 * @default 80
 * @range 20, 200
 */
uniform float u_cells;

/**
 * @label Period (s)
 * @default 1.6
 * @range 0.4, 6
 */
uniform float u_period;

/**
 * @label Backing (over an image)
 * @default 0
 * @range 0, 1
 */
uniform float u_backing;

/**
 * @label Phase (-1 plays)
 * @default -1
 * @range -1, 1
 */
uniform float u_phase;

const float TAU = 6.2831853;
// 1 px of gap on a 4 px pitch, on one side of each cell so it survives 1x.
const float GAP = 0.25;
// Brightness steps. Dithering between them keeps gradients soft without losing the voxel look.
const float STEPS = 6.0;
// The canvas surface, #0E1012.
const vec3 DARK = vec3(0.055, 0.063, 0.071);
// The circle's radius once gathered, in half-widths of the card.
const float SMALL = 0.2;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

// 4x4 ordered dither, 0..1, per cell.
float bayer(vec2 c) {
  vec2 m = mod(c, 4.0);
  float i = m.x + m.y * 4.0;
  float b = 0.0;
  if (i < 0.5) b = 0.0; else if (i < 1.5) b = 8.0; else if (i < 2.5) b = 2.0; else if (i < 3.5) b = 10.0;
  else if (i < 4.5) b = 12.0; else if (i < 5.5) b = 4.0; else if (i < 6.5) b = 14.0; else if (i < 7.5) b = 6.0;
  else if (i < 8.5) b = 3.0; else if (i < 9.5) b = 11.0; else if (i < 10.5) b = 1.0; else if (i < 11.5) b = 9.0;
  else if (i < 12.5) b = 15.0; else if (i < 13.5) b = 7.0; else if (i < 14.5) b = 13.0; else b = 5.0;
  return (b + 0.5) / 16.0;
}

// A flat circle: a bright band at its edge over a dimmer inside. Wider spreads get a thinner band
// and an emptier middle.
float circle(float r, float radius, float spread) {
  float band = smoothstep(radius * mix(0.7, 0.55, spread), radius, r);
  return mix(mix(0.4, 0.15, spread), 1.0, band);
}

void main() {
  // Cells stay square whatever the card's shape: the width sets the pitch.
  vec2 size = vec2(u_cells, u_cells * u_resolution.y / u_resolution.x);
  vec2 q = gl_FragCoord.xy / u_resolution * size - size * 0.5;
  vec2 inCell = fract(q);
  if (inCell.x < GAP || inCell.y < GAP) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec2 cell = floor(q);
  // Position in half-widths: -1..1 across, further down a portrait card.
  vec2 p = (cell + 0.5) / (u_cells * 0.5);
  float r = length(p);
  // Center to the farthest corner, in the same units.
  float reach = length(size * 0.5) / (u_cells * 0.5);

  float t = u_phase >= 0.0 ? u_phase : fract(u_time / u_period);
  float b = 0.04;

  if (u_mode < 0.5) {
    // Gather: the first quarter. Cells switch on at their own moment, the center first.
    float gather = smoothstep(0.0, 0.28, t);
    // Spread: from a quarter in to the end, out well past the farthest corner.
    float spread = smoothstep(0.22, 1.0, t);
    float radius = mix(mix(SMALL * 0.55, SMALL, gather), reach * 1.5, spread);
    // Still bright while it fills the card; it dissolves once its edge has left the frame.
    float fade = 1.0 - smoothstep(0.6, 1.5, radius / reach);

    if (r < radius) {
      b = circle(r, radius, spread) * 0.9;
      // While it gathers, cells switch on at their own moment, the center first.
      float on = spread > 0.02 ? 1.0 : step(hash(vec3(cell, 7.0)), gather * 1.7 - r / SMALL * 0.7);
      // As it fades, cells drop out at random and the rest dim, so it dissolves.
      float keep = step(hash(vec3(cell, 3.0)), fade * 1.4);
      b = mix(0.04, b * fade, on * keep);
    }
  } else {
    float breath = 0.5 - 0.5 * cos(TAU * t);
    float radius = SMALL * (0.92 + 0.12 * breath);
    if (r < radius) b = max(circle(r, radius, 0.0) * (0.35 + 0.25 * breath), 0.04);
  }

  b = clamp(floor(b * STEPS + bayer(cell)) / STEPS, 0.0, 1.0);
  float alpha = mix(0.05, 0.95, b);

  // Only lit cells get the backing, so the image stays visible around the pulse.
  float backing = u_backing * smoothstep(0.0, 0.3, b);
  vec3 rgb = u_color * alpha + DARK * backing * (1.0 - alpha);
  gl_FragColor = vec4(rgb, alpha + backing * (1.0 - alpha));
}
