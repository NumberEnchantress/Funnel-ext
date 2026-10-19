'use strict';
/* Background page: storage, de-duplication, sorted set, Later list, and the file writers' safety rules. */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const { read, sleep, until } = require('./helpers');

const SCRIPTS = ['shared/settings.js', 'shared/format.js', 'background/db.js', 'background/sinks.js', 'background/main.js'];

/**
 * Load the background scripts into a fresh context.
 * disk: a Map standing in for the Downloads folder (path -> text), shared across "reinstalls".
 */
function background({ settings, disk = new Map(), nativeFiles = null, os = 'win' } = {}) {
  const listeners = [];
  const storageListeners = [];
  const nativeSeen = new Map();
  const timers = new Set();
  let nextId = 1;
  const downloads = new Map(); // id -> item
  const changeListeners = new Set();
  const blobs = new Map();
  const ctx = {
    console,
    crypto: globalThis.crypto,
    structuredClone,
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    Blob: class {
      constructor(parts) {
        this.text = parts.join('');
      }
    },
    URL: Object.assign(class extends URL {}, {
      createObjectURL(blob) {
        const u = `blob:test/${blobs.size + 1}`;
        blobs.set(u, blob.text);
        return u;
      },
      revokeObjectURL() {},
    }),
    setTimeout(fn, ms) {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, Math.min(ms, 50)); // compress the writers' debounce delays
      timers.add(t);
      return t;
    },
    clearTimeout(t) {
      timers.delete(t);
      clearTimeout(t);
    },
    browser: {
      storage: {
        local: { get: async () => ({ settings }), set: async () => {} },
        onChanged: { addListener: (fn) => storageListeners.push(fn) },
      },
      runtime: {
        id: 'test@otaat',
        getURL: (p) => `moz-extension://test/${p}`,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        getPlatformInfo: async () => ({ os }),
        async sendNativeMessage(app, msg) {
          if (!nativeFiles) throw new Error('No such native application');
          if (msg.type === 'hello') return { ok: true, version: 't', folder: msg.folder || 'C:/Docs/OneThingAtATime' };
          if (msg.type === 'append') {
            // Same rules as the real host: skip lines already written for this log and file.
            for (const f of msg.files) {
              const k = `${msg.folder || 'default'}|${f.path}`;
              const seenKey = `${msg.folder || 'default'}|${msg.log}|${f.path}`;
              const last = nativeSeen.get(seenKey) || 0;
              const fresh = f.lines.filter(([id]) => id > last);
              if (!fresh.length) continue;
              const cur = nativeFiles.get(k);
              nativeFiles.set(k, (cur === undefined ? f.header || '' : cur) + fresh.map(([, t]) => t).join(''));
              nativeSeen.set(seenKey, Math.max(...fresh.map(([id]) => id)));
            }
            return { ok: true };
          }
          return { ok: false, error: 'unknown' };
        },
      },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      commands: { onCommand: { addListener() {} } },
      tabs: { query: async () => [], create: async () => ({}), update: async () => ({}), sendMessage: async () => {} },
      windows: { update: async () => ({}) },
      downloads: {
        async download({ url, filename, conflictAction }) {
          let name = filename;
          if (conflictAction === 'uniquify' && disk.has(name)) {
            const dot = name.lastIndexOf('.');
            for (let i = 1; disk.has(name); i++) name = `${filename.slice(0, dot)}(${i})${filename.slice(dot)}`;
          }
          disk.set(name, blobs.get(url));
          const id = nextId++;
          downloads.set(id, { id, state: 'complete', filename: `C:\\Users\\me\\Downloads\\${name.replace(/\//g, '\\')}` });
          return id;
        },
        async search({ id }) {
          return downloads.has(id) ? [downloads.get(id)] : [];
        },
        async erase() {
          return [];
        },
        onChanged: { addListener: (fn) => changeListeners.add(fn), removeListener: (fn) => changeListeners.delete(fn) },
      },
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  if (os === 'android') {
    // Firefox for Android: no keyboard commands, no windows API, no native messaging, no downloads API.
    delete ctx.browser.commands;
    delete ctx.browser.windows;
    delete ctx.browser.runtime.sendNativeMessage;
    delete ctx.browser.downloads;
  }
  for (const rel of SCRIPTS) vm.runInContext(read(rel), ctx, { filename: rel });
  const send = (msg, sender = { url: 'moz-extension://test/pages/logs.html' }) =>
    listeners[0](msg, sender).then((r) => JSON.parse(JSON.stringify(r)));
  const changeSettings = (next) => {
    const old = settings;
    settings = next;
    for (const fn of storageListeners) fn({ settings: { oldValue: old, newValue: next } }, 'local');
  };
  return { ctx, send, disk, changeSettings, listener: listeners[0], stop: () => timers.forEach((t) => clearTimeout(t)) };
}

const item = (n, extra = {}) => ({
  key: `reddit:t3_${n}`,
  site: 'reddit',
  kind: 'post',
  url: `https://www.reddit.com/r/x/comments/${n}/`,
  title: `Post ${n}`,
  author: 'u/someone',
  ...extra,
});

test('logging: repeat sightings within the window are dropped; actions always count', async () => {
  const bg = background();
  const fromPage = { url: 'https://www.reddit.com/' };
  let r = await bg.send({ type: 'log', entries: [{ action: 'seen', item: item(1), surface: 'home' }] }, fromPage);
  assert.equal(r.stored, 1);
  r = await bg.send({ type: 'log', entries: [{ action: 'seen', item: item(1), surface: 'home' }] }, fromPage);
  assert.equal(r.stored, 0, 'same item seen again within 24 h is not re-logged');
  r = await bg.send({ type: 'log', entries: [{ action: 'skipped', item: item(1) }, { action: 'skipped', item: item(1) }] }, fromPage);
  assert.equal(r.stored, 2);
  assert.deepEqual(r.counts, { seen: 1, skipped: 2, deferred: 0, queued: 0 });
  bg.stop();
});

test('sorted set and Later list', async () => {
  const bg = background();
  const page = { url: 'https://x.com/home' };
  await bg.send({ type: 'log', entries: [{ action: 'deferred', item: item(2), localLater: true }] }, page);
  await bg.send({ type: 'log', entries: [{ action: 'deferred', item: item(3), localLater: false }] }, page);
  await bg.send({ type: 'log', entries: [{ action: 'seen', item: item(4) }] }, page);
  const { sorted } = await bg.send({ type: 'filterSorted', keys: ['reddit:t3_2', 'reddit:t3_3', 'reddit:t3_4'] }, page);
  assert.deepEqual(sorted.sort(), ['reddit:t3_2', 'reddit:t3_3'], 'seen alone does not count as sorted');
  const { items } = await bg.send({ type: 'later.list' });
  assert.deepEqual(items.map((i) => i.key), ['reddit:t3_2'], 'only local-later items are on the Later list');
  await bg.send({ type: 'later.update', key: 'reddit:t3_2', patch: { done: true } });
  assert.equal((await bg.send({ type: 'later.list' })).items[0].done, true);
  bg.stop();
});

test('content scripts cannot call page-only messages', async () => {
  const bg = background();
  const fromSite = { url: 'https://www.reddit.com/' };
  for (const type of ['sorted.reset', 'later.remove', 'events.query', 'files.open', 'files.rebuild']) {
    assert.equal(bg.listener({ type }, fromSite), undefined, `${type} is ignored from a web page`);
  }
  assert.ok(bg.listener({ type: 'counts' }, fromSite), 'counts is allowed');
  bg.stop();
});

test('log viewer query filters by action, site and text', async () => {
  const bg = background();
  const page = { url: 'https://www.reddit.com/' };
  await bg.send(
    {
      type: 'log',
      entries: [
        { action: 'skipped', item: item(5, { title: 'Cats in space' }) },
        { action: 'skipped', item: { ...item(6), site: 'youtube', key: 'youtube:abcdefghijk', title: 'Dogs' } },
        { action: 'deferred', item: item(7, { title: 'More cats' }) },
      ],
    },
    page
  );
  const all = await bg.send({ type: 'events.query', filter: {} });
  assert.equal(all.events.length, 3);
  assert.ok(all.events[0].id > all.events[2].id, 'newest first');
  const cats = await bg.send({ type: 'events.query', filter: { q: 'cats' } });
  assert.equal(cats.events.length, 2);
  const yt = await bg.send({ type: 'events.query', filter: { site: 'youtube' } });
  assert.equal(yt.events.length, 1);
  const def = await bg.send({ type: 'events.query', filter: { action: 'deferred' } });
  assert.equal(def.events[0].title, 'More cats');
  bg.stop();
});

test('Downloads writer never overwrites files it did not create (e.g. after a reinstall)', async () => {
  const disk = new Map();
  const page = { url: 'https://www.reddit.com/' };
  // First install writes its files.
  const a = background({ settings: { fileOutput: 'downloads' }, disk });
  await a.send({ type: 'log', entries: [{ action: 'skipped', item: item(10) }, { action: 'skipped', item: item(11) }] }, page);
  await a.send({ type: 'files.syncNow' });
  const month = [...disk.keys()].find((k) => k.endsWith('/skipped.md'));
  assert.ok(month, 'skipped.md written');
  assert.match(disk.get(month), /Post 10[\s\S]*Post 11/);
  // Later writes from the same install rewrite that same file.
  await a.send({ type: 'log', entries: [{ action: 'skipped', item: item(12) }] }, page);
  await a.send({ type: 'files.syncNow' });
  assert.match(disk.get(month), /Post 12/);
  assert.equal([...disk.keys()].filter((k) => k.includes('skipped')).length, 1);
  a.stop();

  // "Reinstall": empty in-browser log, same Downloads folder.
  const b = background({ settings: { fileOutput: 'downloads' }, disk });
  await b.send({ type: 'log', entries: [{ action: 'skipped', item: item(20) }] }, page);
  await b.send({ type: 'files.syncNow' });
  assert.match(disk.get(month), /Post 10[\s\S]*Post 11[\s\S]*Post 12/, 'old file untouched');
  assert.doesNotMatch(disk.get(month), /Post 20/);
  const newer = [...disk.keys()].find((k) => /skipped\(1\)\.md$/.test(k));
  assert.ok(newer, 'new install writes skipped(1).md instead');
  assert.match(disk.get(newer), /Post 20/);
  b.stop();
});

test('native writer appends only, and a new folder receives the full history', async () => {
  const files = new Map();
  const page = { url: 'https://www.reddit.com/' };
  const bg = background({ settings: { fileOutput: 'native' }, nativeFiles: files });
  await bg.send({ type: 'log', entries: [{ action: 'deferred', item: item(30) }] }, page);
  await until(() => [...files.keys()].some((k) => k.endsWith('/deferred.md')), 'written by the native writer');
  const key = [...files.keys()].find((k) => k.endsWith('/deferred.md'));
  assert.ok(key.startsWith('default|'));
  assert.match(files.get(key), /^# Deferred \(Later\)/);
  await bg.send({ type: 'log', entries: [{ action: 'deferred', item: item(31) }] }, page);
  await until(() => /Post 31/.test(files.get(key)), 'appended');
  assert.equal(files.get(key).match(/# Deferred/g).length, 1, 'header written once');
  assert.match(files.get(key), /Post 30[\s\S]*Post 31/);
  const st = await bg.send({ type: 'files.status' });
  assert.equal(st.output, 'native');
  assert.equal(st.pending, 0);

  // Point the writer at another folder: it gets everything, the old folder is left alone.
  const before = files.get(key);
  bg.changeSettings({ fileOutput: 'native', nativeFolder: 'D:/Elsewhere' });
  await bg.send({ type: 'files.syncNow' });
  const moved = [...files.keys()].find((k) => k.startsWith('D:/Elsewhere|') && k.endsWith('/deferred.md'));
  assert.ok(moved, 'written to the new folder');
  assert.match(files.get(moved), /Post 30[\s\S]*Post 31/, 'full history in the new folder');
  assert.equal(files.get(key), before, 'old folder untouched');
  bg.stop();
});

test('switching the native folder away and back does not write entries twice', async () => {
  const files = new Map();
  const page = { url: 'https://www.reddit.com/' };
  const bg = background({ settings: { fileOutput: 'native', nativeFolder: 'A' }, nativeFiles: files });
  await bg.send({ type: 'log', entries: [{ action: 'skipped', item: item(50) }] }, page);
  await bg.send({ type: 'files.syncNow' });
  bg.changeSettings({ fileOutput: 'native', nativeFolder: 'B' });
  await bg.send({ type: 'files.syncNow' });
  bg.changeSettings({ fileOutput: 'native', nativeFolder: 'A' });
  await bg.send({ type: 'files.syncNow' });
  const a = [...files.entries()].find(([k]) => k.startsWith('A|') && k.endsWith('/skipped.md'))[1];
  assert.equal(a.match(/Post 50/g).length, 1, 'once in folder A');
  assert.ok([...files.keys()].some((k) => k.startsWith('B|') && k.endsWith('/skipped.md')), 'B got the history');
  bg.stop();
});

test('text with half an emoji is stored well-formed, so the native writer never chokes on it', async () => {
  const files = new Map();
  const page = { url: 'https://x.com/home' };
  const bg = background({ settings: { fileOutput: 'native' }, nativeFiles: files });
  await bg.send({ type: 'log', entries: [{ action: 'seen', item: item(60, { title: 'broken \uD83D', snippet: 'x\uDE00y' }) }] }, page);
  await bg.send({ type: 'files.syncNow' });
  const all = [...files.values()].join('');
  assert.ok(!/[\uD800-\uDFFF]/.test(all.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), 'no lone surrogates written');
  assert.match(all, /broken �/);
  const st = await bg.send({ type: 'files.status' });
  assert.equal(st.pending, 0);
  bg.stop();
});

test('Firefox for Android: starts without desktop-only APIs and keeps logs in Firefox by default', async () => {
  const disk = new Map();
  const page = { url: 'https://m.youtube.com/' };
  const bg = background({ os: 'android', disk });
  const r = await bg.send({ type: 'log', entries: [{ action: 'skipped', item: item(70) }] }, page);
  assert.equal(r.stored, 1, 'logging works');
  await bg.send({ type: 'files.syncNow' });
  const st = await bg.send({ type: 'files.status' });
  assert.equal(st.platform, 'android');
  assert.equal(st.output, null, 'no automatic downloads (each would show a notification)');
  assert.equal(disk.size, 0);
  assert.equal(st.canDownload, false);
  const open = await bg.send({ type: 'files.open', path: '' });
  assert.equal(open.ok, false);
  assert.match(open.error, /Export/);
  // A "Downloads" setting (e.g. chosen before) can't do anything there, and must not break anything.
  bg.changeSettings({ fileOutput: 'downloads' });
  await bg.send({ type: 'files.syncNow' });
  const st2 = await bg.send({ type: 'files.status' });
  assert.equal(st2.output, null);
  assert.equal(st2.lastError, '');
  assert.equal(disk.size, 0);
  const counts = await bg.send({ type: 'counts' });
  assert.equal(counts.counts.skipped, 1, 'the log itself is intact');
  bg.stop();
});

test('auto mode: Downloads until the native writer has worked, then it waits for native', async () => {
  const disk = new Map();
  const page = { url: 'https://www.reddit.com/' };
  const bg = background({ disk });
  await bg.send({ type: 'log', entries: [{ action: 'queued', item: item(40) }] }, page);
  await bg.send({ type: 'files.syncNow' });
  const st = await bg.send({ type: 'files.status' });
  assert.equal(st.output, 'downloads');
  assert.ok([...disk.keys()].some((k) => k.startsWith('OneThingAtATime/') && k.endsWith('/queued.md')));
  bg.stop();
  await sleep(10);
});
