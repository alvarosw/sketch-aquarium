// Procedural underwater scenery for the aquarium page.
// Everything that does not move is painted once into offscreen canvases
// (rebuilt on resize). Things that sway or drift are drawn every frame.
// Depth is faked with scale and with "water fog": the farther an object is,
// the smaller it gets and the more its colour fades into the water colour.

const TAU = Math.PI * 2;

// Water colour near the horizon; distant objects fade towards it.
const FOG = '#15648a';

// Seeded random numbers, so the scene keeps its layout across resizes.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rgbOf = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const FOG_RGB = rgbOf(FOG);

// Colour helper: shade > 0 lightens, < 0 darkens, then fades into the fog.
function tone(hex, fog = 0, shade = 0, alpha = 1) {
  let [r, g, b] = rgbOf(hex);
  const target = shade > 0 ? 255 : 0;
  const k = Math.abs(shade);
  r += (target - r) * k;
  g += (target - g) * k;
  b += (target - b) * k;
  r += (FOG_RGB[0] - r) * fog;
  g += (FOG_RGB[1] - g) * fog;
  b += (FOG_RGB[2] - b) * fog;
  return `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${alpha})`;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

const ROCK_COLORS = ['#56707a', '#5f6270', '#6e675b', '#47616b', '#64705f'];
const CORAL_COLORS = ['#ff7b6b', '#ff9f43', '#f368e0', '#a55eea', '#ffd166', '#ff6b9a', '#4dd0c8'];

export function createScenery() {
  let W = 0;
  let H = 0;
  let dpr = 1;
  let unit = 1; // CSS px per "design px" at 1080p

  let back = null; // static far-to-near background
  let vignette = null;
  let cornerL = null;
  let cornerR = null;
  let rayGradient = null;

  let rays = [];
  let weeds = [];
  let anemones = [];
  let kelp = [];
  let schools = [];
  let plankton = [];
  let bubbles = [];
  let vents = [];

  // Sand line for a given depth d (0 = horizon, 1 = bottom of the screen).
  const floorTop = () => H * 0.7;
  const floorY = (d) => floorTop() + (H - floorTop()) * (0.06 + 0.9 * d);
  const sizeAt = (d) => 0.28 + 0.85 * d; // relative size of objects at depth d
  const scaleAt = (d) => unit * sizeAt(d);
  const fogAt = (d) => 0.82 * (1 - d) ** 1.25;
  // Creature size relative to the front (d = 1): about 0.43 far away. Same
  // curve as scaleAt, softened so that small far creatures stay readable.
  const perspective = (d) => (sizeAt(d) / sizeAt(1)) ** 0.6;

  // -------------------------------------------------------------------------
  // Static painters
  // -------------------------------------------------------------------------

  function paintWater(g) {
    const water = g.createLinearGradient(0, 0, 0, H);
    water.addColorStop(0, '#2a93b8');
    water.addColorStop(0.3, '#16709a');
    water.addColorStop(0.62, FOG);
    water.addColorStop(1, '#0a3b58');
    g.fillStyle = water;
    g.fillRect(0, 0, W, H);

    const haze = g.createRadialGradient(W * 0.5, -H * 0.15, 0, W * 0.5, -H * 0.15, W * 0.8);
    haze.addColorStop(0, 'rgba(190, 245, 255, 0.4)');
    haze.addColorStop(1, 'rgba(190, 245, 255, 0)');
    g.fillStyle = haze;
    g.fillRect(0, 0, W, H);
  }

  // Shimmering surface seen from below.
  function paintSurface(g, rnd) {
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 70; i++) {
      const y = rnd() * H * 0.07;
      const x = rnd() * W;
      const w = (30 + rnd() * 120) * unit * (1 - y / (H * 0.1));
      g.fillStyle = `rgba(200, 245, 255, ${0.03 + rnd() * 0.05})`;
      g.beginPath();
      g.ellipse(x, y, w, w * 0.08 + 1, 0, 0, TAU);
      g.fill();
    }
    g.restore();
  }

  // Distant ridges: a soft sum of waves plus a few tall pinnacles.
  function paintRidge(g, rnd, baseY, amp, color, fog, pinnacles) {
    const p1 = rnd() * TAU;
    const p2 = rnd() * TAU;
    const p3 = rnd() * TAU;
    const peaks = Array.from({ length: pinnacles }, () => ({
      x: rnd() * W,
      w: (0.008 + rnd() * 0.03) * W,
      h: (0.4 + rnd() * 1.1) * amp,
    }));
    const top = [];
    for (let i = 0; i <= 240; i++) {
      const x = (i / 240) * W;
      const u = x / W;
      let y = baseY - amp * (0.55 + 0.25 * Math.sin(u * TAU * 1.3 + p1) + 0.14 * Math.sin(u * TAU * 3.7 + p2) + 0.06 * Math.sin(u * TAU * 11 + p3));
      for (const pk of peaks) y -= pk.h * Math.exp(-(((x - pk.x) / pk.w) ** 2));
      top.push([x, y]);
    }
    const minY = Math.min(...top.map((p) => p[1]));
    const grad = g.createLinearGradient(0, minY, 0, baseY + amp);
    grad.addColorStop(0, tone(color, fog, 0.12));
    grad.addColorStop(1, tone(color, fog, -0.25));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, H);
    for (const [x, y] of top) g.lineTo(x, y);
    g.lineTo(W, H);
    g.closePath();
    g.fill();
    return top;
  }

  function paintFloor(g, rnd) {
    const top = floorTop();
    const sand = g.createLinearGradient(0, top, 0, H);
    sand.addColorStop(0, tone('#d9bd86', 0.72));
    sand.addColorStop(0.35, tone('#d9bd86', 0.35));
    sand.addColorStop(0.75, '#c9a46a');
    sand.addColorStop(1, '#8a6a42');
    g.fillStyle = sand;
    g.beginPath();
    g.moveTo(0, H);
    for (let i = 0; i <= 160; i++) {
      const x = (i / 160) * W;
      g.lineTo(x, top + Math.sin((x / W) * TAU * 1.7 + 0.6) * H * 0.008 + Math.sin((x / W) * TAU * 4.3) * H * 0.003);
    }
    g.lineTo(W, H);
    g.closePath();
    g.fill();

    // Ripples get wider apart and stronger towards the viewer.
    const rows = 26;
    for (let k = 1; k <= rows; k++) {
      const d = (k / rows) ** 1.6;
      const y = top + (H - top) * d;
      const amp = (1 + 5 * d) * unit;
      const ph = rnd() * TAU;
      const freq = 6 + rnd() * 5;
      g.lineWidth = (0.6 + 2.4 * d) * unit;
      for (const [dy, color] of [
        [0, `rgba(255, 244, 214, ${0.05 + 0.13 * d})`],
        [g.lineWidth * 1.4, `rgba(90, 60, 30, ${0.04 + 0.1 * d})`],
      ]) {
        g.strokeStyle = color;
        g.beginPath();
        for (let i = 0; i <= 120; i++) {
          const x = (i / 120) * W;
          const yy = y + dy + Math.sin((x / W) * TAU * freq + ph) * amp + Math.sin((x / W) * TAU * 23 + ph * 2) * amp * 0.3;
          if (i === 0) g.moveTo(x, yy);
          else g.lineTo(x, yy);
        }
        g.stroke();
      }
    }

    // Grains: denser and bigger near the bottom.
    for (let i = 0; i < 2600; i++) {
      const d = rnd() ** 0.6;
      const y = top + (H - top) * d;
      const s = (0.6 + 2.2 * d) * unit;
      g.fillStyle = rnd() < 0.5 ? `rgba(255, 245, 215, ${0.1 + 0.2 * d})` : `rgba(70, 45, 20, ${0.08 + 0.18 * d})`;
      g.fillRect(rnd() * W, y, s, s * 0.7);
    }
  }

  function shadow(g, x, y, rx, ry, a = 0.28) {
    const grad = g.createRadialGradient(x, y, 0, x, y, rx);
    grad.addColorStop(0, `rgba(10, 20, 25, ${a})`);
    grad.addColorStop(1, 'rgba(10, 20, 25, 0)');
    g.fillStyle = grad;
    g.save();
    g.translate(x, y);
    g.scale(1, ry / rx);
    g.translate(-x, -y);
    g.beginPath();
    g.arc(x, y, rx, 0, TAU);
    g.fill();
    g.restore();
  }

  // Boulder resting on the sand: lumpy silhouette, lit from above, with
  // flat facets, a rim light and patches of algae.
  function paintRock(g, rnd, x, base, r, fog, color = ROCK_COLORS[(rnd() * ROCK_COLORS.length) | 0], tall = 0.55 + rnd() * 0.35) {
    const rx = r * (0.9 + rnd() * 0.4);
    const ry = r * tall;
    const n = 12;
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = Math.PI + (i / n) * Math.PI;
      const k = 1 + (rnd() - 0.5) * 0.28;
      pts.push([x + Math.cos(a) * rx * k, base + Math.sin(a) * ry * k]);
    }
    pts.push([x + rx * 0.85, base + r * 0.08], [x - rx * 0.85, base + r * 0.08]);

    shadow(g, x + rx * 0.15, base + r * 0.06, rx * 1.35, r * 0.18, 0.35 * (1 - fog));

    const outline = () => {
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        const [px, py] = pts[i - 1];
        const [qx, qy] = pts[i];
        g.quadraticCurveTo(px, py, (px + qx) / 2, (py + qy) / 2);
      }
      g.closePath();
    };
    const grad = g.createLinearGradient(x - rx * 0.4, base - ry, x + rx * 0.3, base);
    grad.addColorStop(0, tone(color, fog, 0.3));
    grad.addColorStop(0.55, tone(color, fog, 0));
    grad.addColorStop(1, tone(color, fog, -0.45));
    g.fillStyle = grad;
    outline();
    g.fill();

    g.save();
    outline();
    g.clip();
    // Facets: wedges from a point inside the rock to pairs of rim points.
    const cx = x - rx * 0.1;
    const cy = base - ry * 0.45;
    for (let i = 0; i < n; i += 2) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const lit = i < n / 2;
      g.fillStyle = lit ? tone('#ffffff', fog, 0, 0.06 + rnd() * 0.06) : tone('#000000', fog, 0, 0.06 + rnd() * 0.08);
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(ax, ay);
      g.lineTo(bx, by);
      g.closePath();
      g.fill();
    }
    // Cracks.
    g.strokeStyle = tone(color, fog, -0.55, 0.6);
    g.lineWidth = Math.max(1, r * 0.025);
    for (let i = 0; i < 2; i++) {
      let px = x + (rnd() - 0.5) * rx;
      let py = base - ry * (0.2 + rnd() * 0.5);
      g.beginPath();
      g.moveTo(px, py);
      for (let j = 0; j < 4; j++) {
        px += (rnd() - 0.5) * r * 0.35;
        py += r * (0.05 + rnd() * 0.12);
        g.lineTo(px, py);
      }
      g.stroke();
    }
    // Algae on the top.
    for (let i = 0; i < 9; i++) {
      const j = 2 + ((rnd() * (n - 4)) | 0);
      const [ax, ay] = pts[j];
      g.fillStyle = tone(rnd() < 0.6 ? '#4f8a4a' : '#7aa64a', fog, 0, 0.55);
      g.beginPath();
      g.ellipse(ax + (x - ax) * 0.1, ay + r * 0.06, r * (0.08 + rnd() * 0.1), r * (0.04 + rnd() * 0.04), 0, 0, TAU);
      g.fill();
    }
    g.restore();

    // Rim light from the surface.
    g.strokeStyle = tone('#d8f6ff', fog, 0, 0.25);
    g.lineWidth = Math.max(1, r * 0.03);
    g.beginPath();
    for (let i = 2; i <= n - 3; i++) {
      const [px, py] = pts[i];
      if (i === 2) g.moveTo(px, py + r * 0.02);
      else g.lineTo(px, py + r * 0.02);
    }
    g.stroke();
    return pts;
  }

  function paintBrainCoral(g, rnd, x, base, r, fog, color) {
    shadow(g, x, base, r * 1.3, r * 0.16, 0.3 * (1 - fog));
    const dome = () => {
      g.beginPath();
      g.ellipse(x, base, r, r * 0.72, 0, Math.PI, TAU);
      g.closePath();
    };
    const grad = g.createRadialGradient(x - r * 0.3, base - r * 0.55, r * 0.1, x, base - r * 0.2, r * 1.1);
    grad.addColorStop(0, tone(color, fog, 0.35));
    grad.addColorStop(1, tone(color, fog, -0.35));
    g.fillStyle = grad;
    dome();
    g.fill();
    g.save();
    dome();
    g.clip();
    g.strokeStyle = tone(color, fog, -0.5, 0.55);
    g.lineWidth = Math.max(1, r * 0.045);
    for (let j = 1; j <= 7; j++) {
      const y = base - r * 0.72 * (j / 7.5);
      const ph = rnd() * TAU;
      g.beginPath();
      for (let i = 0; i <= 30; i++) {
        const xx = x - r + (i / 30) * 2 * r;
        const yy = y + Math.sin(i * 0.9 + ph) * r * 0.05 + Math.sin(i * 2.3 + ph) * r * 0.02;
        if (i === 0) g.moveTo(xx, yy);
        else g.lineTo(xx, yy);
      }
      g.stroke();
    }
    g.restore();
  }

  // Branching coral: forked arms with round tips.
  function paintStaghorn(g, rnd, x, base, s, fog, color) {
    shadow(g, x, base, 60 * s, 8 * s, 0.25 * (1 - fog));
    g.lineCap = 'round';
    const branch = (bx, by, ang, len, w, depth) => {
      const ex = bx + Math.cos(ang) * len;
      const ey = by + Math.sin(ang) * len;
      g.strokeStyle = tone(color, fog, -0.15 + depth * 0.06);
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(bx, by);
      g.quadraticCurveTo(bx + Math.cos(ang + 0.3) * len * 0.5, by + Math.sin(ang + 0.3) * len * 0.5, ex, ey);
      g.stroke();
      if (depth <= 0) {
        g.fillStyle = tone(color, fog, 0.45);
        g.beginPath();
        g.arc(ex, ey, w * 0.6, 0, TAU);
        g.fill();
        return;
      }
      const kids = rnd() < 0.4 ? 3 : 2;
      for (let k = 0; k < kids; k++) {
        const a = ang + (k - (kids - 1) / 2) * (0.5 + rnd() * 0.3) + (rnd() - 0.5) * 0.2;
        branch(ex, ey, a, len * (0.68 + rnd() * 0.15), w * 0.74, depth - 1);
      }
    };
    const trunks = 3 + ((rnd() * 2) | 0);
    for (let i = 0; i < trunks; i++) {
      const a = -Math.PI / 2 + (i - (trunks - 1) / 2) * 0.45 + (rnd() - 0.5) * 0.2;
      branch(x + (rnd() - 0.5) * 14 * s, base, a, (26 + rnd() * 12) * s, 9 * s, 3);
    }
  }

  // Sea fan: a flat, fine mesh of branches spreading upwards.
  function paintFan(g, rnd, x, base, s, fog, color) {
    g.lineCap = 'round';
    const branch = (bx, by, ang, len, w, depth) => {
      const ex = bx + Math.cos(ang) * len;
      const ey = by + Math.sin(ang) * len;
      g.strokeStyle = tone(color, fog, -0.1);
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(bx, by);
      g.lineTo(ex, ey);
      g.stroke();
      if (depth <= 0) return;
      branch(ex, ey, ang - 0.32 - rnd() * 0.15, len * 0.82, w * 0.78, depth - 1);
      branch(ex, ey, ang + 0.32 + rnd() * 0.15, len * 0.82, w * 0.78, depth - 1);
    };
    g.globalAlpha = 0.9;
    branch(x, base, -Math.PI / 2 + (rnd() - 0.5) * 0.3, 26 * s, 4 * s, 6);
    g.globalAlpha = 1;
  }

  function paintTubeSponge(g, rnd, x, base, s, fog, color) {
    shadow(g, x, base, 40 * s, 6 * s, 0.25 * (1 - fog));
    const tubes = 3 + ((rnd() * 3) | 0);
    const list = Array.from({ length: tubes }, (_, i) => ({
      dx: (i - (tubes - 1) / 2) * 13 * s + (rnd() - 0.5) * 5 * s,
      h: (30 + rnd() * 50) * s,
      w: (9 + rnd() * 5) * s,
    })).sort((a, b) => b.h - a.h);
    for (const t of list) {
      const left = x + t.dx - t.w;
      const top = base - t.h;
      const grad = g.createLinearGradient(left, 0, left + t.w * 2, 0);
      grad.addColorStop(0, tone(color, fog, -0.4));
      grad.addColorStop(0.4, tone(color, fog, 0.2));
      grad.addColorStop(1, tone(color, fog, -0.5));
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(left, base);
      g.lineTo(left + t.w * 0.1, top);
      g.lineTo(left + t.w * 1.9, top);
      g.lineTo(left + t.w * 2, base);
      g.closePath();
      g.fill();
      g.fillStyle = tone(color, fog, 0.3);
      g.beginPath();
      g.ellipse(x + t.dx, top, t.w * 0.9, t.w * 0.32, 0, 0, TAU);
      g.fill();
      g.fillStyle = tone(color, fog, -0.7);
      g.beginPath();
      g.ellipse(x + t.dx, top + 1, t.w * 0.62, t.w * 0.2, 0, 0, TAU);
      g.fill();
    }
  }

  function paintStarfish(g, rnd, x, y, s, fog, color) {
    const r = 13 * s;
    const rot = rnd() * TAU;
    g.save();
    g.translate(x, y);
    g.scale(1, 0.55);
    g.rotate(rot);
    g.fillStyle = tone(color, fog);
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      const rr = i % 2 ? r * 0.42 : r;
      g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.closePath();
    g.fill();
    g.fillStyle = tone(color, fog, 0.5, 0.8);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      for (const k of [0.3, 0.55, 0.78]) {
        g.beginPath();
        g.arc(Math.cos(a) * r * k, Math.sin(a) * r * k, r * 0.06, 0, TAU);
        g.fill();
      }
    }
    g.restore();
  }

  function paintShell(g, rnd, x, y, s, fog) {
    const r = 9 * s;
    const color = rnd() < 0.5 ? '#f6d7c3' : '#f1b7a6';
    g.fillStyle = tone(color, fog);
    g.beginPath();
    g.moveTo(x, y);
    g.arc(x, y, r, Math.PI * 1.08, Math.PI * 1.92);
    g.closePath();
    g.fill();
    g.strokeStyle = tone(color, fog, -0.35, 0.8);
    g.lineWidth = Math.max(0.8, s);
    for (let i = 1; i < 7; i++) {
      const a = Math.PI * (1.08 + (0.84 * i) / 7);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      g.stroke();
    }
  }

  // Big reef formation framing one side of the screen.
  function paintSideReef(g, rnd, side) {
    const sx = (f) => (side < 0 ? f * W : W - f * W);
    const ground = H * 0.97;
    // Stack of boulders: big ones at the edge, smaller towards the centre.
    const boulders = [
      [0.0, ground - H * 0.3, 0.13, 1.3],
      [0.03, ground - H * 0.14, 0.17, 1.1],
      [0.04, ground, 0.24, 1.0],
      [0.13, ground + H * 0.01, 0.13, 0.85],
      [0.2, ground + H * 0.02, 0.07, 0.8],
    ];
    const tops = [];
    for (const [fx, by, fr, tall] of boulders) {
      const r = fr * H;
      const pts = paintRock(g, rnd, sx(fx), by, r, 0.05, ROCK_COLORS[(rnd() * ROCK_COLORS.length) | 0], 0.55 * tall);
      tops.push(...pts.slice(3, 10));
    }
    // Corals growing on top of the boulders.
    const s = unit * 1.15;
    const pick = (i) => tops[(i * 7 + ((rnd() * 5) | 0)) % tops.length];
    const color = () => CORAL_COLORS[(rnd() * CORAL_COLORS.length) | 0];
    let i = 0;
    for (const kind of ['fan', 'stag', 'brain', 'tube', 'stag', 'fan', 'brain']) {
      const [px, py] = pick(i++);
      if (px < -20 || px > W + 20) continue;
      const y = py + 6 * s;
      if (kind === 'fan') paintFan(g, rnd, px, y, s * (0.9 + rnd() * 0.5), 0, color());
      else if (kind === 'stag') paintStaghorn(g, rnd, px, y, s * (0.7 + rnd() * 0.4), 0, color());
      else if (kind === 'brain') paintBrainCoral(g, rnd, px, y, (22 + rnd() * 16) * s, 0, color());
      else paintTubeSponge(g, rnd, px, y, s * 0.9, 0, color());
    }
    return tops;
  }

  // Very near rocks in the bottom corners, out of focus, drawn over everything.
  function paintCorner(side) {
    const cw = W * 0.2;
    const ch = H * 0.32;
    const c = makeCanvas(cw * dpr, ch * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.filter = `blur(${Math.max(2, 4 * unit)}px)`;
    const rnd = seeded(side < 0 ? 31 : 47);
    const ox = side < 0 ? 0 : cw;
    const dir = side < 0 ? 1 : -1;
    // Round, out-of-focus boulders hugging the corner.
    for (const [fx, fy, fr] of [[0.05, 1.02, 0.42], [0.42, 1.08, 0.3], [0.2, 0.86, 0.22]]) {
      const grad = g.createRadialGradient(ox + dir * cw * fx, ch * fy - ch * fr * 0.5, 0, ox + dir * cw * fx, ch * fy, ch * fr * 1.2);
      grad.addColorStop(0, '#1d3a44');
      grad.addColorStop(1, '#061820');
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(ox + dir * cw * fx, ch * fy, ch * fr * (1.2 + rnd() * 0.3), ch * fr, 0, 0, TAU);
      g.fill();
    }
    // A few dark fronds poking up.
    g.strokeStyle = '#06261c';
    g.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const bx = ox + dir * cw * (0.05 + rnd() * 0.4);
      g.lineWidth = (6 + rnd() * 6) * unit;
      g.beginPath();
      g.moveTo(bx, ch);
      g.quadraticCurveTo(bx + dir * 20 * unit, ch * 0.4, bx + dir * (rnd() * 40 - 10) * unit, ch * (0.05 + rnd() * 0.2));
      g.stroke();
    }
    return c;
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  function build() {
    const rnd = seeded(20251022);
    back = makeCanvas(W * dpr, H * dpr);
    const g = back.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    paintWater(g);
    paintSurface(g, rnd);

    // Far away: two hazy ridges with pinnacles, a little blurred.
    g.filter = `blur(${Math.max(1, 2.5 * unit)}px)`;
    paintRidge(g, rnd, H * 0.66, H * 0.14, '#3f6f7c', 0.86, 5);
    g.filter = `blur(${Math.max(0.5, 1.2 * unit)}px)`;
    const ridge = paintRidge(g, rnd, H * 0.71, H * 0.1, '#3c6470', 0.7, 4);
    g.filter = 'none';
    // Tiny coral silhouettes along the nearer ridge.
    for (let i = 0; i < 16; i++) {
      const [x, y] = ridge[(rnd() * ridge.length) | 0];
      paintStaghorn(g, rnd, x, y + 4 * unit, unit * 0.3, 0.72, CORAL_COLORS[i % CORAL_COLORS.length]);
    }

    paintFloor(g, rnd);

    // Objects on the sand, spread over the whole width and sorted far to near.
    const items = [];
    const add = (kind, count, d0, d1) => {
      for (let i = 0; i < count; i++) {
        items.push({ kind, x: ((i + rnd()) / count) * W, d: d0 + rnd() * (d1 - d0), color: CORAL_COLORS[(rnd() * CORAL_COLORS.length) | 0] });
      }
    };
    add('rock', 9, 0.0, 0.75);
    add('brain', 5, 0.05, 0.8);
    add('stag', 6, 0.0, 0.75);
    add('fan', 4, 0.0, 0.6);
    add('tube', 4, 0.1, 0.8);
    add('star', 5, 0.45, 0.95);
    add('shell', 6, 0.4, 0.95);
    items.sort((a, b) => a.d - b.d);
    for (const it of items) {
      const y = floorY(it.d);
      const s = scaleAt(it.d);
      const fog = fogAt(it.d);
      if (it.kind === 'rock') paintRock(g, rnd, it.x, y, (45 + rnd() * 60) * s, fog);
      else if (it.kind === 'brain') paintBrainCoral(g, rnd, it.x, y, (20 + rnd() * 14) * s, fog, it.color);
      else if (it.kind === 'stag') paintStaghorn(g, rnd, it.x, y, s * (0.7 + rnd() * 0.5), fog, it.color);
      else if (it.kind === 'fan') paintFan(g, rnd, it.x, y, s * (0.9 + rnd() * 0.6), fog, it.color);
      else if (it.kind === 'tube') paintTubeSponge(g, rnd, it.x, y, s, fog, it.color);
      else if (it.kind === 'star') paintStarfish(g, rnd, it.x, y, s, fog, rnd() < 0.5 ? '#ff7f50' : '#e8505b');
      else paintShell(g, rnd, it.x, y, s, fog);
    }

    // Reefs framing both sides.
    const leftTops = paintSideReef(g, rnd, -1);
    const rightTops = paintSideReef(g, rnd, 1);

    // Animated plants on the sand (depth-scaled) and on the side reefs.
    weeds = [];
    for (let i = 0; i < 16; i++) {
      const d = 0.1 + rnd() * 0.8;
      const s = scaleAt(d);
      weeds.push({
        x: ((i + rnd()) / 16) * W,
        y: floorY(d) + 2 * s,
        h: (60 + rnd() * 110) * s,
        w: (5 + rnd() * 4) * s,
        sway: 0.12 + rnd() * 0.12,
        speed: 0.5 + rnd() * 0.6,
        phase: rnd() * TAU,
        color: tone(rnd() < 0.5 ? '#2f9a5f' : '#3fae6a', fogAt(d)),
        d,
      });
    }
    weeds.sort((a, b) => a.d - b.d);

    anemones = [];
    const anemoneAt = (x, y, s) => {
      const hue = ['#ff6b81', '#ffa94d', '#c084fc', '#7bdff2'][(rnd() * 4) | 0];
      anemones.push({ x, y, s, color: hue, tip: tone(hue, 0, 0.5), phase: rnd() * TAU, n: 13 + ((rnd() * 5) | 0) });
    };
    for (let i = 0; i < 3; i++) anemoneAt(...leftTops[(rnd() * leftTops.length) | 0], unit * (0.9 + rnd() * 0.4));
    for (let i = 0; i < 3; i++) anemoneAt(...rightTops[(rnd() * rightTops.length) | 0], unit * (0.9 + rnd() * 0.4));
    for (let i = 0; i < 4; i++) {
      const d = 0.55 + rnd() * 0.4;
      anemoneAt(W * (0.22 + rnd() * 0.56), floorY(d), scaleAt(d));
    }

    // Tall kelp at the edges, in front of everything.
    kelp = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const fx = 0.012 + i * 0.03 + rnd() * 0.015;
        kelp.push({
          x: side < 0 ? fx * W : W - fx * W,
          h: H * (0.55 + rnd() * 0.35),
          w: (5 + rnd() * 3) * unit,
          leaf: (16 + rnd() * 8) * unit,
          phase: rnd() * TAU,
          speed: 0.35 + rnd() * 0.3,
          color: ['#1f6b3a', '#2a7d40', '#1a5a35'][i],
        });
      }
    }

    // Bubble vents on the side reefs.
    vents = [leftTops[(rnd() * leftTops.length) | 0], rightTops[(rnd() * rightTops.length) | 0]].map(([x, y]) => ({ x, y, timer: rnd() }));

    cornerL = paintCorner(-1);
    cornerR = paintCorner(1);

    vignette = makeCanvas(W * dpr, H * dpr);
    const vg = vignette.getContext('2d');
    vg.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = vg.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.4, W / 2, H * 0.45, Math.max(W, H) * 0.78);
    v.addColorStop(0, 'rgba(0, 0, 0, 0)');
    v.addColorStop(1, 'rgba(0, 10, 20, 0.5)');
    vg.fillStyle = v;
    vg.fillRect(0, 0, W, H);
  }

  function seedLife() {
    const rnd = Math.random;
    rays = Array.from({ length: 8 }, (_, i) => ({
      x: (i + rnd() * 0.6) / 8,
      w: 0.012 + rnd() * 0.03,
      lean: (rnd() - 0.5) * 0.24,
      speed: 0.15 + rnd() * 0.2,
      phase: rnd() * TAU,
    }));
    // Far-away schools of tiny fish, only shapes in the haze.
    schools = Array.from({ length: 2 }, (_, k) => ({
      x: rnd() * W,
      y: H * (0.3 + k * 0.18 + rnd() * 0.08),
      v: (k ? -1 : 1) * (14 + rnd() * 10),
      size: (k ? 5 : 7) * unit,
      fog: k ? 0.7 : 0.55,
      fish: Array.from({ length: 26 }, () => ({ ox: (rnd() - 0.5) * 220, oy: (rnd() - 0.5) * 70, ph: rnd() * TAU })),
    }));
    plankton = Array.from({ length: 90 }, () => ({
      x: rnd() * W,
      y: rnd() * H,
      r: 0.6 + rnd() * 1.2,
      a: 0.2 + rnd() * 0.4,
      vx: (rnd() - 0.5) * 12,
      vy: -2 - rnd() * 8,
      ph: rnd() * TAU,
    }));
    bubbles = Array.from({ length: 30 }, () => newBubble(rnd() * W, rnd() * H, false));
  }

  function newBubble(x, y, burst, r = 2 + Math.random() * 4) {
    return { x, y, r, speed: 40 + Math.random() * 80 + r * 6, phase: Math.random() * TAU, sway: 6 + Math.random() * 10, burst };
  }

  // -------------------------------------------------------------------------
  // Per-frame drawing
  // -------------------------------------------------------------------------

  function drawRays(ctx, t) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rayGradient;
    for (const r of rays) {
      const top = r.x * W + Math.sin(t * r.speed + r.phase) * W * 0.02;
      const bottom = top + r.lean * W;
      const wTop = r.w * W;
      const wBottom = wTop * 2.6;
      ctx.globalAlpha = 0.05 + 0.035 * Math.sin(t * r.speed * 1.7 + r.phase);
      ctx.beginPath();
      ctx.moveTo(top - wTop / 2, 0);
      ctx.lineTo(top + wTop / 2, 0);
      ctx.lineTo(bottom + wBottom / 2, H * 0.85);
      ctx.lineTo(bottom - wBottom / 2, H * 0.85);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function drawSchools(ctx, t) {
    for (const sc of schools) {
      ctx.fillStyle = tone('#0b3a55', sc.fog * 0.6, 0, 0.55);
      const dir = Math.sign(sc.v);
      for (const f of sc.fish) {
        const x = sc.x + f.ox * unit + Math.sin(t * 0.7 + f.ph) * 6 * unit;
        const y = sc.y + f.oy * unit + Math.sin(t * 0.9 + f.ph * 1.3) * 4 * unit;
        const s = sc.size;
        const flick = Math.sin(t * 8 + f.ph) * s * 0.25;
        ctx.beginPath();
        ctx.ellipse(x, y, s, s * 0.42, 0, 0, TAU);
        ctx.moveTo(x - dir * s * 0.8, y);
        ctx.lineTo(x - dir * s * 1.7, y - s * 0.5 + flick);
        ctx.lineTo(x - dir * s * 1.7, y + s * 0.5 + flick);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // A strand of seaweed as one filled, tapering ribbon.
  function drawWeed(ctx, w, t) {
    const segs = 10;
    const left = [];
    const right = [];
    for (let j = 0; j <= segs; j++) {
      const f = j / segs;
      const sway = (Math.sin(t * w.speed + w.phase + f * 2.4) * 0.7 + Math.sin(t * w.speed * 0.43 + w.phase * 1.7 + f) * 0.3) * w.sway * w.h * f * f;
      const x = w.x + sway;
      const y = w.y - w.h * f;
      const half = (w.w * (1 - 0.8 * f)) / 2;
      left.push([x - half, y]);
      right.push([x + half, y]);
    }
    ctx.fillStyle = w.color;
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (const [x, y] of left) ctx.lineTo(x, y);
    for (let j = right.length - 1; j >= 0; j--) ctx.lineTo(right[j][0], right[j][1]);
    ctx.closePath();
    ctx.fill();
  }

  function drawAnemone(ctx, a, t) {
    const s = a.s;
    ctx.fillStyle = tone(a.color, 0, -0.35);
    ctx.beginPath();
    ctx.ellipse(a.x, a.y - 6 * s, 11 * s, 8 * s, 0, 0, TAU);
    ctx.fill();
    ctx.lineCap = 'round';
    ctx.lineWidth = 3.2 * s;
    for (let i = 0; i < a.n; i++) {
      const spread = (i / (a.n - 1) - 0.5) * 2.3;
      const ang = -Math.PI / 2 + spread;
      const len = (20 + 6 * Math.sin(i * 1.7)) * s;
      const sw = Math.sin(t * 1.3 + a.phase + i * 0.35) * 0.35;
      const bx = a.x + Math.cos(ang) * 6 * s;
      const by = a.y - 10 * s + Math.sin(ang) * 3 * s;
      const ex = bx + Math.cos(ang + sw) * len;
      const ey = by + Math.sin(ang + sw) * len;
      ctx.strokeStyle = a.color;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.quadraticCurveTo(bx + Math.cos(ang) * len * 0.6, by + Math.sin(ang) * len * 0.6, ex, ey);
      ctx.stroke();
      ctx.fillStyle = a.tip;
      ctx.beginPath();
      ctx.arc(ex, ey, 2 * s, 0, TAU);
      ctx.fill();
    }
  }

  function drawKelp(ctx, k, t) {
    const segs = 14;
    const pts = [];
    for (let j = 0; j <= segs; j++) {
      const f = j / segs;
      const sway = (Math.sin(t * k.speed + k.phase + f * 2) * 0.75 + Math.sin(t * k.speed * 0.5 + k.phase + f * 3.1) * 0.25) * H * 0.045 * f ** 1.5;
      pts.push([k.x + sway, H - k.h * f]);
    }
    ctx.strokeStyle = k.color;
    ctx.lineWidth = k.w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.fillStyle = k.color;
    for (let j = 1; j < segs; j++) {
      const [x, y] = pts[j];
      const [nx, ny] = pts[j + 1];
      const side = j % 2 ? 1 : -1;
      const ang = Math.atan2(ny - y, nx - x) + side * 0.9 + Math.sin(t * k.speed * 1.5 + j) * 0.15;
      const len = k.leaf * (1.2 - (j / segs) * 0.5);
      ctx.beginPath();
      ctx.ellipse(x + Math.cos(ang) * len * 0.5, y + Math.sin(ang) * len * 0.5, len * 0.55, len * 0.18, ang, 0, TAU);
      ctx.fill();
    }
  }

  function drawPlankton(ctx) {
    ctx.fillStyle = 'rgb(200, 240, 255)';
    for (const p of plankton) {
      ctx.globalAlpha = p.a;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawBubbles(ctx) {
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

  return {
    // Depth model for the creatures: the same sand line, size and fog as the scenery.
    depth: { floorY, perspective, fogAt, fog: FOG },

    resize(width, height, ratio, ctx) {
      const sx = W ? width / W : 1;
      const sy = H ? height / H : 1;
      W = width;
      H = height;
      dpr = ratio;
      unit = H / 1080;
      for (const p of [...bubbles, ...plankton]) {
        p.x *= sx;
        p.y *= sy;
      }
      build();
      if (!rays.length) seedLife();
      for (const sc of schools) sc.y *= sy;
      rayGradient = ctx.createLinearGradient(0, 0, 0, H);
      rayGradient.addColorStop(0, 'rgba(200, 246, 255, 0.55)');
      rayGradient.addColorStop(1, 'rgba(200, 246, 255, 0)');
    },

    update(dt, t) {
      for (const sc of schools) {
        sc.x += sc.v * unit * dt;
        const span = 260 * unit;
        if (sc.v > 0 && sc.x - span > W) sc.x = -span;
        if (sc.v < 0 && sc.x + span < 0) sc.x = W + span;
      }
      for (const p of plankton) {
        p.x += (p.vx + Math.sin(t * 0.5 + p.ph) * 4) * dt;
        p.y += p.vy * dt;
        if (p.y < -4) p.y = H + 4;
        if (p.x < -4) p.x = W + 4;
        if (p.x > W + 4) p.x = -4;
      }
      for (const v of vents) {
        v.timer -= dt;
        if (v.timer <= 0 && bubbles.length < 140) {
          v.timer = 0.12 + Math.random() * 0.5;
          bubbles.push(newBubble(v.x + (Math.random() - 0.5) * 6, v.y, true, 1.5 + Math.random() * 3));
        }
      }
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const b = bubbles[i];
        b.y -= b.speed * dt;
        b.x += Math.sin(t * 1.3 + b.phase) * b.sway * dt;
        if (b.y < -b.r * 2) {
          if (b.burst) bubbles.splice(i, 1);
          else {
            b.y = H + b.r * 2;
            b.x = Math.random() * W;
          }
        }
      }
    },

    // Bubbles released by a creature (for example when it leaves).
    burst(x, y, count) {
      for (let i = 0; i < count && bubbles.length < 140; i++) {
        bubbles.push(newBubble(x + (Math.random() - 0.5) * 40, y + (Math.random() - 0.5) * 20, true, 3 + Math.random() * 4));
      }
    },

    // Everything behind the creatures.
    drawBack(ctx, t) {
      ctx.drawImage(back, 0, 0, W, H);
      drawRays(ctx, t);
      drawSchools(ctx, t);
      for (const w of weeds) drawWeed(ctx, w, t);
      for (const a of anemones) drawAnemone(ctx, a, t);
      drawPlankton(ctx);
    },

    // Everything in front of the creatures.
    drawFront(ctx, t) {
      for (const k of kelp) drawKelp(ctx, k, t);
      ctx.drawImage(cornerL, 0, H - H * 0.32, W * 0.2, H * 0.32);
      ctx.drawImage(cornerR, W - W * 0.2, H - H * 0.32, W * 0.2, H * 0.32);
      drawBubbles(ctx);
      ctx.drawImage(vignette, 0, 0, W, H);
    },
  };
}
