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
// Upright creatures (jellyfish, seahorse) keep their head at the top.
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

function ellipse(cx, cy, rx, ry, n = 12) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

// Mirror anchors across the horizontal line y = axis (for symmetric fins).
const flipY = (anchors, axis) => anchors.map(([x, y, s]) => [x, 2 * axis - y, s]);

// Smooth centre line sampled from a function s -> [x, y], s in 0..1.
function sample(fn, n = 18) {
  return Array.from({ length: n + 1 }, (_, i) => fn(i / n));
}

// Tapering tube around a centre line, as a closed outline with a pointed tip.
function tube(center, w0, w1) {
  const n = center.length - 1;
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    const a = center[Math.max(i - 1, 0)];
    const b = center[i + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / l;
    const ny = (b[0] - a[0]) / l;
    const h = (w0 + (w1 - w0) * (i / n)) / 2;
    const c = center[i];
    left.push([c[0] + nx * h, c[1] + ny * h]);
    right.push([c[0] - nx * h, c[1] - ny * h]);
  }
  const tip = [center[n][0], center[n][1], true];
  return [...left, tip, ...right.reverse()];
}

// Turn a list of anchor arrays (back to front) into SVG parts plus a combined
// outline string. Parts later in the list are drawn on top on the sheet.
function buildParts(anchorLists) {
  const parts = anchorLists.map((a) => closedPath(sameWinding(a)));
  return { parts, outline: parts.join(' ') };
}

// ---------------------------------------------------------------------------
// Fish: round tropical fish, fan tail, tall dorsal fin, pectoral fin on top.
// ---------------------------------------------------------------------------

const fish = (() => {
  const body = [
    [231, 80], [224, 56], [202, 38], [168, 28], [130, 28], [98, 36], [76, 52], [60, 70],
    [60, 82], [76, 100], [100, 116], [134, 124], [170, 122], [204, 110], [225, 96],
  ];
  const tail = [
    [68, 68], [46, 50], [20, 24, true], [14, 50], [30, 76, true], [14, 102], [20, 128, true], [46, 102], [68, 84],
  ];
  const dorsal = [[90, 46], [94, 24], [114, 9], [146, 5], [172, 16], [164, 34]];
  const anal = [[102, 112], [106, 132], [124, 146], [142, 140], [146, 120]];
  const pectoral = [[164, 86], [148, 92], [134, 108, true], [150, 108], [168, 98]];
  const p = buildParts([tail, dorsal, anal, body, pectoral]);
  return {
    ...p,
    eyes: [[194, 62, 10]],
  };
})();

// ---------------------------------------------------------------------------
// Shark: torpedo body, swept-back dorsal fin, crescent tail, toothy smile.
// ---------------------------------------------------------------------------

const shark = (() => {
  // Open mouth cut into the silhouette: the lower jaw drops, and both jaws
  // carry a row of triangular teeth.
  const jaw = (x0, y0, x1, y1, n, toothDy) => {
    const out = [];
    for (let k = 0; k < n; k++) {
      const a = k / n;
      const b = (k + 0.5) / n;
      out.push([x0 + (x1 - x0) * a, y0 + (y1 - y0) * a, true]);
      out.push([x0 + (x1 - x0) * b, y0 + (y1 - y0) * b + toothDy, true]);
    }
    return out;
  };
  const body = [
    [239, 86], [232, 71], [214, 59], [186, 52], [150, 50], [114, 54], [84, 62], [62, 70], [46, 74],
    [46, 82], [64, 88], [90, 96], [124, 104], [164, 108], [196, 111], [218, 111],
    [229, 108, true], // lower jaw tip
    ...jaw(229, 108, 200, 99, 5, -5.5), // lower teeth point up
    [198, 97, true], // corner of the mouth
    ...jaw(200, 96, 234, 91, 6, 5.5), // upper teeth point down
    [235, 91, true],
  ];
  const tail = [
    [56, 72], [44, 54], [28, 30], [10, 6, true], [16, 34], [26, 62], [32, 80, true], [22, 100], [14, 122, true], [34, 104], [54, 86],
  ];
  const dorsal = [[172, 55], [160, 38], [146, 20], [124, 5, true], [128, 26], [126, 42], [118, 58]];
  const dorsal2 = [[82, 66], [76, 56], [66, 49, true], [66, 60], [64, 72]];
  const pectoral = [[192, 100], [176, 118], [156, 136], [132, 147, true], [150, 128], [162, 110], [168, 102]];
  const pelvic = [[106, 98], [98, 110], [84, 119, true], [90, 106], [92, 94]];
  const p = buildParts([tail, dorsal, dorsal2, pectoral, pelvic, body]);
  return {
    ...p,
    eyes: [[204, 72, 6]],
  };
})();

