// Single source of truth for the species and the printable sheet geometry.
// Used by the server (valid ids), the templates page, the capture page and
// the detection code. Plain ES module: no DOM access.

// A4 landscape sheet, millimetres.
export const PAGE = { w: 297, h: 210 };

// Four solid black squares in the corners. Centres: (18,18) (279,18) (18,192) (279,192).
export const MARKER = { size: 16, inset: 10 };

// Three code cells. xs are cell centres; y is the cell centre (cells span y 192..200).
// Bit i of the code is set when cell i is filled black (code = b0*1 + b1*2 + b2*4).
export const CODE = { size: 8, y: 196, xs: [128.5, 148.5, 168.5] };

// Drawing area on the sheet, millimetres. Outlines are defined in box-local
// coordinates (0..240, 0..150) with the creature facing right (head towards +x).
export const BOX = { x: 28.5, y: 30, w: 240, h: 150 };

// ---------------------------------------------------------------------------
// Geometry helpers used to author the outlines below.
// An anchor is [x, y] or [x, y, true]; the flag marks a sharp corner.
// ---------------------------------------------------------------------------

const r2 = (v) => Math.round(v * 100) / 100;

// Closed smooth curve through the anchors, as cubic Bezier segments.
function closedPath(anchors) {
  const n = anchors.length;
  const at = (i) => anchors[((i % n) + n) % n];
  let d = `M${r2(at(0)[0])} ${r2(at(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = at(i);
    const p1 = at(i + 1);
    const pm = at(i - 1);
    const p2 = at(i + 2);
    const out = p0[2] ? [0, 0] : [(p1[0] - pm[0]) / 6, (p1[1] - pm[1]) / 6];
    const inn = p1[2] ? [0, 0] : [(p2[0] - p0[0]) / 6, (p2[1] - p0[1]) / 6];
    d += `C${r2(p0[0] + out[0])} ${r2(p0[1] + out[1])} ${r2(p1[0] - inn[0])} ${r2(p1[1] - inn[1])} ${r2(p1[0])} ${r2(p1[1])}`;
  }
  return d + 'Z';
}

// Signed area (shoelace). Used to give every part the same winding so that
// the union of parts is filled with the nonzero rule.
function signedArea(anchors) {
  let a = 0;
  for (let i = 0; i < anchors.length; i++) {
    const p = anchors[i];
    const q = anchors[(i + 1) % anchors.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function sameWinding(anchors) {
  return signedArea(anchors) < 0 ? [...anchors].reverse() : anchors;
}

function ellipse(cx, cy, rx, ry, n = 8) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

// Leaf-shaped flipper from a base (inside the shell) to a tip.
function limb(bx, by, tx, ty, w) {
  const dx = tx - bx;
  const dy = ty - by;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  const at = (t, k) => [bx + dx * t + nx * w * k, by + dy * t + ny * w * k];
  return [
    [bx, by],
    at(0.3, 1),
    at(0.8, 0.8),
    [tx, ty, true],
    at(0.8, -0.8),
    at(0.3, -1),
  ];
}

// Wavy tapering tentacle as a closed polygon, starting at (xb, yb) and running left.
function tentacle(xb, yb, len, amp, phase, w0) {
  const N = 16;
  const center = [];
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    center.push([xb - len * s, yb + amp * s * Math.sin(Math.PI * 2 * 1.3 * s + phase)]);
  }
  const left = [];
  const right = [];
  for (let i = 0; i < N; i++) {
    const a = center[Math.max(i - 1, 0)];
    const b = center[Math.min(i + 1, N)];
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const l = Math.hypot(tx, ty);
    const nx = -ty / l;
    const ny = tx / l;
    const h = (w0 * (1 - i / N) ** 0.7 + 0.3) / 2;
    const c = center[i];
    left.push([c[0] + nx * h, c[1] + ny * h]);
    right.push([c[0] - nx * h, c[1] - ny * h]);
  }
  const tip = [center[N][0], center[N][1], true];
  return [...left, tip, ...right.reverse()];
}

function circle(cx, cy, r) {
  return `M${r2(cx - r)} ${r2(cy)}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;
}

function ellipsePath(cx, cy, rx, ry) {
  return `M${r2(cx - rx)} ${r2(cy)}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0`;
}

// Turn a list of anchor arrays into SVG parts plus a combined outline string.
function buildParts(anchorLists) {
  const parts = anchorLists.map((a) => closedPath(sameWinding(a)));
  return { parts, outline: parts.join(' ') };
}

