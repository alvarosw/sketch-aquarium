import { PAGE, MARKER, CODE, BOX, SPECIES } from '/shared/species.js';

const INSTRUCTION = 'Desenhe os olhos e pinte o animal.';
const HINT = 'Fotografe a folha inteira, com os 4 quadrados.';
const r2 = (v) => Math.round(v * 100) / 100;

function markers() {
  const { size, inset } = MARKER;
  const right = PAGE.w - inset - size;
  const bottom = PAGE.h - inset - size;
  return [
    [inset, inset],
    [right, inset],
    [inset, bottom],
    [right, bottom],
  ]
    .map(([x, y]) => `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="#000"/>`)
    .join('');
}

// Every cell has a thin outline; filled black cells are bit 1.
function codeCells(code) {
  return CODE.xs
    .map((cx, bit) => {
      const on = (code >> bit) & 1;
      return `<rect x="${r2(cx - CODE.size / 2)}" y="${r2(CODE.y - CODE.size / 2)}" width="${CODE.size}" height="${CODE.size}" fill="${on ? '#000' : 'none'}" stroke="#000" stroke-width="0.3"/>`;
    })
    .join('');
}

// Eyes are only marked with a dashed circle: the child draws them however
// they like, and the aquarium makes them blink.
function eyes(list) {
  return list
    .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="#000" stroke-width="0.5" stroke-dasharray="2 1.5"/>`)
    .join('');
}

// Header text stays at the left and right of the top margin: the middle is
// kept empty so a sheet photographed upside down never shows text where the
// code cells would be.
function sheetSvg(sp) {
  // Only the outer silhouette, dashed: each part is stroked 1.0 mm wide, then
  // the union is filled white, which hides the inner half of each stroke, so
  // the visible dashed line is 0.5 mm, the same as the eye circles, and no
  // line inside the animal shows.
  const dash = sp.parts
    .map((d) => `<path d="${d}" fill="none" stroke="#000" stroke-width="1" stroke-dasharray="2 1.5"/>`)
    .join('');
  const font = 'font-family="Arial, Helvetica, sans-serif"';
  return `<svg viewBox="0 0 ${PAGE.w} ${PAGE.h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Folha para colorir: ${sp.name}">
  <rect width="${PAGE.w}" height="${PAGE.h}" fill="#fff"/>
  ${markers()}
  ${codeCells(sp.code)}
  <text x="32" y="22" ${font} font-size="8" font-weight="bold" fill="#000">${sp.name}</text>
  <text x="${PAGE.w - 32}" y="17" text-anchor="end" ${font} font-size="4" fill="#000">${INSTRUCTION}</text>
  <text x="${PAGE.w - 32}" y="22.5" text-anchor="end" ${font} font-size="3.4" fill="#555">${HINT}</text>
  <g transform="translate(${BOX.x} ${BOX.y})" stroke-linecap="round" stroke-linejoin="round">
    ${dash}
    <path d="${sp.outline}" fill="#fff"/>
    ${eyes(sp.eyes)}
  </g>
</svg>`;
}

document.getElementById('sheets').innerHTML = SPECIES.map(
  (sp) => `<section class="sheet">${sheetSvg(sp)}</section>`,
).join('');

document.getElementById('print').addEventListener('click', () => window.print());