// ---------------------------------------------------------------------------
// Squid: mantle pointing right with diamond fins, a round head with two eyes,
// six arms and two long club tentacles trailing left.
// ---------------------------------------------------------------------------

const squid = (() => {
  const C = 76;
  const mantle = [
    [240, C, true], [230, 66], [210, 56], [180, 50], [150, 48], [126, 50], [112, 56], [108, C],
    [112, 96], [126, 102], [150, 104], [180, 102], [210, 96], [230, 86],
  ];
  const fin = [[176, 58], [184, 34], [194, 12, true], [214, 34], [234, 70]];
  const head = ellipse(96, C, 23, 27);
  const arms = [];
  const armSpecs = [
    // base y, length, wave phase
    [60, 60, 0.0], [66, 68, 1.3], [72, 62, 2.4], [80, 64, 0.7], [86, 70, 1.9], [92, 58, 3.0],
  ];
  for (const [yb, len, ph] of armSpecs) {
    const yEnd = C + (yb - C) * 1.9;
    const center = sample((s) => [84 - len * s, yb + (yEnd - yb) * s + 4 * s * Math.sin(Math.PI * 2 * 1.2 * s + ph)]);
    arms.push(tube(center, 10, 2.2));
  }
  // Two long feeding tentacles.
  for (const [yb, yEnd, ph] of [[70, 50, 0.5], [82, 104, 2.2]]) {
    const len = 78;
    const center = sample((s) => [84 - len * s, yb + (yEnd - yb) * s + 3 * s * Math.sin(Math.PI * 2 * s + ph)]);
    arms.push(tube(center, 5.5, 1.6));
  }
  const p = buildParts([...arms, fin, flipY(fin, C), head, mantle]);
  return {
    ...p,
    eyes: [[100, 61, 7], [100, 91, 7]],
  };
})();

// ---------------------------------------------------------------------------
// Turtle: seen from above, scute pattern on the shell, two eyes, four flippers.
// ---------------------------------------------------------------------------

const turtle = (() => {
  const C = 76;
  // Egg-shaped shell: a bit longer towards the head.
  const shell = Array.from({ length: 16 }, (_, i) => {
    const t = (i / 16) * Math.PI * 2;
    const cos = Math.cos(t);
    return [118 + (cos > 0 ? 76 : 70) * cos, C + 54 * Math.sin(t)];
  });
  const head = ellipse(204, C, 27, 19);
  const front = [[150, 34], [170, 18], [196, 6], [224, 3, true], [208, 16], [186, 32], [166, 46]];
  const rear = [[80, 38], [64, 24], [40, 16, true], [46, 32], [64, 46]];
  const tail = [[54, 68], [40, 71], [32, C, true], [40, 81], [54, 84]];
  const p = buildParts([front, flipY(front, C), rear, flipY(rear, C), tail, head, shell]);

  return {
    ...p,
    eyes: [[214, 66, 4.5], [214, 86, 4.5]],
  };
})();

// ---------------------------------------------------------------------------
// Jellyfish: upright, scalloped bell with a happy face, frilly oral arms and
// thin trailing tentacles.
// ---------------------------------------------------------------------------

const jellyfish = (() => {
  const bell = [[58, 66, true], [60, 40], [80, 16], [120, 6], [160, 16], [180, 40], [182, 66, true]];
  const notches = [182, 157.2, 132.4, 107.6, 82.8, 58];
  for (let i = 0; i < 5; i++) {
    bell.push([(notches[i] + notches[i + 1]) / 2, 77]);
    if (i < 4) bell.push([notches[i + 1], 67, true]);
  }
  const strands = [];
  for (const [x, len, ph, w0, w1] of [
    [104, 74, 0.0, 13, 3],
    [120, 80, 1.6, 15, 3.5],
    [136, 72, 3.0, 13, 3],
  ]) {
    const center = sample((s) => [x + 7 * s * Math.sin(Math.PI * 2 * 1.4 * s + ph), 66 + len * s]);
    strands.push(tube(center, w0, w1));
  }
  for (const [x, len, ph] of [[68, 66, 0.4], [86, 76, 2.0], [154, 78, 1.0], [172, 64, 2.6]]) {
    const center = sample((s) => [x + 5 * s * Math.sin(Math.PI * 2 * 1.1 * s + ph), 66 + len * s]);
    strands.push(tube(center, 5, 2.2));
  }
  const p = buildParts([...strands, bell]);
  return {
    ...p,
    eyes: [],
  };
})();

