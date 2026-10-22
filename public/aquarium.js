// Aquarium display: a procedural underwater scene with the live creatures.
// Creatures arrive and leave through Server-Sent Events. Sprites are drawn as
// vertical strips so the tail (or tentacles) can bend without a skeleton.
import { byId } from './shared/species.js';

const TAU = Math.PI * 2;
const MAX_DPR = 2;
const JET_PERIOD = 1.4; // seconds per squid jet cycle
const JET_THRUST_SHARE = 0.35; // fraction of the cycle spent thrusting
const ENTER_SECONDS = 1.2;
const FADE_IN_SECONDS = 1.8;
const LEAVE_SECONDS = 1.5;
const GLOW_SECONDS = 1.6;
const MAX_SPARKS = 160;
const MAX_BUBBLES = 140;

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
};
// Strip widths in CSS px: narrow where the tail moves most, wide at the head.
const STRIP_TAIL_PX = 4;
const STRIP_HEAD_PX = 8;
const SEPARATION_ACCEL = 400; // px/s^2 at 1080p, pushes overlapping creatures apart
const DEFAULT_TUNING = TUNING.fish;

const canvas = document.getElementById('scene');
// The background covers every pixel, so an opaque canvas is safe and cheaper.
const ctx = canvas.getContext('2d', { alpha: false });
const hint = document.getElementById('hint');

let W = 0;
let H = 0;
let dpr = 1;
let time = 0;

let bgLayer = null;
let vignette = null;
let rayGradient = null;
let rays = [];
let backWeeds = [];
let foreWeeds = [];
let plankton = [];
let bubbles = [];
let sparks = [];

const creatures = new Map();
let drawOrder = [];
let orderDirty = true;

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// Sand top line, in CSS px. Shared by the background, seaweed and rocks.
function sandTop(x) {
  return H * 0.86 + Math.sin((x / W) * TAU * 1.3) * H * 0.012 + Math.sin((x / W) * TAU * 3.1 + 1) * H * 0.006;
}

// ---------------------------------------------------------------------------
// Scenery
// ---------------------------------------------------------------------------

function drawRock(g, x, y, r) {
  const grad = g.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r * 1.1);
  grad.addColorStop(0, '#7f9d9c');
  grad.addColorStop(0.6, '#3d5a5f');
  grad.addColorStop(1, '#1b2f33');
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(x, y, r, r * 0.6, 0, 0, TAU);
  g.fill();
}

function buildBackground() {
  const layer = makeCanvas(W * dpr, H * dpr);
  const g = layer.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Water: lighter near the surface, almost black at the bottom.
  const water = g.createLinearGradient(0, 0, 0, H);
  water.addColorStop(0, '#1d7fa3');
  water.addColorStop(0.35, '#0d5378');
  water.addColorStop(0.75, '#07304d');
  water.addColorStop(1, '#031a2b');
  g.fillStyle = water;
  g.fillRect(0, 0, W, H);

  // Soft glow where the light comes from.
  const haze = g.createRadialGradient(W * 0.5, -H * 0.1, 0, W * 0.5, -H * 0.1, W * 0.75);
  haze.addColorStop(0, 'rgba(170, 240, 255, 0.35)');
  haze.addColorStop(1, 'rgba(170, 240, 255, 0)');
  g.fillStyle = haze;
  g.fillRect(0, 0, W, H);

  // Sand floor.
  const sand = g.createLinearGradient(0, H * 0.84, 0, H);
  sand.addColorStop(0, '#e6c88f');
  sand.addColorStop(0.45, '#b98f58');
  sand.addColorStop(1, '#6f5030');
  g.fillStyle = sand;
  g.beginPath();
  g.moveTo(0, H);
  for (let x = 0; x <= W; x += W / 160) g.lineTo(x, sandTop(x));
  g.lineTo(W, H);
  g.closePath();
  g.fill();

  // Grain and ripples.
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * W;
    const y = rand(H * 0.88, H);
    g.fillStyle = Math.random() < 0.5 ? 'rgba(255,240,200,0.18)' : 'rgba(60,35,15,0.18)';
    g.fillRect(x, y, Math.random() < 0.8 ? 1.5 : 3, 1.2);
  }
  g.strokeStyle = 'rgba(255, 240, 210, 0.12)';
  g.lineWidth = 2;
  for (let i = 0; i < 5; i++) {
    const y = H * (0.9 + i * 0.02);
    g.beginPath();
    for (let x = 0; x <= W; x += W / 80) {
      const yy = y + Math.sin(x / W * TAU * 6 + i) * 2;
      if (x === 0) g.moveTo(x, yy);
      else g.lineTo(x, yy);
    }
    g.stroke();
  }

  // Rocks sitting on the sand.
  const rocks = [
    [0.07, 0.07],
    [0.27, 0.045],
    [0.66, 0.05],
    [0.9, 0.08],
  ];
  for (const [fx, fr] of rocks) {
    const x = fx * W;
    drawRock(g, x, sandTop(x) + H * fr * 0.2, H * fr);
  }

  bgLayer = layer;

  // Dark corners draw the eye to the middle.
  const vig = makeCanvas(W * dpr, H * dpr);
  const vg = vig.getContext('2d');
  vg.setTransform(dpr, 0, 0, dpr, 0, 0);
  const v = vg.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,8,16,0.55)');
  vg.fillStyle = v;
  vg.fillRect(0, 0, W, H);
  vignette = vig;

  rayGradient = ctx.createLinearGradient(0, 0, 0, H);
  rayGradient.addColorStop(0, 'rgba(200, 246, 255, 0.55)');
  rayGradient.addColorStop(1, 'rgba(200, 246, 255, 0)');
}

