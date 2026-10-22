// Aquarium display: a procedural underwater scene with the live creatures.
// Creatures arrive and leave through Server-Sent Events. Sprites are drawn as
// vertical strips so the tail (or tentacles) can bend without a skeleton.
// Creatures swim in depth too: d = 0 is far (near the horizon), d = 1 is near.
// Depth sets their size, speed, haze and the sand they can reach, using the
// same model as the scenery.
import { byId } from './shared/species.js';
import { createScenery } from './scenery.js';

const TAU = Math.PI * 2;
const MAX_DPR = 2;
const JET_PERIOD = 1.4; // seconds per squid jet cycle
const JET_THRUST_SHARE = 0.35; // fraction of the cycle spent thrusting
const ENTER_SECONDS = 1.2;
const FADE_IN_SECONDS = 1.8;
const LEAVE_SECONDS = 1.5;
const GLOW_SECONDS = 1.6;
const MAX_SPARKS = 160;
const NEAR_SIZE = 0.8; // drawn size at the front (depth 1), times motion.size * H
const DEPTH_SPEED_MIN = 0.08; // depth units per second: a full crossing takes 7 to 12 s
const DEPTH_SPEED_MAX = 0.14;
const FOG_MIN = 0.03; // below this haze level the fog pass is skipped
const SEPARATION_DEPTH = 0.15; // creatures this far apart in depth do not push each other

// Wave tuning per species. motion.type (from species.js) picks the behaviour,
// these numbers only shape the look.
// Keep amp / wavelength small: strips are axis-aligned, so the bend shows as
// small steps whose size is the slope of the wave (about 2 * PI * amp / wavelength).
// `spatial` is the wave phase (radians) across the whole body length.
const TUNING = {
  fish: { amp: 0.06, hz: 1.9, spatial: 6.4, tailPow: 1.7 },
  shark: { amp: 0.03, hz: 1.0, spatial: 6.4, tailPow: 1.8 },
  squid: { amp: 0.018, hz: 1.6, spatial: 7.7, tailPow: 2.6 },
  turtle: { amp: 0.015, hz: 0.5, spatial: 5.5, tailPow: 1.0 },
  ray: { amp: 0.05, hz: 0.9, spatial: 6, tailPow: 4 },
  // Upright creatures sway in rows: the weight grows towards the bottom.
  jellyfish: { amp: 0.035, hz: 0.8, spatial: 7, tailPow: 1.4 },
  seahorse: { amp: 0.02, hz: 0.6, spatial: 5, tailPow: 2 },
};
const UPRIGHT = new Set(['drift', 'hover']);
const JELLY_PERIOD = 2.6; // seconds per jellyfish bell pulse
const BLINK_SECONDS = 0.24;
// Strip widths in CSS px: narrow where the tail moves most, wide at the head.
const STRIP_TAIL_PX = 4;
const STRIP_HEAD_PX = 8;
const SEPARATION_ACCEL = 400; // px/s^2 at 1080p, pushes overlapping creatures apart
const DEFAULT_TUNING = TUNING.fish;

const canvas = document.getElementById('scene');
// The background covers every pixel, so an opaque canvas is safe and cheaper.
const ctx = canvas.getContext('2d', { alpha: false });
const hint = document.getElementById('hint');
const scenery = createScenery();
const depth = scenery.depth;
const persp = depth.perspective;

let W = 0;
let H = 0;
let dpr = 1;
let time = 0;

let sparks = [];

const creatures = new Map();

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

