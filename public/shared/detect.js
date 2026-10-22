// Pure image processing for the capture page: finds the printed sheet in a
// phone photo, straightens it and reads which species it is.
// No DOM APIs. Images are {width, height, data: Uint8ClampedArray RGBA}.
// Coordinates are continuous: pixel (i, j) covers [i, i+1) x [j, j+1).

import { PAGE, MARKER, CODE, byCode } from './species.js';

export const PX_PER_MM = 4;

const WORK_SIDE = 800; // long side used for marker search
const PAPER_LEVEL = 235; // flattened brightness of blank paper
const DARK_LEVELS = [110, 150]; // thresholds on flattened brightness
const MAX_CANDIDATES = 12;

const HALF = MARKER.size / 2;
const MARKER_MIN = MARKER.inset + HALF; // 18 mm
const MARKER_MAX_X = PAGE.w - MARKER.inset - HALF; // 279 mm
const MARKER_MAX_Y = PAGE.h - MARKER.inset - HALF; // 192 mm

// Marker centres in page millimetres, clockwise from the top-left.
const MM_CW = [
  [MARKER_MIN, MARKER_MIN],
  [MARKER_MAX_X, MARKER_MIN],
  [MARKER_MAX_X, MARKER_MAX_Y],
  [MARKER_MIN, MARKER_MAX_Y],
];

const MSG_NO_MARKERS =
  'Não encontrei os 4 quadrados pretos da folha. Fotografe a folha inteira, com boa luz e sem sombras fortes.';
const MSG_NO_SHEET_TYPE =
  'Não reconheci o tipo de desenho. Confira se a folha está inteira e tente novamente.';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

// Solves A x = b by Gaussian elimination with partial pivoting.
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('Pontos degenerados.');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// Homography H (3x3, row-major nested arrays) with dst ~ H * src for four point pairs.
export function homography(src4, dst4) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src4[i];
    const [u, v] = dst4[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear(A, b);
  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ];
}

// Applies H to (x, y) and returns [u, v].
export function applyH(H, x, y) {
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  return [
    (H[0][0] * x + H[0][1] * y + H[0][2]) / w,
    (H[1][0] * x + H[1][1] * y + H[1][2]) / w,
  ];
}

// ---------------------------------------------------------------------------
// Raster helpers
// ---------------------------------------------------------------------------

function grayOf(img) {
  const n = img.width * img.height;
  const d = img.data;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    g[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  }
  return g;
}

// Box-averaged grayscale of img, long side reduced to maxSide.
// fx, fy map work coordinates back to img coordinates.
function shrinkGray(img, maxSide) {
  const k = Math.max(img.width, img.height) / maxSide;
  if (k <= 1) return { gray: grayOf(img), w: img.width, h: img.height, fx: 1, fy: 1 };
  const w = Math.max(1, Math.round(img.width / k));
  const h = Math.max(1, Math.round(img.height / k));
  const fx = img.width / w;
  const fy = img.height / h;
  const out = new Float32Array(w * h);
  const d = img.data;
  const W = img.width;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * fy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.min(W, Math.max(x0 + 1, Math.floor((x + 1) * fx)));
      let s = 0;
      let c = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const p = (yy * W + xx) * 4;
          s += 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
          c++;
        }
      }
      out[y * w + x] = s / c;
    }
  }
  return { gray: out, w, h, fx, fy };
}

function bilinearGray(g, w, h, x, y) {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const xa = clamp(x0, 0, w - 1);
  const xb = clamp(x0 + 1, 0, w - 1);
  const ya = clamp(y0, 0, h - 1);
  const yb = clamp(y0 + 1, 0, h - 1);
  return (
    (g[ya * w + xa] * (1 - tx) + g[ya * w + xb] * tx) * (1 - ty) +
    (g[yb * w + xa] * (1 - tx) + g[yb * w + xb] * tx) * ty
  );
}