function makeWeeds(count, fore) {
  const out = [];
  const palette = fore ? ['#0c3b2a', '#11523a'] : ['#1f7a4d', '#2f9a5f', '#3aa86a'];
  for (let i = 0; i < count; i++) {
    out.push({
      bx: fore ? (i === 0 ? 0.02 : 0.98) : rand(0.03, 0.97),
      h: fore ? rand(0.4, 0.5) : rand(0.14, 0.32),
      width: fore ? 0.035 : 0.014,
      sway: fore ? 0.05 : rand(0.025, 0.045),
      speed: rand(0.6, 1.1),
      phase: rand(0, TAU),
      color: palette[i % palette.length],
    });
  }
  return out;
}

function drawWeeds(list, t, alpha) {
  ctx.lineCap = 'round';
  ctx.globalAlpha = alpha;
  for (const w of list) {
    const baseX = w.bx * W;
    const baseY = sandTop(baseX) + H * 0.02;
    const height = w.h * H;
    let px = baseX;
    let py = baseY;
    const segs = 9;
    ctx.strokeStyle = w.color;
    for (let j = 1; j <= segs; j++) {
      const f = j / segs;
      const sway =
        (Math.sin(t * w.speed + w.phase + f * 2.2) * 0.6 + Math.sin(t * w.speed * 0.37 + w.phase * 1.7 + f * 1.1) * 0.4) *
        w.sway * H * f * f;
      const x = baseX + sway;
      const y = baseY - height * f;
      ctx.lineWidth = w.width * H * (1 - 0.7 * f) + 1;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(x, y);
      ctx.stroke();
      px = x;
      py = y;
    }
  }
  ctx.globalAlpha = 1;
}

