import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import archiver from 'archiver';
import express from 'express';
import multer from 'multer';

const UID_RE = /^[0-9a-f]{64}$/;
// A collection's or distribution's name is its URL: /c/<name>, /d/<name>.
const NAME_RE = /^[A-Za-z0-9]{1,32}$/;
const NAME_ERR = '名字只能是 1-32 位英文字母或数字';
const SID_RE = /^[0-9a-f]{16}$/;
const TEN_YEARS = 10 * 365 * 24 * 3600;

const rand = (n) => crypto.randomBytes(n).toString('hex');

// Client-supplied relative path -> normalized path, or null if unsafe.
// This is the only gate between user input and the filesystem layout.
export function cleanPath(p) {
  if (typeof p !== 'string' || p.includes('\0') || p.includes('\\')) return null;
  const parts = p.split('/');
  if (parts.length > 32) return null;
  for (const s of parts) if (s === '' || s === '.' || s === '..' || s.length > 255) return null;
  return parts.join('/');
}

function parseCookies(header = '') {
  const out = {};
  for (const kv of header.split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return out;
}

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const handler = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// multer's staged files keyed by their cleaned paths; last one wins on duplicate paths.
function staged(req) {
  const files = req.files ?? [];
  const cleanup = () => files.forEach((f) => fs.rmSync(f.path, { force: true }));
  const paths = asArray(req.body.paths).map(cleanPath);
  if (!files.length) return { cleanup, error: '没有文件' };
  if (paths.length !== files.length || paths.includes(null)) return { cleanup, error: '文件路径非法' };
  return { cleanup, entries: new Map(paths.map((p, i) => [p, files[i]])) };
}

export function createApp({ dataDir, maxFileMB = 500, maxFiles = 5000, ttlMs = 3 * 24 * 3600 * 1000 } = {}) {
  const filesDir = path.join(dataDir, 'files');
  const distDir = path.join(dataDir, 'dist');
  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const db = new DatabaseSync(path.join(dataDir, 'collector.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS collections (
      code TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT NOT NULL, created_at INTEGER NOT NULL,
      closed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS members (
      code TEXT NOT NULL REFERENCES collections(code) ON DELETE CASCADE, uid TEXT NOT NULL,
      PRIMARY KEY (code, uid));
    CREATE TABLE IF NOT EXISTS submissions (
      sid TEXT PRIMARY KEY, code TEXT NOT NULL REFERENCES collections(code) ON DELETE CASCADE,
      uid TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (code, uid));
    CREATE TABLE IF NOT EXISTS files (
      sid TEXT NOT NULL REFERENCES submissions(sid) ON DELETE CASCADE, path TEXT NOT NULL,
      size INTEGER NOT NULL, PRIMARY KEY (sid, path));
    CREATE TABLE IF NOT EXISTS distributions (
      code TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS dist_members (
      code TEXT NOT NULL REFERENCES distributions(code) ON DELETE CASCADE, uid TEXT NOT NULL,
      PRIMARY KEY (code, uid));
    CREATE TABLE IF NOT EXISTS dist_files (
      code TEXT NOT NULL REFERENCES distributions(code) ON DELETE CASCADE, path TEXT NOT NULL,
      fid TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (code, path));
  `);

  // Databases created before manual close existed lack the column.
  if (!db.prepare('PRAGMA table_info(collections)').all().some((c) => c.name === 'closed')) {
    db.exec('ALTER TABLE collections ADD COLUMN closed INTEGER NOT NULL DEFAULT 0');
  }

  const q = {
    collection: db.prepare('SELECT * FROM collections WHERE code = ?'),
    insertCollection: db.prepare('INSERT INTO collections (code, title, owner, created_at) VALUES (?, ?, ?, ?)'),
    setClosed: db.prepare('UPDATE collections SET closed = ? WHERE code = ?'),
    join: db.prepare('INSERT OR IGNORE INTO members VALUES (?, ?)'),
    mine: db.prepare(`
      SELECT c.code, c.title, c.created_at, c.owner = ?1 AS is_owner FROM collections c
      WHERE (c.owner = ?1 OR c.code IN (SELECT code FROM members WHERE uid = ?1)) AND c.created_at > ?2
      ORDER BY c.created_at DESC`),
    expired: db.prepare('SELECT code FROM collections WHERE created_at <= ?'),
    deleteCollection: db.prepare('DELETE FROM collections WHERE code = ?'),
    submissionOf: db.prepare('SELECT * FROM submissions WHERE code = ? AND uid = ?'),
    submissionBySid: db.prepare('SELECT * FROM submissions WHERE code = ? AND sid = ?'),
    submissions: db.prepare('SELECT sid, name, created_at FROM submissions WHERE code = ? ORDER BY created_at DESC'),
    filesOf: db.prepare('SELECT path, size FROM files WHERE sid = ? ORDER BY path'),
    fileOf: db.prepare('SELECT size FROM files WHERE sid = ? AND path = ?'),
    deleteSubmissionOf: db.prepare('DELETE FROM submissions WHERE code = ? AND uid = ?'),
    deleteSubmission: db.prepare('DELETE FROM submissions WHERE sid = ?'),
    insertSubmission: db.prepare('INSERT INTO submissions VALUES (?, ?, ?, ?, ?)'),
    insertFile: db.prepare('INSERT INTO files VALUES (?, ?, ?)'),

    dist: db.prepare('SELECT * FROM distributions WHERE code = ?'),
    insertDist: db.prepare('INSERT INTO distributions (code, owner, created_at) VALUES (?, ?, ?)'),
    setDistClosed: db.prepare('UPDATE distributions SET closed = ? WHERE code = ?'),
    joinDist: db.prepare('INSERT OR IGNORE INTO dist_members VALUES (?, ?)'),
    myDists: db.prepare(`
      SELECT d.code, d.created_at, d.owner = ?1 AS is_owner FROM distributions d
      WHERE (d.owner = ?1 OR d.code IN (SELECT code FROM dist_members WHERE uid = ?1)) AND d.created_at > ?2
      ORDER BY d.created_at DESC`),
    expiredDists: db.prepare('SELECT code FROM distributions WHERE created_at <= ?'),
    deleteDist: db.prepare('DELETE FROM distributions WHERE code = ?'),
    distFiles: db.prepare('SELECT path, fid, size FROM dist_files WHERE code = ? ORDER BY path'),
    distFile: db.prepare('SELECT fid, size FROM dist_files WHERE code = ? AND path = ?'),
    putDistFile: db.prepare('INSERT OR REPLACE INTO dist_files VALUES (?, ?, ?, ?)'),
    deleteDistFile: db.prepare('DELETE FROM dist_files WHERE code = ? AND path = ?'),
  };

  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  const expiresAt = (c) => c.created_at + ttlMs;

  // Files first, row second: a crash in between is retried by the next sweep.
  function purge(code) {
    fs.rmSync(path.join(filesDir, code), { recursive: true, force: true });
    q.deleteCollection.run(code);
  }
  function purgeDist(code) {
    fs.rmSync(path.join(distDir, code), { recursive: true, force: true });
    q.deleteDist.run(code);
  }
  const sweep = () => {
    const cutoff = Date.now() - ttlMs;
    q.expired.all(cutoff).forEach(({ code }) => purge(code));
    q.expiredDists.all(cutoff).forEach(({ code }) => purgeDist(code));
  };
  sweep();

  // An expired name may still be on disk until the next sweep; reclaim it now.
  function nameFree(code, lookup, purgeFn) {
    const prev = lookup.get(code);
    if (prev && expiresAt(prev) > Date.now()) return false;
    if (prev) purgeFn(code);
    return true;
  }

  const subDir = (code, sid) => path.join(filesDir, code, sid);
  const listFiles = (sid) => q.filesOf.all(sid).map((f) => ({ path: f.path, size: f.size }));
  const blob = (code, fid) => path.join(distDir, code, fid);
  const listDist = (code) => q.distFiles.all(code).map((f) => ({ path: f.path, size: f.size }));

  const upload = multer({
    storage: multer.diskStorage({
      destination: tmpDir,
      filename: (_req, _file, cb) => cb(null, rand(16)),
    }),
    limits: { fileSize: maxFileMB * 1024 * 1024, files: maxFiles, fields: maxFiles + 8 },
  });

  const app = express();
  app.disable('x-powered-by');

  // Identity is nothing but this random token. Anything not in our format is replaced.
  app.use((req, res, next) => {
    let uid = parseCookies(req.headers.cookie).uid;
    if (!UID_RE.test(uid || '')) {
      uid = rand(32);
      res.append(
        'Set-Cookie',
        `uid=${uid}; Path=/; Max-Age=${TEN_YEARS}; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`,
      );
    }
    req.uid = uid;
    next();
  });

  const pub = path.join(import.meta.dirname, 'public');
  app.get('/c/:id', (_req, res) => res.sendFile(path.join(pub, 'collection.html')));
  app.get('/d/:id', (_req, res) => res.sendFile(path.join(pub, 'distribution.html')));
  app.use(express.static(pub));
  app.use('/api', express.json({ limit: '16kb' }));

  // Resolve :code once; 404 for anything malformed or unknown.
  app.param('code', (req, res, next, code) => {
    const c = NAME_RE.test(code) ? q.collection.get(code) : undefined;
    if (!c || expiresAt(c) <= Date.now()) return res.status(404).json({ error: '收集不存在' });
    req.collection = c;
    next();
  });

  const ownerOnly = (req, res, next) =>
    req.collection.owner === req.uid ? next() : res.status(403).json({ error: '仅发起者可操作' });

  app.get('/api/collections', (req, res) => {
    res.json(
      q.mine.all(req.uid, Date.now() - ttlMs).map((r) => ({
        code: r.code,
        title: r.title,
        isOwner: !!r.is_owner,
        expiresAt: r.created_at + ttlMs,
      })),
    );
  });

  app.post('/api/collections', (req, res) => {
    const code = String(req.body?.title ?? '').trim();
    if (!NAME_RE.test(code)) return res.status(400).json({ error: NAME_ERR });
    if (!nameFree(code, q.collection, purge)) return res.status(409).json({ error: '名字已被占用' });
    q.insertCollection.run(code, code, req.uid, Date.now());
    res.json({ code });
  });

  // Opening the link is joining: membership is recorded so it shows up in the user's list.
  app.get('/api/collections/:code', (req, res) => {
    const { code, title, owner } = req.collection;
    q.join.run(code, req.uid);
    const sub = q.submissionOf.get(code, req.uid);
    res.json({
      code,
      title,
      isOwner: owner === req.uid,
      expiresAt: expiresAt(req.collection),
      closed: !!req.collection.closed,
      mine: sub ? { name: sub.name, createdAt: sub.created_at, files: listFiles(sub.sid) } : null,
    });
  });

  app.post('/api/collections/:code/closed', ownerOnly, (req, res) => {
    q.setClosed.run(req.body?.closed ? 1 : 0, req.collection.code);
    res.json({ closed: !!req.body?.closed });
  });

  // Checked before multer so a closed collection never buffers an upload.
  const mustBeOpen = (req, res, next) =>
    req.collection.closed ? res.status(403).json({ error: '收集已关闭' }) : next();

  // Submitting replaces the user's previous submission wholesale.
  app.post(
    '/api/collections/:code/submit',
    mustBeOpen,
    upload.array('files'),
    handler(async (req, res) => {
      const { code } = req.collection;
      const { cleanup, entries, error } = staged(req);
      const name = String(req.body.name ?? '').trim().slice(0, 50);
      if (!name || error) {
        cleanup();
        return res.status(400).json({ error: name ? error : '请填写姓名' });
      }

      const sid = rand(8);
      const dir = subDir(code, sid);
      try {
        for (const [p, f] of entries) {
          const dest = path.join(dir, p);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(f.path, dest);
        }
        const old = tx(() => {
          const prev = q.submissionOf.get(code, req.uid);
          if (prev) q.deleteSubmissionOf.run(code, req.uid);
          q.insertSubmission.run(sid, code, req.uid, name, Date.now());
          for (const [p, f] of entries) q.insertFile.run(sid, p, f.size);
          return prev;
        });
        if (old) fs.rmSync(subDir(code, old.sid), { recursive: true, force: true });
      } catch (e) {
        fs.rmSync(dir, { recursive: true, force: true });
        cleanup();
        throw e;
      }
      cleanup(); // duplicates that never got moved
      res.json({ files: listFiles(sid) });
    }),
  );

  app.get('/api/collections/:code/submissions', ownerOnly, (req, res) => {
    res.json(
      q.submissions.all(req.collection.code).map((s) => ({
        sid: s.sid,
        name: s.name,
        createdAt: s.created_at,
        files: listFiles(s.sid),
      })),
    );
  });

  const submissionParam = (req, res) => {
    const s = SID_RE.test(req.params.sid) ? q.submissionBySid.get(req.collection.code, req.params.sid) : undefined;
    if (!s) res.status(404).json({ error: '提交不存在' });
    return s;
  };

  app.delete('/api/collections/:code/submissions/:sid', ownerOnly, (req, res) => {
    const s = submissionParam(req, res);
    if (!s) return;
    q.deleteSubmission.run(s.sid);
    fs.rmSync(subDir(req.collection.code, s.sid), { recursive: true, force: true });
    res.json({ ok: true });
  });

  // Only paths recorded in the DB can be served, so no traversal check is needed here.
  app.get('/api/collections/:code/submissions/:sid/files/*', ownerOnly, (req, res) => {
    const s = submissionParam(req, res);
    if (!s) return;
    const p = cleanPath(req.params[0]);
    if (!p || !q.fileOf.get(s.sid, p)) return res.status(404).json({ error: '文件不存在' });
    res.download(path.join(subDir(req.collection.code, s.sid), p), path.basename(p));
  });

  // One submission with ?sid=, or everything. Entries keep the submitted paths as-is;
  // when two submitters sent the same path, later ones become "name (2).ext".
  app.get('/api/collections/:code/download', ownerOnly, (req, res) => {
    const { code, title } = req.collection;
    const subs = req.query.sid
      ? [q.submissionBySid.get(code, String(req.query.sid))].filter(Boolean)
      : q.submissions.all(code);
    if (!subs.length) return res.status(404).json({ error: '没有可下载的提交' });

    const zip = archiver('zip', { store: true });
    res.attachment(`${req.query.sid ? subs[0].name : title}.zip`);
    zip.on('error', () => res.destroy());
    zip.pipe(res);
    const taken = new Set();
    const unique = (p) => {
      const ext = path.posix.extname(p);
      let name = p;
      for (let i = 2; taken.has(name); i++) name = `${p.slice(0, p.length - ext.length)} (${i})${ext}`;
      taken.add(name);
      return name;
    };
    for (const s of subs) {
      for (const f of q.filesOf.all(s.sid)) {
        zip.file(path.join(subDir(code, s.sid), f.path), { name: unique(f.path) });
      }
    }
    zip.finalize();
  });

  // ---- distributions: the owner uploads, everyone with the link downloads ----

  app.param('dcode', (req, res, next, code) => {
    const d = NAME_RE.test(code) ? q.dist.get(code) : undefined;
    if (!d || expiresAt(d) <= Date.now()) return res.status(404).json({ error: '分发不存在' });
    req.dist = d;
    next();
  });

  const distOwnerOnly = (req, res, next) =>
    req.dist.owner === req.uid ? next() : res.status(403).json({ error: '仅发起者可操作' });
  // Closing hides the files from everyone but the owner.
  const distReadable = (req, res, next) =>
    req.dist.closed && req.dist.owner !== req.uid ? res.status(403).json({ error: '分发已关闭' }) : next();

  app.get('/api/distributions', (req, res) => {
    res.json(
      q.myDists.all(req.uid, Date.now() - ttlMs).map((r) => ({
        code: r.code,
        isOwner: !!r.is_owner,
        expiresAt: r.created_at + ttlMs,
      })),
    );
  });

  app.post('/api/distributions', (req, res) => {
    const code = String(req.body?.title ?? '').trim();
    if (!NAME_RE.test(code)) return res.status(400).json({ error: NAME_ERR });
    if (!nameFree(code, q.dist, purgeDist)) return res.status(409).json({ error: '名字已被占用' });
    q.insertDist.run(code, req.uid, Date.now());
    res.json({ code });
  });

  app.get('/api/distributions/:dcode', (req, res) => {
    const { code, owner, closed } = req.dist;
    q.joinDist.run(code, req.uid);
    const isOwner = owner === req.uid;
    res.json({
      code,
      isOwner,
      expiresAt: expiresAt(req.dist),
      closed: !!closed,
      files: closed && !isOwner ? [] : listDist(code),
    });
  });

  app.post('/api/distributions/:dcode/closed', distOwnerOnly, (req, res) => {
    q.setDistClosed.run(req.body?.closed ? 1 : 0, req.dist.code);
    res.json({ closed: !!req.body?.closed });
  });

  // Uploading adds files; an existing path is replaced. Each file lives on disk under a
  // random id, so replacing or deleting never leaves empty directories behind.
  app.post(
    '/api/distributions/:dcode/files',
    distOwnerOnly,
    upload.array('files'),
    handler(async (req, res) => {
      const { code } = req.dist;
      const { cleanup, entries, error } = staged(req);
      if (error) {
        cleanup();
        return res.status(400).json({ error });
      }
      const added = [];
      try {
        fs.mkdirSync(path.join(distDir, code), { recursive: true });
        for (const [p, f] of entries) {
          const fid = rand(8);
          fs.renameSync(f.path, blob(code, fid));
          added.push([p, fid, f.size]);
        }
        const replaced = tx(() =>
          added.map(([p, fid, size]) => {
            const prev = q.distFile.get(code, p);
            q.putDistFile.run(code, p, fid, size);
            return prev?.fid;
          }),
        );
        for (const fid of replaced) if (fid) fs.rmSync(blob(code, fid), { force: true });
      } catch (e) {
        for (const [, fid] of added) fs.rmSync(blob(code, fid), { force: true });
        cleanup();
        throw e;
      }
      cleanup(); // duplicates that never got moved
      res.json({ files: listDist(code) });
    }),
  );

  app.delete('/api/distributions/:dcode/files/*', distOwnerOnly, (req, res) => {
    const { code } = req.dist;
    const p = cleanPath(req.params[0]);
    const f = p && q.distFile.get(code, p);
    if (!f) return res.status(404).json({ error: '文件不存在' });
    q.deleteDistFile.run(code, p);
    fs.rmSync(blob(code, f.fid), { force: true });
    res.json({ ok: true });
  });

  app.get('/api/distributions/:dcode/files/*', distReadable, (req, res) => {
    const p = cleanPath(req.params[0]);
    const f = p && q.distFile.get(req.dist.code, p);
    if (!f) return res.status(404).json({ error: '文件不存在' });
    res.download(blob(req.dist.code, f.fid), path.basename(p));
  });

  app.get('/api/distributions/:dcode/download', distReadable, (req, res) => {
    const { code } = req.dist;
    const files = q.distFiles.all(code);
    if (!files.length) return res.status(404).json({ error: '没有可下载的文件' });
    const zip = archiver('zip', { store: true });
    res.attachment(`${code}.zip`);
    zip.on('error', () => res.destroy());
    zip.pipe(res);
    for (const f of files) zip.file(blob(code, f.fid), { name: f.path });
    zip.finalize();
  });

  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `单个文件不能超过 ${maxFileMB}MB` : '上传超出限制';
      return res.status(413).json({ error: msg });
    }
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  });

  app.sweep = sweep;
  return app;
}
