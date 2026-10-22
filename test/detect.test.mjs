import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE, MARKER, CODE, BOX } from '../public/shared/species.js';
import { homography, applyH, findMarkers, processPhoto, readCode, PX_PER_MM } from '../public/shared/detect.js';

// ---------------------------------------------------------------------------
// Synthetic sheets and photos (built in memory)
// ---------------------------------------------------------------------------

const PPM = 4; // resolution of the synthetic master sheet

// Renders a flat sheet: white paper, 4 markers, 3 code cells, and optional
// coloured rectangles given in page millimetres.
function renderSheet({ code, rects = [] }) {
  const W = PAGE.w * PPM;
  const H = PAGE.h * PPM;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const set = (x, y, rgb) => {
    const p = (y * W + x) * 4;
    data[p] = rgb[0];
    data[p + 1] = rgb[1];
    data[p + 2] = rgb[2];
  };
  const forEachMm = (fn) => {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) fn(x, y, (x + 0.5) / PPM, (y + 0.5) / PPM);
  };
  const { size, inset } = MARKER;
  const corners = [
    [inset, inset],
    [PAGE.w - inset - size, inset],
    [inset, PAGE.h - inset - size],
    [PAGE.w - inset - size, PAGE.h - inset - size],
  ];
  const cellHalf = CODE.size / 2;
  forEachMm((x, y, mx, my) => {
    for (const [cx, cy] of corners) {
      if (mx >= cx && mx <= cx + size && my >= cy && my <= cy + size) set(x, y, [0, 0, 0]);
    }
    CODE.xs.forEach((cx, bit) => {
      const dx = Math.abs(mx - cx);
      const dy = Math.abs(my - CODE.y);
      if (dx <= cellHalf && dy <= cellHalf) {
        const onBit = (code >> bit) & 1;
        if (onBit || dx >= cellHalf - 0.15 || dy >= cellHalf - 0.15) set(x, y, [0, 0, 0]);
      }
    });
    for (const r of rects) {
      if (mx >= r.x0 && mx <= r.x1 && my >= r.y0 && my <= r.y1) set(x, y, r.rgb);
    }
  });
  return { width: W, height: H, data };
}

// Places a sheet in a photo: rotation (deg), scale (px/mm), perspective
// offsets for the four page corners (px), lighting function, background.
function renderPhoto(sheet, { angle = 0, upsideDown = false, persp = [[0, 0], [0, 0], [0, 0], [0, 0]], scale = 2.6, light = () => 1, bg = 120 } = {}) {
  const W = 1200;
  const H = 900;
  const pageCorners = [
    [0, 0],
    [PAGE.w, 0],
    [PAGE.w, PAGE.h],
    [0, PAGE.h],
  ];
  const theta = ((angle + (upsideDown ? 180 : 0)) * Math.PI) / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const quad = pageCorners.map(([x, y], i) => {
    const dx = (x - PAGE.w / 2) * scale;
    const dy = (y - PAGE.h / 2) * scale;
    return [600 + dx * c - dy * s + persp[i][0], 450 + dx * s + dy * c + persp[i][1]];
  });
  // Photo pixel -> page millimetres.
  const toMm = homography(quad, pageCorners);
  const data = new Uint8ClampedArray(W * H * 4);
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [mx, my] = applyH(toMm, x + 0.5, y + 0.5);
      const inside = mx >= 0 && mx < PAGE.w && my >= 0 && my < PAGE.h;
      const o = (y * W + x) * 4;
      const k = light(x, y) * 0.9;
      const noise = rnd() * 6;
      if (inside) {
        const sx = Math.min(sheet.width - 1, Math.floor(mx * PPM));
        const sy = Math.min(sheet.height - 1, Math.floor(my * PPM));
        const p = (sy * sheet.width + sx) * 4;
        data[o] = sheet.data[p] * k + noise;
        data[o + 1] = sheet.data[p + 1] * k + noise;
        data[o + 2] = sheet.data[p + 2] * k + noise;
      } else {
        data[o] = bg * k + noise;
        data[o + 1] = bg * k + noise;
        data[o + 2] = bg * k + noise;
      }
      data[o + 3] = 255;
    }
  }
  return { photo: { width: W, height: H, data }, quad, toMm };
}

// Expected image position of a page point, from the rendering geometry.
function imageOf(quad, pageCorners, mm) {
  return applyH(homography(pageCorners, quad), mm[0], mm[1]);
}

const PAGE_CORNERS = [
  [0, 0],
  [PAGE.w, 0],
  [PAGE.w, PAGE.h],
  [0, PAGE.h],
];
const MARKER_CENTRES_MM = [
  [18, 18],
  [279, 18],
  [18, 192],
  [279, 192],
];

const CENTRE = [BOX.x + BOX.w / 2, BOX.y + BOX.h / 2];
const SQUID_BLOB = [{ x0: CENTRE[0] - 30, x1: CENTRE[0] + 30, y0: CENTRE[1] - 20, y1: CENTRE[1] + 20, rgb: [200, 40, 40] }];

function pixelAt(img, x, y) {
  const p = (Math.round(y) * img.width + Math.round(x)) * 4;
  return [img.data[p], img.data[p + 1], img.data[p + 2]];
}

function assertNear(actual, expected, tol, msg) {
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= tol, `${msg}: got ${actual} expected ~${expected}`);
  }
}

