import { PAGE, MARKER, CODE, BOX, SPECIES } from '/shared/species.js';

const INSTRUCTION = 'Pinte o desenho, depois fotografe a folha inteira';
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

function sheetSvg(sp) {
  const body = sp.parts
    .map((d) => `<path d="${d}" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>`)
    .join('');
  return `<svg viewBox="0 0 ${PAGE.w} ${PAGE.h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Folha para colorir: ${sp.name}">
  <rect width="${PAGE.w}" height="${PAGE.h}" fill="#fff"/>
  ${markers()}
  ${codeCells(sp.code)}
  <text x="${PAGE.w / 2}" y="19" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="5.5" fill="#000">${INSTRUCTION}</text>
  <text x="30" y="206" font-family="Arial, Helvetica, sans-serif" font-size="4" fill="#000">${sp.name}</text>
  <g transform="translate(${BOX.x} ${BOX.y})">
    ${body}
    <path d="${sp.details}" fill="none" stroke="#9a9a9a" stroke-width="0.6" stroke-dasharray="2 1.5" stroke-linecap="round"/>
  </g>
</svg>`;
}

document.getElementById('sheets').innerHTML = SPECIES.map(
  (sp) => `<section class="sheet">${sheetSvg(sp)}</section>`,
).join('');

document.getElementById('print').addEventListener('click', () => window.print());
