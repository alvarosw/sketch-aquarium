// Sketch Aquarium HTTP server. Uses only node:* modules.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SPECIES } from './public/shared/species.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEFAULT_DATA_DIR = path.join(ROOT, 'data');

const MAX_CREATURES = 60;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const PING_MS = 25000;

const SPECIES_IDS = new Set(SPECIES.map((s) => s.id));
const ID_RE = /^[0-9a-f]{12}$/;
const DATA_URL_RE = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Base64 text length for a decoded image at the size limit (plus slack).
const MAX_BASE64_LENGTH = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4;

const PAGES = {
  '/': 'index.html',
  '/capture': 'capture.html',
  '/aquarium': 'aquarium.html',
  '/templates': 'templates.html',
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// Reads the request body up to `limit` bytes. Over the limit it rejects with 413
// and keeps draining the request so the client still receives the response.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > limit) {
        tooBig = true;
        reject(new HttpError(413, 'Requisição grande demais.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!tooBig) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function newId(existing) {
  for (;;) {
    const id = crypto.randomBytes(6).toString('hex');
    if (!existing.has(id)) return id;
  }
}

function loadCreatures(jsonPath) {
  try {
    const list = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Não consegui ler ${jsonPath}; começando vazio.`);
    return [];
  }
}

async function writeFileAtomic(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

const CONTENT_TYPE_OF = (file) => CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

export function createServer({ dataDir = DEFAULT_DATA_DIR } = {}) {
  const fishDir = path.join(dataDir, 'fish');
  const jsonPath = path.join(dataDir, 'fish.json');
  fs.mkdirSync(fishDir, { recursive: true });

  let creatures = loadCreatures(jsonPath);
  const clients = new Set();

  // Writes to fish.json are serialised so the last snapshot always wins.
  let writeChain = Promise.resolve();
  function persist() {
    const snapshot = JSON.stringify(creatures, null, 2);
    const job = writeChain.then(() => writeFileAtomic(jsonPath, snapshot));
    writeChain = job.catch(() => {});
    return job;
  }

  function broadcast(event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(message);
  }

  const pngPathOf = (id) => path.join(fishDir, `${id}.png`);

  async function removePng(id) {
    await fsp.rm(pngPathOf(id), { force: true });
  }

  async function createCreature(req, res) {
    let data;
    try {
      data = JSON.parse(await readBody(req, MAX_BODY_BYTES));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'JSON inválido.');
    }
    if (!data || typeof data !== 'object') throw new HttpError(400, 'Corpo inválido.');

    const { species, image } = data;
    if (!SPECIES_IDS.has(species)) throw new HttpError(400, 'Espécie desconhecida.');

    const match = typeof image === 'string' ? DATA_URL_RE.exec(image) : null;
    if (!match) throw new HttpError(400, 'A imagem deve ser um PNG em data URL.');
    if (match[1].length > MAX_BASE64_LENGTH) throw new HttpError(413, 'Imagem grande demais.');

    const buffer = Buffer.from(match[1], 'base64');
    if (buffer.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'Imagem grande demais.');
    if (buffer.length < PNG_MAGIC.length || !buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
      throw new HttpError(400, 'Arquivo não é PNG.');
    }

    const id = newId(new Set(creatures.map((c) => c.id)));
    await fsp.writeFile(pngPathOf(id), buffer);
    const record = { id, species, createdAt: new Date().toISOString() };
    creatures.push(record);

    const removed = [];
    while (creatures.length > MAX_CREATURES) removed.push(creatures.shift());
    for (const old of removed) {
      await removePng(old.id);
      broadcast('remove', { id: old.id });
    }

    await persist();
    broadcast('add', record);
    sendJson(res, 201, record);
  }

  async function deleteCreature(res, id) {
    const index = creatures.findIndex((c) => c.id === id);
    if (index < 0) throw new HttpError(404, 'Criatura não encontrada.');
    creatures.splice(index, 1);
    broadcast('remove', { id });
    await persist();
    await removePng(id);
    res.writeHead(204);
    res.end();
  }

  async function servePng(res, id) {
    let buffer;
    try {
      buffer = await fsp.readFile(pngPathOf(id));
    } catch (err) {
      if (err.code === 'ENOENT') throw new HttpError(404, 'Imagem não encontrada.');
      throw err;
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.end(buffer);
  }

  function openEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: init\ndata: ${JSON.stringify(creatures)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    ping.unref();
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  }

  async function serveStatic(res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Caminho inválido.');
    }
    const file = path.resolve(PUBLIC_DIR, `.${rel}`);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Proibido.');

    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      throw new HttpError(404, 'Não encontrado.');
    }
    if (!stat.isFile()) throw new HttpError(404, 'Não encontrado.');

    res.writeHead(200, {
      'Content-Type': CONTENT_TYPE_OF(file),
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  }

  async function route(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    const method = req.method;

    if (pathname === '/api/events') {
      if (method !== 'GET') throw new HttpError(405, 'Método não permitido.');
      return openEvents(req, res);
    }

    if (pathname === '/api/fish') {
      if (method === 'GET') return sendJson(res, 200, creatures);
      if (method === 'POST') return createCreature(req, res);
      throw new HttpError(405, 'Método não permitido.');
    }

    const apiMatch = /^\/api\/fish\/([^/]+)$/.exec(pathname);
    if (apiMatch) {
      if (method !== 'DELETE') throw new HttpError(405, 'Método não permitido.');
      if (!ID_RE.test(apiMatch[1])) throw new HttpError(400, 'Identificador inválido.');
      return deleteCreature(res, apiMatch[1]);
    }

    const imageMatch = /^\/fish\/([^/]+)\.png$/.exec(pathname);
    if (imageMatch) {
      if (method !== 'GET') throw new HttpError(405, 'Método não permitido.');
      if (!ID_RE.test(imageMatch[1])) throw new HttpError(404, 'Não encontrado.');
      return servePng(res, imageMatch[1]);
    }

    if (method !== 'GET') throw new HttpError(405, 'Método não permitido.');
    if (Object.hasOwn(PAGES, pathname)) {
      return serveStatic(res, `/${PAGES[pathname]}`);
    }
    return serveStatic(res, pathname);
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        if (err.status === 413) res.setHeader('Connection', 'close');
        if (err.status === 413 && !req.readableEnded) req.resume();
        if (err.status >= 500) console.error(err);
        if (req.url.startsWith('/api/')) {
          sendJson(res, err.status, { error: err.message });
        } else {
          sendText(res, err.status, err.message);
        }
        return;
      }
      console.error(err);
      sendJson(res, 500, { error: 'Erro interno.' });
    });
  });

  return server;
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) {
      const ipv4 = addr.family === 'IPv4' || addr.family === 4;
      if (ipv4 && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 8000;
  const server = createServer();
  server.listen(port, () => {
    console.log(`Aquário de Desenhos rodando na porta ${port}.`);
    console.log(`  Neste computador: http://localhost:${port}/`);
    for (const ip of lanAddresses()) {
      console.log(`  Captura (celular): http://${ip}:${port}/capture`);
      console.log(`  Aquário (tela):    http://${ip}:${port}/aquarium`);
    }
  });
}