function assertCentreColour(page, rgb, tol = 45) {
  // Page centre in mm is (148.5, 105): the coloured block sits there.
  const x = Math.round(148.5 * PX_PER_MM);
  const y = Math.round(105 * PX_PER_MM);
  assert.equal(page.width, PAGE.w * PX_PER_MM);
  assert.equal(page.height, PAGE.h * PX_PER_MM);
  assertNear(pixelAt(page, x, y), rgb, tol, 'colour at page centre');
}

function checkCase(name, { code, expectedSpecies, sheetOpts, photoOpts, blobs = SQUID_BLOB, rgb = [200, 40, 40] }) {
  test(name, () => {
    const sheet = renderSheet({ code, rects: blobs });
    const { photo, quad } = renderPhoto(sheet, photoOpts);
    const result = processPhoto(photo);
    assert.equal(result.species.id, expectedSpecies);
    assert.equal(result.code, code);
    assertCentreColour(result.page, rgb);
    // The marker centres must land where the geometry says they are.
    const markers = findMarkers(photo);
    assert.ok(markers, 'markers found');
    const truth = MARKER_CENTRES_MM.map((mm) => imageOf(quad, PAGE_CORNERS, mm));
    // findMarkers returns [TL, TR, BL, BR] for an upright guess; the sheet may
    // be upside down, so compare as a set.
    for (const t of truth) {
      const d = Math.min(...markers.map((m) => Math.hypot(m[0] - t[0], m[1] - t[1])));
      assert.ok(d < 4, `marker off by ${d.toFixed(1)} px`);
    }
  }, { timeout: 20000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('geometry helpers', () => {
  test('homography maps the four points exactly and round-trips', () => {
    const src = [
      [0, 0],
      [100, 0],
      [100, 50],
      [0, 50],
    ];
    const dst = [
      [10, 12],
      [200, 30],
      [180, 140],
      [-5, 120],
    ];
    const H = homography(src, dst);
    src.forEach(([x, y], i) => {
      const [u, v] = applyH(H, x, y);
      assert.ok(Math.abs(u - dst[i][0]) < 1e-6 && Math.abs(v - dst[i][1]) < 1e-6);
    });
    const back = homography(dst, src);
    const [u, v] = applyH(back, ...applyH(H, 37, 21));
    assert.ok(Math.abs(u - 37) < 1e-6 && Math.abs(v - 21) < 1e-6);
  });
});

describe('processPhoto', () => {
  checkCase('flat sheet, squid', {
    code: 3,
    expectedSpecies: 'squid',
    photoOpts: { scale: 2.6 },
  });

  checkCase('perspective (uneven corner distances)', {
    code: 1,
    expectedSpecies: 'fish',
    photoOpts: { persp: [[-25, 10], [30, -20], [20, 25], [-15, -10]] },
    blobs: [{ x0: CENTRE[0] - 25, x1: CENTRE[0] + 25, y0: CENTRE[1] - 25, y1: CENTRE[1] + 25, rgb: [30, 120, 220] }],
    rgb: [30, 120, 220],
  });

  checkCase('rotated about 20 degrees', {
    code: 2,
    expectedSpecies: 'shark',
    photoOpts: { angle: 20 },
  });

  checkCase('upside down (180 degrees) with a tilt', {
    code: 4,
    expectedSpecies: 'turtle',
    photoOpts: { upsideDown: true, angle: 6 },
    blobs: [{ x0: CENTRE[0] - 30, x1: CENTRE[0] + 30, y0: CENTRE[1] - 20, y1: CENTRE[1] + 20, rgb: [60, 170, 80] }],
    rgb: [60, 170, 80],
  });

  checkCase('strong lighting gradient and darker photo', {
    code: 3,
    expectedSpecies: 'squid',
    photoOpts: { light: (x) => 0.35 + 0.65 * (x / 1200) },
  });

  checkCase('large dark coloured blob inside the box is not a marker', {
    code: 1,
    expectedSpecies: 'fish',
    photoOpts: {},
    blobs: [
      { x0: 40, x1: 90, y0: 60, y1: 110, rgb: [15, 25, 60] }, // dark blue 50x50 mm block, marker-like
      { x0: CENTRE[0] - 15, x1: CENTRE[0] + 15, y0: CENTRE[1] - 15, y1: CENTRE[1] + 15, rgb: [200, 40, 40] },
    ],
    rgb: [200, 40, 40],
  });

  test('a marker-sized dark square inside the box does not break detection', () => {
    const blobs = [
      { x0: CENTRE[0] - 8, x1: CENTRE[0] + 8, y0: CENTRE[1] - 8, y1: CENTRE[1] + 8, rgb: [0, 0, 0] },
      { x0: CENTRE[0] + 40, x1: CENTRE[0] + 60, y0: CENTRE[1] - 10, y1: CENTRE[1] + 10, rgb: [200, 40, 40] },
    ];
    const sheet = renderSheet({ code: 2, rects: blobs });
    const { photo } = renderPhoto(sheet, { angle: -12 });
    const result = processPhoto(photo);
    assert.equal(result.species.id, 'shark');
  });

  test('readCode reads the code cells of a rectified page', () => {
    const sheet = renderSheet({ code: 4 });
    const { photo } = renderPhoto(sheet, { angle: 3 });
    const { page } = processPhoto(photo);
    assert.equal(readCode(page), 4);
  });

  test('a photo without a sheet is rejected with a Portuguese message', () => {
    const data = new Uint8ClampedArray(640 * 480 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (i * 7) & 255;
      data[i + 1] = (i * 3) & 255;
      data[i + 2] = (i * 11) & 255;
      data[i + 3] = 255;
    }
    assert.throws(() => processPhoto({ width: 640, height: 480, data }), /Não/);
  });
});
