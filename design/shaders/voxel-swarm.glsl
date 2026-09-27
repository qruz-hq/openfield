// Full precision where the GPU has it: the clock runs to large values over a session.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

// Generating card, particle swarm. The same 4 px voxel grid as voxel-pulse.glsl, over the whole card.
// Single-cell particles each drift in a slow loop around their own home. A slowly churning cloud
// field decides which ones show, so they gather into airy clusters that form and break up in
// place, and a few pockets inside the clouds glow brighter and fade, a few at a time.
// Swarm (mode 0) is the generating state. Idle (mode 1) is the same swarm, slower and dimmer, with
// no glowing pockets, for waiting.
// Injection: each time a connected input port's link glow lands (Arrives at, on the canvas's shared
// Link cycle), a puff of new cloud swells out in a circle from that port on the card's left edge,
// with a cloud's uneven edge and a denser middle, then keeps diffusing outwards, thinning as it
// spreads, until it has become sky a few cycles later. It never pulls back. It's
// added to the cloud's own thickness, so it has the same solid core, particle edges, light and shade
// as every other puff, and puffs from ports next to each other run together. It carries a touch of
// the link's glow as it appears.
// Seed makes each card its own sky: it moves the cloud field, the particles and the pockets, so no
// two generating cards look alike. The app derives it from the run's id.
// Set Phase to 0..1 to freeze a frame (keyframes, reduced motion); -1 plays.
// Backing puts a dark cell under each lit one, so particles still read over a dimmed image.
// The app draws it one fragment per cell and cuts the 1 px gaps afterwards (apps/web/src/canvas/
// nodes/generate/voxel), so a fragment always sits mid-cell and the gap test below never trips.

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
 * @label Mode (0 swarm, 1 idle)
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
 * @label Period (s, one glowing pocket)
 * @default 3.2
 * @range 1, 10
 */
uniform float u_period;

/**
 * @label Input ports (share of the card's height from the top, -1 not connected)
 */
uniform vec3 u_ports;

/**
 * @label Link cycle (s)
 * @default 2.4
 * @range 0.8, 8
 */
uniform float u_link;

/**
 * @label Link arrives at (s into the cycle)
 * @default 1.6
 * @range 0, 8
 */
uniform float u_arrive;

/**
 * @label Starts fading after (s)
 * @default 2.4
 * @range 0.8, 8
 */
uniform float u_settle;

/**
 * @label Seed
 * @default 0
 * @range 0, 1000
 */
uniform float u_seed;

/**
 * @label Backing color (the canvas surface)
 * @color
 * @default #0E1012
 */
uniform vec3 u_dark;

/**
 * @label First dose lands at (s on the clock, -1 any)
 * @default -1
 * @range -1, 100000
 */
uniform float u_first;

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

const float GAP = 0.25;
const float STEPS = 6.0;
// One particle per this many cells, each way, before the clouds hide some of them.
const float SPACING = 1.25;
// How far a particle wanders from home, in cells.
const float WANDER = 1.6;
const float PI = 3.1415927;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return v;
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

// How cloudy it is at p (cells from the center): 0 clear, 1 thick. The field is warped by itself,
// which makes billowy puffs with dense cores and thinning edges. It churns in place.
float cloud(vec2 p, float time) {
  // The seed picks a far-off part of the noise, so each card's clouds are its own.
  // Kept within a few hundred cells: far larger offsets lose float precision and band the noise.
  p += vec2(fract(u_seed * 0.1373), fract(u_seed * 0.4127)) * 400.0;
  vec3 q = vec3(p * 0.045, time * 0.1);
  vec2 warp = vec2(fbm(q), fbm(q + vec3(5.2, 1.3, 0.0)));
  float n = fbm(vec3(p * 0.045 + 1.2 * warp, time * 0.12));
  // Finer texture inside each cloud, so it isn't one even patch.
  float detail = noise(vec3(p * 0.12, time * 0.3));
  return smoothstep(0.36, 0.68, n) * mix(0.7, 1.0, detail);
}

