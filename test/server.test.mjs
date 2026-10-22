import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../server.js';

// A valid 1x1 PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const TINY_PNG_URL = `data:image/png;base64,${TINY_PNG.toString('base64')}`;

function request(port, { method = 'GET', path: urlPath, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const reqHeaders = { ...headers };
    if (data !== undefined) {
      reqHeaders['Content-Type'] ??= 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: reqHeaders }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

const jsonOf = (r) => JSON.parse(r.body.toString('utf8'));

async function postFish(port, species = 'fish', image = TINY_PNG_URL) {
  return request(port, { method: 'POST', path: '/api/fish', body: { species, image } });
}

// Opens /api/events and collects parsed SSE messages.
function openEvents(port) {
  const stream = { events: [], req: null };
  let buf = '';
  stream.req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /^event: (.+)$/m.exec(block);
        const data = /^data: (.+)$/m.exec(block);
        if (ev && data) stream.events.push({ type: ev[1], data: JSON.parse(data[1]) });
      }
    });
  });
  stream.req.on('error', () => {});
  return stream;
}

async function until(fn, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('condition not met in time');
}

describe('sketch aquarium server', () => {
  let dir;
  let server;
  let port;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sketch-aquarium-test-'));
    server = createServer({ dataDir: dir });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('serves the pages and static files', async () => {
    for (const p of ['/', '/capture', '/aquarium', '/templates']) {
      const r = await request(port, { path: p });
      assert.equal(r.status, 200, p);
      assert.match(r.headers['content-type'], /^text\/html/, p);
    }
    const species = await request(port, { path: '/shared/species.js' });
    assert.equal(species.status, 200);
    assert.match(species.headers['content-type'], /^text\/javascript/);
    assert.match(species.body.toString('utf8'), /export const SPECIES/);
  });

  test('lists nothing when empty', async () => {
    const r = await request(port, { path: '/api/fish' });
    assert.equal(r.status, 200);
    assert.deepEqual(jsonOf(r), []);
  });

  let created;

  test('accepts a valid PNG and returns 201 with the record', async () => {
    const r = await postFish(port, 'fish');
    assert.equal(r.status, 201);
    created = jsonOf(r);
    assert.match(created.id, /^[0-9a-f]{12}$/);
    assert.equal(created.species, 'fish');
    assert.ok(!Number.isNaN(Date.parse(created.createdAt)));
  });

  test('lists the created creature', async () => {
    const list = jsonOf(await request(port, { path: '/api/fish' }));
    assert.deepEqual(list.map((c) => c.id), [created.id]);
  });

  test('serves the stored PNG with long cache headers', async () => {
    const r = await request(port, { path: `/fish/${created.id}.png` });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.match(r.headers['cache-control'], /immutable/);
    assert.ok(r.body.equals(TINY_PNG));
  });

  test('rejects an unknown species', async () => {
    const r = await postFish(port, 'octopus');
    assert.equal(r.status, 400);
  });

  test('rejects non-PNG images', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
    const r = await postFish(port, 'fish', `data:image/png;base64,${jpeg.toString('base64')}`);
    assert.equal(r.status, 400);
  });

  test('rejects a value that is not a PNG data URL', async () => {
    const r = await postFish(port, 'fish', 'https://example.com/a.png');
    assert.equal(r.status, 400);
  });

  test('rejects malformed JSON', async () => {
    const r = await request(port, { method: 'POST', path: '/api/fish', body: '{nope' });
    assert.equal(r.status, 400);
  });

  test('rejects an image larger than 3 MB decoded', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 1);
    TINY_PNG.copy(big, 0);
    const r = await postFish(port, 'fish', `data:image/png;base64,${big.toString('base64')}`);
    assert.equal(r.status, 413);
  });

  test('rejects a request body larger than 5 MB', async () => {
    const r = await postFish(port, 'fish', `data:image/png;base64,${'A'.repeat(5.5 * 1024 * 1024)}`);
    assert.equal(r.status, 413);
  });

  test('deletes a creature: 204, then 404, and the image is gone', async () => {
    const del = await request(port, { method: 'DELETE', path: `/api/fish/${created.id}` });
    assert.equal(del.status, 204);
    const list = jsonOf(await request(port, { path: '/api/fish' }));
    assert.equal(list.some((c) => c.id === created.id), false);
    const img = await request(port, { path: `/fish/${created.id}.png` });
    assert.equal(img.status, 404);
    const again = await request(port, { method: 'DELETE', path: `/api/fish/${created.id}` });
    assert.equal(again.status, 404);
  });

  test('rejects malformed ids on delete', async () => {
    const r = await request(port, { method: 'DELETE', path: '/api/fish/..%2F..%2Fetc' });
    assert.equal(r.status, 400);
    const r2 = await request(port, { method: 'DELETE', path: '/api/fish/XYZ' });
    assert.equal(r2.status, 400);
  });

  test('does not serve files outside public/', async () => {
    const r = await request(port, { path: '/..%2F..%2Fpackage.json' });
    assert.ok([403, 404].includes(r.status), `status ${r.status}`);
    assert.notEqual(r.status, 200);
    const r2 = await request(port, { path: '/%2e%2e%2fserver.js' });
    assert.notEqual(r2.status, 200);
  });

  test('keeps at most 60 creatures, dropping the oldest', async () => {
    const ids = [];
    for (let i = 0; i < 61; i++) {
      const r = await postFish(port, 'turtle');
      assert.equal(r.status, 201);
      ids.push(jsonOf(r).id);
    }
    const list = jsonOf(await request(port, { path: '/api/fish' }));
    assert.equal(list.length, 60);
    assert.equal(list.some((c) => c.id === ids[0]), false);
    assert.equal(list[list.length - 1].id, ids[60]);
    const gone = await request(port, { path: `/fish/${ids[0]}.png` });
    assert.equal(gone.status, 404);
  });

  test('streams init, add and remove events over SSE', async () => {
    const stream = openEvents(port);
    try {
      await until(() => stream.events.some((e) => e.type === 'init'));
      const init = stream.events.find((e) => e.type === 'init');
      assert.equal(init.data.length, 60);

      const r = await postFish(port, 'squid');
      const record = jsonOf(r);
      await until(() => stream.events.some((e) => e.type === 'add' && e.data.id === record.id));

      const del = await request(port, { method: 'DELETE', path: `/api/fish/${record.id}` });
      assert.equal(del.status, 204);
      await until(() => stream.events.some((e) => e.type === 'remove' && e.data.id === record.id));
    } finally {
      stream.req.destroy();
    }
  });

  test('returns a JSON 404 for unknown API routes', async () => {
    const r = await request(port, { path: '/api/nada' });
    assert.equal(r.status, 404);
  });
});

test('creatures persist across server restarts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sketch-aquarium-persist-'));
  try {
    const first = createServer({ dataDir: dir });
    await new Promise((resolve) => first.listen(0, '127.0.0.1', resolve));
    const r = await postFish(first.address().port, 'shark');
    const record = jsonOf(r);
    first.closeAllConnections();
    await new Promise((resolve) => first.close(resolve));

    const second = createServer({ dataDir: dir });
    await new Promise((resolve) => second.listen(0, '127.0.0.1', resolve));
    try {
      const list = jsonOf(await request(second.address().port, { path: '/api/fish' }));
      assert.deepEqual(list, [record]);
    } finally {
      second.closeAllConnections();
      await new Promise((resolve) => second.close(resolve));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