// Mean over a (2r+1)^2 window, via an integral image.
function localMean(g, w, h, r) {
  const W1 = w + 1;
  const I = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      I[(y + 1) * W1 + x + 1] = g[y * w + x] + I[y * W1 + x + 1] + I[(y + 1) * W1 + x] - I[y * W1 + x];
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
      out[y * w + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

// Removes uneven lighting: brightness relative to the local background.
function flatten(gray, w, h) {
  const bg = localMean(gray, w, h, Math.max(4, Math.round(Math.max(w, h) / 12)));
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = (gray[i] / Math.max(bg[i], 8)) * PAPER_LEVEL;
  return out;
}

// ---------------------------------------------------------------------------
// Marker search
// ---------------------------------------------------------------------------

// Smallest rotated bounding box of a pixel set (pixels given as indices).
function minAreaBox(pix, len, w) {
  let best = null;
  for (let deg = 0; deg < 90; deg += 6) {
    const th = (deg * Math.PI) / 180;
    const c = Math.cos(th);
    const s = Math.sin(th);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (let k = 0; k < len; k++) {
      const p = pix[k];
      const x = (p % w) + 0.5;
      const y = Math.floor(p / w) + 0.5;
      const u = x * c + y * s;
      const v = -x * s + y * c;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const a = u1 - u0 + 1;
    const b = v1 - v0 + 1;
    if (!best || a * b < best.area) best = { area: a * b, a, b };
  }
  return best;
}

// Solid, roughly square dark blobs: candidate markers (and code cells, which
// are filtered later by size).
function markerBlobs(mask, w, h) {
  const n = w * h;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  const out = [];
  for (let s = 0; s < n; s++) {
    if (!mask[s] || seen[s]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    seen[s] = 1;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    let sx = 0;
    let sy = 0;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      const y = (p - x) / w;
      sx += x;
      sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; queue[tail++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; queue[tail++] = p + 1; }
      if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; queue[tail++] = p - w; }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; queue[tail++] = p + w; }
    }
    const area = tail;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (area < 25 || bw < 5 || bh < 5) continue;
    if (minX === 0 || minY === 0 || maxX === w - 1 || maxY === h - 1) continue;
    if (bw / bh > 1.5 || bh / bw > 1.5) continue;
    if (area / (bw * bh) < 0.45) continue; // cheap pre-filter, a rotated square still passes
    const box = minAreaBox(queue, tail, w);
    if (area / box.area < 0.83) continue; // solid square (a disc only reaches ~0.79)
    const ar = Math.min(box.a, box.b) / Math.max(box.a, box.b);
    if (ar < 0.75) continue;
    out.push({ x: sx / area + 0.5, y: sy / area + 0.5, side: Math.sqrt(area) });
  }
  return out;
}

// Orders four points clockwise on screen (y down): TL, TR, BR, BL.
function orderCw(pts) {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  return pts
    .map((p) => [p.x, p.y, Math.atan2(p.y - cy, p.x - cx)])
    .sort((a, b) => a[2] - b[2])
    .map((p) => [p[0], p[1]]);
}

function isConvexCw(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const s = Math.sign(cross);
    if (s === 0) return false;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function polyArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const r = q[(i + 1) % 4];
    a += p[0] * r[1] - r[0] * p[1];
  }
  return Math.abs(a) / 2;
}

// Four candidate blobs forming a convex quadrilateral with the sheet's proportions.
function quadsFromCandidates(cands) {
  const out = [];
  const n = cands.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) {
          const grp = [cands[a], cands[b], cands[c], cands[d]];
          const sides = grp.map((p) => p.side);
          // Code cells are half the size of markers: all four must be similar.
          if (Math.max(...sides) / Math.min(...sides) > 1.8) continue;
          const q = orderCw(grp);
          if (!isConvexCw(q)) continue;
          const e = [0, 1, 2, 3].map((i) => Math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]));
          const long = (e[0] + e[2]) / 2;
          const short = (e[1] + e[3]) / 2;
          const ratio = Math.max(long, short) / Math.min(long, short);
          if (ratio < 1.15 || ratio > 2.1) continue; // page is 261:174 between marker centres
          if (Math.max(e[0], e[2]) / Math.min(e[0], e[2]) > 1.6) continue;
          if (Math.max(e[1], e[3]) / Math.min(e[1], e[3]) > 1.6) continue;
          out.push({ pts: q, area: polyArea(q) });
        }
  return out;
}