// Glowing pockets: a few soft spots that light up and fade, each at its own time and place.
float pockets(vec2 p, vec2 size, float time) {
  float g = 0.0;
  for (int i = 0; i < 5; i++) {
    float k = float(i);
    float tk = time / u_period + k * 0.2 + fract(u_seed * 0.618);
    float epoch = floor(tk);
    float f = fract(tk);
    vec3 at = vec3(k + fract(u_seed * 0.2311) * 97.0, epoch, 0.0);
    vec2 center = (vec2(hash(at + vec3(0, 0, 1)), hash(at + vec3(0, 0, 2))) - 0.5) * size * 0.9;
    float radius = 12.0 + 10.0 * hash(at + vec3(0, 0, 3));
    float d = length(p - center);
    float rise = sin(PI * f);
    g = max(g, exp(-d * d / (radius * radius)) * rise * rise);
  }
  return g;
}

// A puff swells to about this radius, in cells, over SWELL seconds, then keeps diffusing outwards
// at SPREAD cells per square-root second: the same cloud over a wider area, so it thins as it goes.
const float PUFF = 12.0;
const float SWELL = 0.8;
const float SPREAD = 7.0;

// One puff's thickness at d (cells from its port), tau seconds after its dose landed. fresh is how
// much of the link's glow it still carries there.
float plume(vec2 d, float tau, float seed, out float fresh) {
  float grow = 1.0 - pow(1.0 - clamp(tau / SWELL, 0.0, 1.0), 3.0);
  float radius = 2.0 + (PUFF - 2.0) * grow + SPREAD * sqrt(max(tau - SWELL * 0.5, 0.0));
  // Thinner the wider it gets, and gone into the sky over the next couple of cycles: it never
  // pulls back, it only spreads and fades.
  float amount = min(1.0, pow(PUFF / radius, 2.0)) * (1.0 - smoothstep(u_settle, u_settle * 3.0, tau));
  float r = length(d);
  vec2 dir = r > 0.0 ? d / r : vec2(1.0, 0.0);
  // A cloud's uneven edge: the reach varies around the circle and drifts slowly.
  float edge = radius * (0.7 + 0.6 * fbm(vec3(dir * 1.8 + seed, tau * 0.35 + seed)));
  float body = exp(-2.0 * r * r / (edge * edge));
  // Some texture inside, so it isn't one even patch.
  float inside = mix(0.75, 1.0, noise(vec3(d * 0.2, tau * 0.5 + seed)));
  fresh = (1.0 - smoothstep(0.0, 0.8, tau)) * body;
  return clamp(body * inside * amount, 0.0, 1.0);
}

// All connected ports' plumes at p (cells from the card's center), merged: where two meet they run
// together. The last three doses count, so a puff still diffusing isn't cut off.
float plumes(vec2 p, vec2 size, float time, out float fresh) {
  fresh = 0.0;
  float since = time - u_arrive;
  if (since < 0.0) return 0.0;
  float latest = floor(since / u_link);
  float clear = 1.0;
  for (int i = 0; i < 3; i++) {
    float y = i == 0 ? u_ports.x : (i == 1 ? u_ports.y : u_ports.z);
    if (y < 0.0) continue;
    // The port sits on the card's left edge; y is a share of the card's height from the top.
    vec2 port = vec2(-size.x * 0.5, size.y * (0.5 - y));
    for (int k = 0; k < 3; k++) {
      float dose = latest - float(k);
      if (dose < 0.0) break;
      // A link starts pulsing on the cycle after it lights up: no puff before its first pulse lands.
      if (u_first >= 0.0 && dose * u_link + u_arrive < u_first - 0.05) continue;
      float tau = since - dose * u_link;
      float seed = mod(dose, 97.0) * 3.7 + float(i) * 11.3 + fract(u_seed * 0.37) * 50.0;
      float f;
      float t = plume(p - port, tau, seed, f);
      clear *= 1.0 - t;
      fresh = max(fresh, f);
    }
  }
  return 1.0 - clear;
}

