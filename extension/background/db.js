/* IndexedDB store: the canonical, in-browser copy of every log event. */
(function (root) {
  'use strict';

  const DB_NAME = 'otaat';
  const DB_VERSION = 1;
  const DISPOSITIONS = new Set(['skipped', 'deferred', 'queued']);
  const F = root.OTAAT_FORMAT;

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        const events = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        events.createIndex('ts', 'ts');
        events.createIndex('key', 'key');
        events.createIndex('day', 'day');
        db.createObjectStore('sorted', { keyPath: 'key' }); // key -> { action, ts }
        db.createObjectStore('seen', { keyPath: 'key' }); // key -> { ts } last logged sighting
        const later = db.createObjectStore('later', { keyPath: 'key' });
        later.createIndex('addedTs', 'addedTs');
        db.createObjectStore('kv');
      };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      r.onerror = () => {
        dbPromise = null;
        reject(r.error);
      };
    });
    return dbPromise;
  }

  const req = (r) =>
    new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });

  // Run fn inside a transaction; resolves with fn's result once the transaction commits.
  async function tx(storeNames, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
      Promise.resolve(fn(t)).then(
        (v) => (result = v),
        (e) => {
          try {
            t.abort();
          } catch (_) {
            /* already finished */
          }
          reject(e);
        }
      );
    });
  }

  // Field -> maximum length. Everything stored is plain, well-formed text (safe for any file writer).
  const ITEM_FIELDS = { key: 300, site: 20, kind: 20, url: 2000, title: 500, author: 200, snippet: 1000, thumb: 2000 };

  function pickItem(item) {
    const out = {};
    if (!item) return out;
    for (const [f, max] of Object.entries(ITEM_FIELDS)) {
      const v = item[f];
      if (v === undefined || v === null || v === '') continue;
      out[f] = F.cut(String(v), max);
    }
    if (item.extra && typeof item.extra === 'object') {
      const extra = {};
      for (const [k, v] of Object.entries(item.extra)) {
        if (v !== undefined && v !== null && v !== '' && Object.keys(extra).length < 12) extra[F.cut(k, 40)] = F.cut(String(v), 500);
      }
      out.extra = extra;
    }
    return out;
  }

  /**
   * Store log entries. Each entry: { action, item, surface, pageUrl, note, localLater, ts? }.
   * Repeat sightings inside the window are dropped. Returns the stored events.
   */
  async function addEvents(entries, { seenRepeatHours = 24 } = {}) {
    const windowMs = Math.max(0, Number(seenRepeatHours) || 0) * 3600 * 1000;
    return tx(['events', 'sorted', 'seen', 'later', 'kv'], 'readwrite', async (t) => {
      const stored = [];
      const counts = {};
      for (const entry of entries) {
        const item = pickItem(entry.item);
        if (!item.key || !F.ACTIONS.includes(entry.action)) continue;
        const ts = Number(entry.ts) || Date.now();
        if (entry.action === 'seen') {
          const prev = await req(t.objectStore('seen').get(item.key));
          if (prev && windowMs > 0 && ts - prev.ts < windowMs) continue;
          t.objectStore('seen').put({ key: item.key, ts });
        }
        const ev = {
          ...item,
          ts,
          day: F.localDate(ts),
          action: entry.action,
          surface: F.cut(entry.surface || '', 40),
          pageUrl: F.cut(entry.pageUrl || '', 2000),
        };
        if (entry.note) ev.note = F.cut(String(entry.note), 200);
        ev.id = await req(t.objectStore('events').add(ev));
        stored.push(ev);
        if (DISPOSITIONS.has(entry.action)) {
          t.objectStore('sorted').put({ key: item.key, action: entry.action, ts });
        }
        if (entry.action === 'deferred' && entry.localLater) {
          t.objectStore('later').put({ ...item, addedTs: ts, done: false, surface: ev.surface });
        }
        const ck = `count:${F.localDate(ts)}:${entry.action}`;
        counts[ck] = (counts[ck] || 0) + 1;
      }
      const kv = t.objectStore('kv');
      for (const [k, n] of Object.entries(counts)) {
        const cur = (await req(kv.get(k))) || 0;
        kv.put(cur + n, k);
      }
      return stored;
    });
  }

  async function filterSorted(keys) {
    return tx(['sorted'], 'readonly', async (t) => {
      const store = t.objectStore('sorted');
      const hits = await Promise.all(keys.map((k) => req(store.get(k))));
      return hits.filter(Boolean).map((h) => h.key);
    });
  }

  async function resetSorted() {
    return tx(['sorted'], 'readwrite', (t) => req(t.objectStore('sorted').clear()));
  }

  async function eventsAfter(afterId, limit = 500) {
    return tx(['events'], 'readonly', async (t) => {
      const out = [];
      const range = IDBKeyRange.lowerBound(afterId, true);
      await new Promise((resolve, reject) => {
        const c = t.objectStore('events').openCursor(range);
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur || out.length >= limit) return resolve();
          out.push(cur.value);
          cur.continue();
        };
        c.onerror = () => reject(c.error);
      });
      return out;
    });
  }

  async function eventsForDay(day) {
    return tx(['events'], 'readonly', async (t) => {
      const all = await req(t.objectStore('events').index('day').getAll(day));
      return all.sort((a, b) => a.id - b.id);
    });
  }

  async function lastEventId() {
    return tx(['events'], 'readonly', async (t) => {
      const c = await req(t.objectStore('events').openCursor(null, 'prev'));
      return c ? c.value.id : 0;
    });
  }

  /**
   * Newest-first query for the log viewer.
   * filter: { action, site, q, beforeId, limit, fromTs, toTs }
   */
  async function queryEvents(filter = {}) {
    const limit = Math.min(Number(filter.limit) || 100, 100000);
    const q = (filter.q || '').toLowerCase().trim();
    const match = (ev) =>
      (!filter.action || ev.action === filter.action) &&
      (!filter.site || ev.site === filter.site) &&
      (!filter.fromTs || ev.ts >= filter.fromTs) &&
      (!filter.toTs || ev.ts <= filter.toTs) &&
      (!q ||
        [ev.title, ev.author, ev.snippet, ev.url, ev.surface, ev.extra && ev.extra.community]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(q)));
    return tx(['events'], 'readonly', async (t) => {
      const out = [];
      const range = filter.beforeId ? IDBKeyRange.upperBound(filter.beforeId, true) : null;
      let scanned = 0;
      await new Promise((resolve, reject) => {
        const c = t.objectStore('events').openCursor(range, 'prev');
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur || out.length >= limit) return resolve();
          scanned++;
          if (match(cur.value)) out.push(cur.value);
          cur.continue();
        };
        c.onerror = () => reject(c.error);
      });
      return { events: out, scanned };
    });
  }

  async function countsFor(dateStr) {
    return tx(['kv'], 'readonly', async (t) => {
      const kv = t.objectStore('kv');
      const out = {};
      for (const a of F.ACTIONS) out[a] = (await req(kv.get(`count:${dateStr}:${a}`))) || 0;
      return out;
    });
  }

  async function totals() {
    return tx(['events', 'sorted', 'later'], 'readonly', async (t) => ({
      events: await req(t.objectStore('events').count()),
      sorted: await req(t.objectStore('sorted').count()),
      later: await req(t.objectStore('later').count()),
    }));
  }

  async function laterList() {
    return tx(['later'], 'readonly', async (t) => {
      const all = await req(t.objectStore('later').index('addedTs').getAll());
      return all.reverse();
    });
  }

  async function laterUpdate(key, patch) {
    return tx(['later'], 'readwrite', async (t) => {
      const store = t.objectStore('later');
      const cur = await req(store.get(key));
      if (!cur) return null;
      const next = { ...cur, ...patch, key };
      store.put(next);
      return next;
    });
  }

  async function laterRemove(key) {
    return tx(['later'], 'readwrite', (t) => req(t.objectStore('later').delete(key)));
  }

  async function kvGet(k, fallback) {
    const v = await tx(['kv'], 'readonly', (t) => req(t.objectStore('kv').get(k)));
    return v === undefined ? fallback : v;
  }

  async function kvSet(k, v) {
    return tx(['kv'], 'readwrite', (t) => req(t.objectStore('kv').put(v, k)));
  }

  root.OTAAT_DB = {
    open,
    addEvents,
    filterSorted,
    resetSorted,
    eventsAfter,
    eventsForDay,
    lastEventId,
    queryEvents,
    countsFor,
    totals,
    laterList,
    laterUpdate,
    laterRemove,
    kvGet,
    kvSet,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