// All plausible marker quadrilaterals in work coordinates, largest first.
function findQuads(gray, w, h) {
  const flat = flatten(gray, w, h);
  const quads = [];
  for (const T of DARK_LEVELS) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = flat[i] < T ? 1 : 0;
    const cands = markerBlobs(mask, w, h).sort((p, q) => q.side - p.side).slice(0, MAX_CANDIDATES);
    quadsFromCandidates(cands).forEach((qd) => quads.push(qd));
  }
  quads.sort((p, q) => q.area - p.area);
  return quads.map((qd) => qd.pts);
}

// Marker search on a prepared work grayscale; returns quads in full-image coordinates.
function quadsInImage(img) {
  const { gray, w, h, fx, fy } = shrinkGray(img, WORK_SIDE);
  return findQuads(gray, w, h).map((q) => q.map(([x, y]) => [x * fx, y * fy]));
}

// Public: the four marker centres of the largest sheet found, ordered
// [TL, TR, BL, BR] assuming the sheet is upright, or null.
export function findMarkers(img) {
  const quads = quadsInImage(img);
  if (quads.length === 0) return null;
  const q = quads[0];
  let r = 0;
  for (let i = 1; i < 4; i++) if (q[i][0] + q[i][1] < q[r][0] + q[r][1]) r = i;
  const cw = [0, 1, 2, 3].map((i) => q[(r + i) % 4]);
  return [cw[0], cw[1], cw[3], cw[2]];
}

// ---------------------------------------------------------------------------
// Code reading
// ---------------------------------------------------------------------------

// `at(xMm, yMm)` returns the luminance (0..255) at a point of the sheet.
// Each cell is compared with the paper just above the row, so uneven
// lighting does not matter. Returns the code and how many cells look clean.
function readCells(at) {
  let code = 0;
  let score = 0;
  CODE.xs.forEach((cx, bit) => {
    const paper = (at(cx - 1.5, 186) + at(cx + 1.5, 186) + at(cx, 188)) / 3;
    let inner = 0;
    for (const dx of [-1.5, 0, 1.5]) for (const dy of [-1.5, 0, 1.5]) inner += at(cx + dx, CODE.y + dy);
    inner /= 9;
    // The printed outline sits on the top edge of the cell (y = 192).
    let edge = Infinity;
    for (let t = -2.5; t <= 2.5; t += 0.5) {
      for (const yy of [CODE.y - CODE.size / 2 - 0.4, CODE.y - CODE.size / 2, CODE.y - CODE.size / 2 + 0.4]) {
        const v = at(cx + t, yy);
        if (v < edge) edge = v;
      }
    }
    const filled = inner < 0.5 * paper;
    if (filled) code |= 1 << bit;
    const consistent = filled || inner > 0.75 * paper;
    if (paper > 120 && edge < 0.9 * paper && consistent) score++;
  });
  return { code, score };
}

// Reads the code from a rectified page (as returned by rectify).
export function readCode(page, pxPerMm = PX_PER_MM) {
  const g = grayOf(page);
  const at = (x, y) => bilinearGray(g, page.width, page.height, x * pxPerMm, y * pxPerMm);
  return readCells(at).code;
}

// ---------------------------------------------------------------------------
// Rectification and colour
// ---------------------------------------------------------------------------