// ---------------------------------------------------------------------------
// Ray: manta seen from above, wide wings, cephalic fins, long thin tail.
// ---------------------------------------------------------------------------

const ray = (() => {
  const C = 76;
  const body = [
    [228, 66], [214, 56], [194, 48], [170, 34], [150, 16], [130, 3, true], [124, 24], [112, 44], [94, 58], [74, 67], [58, 72],
    [58, 80], [74, 85], [94, 94], [112, 108], [124, 128], [130, 149, true], [150, 136], [170, 118], [194, 104], [214, 96], [228, 86],
  ];
  const horn = [[218, 64], [230, 54], [240, 54, true], [236, 62], [226, 70]];
  const tailLine = sample((s) => [62 - 60 * s, C - 3 * Math.sin(Math.PI * 1.5 * s)]);
  const p = buildParts([horn, flipY(horn, C), tube(tailLine, 6, 1.2), body]);
  return {
    ...p,
    eyes: [[214, 66, 4.5], [214, 86, 4.5]],
  };
})();

// ---------------------------------------------------------------------------
// Seahorse: upright, facing right, crown, belly ridges, curled tail.
// ---------------------------------------------------------------------------

const seahorse = (() => {
  // Head, neck and belly as one outline, starting at the top of the head.
  const body = [
    [112, 4], [122, 6], [131, 11], [137, 17], [152, 19], [166, 19],
    [172, 15, true], [176, 21], [175, 29], [170, 32, true], // trumpet-shaped snout tip
    [156, 29], [142, 31], [136, 37], [131, 44], [133, 52], [141, 62], [147, 76], [147, 90], [141, 102], [130, 110],
    [106, 112], [98, 100], [93, 84], [93, 68], [96, 54], [100, 44], [99, 36], [100, 24], [105, 12],
  ];
  const crown = [[104, 14], [106, 1, true], [112, 8], [117, 0, true], [121, 8], [126, 3, true], [128, 12]];
  const fin = [[96, 56], [86, 53], [78, 61], [76, 72], [80, 84], [95, 88]];
  // Tail curling forward under the belly.
  const tailLine = [
    [118, 104], [116, 116], [115, 126], [117, 135], [122, 141], [130, 144], [137, 142], [141, 136], [139, 129], [133, 126], [128, 129], [128, 134],
  ];
  const p = buildParts([crown, fin, tube(tailLine, 24, 5), body]);
  return {
    ...p,
    eyes: [[124, 21, 5.5]],
  };
})();

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------

// motion.type picks the swimming behaviour in the aquarium:
// tail (side view, tail waves), jet (pulses), paddle (slow glide),
// drift (upright, bobbing, never mirrored), flap (wings beat), hover (upright, slow).
export const SPECIES = [
  {
    id: 'fish',
    name: 'Peixe',
    code: 1,
    ...fish,
    motion: { type: 'tail', speed: 110, size: 0.22, depth: [0.05, 0.95] },
  },
  {
    id: 'shark',
    name: 'Tubarão',
    code: 2,
    ...shark,
    motion: { type: 'tail', speed: 70, size: 0.38, depth: [0.1, 1] },
  },
  {
    id: 'squid',
    name: 'Lula',
    code: 3,
    ...squid,
    motion: { type: 'jet', speed: 130, size: 0.26, depth: [0, 0.9] },
  },
  {
    id: 'turtle',
    name: 'Tartaruga',
    code: 4,
    ...turtle,
    motion: { type: 'paddle', speed: 40, size: 0.28, depth: [0.25, 1] },
  },
  {
    id: 'jellyfish',
    name: 'Água-viva',
    code: 5,
    ...jellyfish,
    motion: { type: 'drift', speed: 22, size: 0.32, depth: [0, 1] },
  },
  {
    id: 'ray',
    name: 'Arraia',
    code: 6,
    ...ray,
    motion: { type: 'flap', speed: 55, size: 0.34, depth: [0.1, 0.95] },
  },
  {
    id: 'seahorse',
    name: 'Cavalo-marinho',
    code: 7,
    ...seahorse,
    motion: { type: 'hover', speed: 18, size: 0.42, depth: [0.4, 1] },
  },
];

export function byId(id) {
  return SPECIES.find((s) => s.id === id) ?? null;
}

export function byCode(code) {
  return SPECIES.find((s) => s.code === code) ?? null;
}
