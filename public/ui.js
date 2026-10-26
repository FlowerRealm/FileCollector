export const $ = (id) => document.getElementById(id);

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

// Lucide-style 24px stroke icons.
const ICONS = {
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  hdd: '<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/><path d="M6 16h.01"/><path d="M10 16h.01"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
};

export function icon(name, size = 18) {
  const s = h('span', { className: 'ico' });
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return s;
}

export const fmtSize = (n) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;

export const fmtTime = (t) =>
  new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const avatar = (name) => h('span', { className: 'avatar' }, [...name][0]?.toUpperCase() ?? '?');

// kind: 'ok' | 'bad'
export function toast(msg, kind = 'ok') {
  let box = $('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', className: 'toasts' });
    document.body.append(box);
  }
  const t = h('div', { className: `toast ${kind}` }, icon(kind === 'ok' ? 'check' : 'x', 16), msg);
  box.append(t);
  setTimeout(() => t.remove(), 2800);
}

// navigator.clipboard only exists in secure contexts; plain http (LAN IP) needs execCommand.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { value: text, readOnly: true, style: 'position:fixed;opacity:0' });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function brand(label = '文件收集') {
  return h(
    'a',
    { className: 'brand', href: '/' },
    h('span', { className: 'logo' }, icon('layers', 16)),
    h('span', {}, label),
  );
}

export const sumSize = (files) => files.reduce((n, f) => n + f.size, 0);

export function fileList(files, { hrefOf, onRemove, plain } = {}) {
  return h('ul', { className: `flist ${plain ? 'plain' : ''}` },
    files.map((f) =>
      h('li', {},
        icon('file', 15),
        h(hrefOf ? 'a' : 'span', { className: 'p', title: f.path, ...(hrefOf && { href: hrefOf(f) }) }, f.path),
        h('span', { className: 'sz' }, fmtSize(f.size)),
        onRemove && h('button', { type: 'button', title: '移除', onclick: () => onRemove(f) }, icon('x', 14)))));
}

async function walk(entry, prefix = '') {
  if (entry.isFile) return [[prefix + entry.name, await new Promise((res, rej) => entry.file(res, rej))]];
  const reader = entry.createReader();
  const out = [];
  for (let batch; (batch = await new Promise((res, rej) => reader.readEntries(res, rej))).length; ) {
    for (const e of batch) out.push(...(await walk(e, `${prefix}${entry.name}/`)));
  }
  return out;
}

// Drop zone with file/folder buttons. onAdd receives [[relativePath, File], ...].
export function picker(onAdd) {
  const input = (props) => h('input', {
    type: 'file', hidden: true, ...props,
    onchange: (e) => {
      onAdd([...e.target.files].map((f) => [f.webkitRelativePath || f.name, f]));
      e.target.value = '';
    },
  });
  const files = input({ multiple: true });
  const dir = input({ webkitdirectory: true });
  const drop = h('div', { className: 'drop' },
    h('span', { className: 'big' }, icon('upload', 28)),
    h('div', {}, h('strong', {}, '把文件或文件夹拖到这里')),
    h('div', { className: 'muted' }, '或者'),
    h('div', { className: 'btns' },
      h('button', { type: 'button', className: 'btn sm', onclick: () => files.click() }, icon('file', 15), '选择文件'),
      h('button', { type: 'button', className: 'btn sm', onclick: () => dir.click() }, icon('folder', 15), '选择文件夹')),
    files, dir);

  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('over'); });
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    // Entries must be grabbed synchronously; the DataTransfer is cleared after the first await.
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    const out = [];
    try {
      for (const entry of entries) out.push(...(await walk(entry)));
    } catch {
      toast('读取文件夹失败', 'bad');
    }
    onAdd(out);
  });
  return drop;
}

// POST with upload progress drawn into a .bar (fetch cannot report upload progress).
// Resolves to the JSON body, or { error } on failure.
export function send(url, fd, bar) {
  const fill = bar.firstChild;
  bar.hidden = false;
  fill.style.width = '0';
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (ev) => { fill.style.width = `${(ev.loaded / ev.total) * 100}%`; };
    xhr.onerror = () => { bar.hidden = true; resolve({ error: '网络错误' }); };
    xhr.onload = () => {
      bar.hidden = true;
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      resolve(xhr.status === 200 ? body : { error: body.error || '上传失败' });
    };
    xhr.send(fd);
  });
}