function drawRays(t) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = rayGradient;
  for (const r of rays) {
    const top = r.x * W + Math.sin(t * r.speed + r.phase) * W * 0.02;
    const bottom = top + r.lean * W;
    const wTop = r.w * W;
    const wBottom = wTop * 2.4;
    ctx.globalAlpha = 0.05 + 0.035 * Math.sin(t * r.speed * 1.7 + r.phase);
    ctx.beginPath();
    ctx.moveTo(top - wTop / 2, 0);
    ctx.lineTo(top + wTop / 2, 0);
    ctx.lineTo(bottom + wBottom / 2, H * 0.9);
    ctx.lineTo(bottom - wBottom / 2, H * 0.9);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawPlankton() {
  ctx.fillStyle = 'rgb(200, 240, 255)';
  for (const p of plankton) {
    ctx.globalAlpha = p.a;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawBubbles() {
  ctx.lineWidth = 1.2;
  for (const b of bubbles) {
    ctx.strokeStyle = 'rgba(225, 248, 255, 0.55)';
    ctx.fillStyle = 'rgba(200, 240, 255, 0.07)';
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.beginPath();
    ctx.arc(b.x - b.r * 0.35, b.y - b.r * 0.35, Math.max(0.8, b.r * 0.22), 0, TAU);
    ctx.fill();
  }
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

function computeSize(c) {
  const ratio = c.img ? c.img.naturalHeight / c.img.naturalWidth : 0.625;
  c.w = c.motion.size * H * c.scale;
  c.h = c.w * ratio;
  c.baseSpeed = c.motion.speed * (H / 1080) * (0.7 + 0.5 * c.z);
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
}

function buildSprite(c) {
  const sprite = makeCanvas(c.w * dpr, c.h * dpr);
  const g = sprite.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(c.img, 0, 0, sprite.width, sprite.height);
  c.sprite = sprite;
}

// Targets are not uniform: a straight path between two uniform points spends
// most of its time near the middle, so many targets go to the outer bands.
function pickTarget(c) {
  const [d0, d1] = c.motion.depth;
  const minX = c.w * 0.5;
  const maxX = W - c.w * 0.5;
  const r = Math.random();
  let tx;
  if (c.species === 'shark' && r < 0.12) {
    // Big sharks sometimes swim partly past an edge, then turn back.
    tx = Math.random() < 0.5 ? -c.w * 0.3 : W + c.w * 0.3;
  } else if (r < 0.5) {
    tx = Math.random() < 0.5 ? rand(minX, W * 0.2) : rand(W * 0.8, maxX);
  } else {
    tx = rand(minX, maxX);
  }
  // Avoid picking a point right next to where the creature already is.
  for (let i = 0; i < 3 && Math.abs(tx - c.x) < W * 0.2; i++) tx = rand(minX, maxX);
  c.tx = tx;
  // Same edge bias as x: half of the depth targets sit near the band limits.
  const ry = Math.random();
  const yFrac = ry < 0.25 ? rand(d0, d0 + (d1 - d0) * 0.2) : ry < 0.5 ? rand(d1 - (d1 - d0) * 0.2, d1) : rand(d0, d1);
  c.ty = clamp(H * yFrac, c.h * 0.5, H * 0.9);
  c.wander = rand(5, 12);
}

function spawnSparks(x, y, radius, count) {
  for (let i = 0; i < count && sparks.length < MAX_SPARKS; i++) {
    const a = Math.random() * TAU;
    const d = Math.random() * radius;
    sparks.push({
      x: x + Math.cos(a) * d,
      y: y + Math.sin(a) * d,
      vx: rand(-20, 20),
      vy: rand(-40, -5),
      r: rand(1.5, 3.5),
      life: rand(0.8, 1.6),
      max: 1.6,
      color: ['#fff3b0', '#bff4ff', '#ffffff'][i % 3],
    });
  }
}

function spawnBubbles(x, y, count) {
  for (let i = 0; i < count && bubbles.length < MAX_BUBBLES; i++) {
    bubbles.push({
      x: x + rand(-20, 20),
      y: y + rand(-10, 10),
      r: rand(3, 7),
      speed: rand(120, 220),
      phase: rand(0, TAU),
      sway: rand(8, 18),
      burst: true,
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
    z: Math.random(),
    phase: Math.random() * TAU,
    jetOffset: Math.random(),
    t: 0,
    scale: 0,
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
  c.scale = 0.55 + 0.3 * c.z;
  computeSize(c);

  const [d0, d1] = c.motion.depth;
  c.y = clamp(H * rand(d0, d1), c.h * 0.5, H * 0.9);
  if (mode === 'add') {
    // New creatures swim in from one side of the screen.
    const dir = Math.random() < 0.5 ? 1 : -1;
    c.x = dir > 0 ? -c.w * 0.6 : W + c.w * 0.6;
    c.vx = dir * c.baseSpeed * 2;
    c.state = 'enter';
    c.age = 0;
    c.glow = GLOW_SECONDS;
  } else {
    c.x = rand(c.w * 0.5, W - c.w * 0.5);
    c.vx = (Math.random() < 0.5 ? -1 : 1) * c.baseSpeed;
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
  orderDirty = true;
  updateHint();
  return c;
}

function startLeave(c) {
  if (c.state === 'leave') return;
  c.state = 'leave';
  c.leaveAge = 0;
  c.exitX = c.vx >= 0 ? W + c.w * 2 : -c.w * 2;
  if (c.sprite) spawnBubbles(c.x, c.y, 8);
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
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const reach = (a.w + b.w) * 0.3;
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

  if (c.glow > 0 && c.sprite) {
    c.glow -= dt;
    if (Math.random() < dt * 14) spawnSparks(c.x, c.y, c.w * 0.5, 1);
  }

  // Wander to a target inside the species' depth band.
  if (c.state !== 'leave') {
    c.wander -= dt;
    const dx = c.tx - c.x;
    const dy = c.ty - c.y;
    if (c.wander <= 0 || dx * dx + dy * dy < (H * 0.05) ** 2) pickTarget(c);
  }

  // Speed, with the squid's jet pulses and the turtle's slow stroke.
  let speed = c.baseSpeed;
  if (type === 'jet') {
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
  const wobble = c.state === 'leave' ? 0 : Math.sin(c.t * 0.7 + c.phase) * 0.35;
  const cs = Math.cos(wobble);
  const sn = Math.sin(wobble);
  const ux = (dx * cs - dy * sn) / d;
  const uy = (dx * sn + dy * cs) / d;
  const rate = type === 'jet' ? 5 : type === 'paddle' ? 1.2 : 2.5;
  const k = 1 - Math.exp(-rate * dt);
  c.vx += (ux * speed - c.vx) * k;
  c.vy += (uy * speed - c.vy) * k;
  c.x += c.vx * dt;
  c.y += c.vy * dt;

  if (c.state !== 'leave') {
    c.x = clamp(c.x, -c.w * 0.3, W + c.w * 0.3);
    c.y = clamp(c.y, c.h * 0.5, H * 0.9);
  }

  // Mirror smoothly when the heading changes, and tilt with the vertical speed.
  if (Math.abs(c.vx) > 3) {
    const df = Math.sign(c.vx) - c.f;
    c.f += Math.max(-dt * 4, Math.min(dt * 4, df));
  }
  const targetPitch = clamp(Math.atan2(c.vy, Math.max(Math.abs(c.vx), 30)) * 0.8, -0.2, 0.2);
  c.pitch += (targetPitch - c.pitch) * Math.min(1, dt * 4);

  if (c.state === 'leave' && (c.x < -c.w * 2.5 || c.x > W + c.w * 2.5)) return false;
  return true;
}

// Draws the sprite as vertical strips. Each strip is shifted vertically in
// proportion to how far it is from the head, so the tail bends like a wave.
// `shear` is the tilt (tan of the pitch). It is a vertical offset per strip
// rather than ctx.rotate: a rotated transform sends every drawImage down a slow
// path. With strips a few px wide the offset steps stay below about 1 px.
function drawStrips(c, amp, shear) {
  const img = c.sprite;
  const tune = c.tune;
  const y0 = -c.h / 2;
  const phase = time * tune.hz * TAU + c.phase;
  const strips = c.strips;
  for (let k = 0; k < strips.length; k++) {
    const s = strips[k];
    const weight = Math.pow(1 - s.xn, tune.tailPow);
    const dy = amp * c.h * weight * Math.sin(phase + tune.spatial * s.xn) + (s.dx + s.dw / 2) * shear;
    // One extra device pixel of overlap hides seams between strips.
    ctx.drawImage(img, s.sx * img.width, 0, s.sw * img.width, img.height, s.dx, y0 + dy, s.dw + 1, c.h);
  }
}

function drawCreature(c) {
  if (!c.sprite || c.alpha <= 0.005) return;
  const type = c.motion.type;
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
  } else if (type === 'paddle') {
    bob = Math.sin(time * TAU * 0.35 + c.phase) * c.h * 0.03;
    shear += Math.sin(time * TAU * 0.25 + c.phase * 0.5) * 0.035;
    sx *= 1 + Math.sin(time * TAU * 0.5 + c.phase) * 0.012;
  }

  let grow = 1;
  if (c.state === 'enter') grow = 0.7 + 0.3 * easeOutCubic(Math.min(1, c.age / ENTER_SECONDS));
  else if (c.state === 'leave') grow = 1 - 0.12 * Math.min(1, c.leaveAge / LEAVE_SECONDS);

  ctx.save();
  ctx.globalAlpha = c.alpha * (0.8 + 0.2 * c.z);
  ctx.translate(c.x, c.y + bob);
  ctx.scale(c.f * sx * grow, sy * grow);
  drawStrips(c, amp, shear);
  ctx.restore();
}

function drawGlow(c) {
  if (c.glow <= 0 || !c.sprite) return;
  const k = c.glow / GLOW_SECONDS;
  const r = c.w * 0.9;
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
  orderDirty = true;
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

  for (const p of [...bubbles, ...sparks, ...plankton]) {
    p.x *= sx;
    p.y *= sy;
  }
  for (const c of creatures.values()) {
    c.x *= sx;
    c.y *= sy;
    computeSize(c);
    if (c.img) buildSprite(c);
  }
  buildBackground();
}

function initScenery() {
  rays = Array.from({ length: 8 }, (_, i) => ({
    x: (i + Math.random() * 0.6) / 8,
    w: rand(0.012, 0.04),
    lean: rand(-0.12, 0.12),
    speed: rand(0.15, 0.35),
    phase: rand(0, TAU),
  }));
  backWeeds = makeWeeds(12, false);
  foreWeeds = makeWeeds(2, true);
  plankton = Array.from({ length: 90 }, () => ({
    x: rand(0, W),
    y: rand(0, H),
    r: rand(0.6, 1.8),
    a: rand(0.2, 0.6),
    vx: rand(-6, 6),
    vy: rand(-10, -2),
    ph: rand(0, TAU),
  }));
  bubbles = Array.from({ length: 45 }, () => ({
    x: rand(0, W),
    y: rand(0, H),
    r: rand(2, 6),
    speed: rand(40, 110),
    phase: rand(0, TAU),
    sway: rand(6, 16),
    burst: false,
  }));
}

function updateScenery(dt) {
  for (const p of plankton) {
    p.x += (p.vx + Math.sin(time * 0.5 + p.ph) * 4) * dt;
    p.y += p.vy * dt;
    if (p.y < -4) p.y = H + 4;
    if (p.x < -4) p.x = W + 4;
    if (p.x > W + 4) p.x = -4;
  }
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    b.y -= b.speed * dt;
    b.x += Math.sin(time * 1.3 + b.phase) * b.sway * dt;
    if (b.y < -b.r * 2) {
      if (b.burst) {
        bubbles.splice(i, 1);
      } else {
        b.y = H + b.r * 2;
        b.x = rand(0, W);
      }
    }
  }
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
  ctx.drawImage(bgLayer, 0, 0, W, H);
  drawRays(time);
  drawWeeds(backWeeds, time, 1);
  drawPlankton();

  if (orderDirty) {
    drawOrder = [...creatures.values()].sort((a, b) => a.z - b.z);
    orderDirty = false;
  }
  for (const c of drawOrder) {
    drawGlow(c);
    drawCreature(c);
  }
  drawSparks();
  drawWeeds(foreWeeds, time, 0.55);
  drawBubbles();
  ctx.globalAlpha = 1;
  ctx.drawImage(vignette, 0, 0, W, H);
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
  if (removed) {
    orderDirty = true;
    updateHint();
  }
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
  initScenery();
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
  window.__aquarium = { count: liveCount };

  connect();
  requestAnimationFrame((now) => {
    lastFrame = now;
    frame(now);
  });
}

setup();
