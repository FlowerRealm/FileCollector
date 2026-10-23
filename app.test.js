import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { cleanPath, createApp } from './app.js';

let server, base, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-'));
  server = createApp({ dataDir, maxFileMB: 1 }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// A client is just a cookie jar.
function client() {
  let cookie = '';
  return async (url, opts = {}) => {
    const r = await fetch(base + url, { ...opts, headers: { ...opts.headers, cookie } });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return r;
  };
}

const json = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function form(name, files) {
  const fd = new FormData();
  fd.append('name', name);
  for (const [p, content] of Object.entries(files)) {
    fd.append('paths', p);
    fd.append('files', new Blob([content]), path.basename(p));
  }
  return { method: 'POST', body: fd };
}

test('cleanPath rejects anything that could escape', () => {
  assert.equal(cleanPath('a/b.txt'), 'a/b.txt');
  for (const bad of ['', '/a', 'a//b', '../a', 'a/../b', 'a/./b', 'a\\b', 'a\0b', 5, undefined]) {
    assert.equal(cleanPath(bad), null, String(bad));
  }
});

test('submit overwrites; owner sees only the latest per user', async () => {
  const owner = client();
  const alice = client();
  const bob = client();

  const { code } = await (await owner('/api/collections', json({ title: 'hw' }))).json();

  assert.equal((await alice(`/api/collections/${code}`)).status, 200);
  assert.equal((await alice(`/api/collections/${code}/submit`, form('Alice', { 'a.txt': 'v1', 'dir/b.txt': 'b' }))).status, 200);
  assert.equal((await alice(`/api/collections/${code}/submit`, form('Alice', { 'c.txt': 'v2' }))).status, 200);
  assert.equal((await bob(`/api/collections/${code}/submit`, form('Bob', { 'x/y/z.txt': 'zzz' }))).status, 200);

  const mine = await (await alice(`/api/collections/${code}`)).json();
  assert.deepEqual(mine.mine.files.map((f) => f.path), ['c.txt']);
  assert.equal(mine.isOwner, false);

  const subs = await (await owner(`/api/collections/${code}/submissions`)).json();
  assert.equal(subs.length, 2);
  const a = subs.find((s) => s.name === 'Alice');
  assert.deepEqual(a.files.map((f) => f.path), ['c.txt']);
  assert.equal(Object.keys(a).sort().join(), 'createdAt,files,name,sid'); // no uid leak

  // old files are gone from disk
  const onDisk = fs.readdirSync(path.join(dataDir, 'files', code));
  assert.equal(onDisk.length, 2);

  const dl = await owner(`/api/collections/${code}/submissions/${a.sid}/files/c.txt`);
  assert.equal(await dl.text(), 'v2');

  const zip = await owner(`/api/collections/${code}/download`);
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
});

test('non-owner cannot manage; owner can delete', async () => {
  const owner = client();
  const alice = client();
  const { code } = await (await owner('/api/collections', json({ title: 't' }))).json();
  await alice(`/api/collections/${code}/submit`, form('Alice', { 'a.txt': 'x' }));

  assert.equal((await alice(`/api/collections/${code}/submissions`)).status, 403);
  assert.equal((await alice(`/api/collections/${code}/download`)).status, 403);

  const [s] = await (await owner(`/api/collections/${code}/submissions`)).json();
  assert.equal((await alice(`/api/collections/${code}/submissions/${s.sid}`, { method: 'DELETE' })).status, 403);
  assert.equal((await owner(`/api/collections/${code}/submissions/${s.sid}`, { method: 'DELETE' })).status, 200);
  assert.equal((await alice(`/api/collections/${code}`).then((r) => r.json())).mine, null);
  assert.equal(fs.existsSync(path.join(dataDir, 'files', code, s.sid)), false);
});

test('bad input is rejected and leaves no residue', async () => {
  const owner = client();
  const { code } = await (await owner('/api/collections', json({ title: 't' }))).json();

  assert.equal((await owner(`/api/collections/${code}/submit`, form('A', { '../evil.txt': 'x' }))).status, 400);
  assert.equal((await owner(`/api/collections/${code}/submit`, form('', { 'a.txt': 'x' }))).status, 400);
  assert.equal((await owner(`/api/collections/${code}/submit`, form('A', { 'big.bin': 'x'.repeat(1024 * 1024 + 1) }))).status, 413);
  assert.equal((await owner('/api/collections/aaaaaaaa')).status, 404);
  assert.equal((await owner('/api/collections/ABCDEFGH')).status, 404);
  assert.equal((await owner('/api/collections/a%2Fb%2Fc%2Fd')).status, 404);
  assert.equal((await owner('/api/collections', json({ title: '  ' }))).status, 400);

  assert.equal(fs.readdirSync(path.join(dataDir, 'tmp')).length, 0);
  assert.equal((await (await owner(`/api/collections/${code}`)).json()).mine, null);
});

test('forged cookie is replaced, not trusted', async () => {
  const r = await fetch(`${base}/api/collections`, { headers: { cookie: 'uid=../../etc' } });
  assert.match(r.headers.get('set-cookie'), /^uid=[0-9a-f]{64};/);
});

test('expired collections are unreachable and swept from disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-ttl-'));
  const app = createApp({ dataDir: dir, ttlMs: 150 });
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const cookie = 'uid=' + 'a'.repeat(64);
    const call = (p, o = {}) => fetch(url + p, { ...o, headers: { ...o.headers, cookie } });
    const { code } = await (await call('/api/collections', json({ title: 't' }))).json();
    assert.equal((await call(`/api/collections/${code}/submit`, form('A', { 'a.txt': 'x' }))).status, 200);
    const info = await (await call(`/api/collections/${code}`)).json();
    assert.ok(info.expiresAt > Date.now());
    assert.equal((await (await call('/api/collections')).json()).length, 1);

    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await call(`/api/collections/${code}`)).status, 404);
    assert.equal((await (await call('/api/collections')).json()).length, 0);
    assert.ok(fs.existsSync(path.join(dir, 'files', code)));

    app.sweep();
    assert.equal(fs.existsSync(path.join(dir, 'files', code)), false);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('owner can close and reopen; closed rejects submissions', async () => {
  const owner = client();
  const alice = client();
  const { code } = await (await owner('/api/collections', json({ title: 't' }))).json();
  assert.equal((await alice(`/api/collections/${code}/submit`, form('A', { 'a.txt': '1' }))).status, 200);

  assert.equal((await alice(`/api/collections/${code}/closed`, json({ closed: true }))).status, 403);
  assert.equal((await owner(`/api/collections/${code}/closed`, json({ closed: true }))).status, 200);
  assert.equal((await (await alice(`/api/collections/${code}`)).json()).closed, true);

  assert.equal((await alice(`/api/collections/${code}/submit`, form('A', { 'b.txt': '2' }))).status, 403);
  assert.equal(fs.readdirSync(path.join(dataDir, 'tmp')).length, 0);
  const [s] = await (await owner(`/api/collections/${code}/submissions`)).json();
  assert.deepEqual(s.files.map((f) => f.path), ['a.txt']); // old submission untouched

  assert.equal((await owner(`/api/collections/${code}/closed`, json({ closed: false }))).status, 200);
  assert.equal((await alice(`/api/collections/${code}/submit`, form('A', { 'b.txt': '2' }))).status, 200);
});

test('database without the closed column is migrated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-old-'));
  try {
    const old = new DatabaseSync(path.join(dir, 'collector.db'));
    old.exec('CREATE TABLE collections (code TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT NOT NULL, created_at INTEGER NOT NULL)');
    old.prepare('INSERT INTO collections VALUES (?, ?, ?, ?)').run('abcdefgh', 't', 'o', Date.now());
    old.close();
    createApp({ dataDir: dir });
    const db = new DatabaseSync(path.join(dir, 'collector.db'));
    assert.equal(db.prepare('SELECT closed FROM collections').get().closed, 0);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