// Straightens the sheet. `markers` are the four marker centres in image
// coordinates ordered [TL, TR, BL, BR]. Returns a page image of
// PAGE.w*pxPerMm by PAGE.h*pxPerMm pixels.
export function rectify(img, markers, pxPerMm = PX_PER_MM) {
  const src = [
    [MARKER_MIN, MARKER_MIN],
    [MARKER_MAX_X, MARKER_MIN],
    [MARKER_MIN, MARKER_MAX_Y],
    [MARKER_MAX_X, MARKER_MAX_Y],
  ];
  const H = homography(src, markers);
  const W = Math.round(PAGE.w * pxPerMm);
  const Hh = Math.round(PAGE.h * pxPerMm);
  const data = new Uint8ClampedArray(W * Hh * 4);
  const d = img.data;
  const iw = img.width;
  const ih = img.height;
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const [u, v] = applyH(H, (x + 0.5) / pxPerMm, (y + 0.5) / pxPerMm);
      const fx = u - 0.5;
      const fy = v - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const xa = clamp(x0, 0, iw - 1);
      const xb = clamp(x0 + 1, 0, iw - 1);
      const ya = clamp(y0, 0, ih - 1);
      const yb = clamp(y0 + 1, 0, ih - 1);
      const o = (y * W + x) * 4;
      const p00 = (ya * iw + xa) * 4;
      const p10 = (ya * iw + xb) * 4;
      const p01 = (yb * iw + xa) * 4;
      const p11 = (yb * iw + xb) * 4;
      for (let c = 0; c < 4; c++) {
        const top = d[p00 + c] * (1 - tx) + d[p10 + c] * tx;
        const bot = d[p01 + c] * (1 - tx) + d[p11 + c] * tx;
        data[o + c] = top * (1 - ty) + bot * ty;
      }
    }
  }
  return { width: W, height: Hh, data };
}

// Per-channel gain so the paper (90th percentile) becomes near white.
export function whiteBalance(img) {
  const d = img.data;
  const n = img.width * img.height;
  const gains = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[d[i * 4 + c]]++;
    const target = n * 0.9;
    let acc = 0;
    let p90 = 255;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= target) {
        p90 = v;
        break;
      }
    }
    gains[c] = clamp(245 / Math.max(p90, 1), 0.8, 2.5);
  }
  const out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    out[p] = Math.min(255, d[p] * gains[0]);
    out[p + 1] = Math.min(255, d[p + 1] * gains[1]);
    out[p + 2] = Math.min(255, d[p + 2] * gains[2]);
    out[p + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

// Reads a photo of a sheet. Returns {species, code, page} where species is
// the species object and page is the rectified sheet (PX_PER_MM pixels per mm).
// Throws an Error with a user-facing pt-BR message when it cannot.
export function processPhoto(img) {
  const wb = whiteBalance(img);
  const quads = quadsInImage(wb);
  if (quads.length === 0) throw new Error(MSG_NO_MARKERS);

  const gray = grayOf(wb);
  const gw = wb.width;
  const gh = wb.height;

  // The sheet may be rotated by 0, 90, 180 or 270 degrees: each cyclic
  // starting corner is a candidate orientation. Keep the one whose code cells
  // read as a valid code with clean outlines.
  let best = null;
  for (const q of quads) {
    for (let r = 0; r < 4; r++) {
      const cw = [0, 1, 2, 3].map((i) => q[(r + i) % 4]);
      const H = homography(MM_CW, cw);
      const at = (x, y) => {
        const [u, v] = applyH(H, x, y);
        return bilinearGray(gray, gw, gh, u, v);
      };
      const { code, score } = readCells(at);
      if (!byCode(code) || score < 2) continue;
      if (!best || score > best.score) best = { code, score, cw };
    }
  }
  if (!best) throw new Error(MSG_NO_SHEET_TYPE);

  const [tl, tr, br, bl] = best.cw;
  const page = rectify(wb, [tl, tr, bl, br], PX_PER_MM);
  return { species: byCode(best.code), code: best.code, page };
}
