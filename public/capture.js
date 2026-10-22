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

  // Keep only the inside of the species outline. Outline coordinates are in
  // box millimetres, so scale them to the crop's pixels.
  ctx.save();
  ctx.setTransform(PX_PER_MM, 0, 0, PX_PER_MM, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fill(new Path2D(species.outline));
  ctx.restore();
  return out;
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
