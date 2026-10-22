// Captura: photo -> detected sheet -> cropped creature -> server, plus the
// list of creatures in the aquarium (live via SSE, with delete).
import { processPhoto, PX_PER_MM } from '/shared/detect.js';
import { BOX, byId } from '/shared/species.js';

const MAX_SIDE = 2000;
const CROP_W = Math.round(BOX.w * PX_PER_MM);
const CROP_H = Math.round(BOX.h * PX_PER_MM);

const $ = (id) => document.getElementById(id);
const input = $('photo');
const views = {
  busy: $('view-busy'),
  result: $('view-result'),
  error: $('view-error'),
};
const preview = $('preview');
const previewCtx = preview.getContext('2d');

let current = null; // {species, canvas}

function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  $('take-label').hidden = name === 'busy';
}

function showError(message) {
  $('error-message').textContent = message;
  show('error');
}

// ---------------------------------------------------------------------------
// Photo -> ImageData
// ---------------------------------------------------------------------------

async function decodePhoto(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Older browsers: fall back to an <img> element.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

async function loadImageData(file) {
  const source = await decodePhoto(file);
  const srcW = source.width;
  const srcH = source.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  if (typeof source.close === 'function') source.close();
  return ctx.getImageData(0, 0, w, h);
}

// ---------------------------------------------------------------------------
// Sheet -> creature cut-out (transparent outside the printed outline)
// ---------------------------------------------------------------------------

function cropCreature(page, species) {
  const pageCanvas = document.createElement('canvas');
  pageCanvas.width = page.width;
  pageCanvas.height = page.height;
  pageCanvas.getContext('2d').putImageData(new ImageData(page.data, page.width, page.height), 0, 0);

  const out = document.createElement('canvas');
  out.width = CROP_W;
  out.height = CROP_H;
  const ctx = out.getContext('2d');
  ctx.drawImage(pageCanvas, BOX.x * PX_PER_MM, BOX.y * PX_PER_MM, CROP_W, CROP_H, 0, 0, CROP_W, CROP_H);

  // Keep the inside of the species outline. The photo can be off by 1-2 mm, so
  // a thin tip just outside the outline is kept too, but only where it is
  // clearly coloured: paper and the printed dashed line stay transparent.
  const inside = outlineMask(species.outline, false);
  const near = outlineMask(species.outline, true);
  const img = ctx.getImageData(0, 0, CROP_W, CROP_H);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    if (inside.data[i + 3] > 0) {
      px[i + 3] = (px[i + 3] * inside.data[i + 3]) / 255;
    } else if (near.data[i + 3] > 127 && isColoured(px[i], px[i + 1], px[i + 2])) {
      px[i + 3] = 255;
    } else {
      px[i + 3] = 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

// Alpha mask of the outline in crop pixels. With `band`, the outline is also
// stroked 2 mm to each side, so the mask reaches 2 mm past the printed line.
// Outline coordinates are in box millimetres, so scale them to the crop.
function outlineMask(outline, band) {
  const c = document.createElement('canvas');
  c.width = CROP_W;
  c.height = CROP_H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.setTransform(PX_PER_MM, 0, 0, PX_PER_MM, 0, 0);
  g.fillStyle = '#000';
  g.fill(new Path2D(outline));
  if (band) {
    g.lineWidth = 4;
    g.lineJoin = 'round';
    g.stroke(new Path2D(outline));
  }
  return g.getImageData(0, 0, CROP_W, CROP_H);
}

// Clearly coloured: not paper white and not gray or black ink.
function isColoured(r, g, b) {
  const hi = Math.max(r, g, b);
  return hi >= 110 && hi - Math.min(r, g, b) >= 60;
}

function drawPreview(canvas) {
  previewCtx.clearRect(0, 0, preview.width, preview.height);
  previewCtx.drawImage(canvas, 0, 0);
}

// ---------------------------------------------------------------------------
// Photo handling
// ---------------------------------------------------------------------------

async function onPhoto(file) {
  show('busy');
  // Let the "searching" message paint before the heavy work starts.
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    const data = await loadImageData(file);
    const { species, page } = processPhoto(data);
    current = { species, canvas: cropCreature(page, species) };
    drawPreview(current.canvas);
    $('species-name').textContent = species.name;
    $('sent').hidden = true;
    $('send').disabled = false;
    $('send').textContent = 'Enviar para o aquário';
    show('result');
  } catch (err) {
    console.error(err);
    showError(err?.message || 'Não consegui ler a foto. Tente de novo.');
  }
}

input.addEventListener('change', () => {
  const file = input.files?.[0];
  input.value = '';
  if (file) onPhoto(file);
});

function startCapture() {
  input.click();
}

$('again').addEventListener('click', () => {
  current = null;
  startCapture();
});

$('retry').addEventListener('click', () => {
  current = null;
  show('idle');
  startCapture();
});

$('send').addEventListener('click', async () => {
  if (!current) return;
  const button = $('send');
  button.disabled = true;
  button.textContent = 'Enviando…';
  try {
    const res = await fetch('/api/fish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        species: current.species.id,
        image: current.canvas.toDataURL('image/png'),
      }),
    });
    if (res.status !== 201) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Não consegui enviar. Tente de novo.');
    }
    current = null;
    const sent = $('sent');
    sent.textContent = 'Enviado! Ele já está nadando no aquário.';
    sent.hidden = false;
    button.textContent = 'Enviado';
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Enviar para o aquário';
    showError(err.message);
  }
});

// ---------------------------------------------------------------------------
// Creatures in the aquarium
// ---------------------------------------------------------------------------

const creatures = new Map(); // id -> {id, species, createdAt}

function renderList() {
  const list = $('list');
  list.replaceChildren();
  for (const c of creatures.values()) {
    const item = document.createElement('li');
    item.className = 'fish-card';
    item.dataset.id = c.id;

    const img = document.createElement('img');
    img.src = `/fish/${c.id}.png`;
    img.loading = 'lazy';
    img.alt = byId(c.species)?.name ?? 'Criatura';

    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '🗑';
    del.title = 'Apagar';
    del.setAttribute('aria-label', `Apagar ${img.alt}`);
    del.addEventListener('click', () => removeCreature(c.id, del));

    item.append(img, del);
    list.append(item);
  }
  $('empty').hidden = creatures.size > 0;
}

async function removeCreature(id, button) {
  if (!confirm('Apagar este desenho do aquário?')) return;
  button.disabled = true;
  try {
    const res = await fetch(`/api/fish/${id}`, { method: 'DELETE' });
    if (res.status === 204 || res.status === 404) {
      creatures.delete(id);
      renderList();
    } else {
      throw new Error();
    }
  } catch {
    button.disabled = false;
    alert('Não consegui apagar. Tente de novo.');
  }
}

async function loadList() {
  try {
    const res = await fetch('/api/fish', { cache: 'no-store' });
    if (!res.ok) return;
    creatures.clear();
    for (const c of await res.json()) creatures.set(c.id, c);
    renderList();
  } catch {
    // The live stream below will fill the list when it connects.
  }
}

function connectLive() {
  if (typeof EventSource === 'undefined') return;
  const es = new EventSource('/api/events');
  es.addEventListener('init', (e) => {
    creatures.clear();
    for (const c of JSON.parse(e.data)) creatures.set(c.id, c);
    renderList();
  });
  es.addEventListener('add', (e) => {
    const c = JSON.parse(e.data);
    creatures.set(c.id, c);
    renderList();
  });
  es.addEventListener('remove', (e) => {
    const { id } = JSON.parse(e.data);
    creatures.delete(id);
    renderList();
  });
}

show('idle');
loadList();
connectLive();