void main() {
  vec2 size = vec2(u_cells, u_cells * u_resolution.y / u_resolution.x);
  vec2 q = gl_FragCoord.xy / u_resolution * size - size * 0.5;
  vec2 inCell = fract(q);
  if (inCell.x < GAP || inCell.y < GAP) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec2 cell = floor(q);

  float idle = step(0.5, u_mode);
  float time = (u_phase >= 0.0 ? u_phase * u_period : u_time) * mix(1.0, 0.5, idle);

  vec2 here = cell + 0.5;

  vec2 src = here;

  // The cloud and any glow at the source, once per cell: every particle passing through shares them.
  float thick = cloud(src, time);
  float injected = 0.0;
  // Light from above and a little to the left: a cell whose neighbor towards the light is thinner
  // sits on the top of a puff and catches it; one under thicker cloud is in shade.
  float towardLight = cloud(src + vec2(-1.5, 3.0), time);
  // Injected liquid joins the cloud's own thickness, so it's drawn exactly like a puff; where it
  // meets cloud the two run together.
  if (idle < 0.5) {
    float fresh;
    float lit;
    float added = plumes(here, size, time, fresh);
    float addedToward = plumes(here + vec2(-1.5, 3.0), size, time, lit);
    thick = 1.0 - (1.0 - thick) * (1.0 - added);
    towardLight = 1.0 - (1.0 - towardLight) * (1.0 - addedToward);
    injected = fresh;
  }
  float shade = clamp(0.62 + 1.4 * (thick - towardLight), 0.3, 1.25);
  float glow = max(pockets(src, size, time) * smoothstep(0.0, 0.3, thick), injected * 0.55) * (1.0 - idle);

  // The thick core of a puff is solid; particles only scatter where it thins out.
  float present = smoothstep(0.5, 0.62, thick);
  vec2 srcCell = floor(src);
  vec2 home0 = floor(src / SPACING);
  // Every particle that could have wandered into this cell.
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      if (present > 0.99) break;
      vec2 lattice = home0 + vec2(float(i), float(j));
      // Particle identity includes the seed, so the same cell gets different particles per card.
      vec2 id = lattice + floor(vec2(fract(u_seed * 0.3119), fract(u_seed * 0.7193)) * 300.0);
      float h1 = hash(vec3(id, 1.0));
      float h2 = hash(vec3(id, 2.0));
      float h3 = hash(vec3(id, 3.0));
      float h4 = hash(vec3(id, 4.0));
      vec2 home = (lattice + vec2(h1, h2)) * SPACING;
      vec2 wander = WANDER * vec2(
        sin(time * (0.5 + 0.7 * h3) + 6.2831853 * h1),
        cos(time * (0.4 + 0.6 * h4) + 6.2831853 * h2));
      if (floor(home + wander) != srcCell) continue;
      // Clouds decide which particles show: most where it's thick, few at the edges. A glowing
      // pocket gathers a few more.
      if (hash(vec3(id, 5.0)) < pow(thick, 0.8) * 0.97 + glow * 0.4) present = 1.0;
    }
  }

  float b = 0.04;
  if (present > 0.0) {
    b = max(b, ((0.16 + 0.55 * thick) * shade + 0.7 * glow) * mix(1.0, 0.55, idle) * max(present, 0.6));
  }

  // Dithered steps, so the shading reads as a smooth gradient in voxels.
  b = clamp(floor(b * STEPS + bayer(cell)) / STEPS, 0.0, 1.0);
  float alpha = mix(0.05, 0.95, b);
  float backing = u_backing * smoothstep(0.0, 0.3, b);
  vec3 rgb = u_color * alpha + u_dark * backing * (1.0 - alpha);
  gl_FragColor = vec4(rgb, alpha + backing * (1.0 - alpha));
}