// Drawn size of a creature at its depth.
const screenW = (c) => c.w * persp(c.d);
const screenH = (c) => c.h * persp(c.d);

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function drawSparks() {
  for (const s of sparks) {
    const a = s.life / s.max;
    ctx.globalAlpha = a;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r * (0.5 + 0.5 * a), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Creatures
// ---------------------------------------------------------------------------

// Sizes are kept at the front (near) scale; depth is applied when drawing.
function computeSize(c) {
  const ratio = c.img ? c.img.naturalHeight / c.img.naturalWidth : 0.625;
  c.w = c.motion.size * H * NEAR_SIZE;
  c.h = c.w * ratio;
  c.baseSpeed = c.motion.speed * (H / 1080);
  buildStrips(c);
}

// Vertical strips covering the sprite, from the tail (xn = 0) to the head (xn = 1).
// Each strip stores its source and destination ranges as fractions of the sprite.
function buildStrips(c) {
  const strips = [];
  for (let x = 0; x < c.w - 0.01; ) {
    const xn = x / c.w;
    const width = Math.min(xn < 0.5 ? STRIP_TAIL_PX : STRIP_HEAD_PX, c.w - x);
    strips.push({
      dx: x - c.w / 2,
      dw: width,
      xn: (x + width / 2) / c.w,
      sx: x / c.w,
      sw: width / c.w,
    });
    x += width;
  }
  c.strips = strips;

  // Horizontal rows for upright creatures, from the top (yn = 0) down.
  const rows = [];
  for (let y = 0; y < c.h - 0.01; ) {
    const height = Math.min(STRIP_TAIL_PX, c.h - y);
    rows.push({ dy: y - c.h / 2, dh: height, yn: (y + height / 2) / c.h, sy: y / c.h, sh: height / c.h });
    y += height;
  }
  c.rows = rows;
}

function buildSprite(c) {
  const sprite = makeCanvas(c.w * dpr, c.h * dpr);
  const g = sprite.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(c.img, 0, 0, sprite.width, sprite.height);
  c.sprite = sprite;
  c.lids = c.eyes.map((e) => lidColor(g, sprite, e));
  // Same silhouette filled with the water colour, drawn over the creature to haze it.
  const fogged = makeCanvas(sprite.width, sprite.height);
  const fg = fogged.getContext('2d');
  fg.drawImage(sprite, 0, 0);
  fg.globalCompositeOperation = 'source-in';
  fg.fillStyle = depth.fog;
  fg.fillRect(0, 0, fogged.width, fogged.height);
  c.fogSprite = fogged;
}

// Eyelid colour: the average colour of the drawing in a ring just outside the
// eye, so the lid looks like the skin the child painted around it.
function lidColor(g, sprite, [ex, ey, er]) {
  const cx = (ex / 240) * sprite.width;
  const cy = (ey / 150) * sprite.height;
  const r = (er / 150) * sprite.height;
  const size = Math.ceil(r * 3.2);
  const x0 = Math.max(0, Math.floor(cx - size / 2));
  const y0 = Math.max(0, Math.floor(cy - size / 2));
  let data;
  try {
    data = g.getImageData(x0, y0, Math.min(size, sprite.width - x0), Math.min(size, sprite.height - y0));
  } catch {
    return 'rgb(120, 120, 120)';
  }
  let rs = 0;
  let gs = 0;
  let bs = 0;
  let n = 0;
  for (let y = 0; y < data.height; y++) {
    for (let x = 0; x < data.width; x++) {
      const d = Math.hypot(x0 + x - cx, y0 + y - cy);
      if (d < r * 1.25 || d > r * 1.6) continue;
      const p = (y * data.width + x) * 4;
      if (data.data[p + 3] < 200) continue;
      rs += data.data[p];
      gs += data.data[p + 1];
      bs += data.data[p + 2];
      n++;
    }
  }
  if (!n) return 'rgb(120, 120, 120)';
  return `rgb(${(rs / n) | 0}, ${(gs / n) | 0}, ${(bs / n) | 0})`;
}

// Vertical limits at depth d for a creature of its size: its top edge may reach
// the top of the screen, and its bottom edge may not go below the sand at that
// depth. The bottom keeps a small extra margin for the bob and the tail's wave.
function boundsAt(c, d) {
  const h = c.h * persp(d);
  return [h / 2, Math.max(h / 2, depth.floorY(d) - h / 2 - h * 0.06)];
}

function yBounds(c) {
  return boundsAt(c, c.d);
}

// Screen y of the species' depth band (yFrac) at the current depth.
function targetY(c) {
  const [lo, hi] = yBounds(c);
  return lo + (hi - lo) * c.yFrac;
}

// Coverage: how long creatures have spent in each cell of the visible volume
// (x, y and depth). Targets go to the emptiest cells, so the whole tank gets
// used and the middle does not fill up: straight paths between uniform targets
// would cross the centre far more often than the edges. The counts fade
// slowly, so the balance follows the current population.
const COVER_COLS = 6;
const COVER_ROWS = 5;
const COVER_DEPTHS = 4;
const COVER_CELLS = COVER_COLS * COVER_ROWS * COVER_DEPTHS;
const COVER_FADE_SECONDS = 300;
const COVER_TEMPERATURE = 0.25; // how strongly the emptiest cells win (lower is stricter)
const BAND_PENALTY = 0.3; // score added when the target is outside the species' band
const CLAIM_PENALTY = 0.5; // score added per other creature already heading for a cell
const TARGET_CANDIDATES = 10; // cells drawn for each pick, the best path wins
const PATH_SAMPLES = 5; // points along the path that are checked for coverage
const NEAR_PENALTY = 0.6; // score added when the target is too close to the creature
const cover = new Float64Array(COVER_CELLS);
let coverTotal = 0;

function coverIndex(x, y, d) {
  const ix = clamp(Math.floor((x / W) * COVER_COLS), 0, COVER_COLS - 1);
  const iy = clamp(Math.floor((y / H) * COVER_ROWS), 0, COVER_ROWS - 1);
  const id = clamp(Math.floor(d * COVER_DEPTHS), 0, COVER_DEPTHS - 1);
  return (id * COVER_ROWS + iy) * COVER_COLS + ix;
}

function updateCover(dt) {
  const keep = Math.exp(-dt / COVER_FADE_SECONDS);
  coverTotal = 0;
  for (let i = 0; i < COVER_CELLS; i++) {
    cover[i] *= keep;
    coverTotal += cover[i];
  }
  for (const c of creatures.values()) {
    if (c.state === 'leave') continue;
    cover[coverIndex(c.x, c.y, c.d)] += dt;
    coverTotal += dt;
  }
}

// Picks the next target. Each cell gets a base score: how crowded it is (1 is an
// average cell, 0 is empty), plus soft preferences for the species band, for
// cells other creatures already head for, and for targets far enough away to
// make a real cruise. Candidate cells are drawn with a weight that favours the
// emptiest ones. Each candidate is then judged by the path from the creature to
// it too: creatures spend most of their time on the way between targets, so a
// path through the middle loads the centre, while a path through empty space does not.
function pickTarget(c) {
  const [d0, d1] = c.motion.depth;
  const upright = UPRIGHT.has(c.motion.type);
  const mean = coverTotal / COVER_CELLS;
  // Other creatures already heading for each cell, so they do not all pile up.
  const claims = new Float64Array(COVER_CELLS);
  for (const o of creatures.values()) if (o !== c && o.state !== 'leave' && o.cell >= 0) claims[o.cell]++;
  const base = new Float64Array(COVER_CELLS);
  const weight = new Float64Array(COVER_CELLS);
  let total = 0;
  for (let cell = 0; cell < COVER_CELLS; cell++) {
    const ix = cell % COVER_COLS;
    const iy = Math.floor(cell / COVER_COLS) % COVER_ROWS;
    const id = Math.floor(cell / (COVER_COLS * COVER_ROWS));
    // Depth at the middle of the cell, to see whether the row is reachable.
    const [lo, hi] = boundsAt(c, (id + 0.5) / COVER_DEPTHS);
    const rowLo = (iy / COVER_ROWS) * H;
    const rowHi = ((iy + 1) / COVER_ROWS) * H;
    // No legal height in this row at that depth (a far creature over the sand).
    if (rowLo > hi || rowHi < lo) continue;
    const yc = clamp((rowLo + rowHi) / 2, lo, hi);
    const yFrac = hi > lo ? (yc - lo) / (hi - lo) : 0.5;
    let s = (mean > 0 ? cover[cell] / mean : 0) + claims[cell] * CLAIM_PENALTY;
    if (yFrac < d0 || yFrac > d1) s += BAND_PENALTY;
    if (!upright && Math.hypot(((ix + 0.5) / COVER_COLS) * W - c.x, yc - c.y) < W * 0.2) s += NEAR_PENALTY;
    base[cell] = s;
    weight[cell] = Math.exp(-s / COVER_TEMPERATURE);
    total += weight[cell];
  }
  if (total <= 0) return; // nothing reachable: keep the current target

  let best = null;
  let bestScore = Infinity;
  for (let k = 0; k < TARGET_CANDIDATES; k++) {
    const cell = drawCell(weight, total);
    const cand = cellTarget(c, cell);
    const score = base[cell] + pathLoad(c, cand, mean) + Math.random() * 0.05; // ties broken at random
    if (score < bestScore) {
      best = cand;
      bestScore = score;
    }
  }
  c.cell = best.cell;
  c.tx = best.tx;
  c.td = best.td;
  c.yFrac = best.yFrac;
  c.ty = targetY(c);
  c.wander = rand(5, 12);
}

// Draws a cell index with probability proportional to its weight; -1 if none.
function drawCell(weight, total) {
  // Rounding can leave r a little above zero at the end, so the last
  // reachable cell is the fallback.
  let r = Math.random() * total;
  let cell = -1;
  for (let i = 0; i < COVER_CELLS; i++) {
    if (weight[i] === 0) continue;
    cell = i;
    r -= weight[i];
    if (r <= 0) break;
  }
  return cell;
}

// A random target inside a cell. The outer columns reach past the screen edges,
// so targets can lie beyond them. The depth is random inside the cell's depth
// range, and y is random inside the cell's rows, clamped to the legal height.
function cellTarget(c, cell) {
  const ix = cell % COVER_COLS;
  const iy = Math.floor(cell / COVER_COLS) % COVER_ROWS;
  const id = Math.floor(cell / (COVER_COLS * COVER_ROWS));
  const d = (id + Math.random()) / COVER_DEPTHS;
  const w = c.w * persp(d);
  const [lo, hi] = boundsAt(c, d);
  const colLo = ix === 0 ? -w * 0.3 : (ix / COVER_COLS) * W;
  const colHi = ix === COVER_COLS - 1 ? W + w * 0.3 : ((ix + 1) / COVER_COLS) * W;
  // Upright creatures mostly drift up and down, with small sideways moves.
  const tx = UPRIGHT.has(c.motion.type) ? clamp(c.x + rand(-0.18, 0.18) * W, -w * 0.3, W + w * 0.3) : rand(colLo, colHi);
  const rowLo = (iy / COVER_ROWS) * H;
  const rowHi = ((iy + 1) / COVER_ROWS) * H;
  const a = Math.max(rowLo, lo);
  const b = Math.min(rowHi, hi);
  const ty = a <= b ? rand(a, b) : clamp(rowLo, lo, hi);
  return { cell, tx, td: d, yFrac: hi > lo ? (ty - lo) / (hi - lo) : 0.5, ty };
}

// Average coverage along the straight path from the creature to a candidate
// target, in units of the mean cell. Depth is blended along the path too.
function pathLoad(c, cand, mean) {
  if (mean <= 0) return 0;
  let sum = 0;
  for (let i = 1; i <= PATH_SAMPLES; i++) {
    const s = i / PATH_SAMPLES;
    const x = c.x + (cand.tx - c.x) * s;
    const y = c.y + (cand.ty - c.y) * s;
    const d = c.d + (cand.td - c.d) * s;
    sum += cover[coverIndex(x, y, d)] / mean;
  }
  return sum / PATH_SAMPLES;
}

function spawnSparks(x, y, radius, count, size = 1) {
  for (let i = 0; i < count && sparks.length < MAX_SPARKS; i++) {
    const a = Math.random() * TAU;
    const d = Math.random() * radius;
    sparks.push({
      x: x + Math.cos(a) * d,
      y: y + Math.sin(a) * d,
      vx: rand(-20, 20),
      vy: rand(-40, -5),
      r: rand(1.5, 3.5) * size,
      life: rand(0.8, 1.6),
      max: 1.6,
      color: ['#fff3b0', '#bff4ff', '#ffffff'][i % 3],
    });
  }
}

function spawnCreature(record, mode) {
  const species = byId(record.species);
  if (!species) return null;
  const c = {
    id: record.id,
    species: species.id,
    motion: species.motion,
    tune: TUNING[species.id] ?? DEFAULT_TUNING,
    d: Math.random(), // depth, see the header
    td: 0, // target depth, picked in pickTarget
    depthSpeed: rand(DEPTH_SPEED_MIN, DEPTH_SPEED_MAX),
    yFrac: 0, // where in the species' depth band the target lies
    cell: -1, // coverage cell of the current target, see pickTarget
    phase: Math.random() * TAU,
    jetOffset: Math.random(),
    eyes: species.eyes,
    lids: [],
    blinkAt: rand(1, 5),
    t: 0,
    w: 0,
    h: 0,
    baseSpeed: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    tx: 0,
    ty: 0,
    wander: 0,
    f: 1, // facing: +1 right (sprite as drawn), -1 left (mirrored), eased in between
    pitch: 0,
    thrust: 0,
    jetT: 0,
    state: 'fade', // fade | enter | alive | leave
    age: 0,
    alpha: 0,
    leaveAge: 0,
    glow: 0,
    img: null,
    sprite: null,
  };
  computeSize(c);

  // Start inside the species' depth band, within the room this depth allows.
  const [d0, d1] = c.motion.depth;
  c.yFrac = rand(d0, d1);
  const [lo, hi] = yBounds(c);
  c.y = lo + (hi - lo) * c.yFrac;
  if (mode === 'add') {
    // New creatures swim in from one side of the screen.
    const dir = Math.random() < 0.5 ? 1 : -1;
    c.x = dir > 0 ? -screenW(c) * 0.6 : W + screenW(c) * 0.6;
    c.vx = dir * c.baseSpeed * persp(c.d) * 2;
    c.state = 'enter';
    c.age = 0;
    c.glow = GLOW_SECONDS;
  } else {
    c.x = rand(screenW(c) * 0.5, W - screenW(c) * 0.5);
    c.vx = (Math.random() < 0.5 ? -1 : 1) * c.baseSpeed * persp(c.d);
    c.state = 'fade';
    c.age = 0;
  }
  c.f = c.vx < 0 ? -1 : 1;
  pickTarget(c);

  const img = new Image();
  img.onload = () => {
    c.img = img;
    computeSize(c);
    buildSprite(c);
  };
  img.onerror = () => {
    // Missing or broken image: drop the creature quietly.
    if (c.state !== 'leave') startLeave(c);
  };
  img.src = `/fish/${record.id}.png`;

  creatures.set(record.id, c);
  updateHint();
  return c;
}

function startLeave(c) {
  if (c.state === 'leave') return;
  c.state = 'leave';
  c.leaveAge = 0;
  c.exitX = c.vx >= 0 ? W + screenW(c) * 2 : -screenW(c) * 2;
  if (c.sprite) scenery.burst(c.x, c.y, 8);
}

// Soft repulsion between creatures that overlap, so they do not stack up.
function applySeparation(dt) {
  const list = [];
  for (const c of creatures.values()) if (c.state !== 'leave' && c.sprite) list.push(c);
  const k = SEPARATION_ACCEL * (H / 1080) * dt;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (Math.abs(a.d - b.d) >= SEPARATION_DEPTH) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const reach = (screenW(a) + screenW(b)) * 0.3;
      const d2 = dx * dx + dy * dy;
      if (d2 >= reach * reach || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const push = k * (1 - d / reach);
      const nx = dx / d;
      const ny = dy / d;
      a.vx -= nx * push;
      a.vy -= ny * push;
      b.vx += nx * push;
      b.vy += ny * push;
    }
  }
}

function updateCreature(c, dt) {
  c.t += dt;
  const type = c.motion.type;

  // Lifecycle: fade in, or fade out and leave.
  if (c.state === 'enter' || c.state === 'fade') {
    if (c.sprite) c.age += dt;
    const dur = c.state === 'enter' ? ENTER_SECONDS : FADE_IN_SECONDS;
    c.alpha = Math.min(1, c.age / dur);
    if (c.alpha >= 1) c.state = 'alive';
  } else if (c.state === 'leave') {
    c.leaveAge += dt;
    c.alpha = Math.max(0, 1 - c.leaveAge / LEAVE_SECONDS);
    c.tx = c.exitX;
    c.ty = c.y;
    if (c.alpha <= 0 || c.leaveAge > LEAVE_SECONDS + 0.5) return false;
  }

  // Depth eases towards the target depth, never faster than depthSpeed.
  c.d += clamp((c.td - c.d) * 0.6, -c.depthSpeed, c.depthSpeed) * dt;
  const p = persp(c.d);

  if (c.glow > 0 && c.sprite) {
    c.glow -= dt;
    if (Math.random() < dt * 14) spawnSparks(c.x, c.y, (c.w * p) * 0.5, 1, p);
  }

  // Wander to a target inside the species' depth band, at the current depth.
  if (c.state !== 'leave') {
    c.wander -= dt;
    c.ty = targetY(c);
    const dx = c.tx - c.x;
    const dy = c.ty - c.y;
    if (c.wander <= 0 || dx * dx + dy * dy < (H * 0.05) ** 2) pickTarget(c);
  }

  // Speed, with the squid's jet pulses and the turtle's slow stroke.
  let speed = c.baseSpeed * p;
  if (type === 'drift') {
    // The bell contracts, pushes the jellyfish forward, then it coasts.
    const p = ((c.t + c.jetOffset * JELLY_PERIOD) / JELLY_PERIOD) % 1;
    const raw = p < 0.3 ? Math.sin((p / 0.3) * Math.PI) : 0;
    c.thrust += (raw - c.thrust) * Math.min(1, dt * 10);
    speed *= 0.35 + 1.8 * c.thrust;
  } else if (type === 'flap') {
    speed *= 1 + 0.25 * Math.sin(time * TAU * c.tune.hz + c.phase);
  } else if (type === 'jet') {
    c.jetT += dt;
    const p = (c.jetT / JET_PERIOD + c.jetOffset) % 1;
    const raw = p < JET_THRUST_SHARE ? Math.sin((p / JET_THRUST_SHARE) * Math.PI) : 0;
    c.thrust += (raw - c.thrust) * Math.min(1, dt * 14);
    speed *= 0.45 + 1.4 * c.thrust;
  } else if (type === 'paddle') {
    speed *= 1 + 0.1 * Math.sin(c.t * TAU * 0.5 + c.phase);
  }
  if (c.state === 'leave') speed *= 1.7;

  // Steer towards the target, with a gentle sideways wobble.
  const dx = c.tx - c.x;
  const dy = c.ty - c.y;
  const d = Math.hypot(dx, dy) || 1;
  const wobble = c.state === 'leave' ? 0 : Math.sin(c.t * 0.7 + c.phase) * 0.35 * p;
  const cs = Math.cos(wobble);
  const sn = Math.sin(wobble);
  const ux = (dx * cs - dy * sn) / d;
  const uy = (dx * sn + dy * cs) / d;
  const rate = type === 'jet' ? 5 : type === 'paddle' || UPRIGHT.has(type) ? 1.2 : 2.5;
  const k = 1 - Math.exp(-rate * dt);
  c.vx += (ux * speed - c.vx) * k;
  c.vy += (uy * speed - c.vy) * k;
  c.x += c.vx * dt;
  c.y += c.vy * dt;

  // Re-clamped every frame, so a creature that moves towards the viewer is
  // pulled up or down to stay on the sand at its new depth.
  if (c.state !== 'leave') {
    const margin = screenW(c) * 0.3;
    c.x = clamp(c.x, -margin, W + margin);
    const [lo, hi] = yBounds(c);
    c.y = clamp(c.y, lo, hi);
  }

  // Mirror smoothly when the heading changes, and tilt with the vertical speed.
  // Jellyfish have no front, so they never turn around.
  if (Math.abs(c.vx) > 3 && type !== 'drift') {
    const df = Math.sign(c.vx) - c.f;
    c.f += Math.max(-dt * 4, Math.min(dt * 4, df));
  }
  const targetPitch = UPRIGHT.has(type) ? 0 : clamp(Math.atan2(c.vy, Math.max(Math.abs(c.vx), 30)) * 0.8, -0.2, 0.2);
  c.pitch += (targetPitch - c.pitch) * Math.min(1, dt * 4);

  if (c.state === 'leave' && (c.x < -screenW(c) * 2.5 || c.x > W + screenW(c) * 2.5)) return false;
  return true;
}

// Draws the sprite as vertical strips. Each strip is shifted vertically in
// proportion to how far it is from the head, so the tail bends like a wave.
// `shear` is the tilt (tan of the pitch). It is a vertical offset per strip
// rather than ctx.rotate: a rotated transform sends every drawImage down a slow
// path. With strips a few px wide the offset steps stay below about 1 px.
// `img` is the sprite or its fog silhouette; both bend the same way.
// `over` is the strip overlap in sprite units (one screen pixel), which hides
// seams between strips.
function drawStrips(c, img, amp, shear, over) {
  const tune = c.tune;
  const y0 = -c.h / 2;
  const phase = time * tune.hz * TAU + c.phase;
  const strips = c.strips;
  for (let k = 0; k < strips.length; k++) {
    const s = strips[k];
    const weight = Math.pow(1 - s.xn, tune.tailPow);
    const dy = amp * c.h * weight * Math.sin(phase + tune.spatial * s.xn) + (s.dx + s.dw / 2) * shear;
    ctx.drawImage(img, s.sx * img.width, 0, s.sw * img.width, img.height, s.dx, y0 + dy, s.dw + over, c.h);
  }
}

// Upright creatures: horizontal rows shifted sideways, more towards the
// bottom, so tentacles and tails sway while the head stays still.
function drawRows(c, img, amp, over) {
  const tune = c.tune;
  const x0 = -c.w / 2;
  const phase = time * tune.hz * TAU + c.phase;
  for (const r of c.rows) {
    const weight = Math.pow(r.yn, tune.tailPow);
    const dx = amp * c.w * weight * Math.sin(phase - tune.spatial * r.yn);
    ctx.drawImage(img, 0, r.sy * img.height, img.width, r.sh * img.height, x0 + dx, r.dy, c.w, r.dh + over);
  }
}

function drawBody(c, img, amp, shear, over) {
  if (UPRIGHT.has(c.motion.type)) drawRows(c, img, amp, over);
  else drawStrips(c, img, amp, shear, over);
}

// Blinking: an eyelid in the colour around the eye slides down and back up.
function drawLids(c, shear) {
  if (!c.lids.length) return;
  const k = (time - c.blinkAt) / BLINK_SECONDS;
  if (k < 0) return;
  if (k > 1) {
    // Sometimes a quick double blink.
    c.blinkAt = time + (Math.random() < 0.2 ? 0.15 : rand(2.5, 6.5));
    return;
  }
  const closed = Math.sin(k * Math.PI);
  c.eyes.forEach(([ex, ey, er], i) => {
    const x = (ex / 240 - 0.5) * c.w;
    const y = (ey / 150 - 0.5) * c.h + x * shear;
    const r = (er / 150) * c.h * 1.15;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.clip();
    const edge = y - r + 2 * r * closed;
    ctx.fillStyle = c.lids[i];
    ctx.fillRect(x - r, y - r, 2 * r, edge - (y - r));
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.lineWidth = Math.max(1, r * 0.18);
    ctx.beginPath();
    ctx.moveTo(x - r, edge);
    ctx.quadraticCurveTo(x, edge + r * 0.25 * closed, x + r, edge);
    ctx.stroke();
    ctx.restore();
  });
}

function drawCreature(c) {
  if (!c.sprite || c.alpha <= 0.005) return;
  const type = c.motion.type;
  const p = persp(c.d);
  let shear = Math.tan(c.pitch);
  let sx = 1;
  let sy = 1;
  let amp = c.tune.amp;
  let bob = 0;

  if (type === 'jet') {
    // Squash while thrusting, stretch back out while gliding.
    sx = 1 - 0.1 * c.thrust;
    sy = 1 + 0.07 * c.thrust;
    amp *= 1 + 0.9 * c.thrust;
  } else if (type === 'drift') {
    // Bell squeezes in and stretches up while pulsing.
    sx = 1 - 0.08 * c.thrust;
    sy = 1 + 0.06 * c.thrust;
  } else if (type === 'flap') {
    // Seen from above, the wings beating up and down look like the body
    // getting narrower and wider.
    sy = 1 + 0.1 * Math.sin(time * TAU * c.tune.hz + c.phase);
  } else if (type === 'hover') {
    bob = Math.sin(time * TAU * 0.3 + c.phase) * screenH(c) * 0.04;
  } else if (type === 'paddle') {
    bob = Math.sin(time * TAU * 0.35 + c.phase) * screenH(c) * 0.03;
    shear += Math.sin(time * TAU * 0.25 + c.phase * 0.5) * 0.035;
    sx *= 1 + Math.sin(time * TAU * 0.5 + c.phase) * 0.012;
  }

  let grow = 1;
  if (c.state === 'enter') grow = 0.7 + 0.3 * easeOutCubic(Math.min(1, c.age / ENTER_SECONDS));
  else if (c.state === 'leave') grow = 1 - 0.12 * Math.min(1, c.leaveAge / LEAVE_SECONDS);

  const haze = depth.fogAt(c.d);
  // One screen pixel of strip overlap, in sprite units, hides the seams.
  const over = 1 / p;

  ctx.save();
  ctx.globalAlpha = c.alpha;
  ctx.translate(c.x, c.y + bob);
  ctx.scale(c.f * sx * grow * p, sy * grow * p);
  drawBody(c, c.sprite, amp, shear, over);
  drawLids(c, UPRIGHT.has(type) ? 0 : shear);
  if (haze >= FOG_MIN) {
    // The silhouette bends exactly like the body, so the haze follows it. It has
    // no overlap: a semi-transparent strip drawn twice would show as stripes.
    ctx.globalAlpha = c.alpha * haze;
    drawBody(c, c.fogSprite, amp, shear, 0);
  }
  ctx.restore();
}

function drawGlow(c) {
  if (c.glow <= 0 || !c.sprite) return;
  const k = c.glow / GLOW_SECONDS;
  const r = screenW(c) * 0.9;
  const grad = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
  grad.addColorStop(0, 'rgba(190, 248, 255, 0.45)');
  grad.addColorStop(1, 'rgba(190, 248, 255, 0)');
  ctx.globalAlpha = k;
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Live data: Server-Sent Events
// ---------------------------------------------------------------------------

// Creatures that are staying (not fading out).
function liveCount() {
  let n = 0;
  for (const c of creatures.values()) if (c.state !== 'leave') n++;
  return n;
}

function updateHint() {
  hint.hidden = liveCount() > 0;
}

function reconcileAll(list) {
  const ids = new Set();
  for (const record of list) {
    if (!record || typeof record.id !== 'string') continue;
    ids.add(record.id);
    const existing = creatures.get(record.id);
    if (!existing) {
      spawnCreature(record, 'fade');
    } else if (existing.state === 'leave') {
      // It came back before it finished leaving.
      existing.state = 'fade';
      existing.age = existing.alpha * FADE_IN_SECONDS;
      existing.glow = 0;
    }
  }
  for (const c of creatures.values()) {
    if (!ids.has(c.id)) startLeave(c);
  }
  updateHint();
}

function addCreature(record) {
  if (!record || typeof record.id !== 'string') return;
  const existing = creatures.get(record.id);
  if (existing) {
    if (existing.state === 'leave') {
      existing.state = 'enter';
      existing.age = existing.alpha * ENTER_SECONDS;
      existing.glow = GLOW_SECONDS;
    }
    return;
  }
  spawnCreature(record, 'add');
}

function removeCreature(id) {
  const c = creatures.get(id);
  if (c) startLeave(c);
}

function connect() {
  const events = new EventSource('/api/events');
  const parse = (e) => {
    try {
      return JSON.parse(e.data);
    } catch {
      return null;
    }
  };
  events.addEventListener('init', (e) => {
    const list = parse(e);
    if (Array.isArray(list)) reconcileAll(list);
  });
  events.addEventListener('add', (e) => addCreature(parse(e)));
  events.addEventListener('remove', (e) => {
    const data = parse(e);
    if (data && typeof data.id === 'string') removeCreature(data.id);
  });
  // EventSource reconnects by itself; the next init reconciles the state.
}

// ---------------------------------------------------------------------------
// Layout, loop and page behaviour
// ---------------------------------------------------------------------------

function resize() {
  const newW = window.innerWidth;
  const newH = window.innerHeight;
  const sx = W ? newW / W : 1;
  const sy = H ? newH / H : 1;
  W = newW;
  H = newH;
  dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);

  for (const p of sparks) {
    p.x *= sx;
    p.y *= sy;
  }
  for (const c of creatures.values()) {
    c.x *= sx;
    c.y *= sy;
    computeSize(c);
    if (c.img) buildSprite(c);
  }
  scenery.resize(W, H, dpr, ctx);
}

function updateScenery(dt) {
  scenery.update(dt, time);
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.life -= dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    if (s.life <= 0) sparks.splice(i, 1);
  }
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  scenery.drawBack(ctx, time);

  // Far creatures first, so nearer ones pass in front of them.
  const order = [...creatures.values()].sort((a, b) => a.d - b.d);
  for (const c of order) {
    drawGlow(c);
    drawCreature(c);
  }
  drawSparks();
  ctx.globalAlpha = 1;
  scenery.drawFront(ctx, time);
}

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  time += dt;

  applySeparation(dt);
  let removed = false;
  for (const c of creatures.values()) {
    if (!updateCreature(c, dt)) {
      creatures.delete(c.id);
      removed = true;
    }
  }
  if (removed) updateHint();
  updateCover(dt);
  updateScenery(dt);
  render();
  requestAnimationFrame(frame);
}