// ---------------------------------------------------------------------------
// Outlines (box-local mm, facing right)
// ---------------------------------------------------------------------------

// Fish: oval body, forked tail on the left, dorsal fin, ventral fin.
const fishBody = [
  [232, 76],
  [226, 54],
  [204, 38],
  [166, 28],
  [124, 27],
  [100, 31],
  [82, 6, true], // dorsal fin tip
  [64, 38],
  [50, 58],
  [6, 14, true], // upper tail tip
  [30, 76, true], // fork notch
  [6, 138, true], // lower tail tip
  [50, 94],
  [66, 110],
  [96, 120],
  [116, 146, true], // ventral fin tip
  [134, 124],
  [166, 120],
  [198, 110],
  [222, 96],
];

// Shark: torpedo body, tall backward dorsal fin, crescent tail, pectoral fin.
const sharkBody = [
  [240, 84, true], // snout
  [226, 66],
  [196, 55],
  [162, 49],
  [122, 4, true], // dorsal fin tip
  [98, 48],
  [66, 62],
  [46, 64],
  [10, 6, true], // upper tail lobe tip
  [6, 30],
  [22, 62],
  [44, 84, true], // tail notch
  [28, 112],
  [14, 134, true], // lower tail lobe tip
  [52, 114],
  [86, 116],
  [118, 112],
  [140, 136, true], // pectoral fin tip
  [164, 112],
  [200, 108],
  [226, 100],
];

// Squid: tube-shaped mantle with a pointed end on the right, two diamond fins
// near that end, and eight wavy tentacles trailing left from the head.
const squidMantle = [
  [240, 76, true], // pointed end
  [226, 64],
  [200, 48],
  [150, 40],
  [110, 40],
  [84, 46],
  [70, 64],
  [68, 90],
  [78, 108],
  [108, 114],
  [150, 114],
  [190, 108],
  [224, 88],
];
const squidFins = [limb(196, 60, 172, 12, 12), limb(196, 94, 172, 140, 12)];
const squidTentacles = [92, 100, 104, 96, 102, 94, 100, 88].map((len, k) =>
  tentacle(110, 48 + k * 8.2, len, 4.5, k * 1.1, 8.5),
);

// Turtle: oval shell seen from above, head to the right, four flippers, small tail.
const turtleShell = ellipse(124, 76, 80, 56);
const turtleHead = ellipse(212, 76, 25, 16);
const turtleTail = ellipse(40, 76, 16, 7);
const turtleFlippers = [
  limb(160, 46, 206, 8, 13), // front upper
  limb(160, 106, 206, 144, 13), // front lower
  limb(88, 44, 54, 10, 11), // rear upper
  limb(88, 108, 54, 142, 11), // rear lower
];

const fish = buildParts([fishBody]);
const shark = buildParts([sharkBody]);
const squid = buildParts([...squidTentacles, ...squidFins, squidMantle]);
const turtle = buildParts([turtleHead, turtleTail, ...turtleFlippers, turtleShell]);

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------

export const SPECIES = [
  {
    id: 'fish',
    name: 'Peixe',
    code: 1,
    parts: fish.parts,
    outline: fish.outline,
    details: circle(186, 60, 5.5) + ' M158 44Q148 76 158 106',
    motion: { type: 'tail', speed: 110, size: 0.22, depth: [0.12, 0.85] },
  },
  {
    id: 'shark',
    name: 'Tubarão',
    code: 2,
    parts: shark.parts,
    outline: shark.outline,
    details:
      circle(206, 68, 4) +
      ' M134 66q-6 12 0 24 M144 66q-6 12 0 24 M154 66q-6 12 0 24' +
      ' M234 94q-14 8-32 4',
    motion: { type: 'tail', speed: 70, size: 0.38, depth: [0.2, 0.75] },
  },
  {
    id: 'squid',
    name: 'Lula',
    code: 3,
    parts: squid.parts,
    outline: squid.outline,
    details: circle(116, 66, 7),
    motion: { type: 'jet', speed: 130, size: 0.24, depth: [0.1, 0.7] },
  },
  {
    id: 'turtle',
    name: 'Tartaruga',
    code: 4,
    parts: turtle.parts,
    outline: turtle.outline,
    details: ellipsePath(124, 76, 44, 30) + ' ' + circle(222, 70, 3),
    motion: { type: 'paddle', speed: 40, size: 0.28, depth: [0.25, 0.8] },
  },
];

export function byId(id) {
  return SPECIES.find((s) => s.id === id) ?? null;
}

export function byCode(code) {
  return SPECIES.find((s) => s.code === code) ?? null;
}