// Hide the cursor after a few idle seconds, click for fullscreen.
let idleTimer = 0;
function wakeCursor() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
}

function setup() {
  resize();
  window.addEventListener('resize', () => {
    resize();
  });
  window.addEventListener('mousemove', wakeCursor);
  window.addEventListener('pointerdown', wakeCursor);
  window.addEventListener('click', () => {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  });
  wakeCursor();

  // Keep the projector screen from sleeping when the browser supports it.
  const keepAwake = async () => {
    try {
      await navigator.wakeLock?.request('screen');
    } catch {
      // Not allowed here (for example, plain HTTP on the LAN). Ignore.
    }
  };
  keepAwake();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepAwake();
  });

  // Small hook for tests and debugging; read-only.
  window.__aquarium = {
    count: liveCount,
    // Depth and screen extent of each live creature.
    snapshot: () =>
      [...creatures.values()]
        .filter((c) => c.state !== 'leave')
        .map((c) => ({
          id: c.id,
          species: c.species,
          d: c.d,
          x: c.x,
          y: c.y,
          h: screenH(c),
          tx: c.tx,
          ty: c.ty,
          td: c.td,
          bottom: c.y + screenH(c) / 2,
          sand: depth.floorY(c.d),
          w: screenW(c),
        })),
  };

  connect();
  requestAnimationFrame((now) => {
    lastFrame = now;
    frame(now);
  });
}

setup();
