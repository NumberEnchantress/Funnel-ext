/* Background event page: message router, file sync, keyboard commands. */
(function () {
  'use strict';

  const S = globalThis.OTAAT_SETTINGS;
  const F = globalThis.OTAAT_FORMAT;
  const DB = globalThis.OTAAT_DB;
  const SINKS = globalThis.OTAAT_SINKS;

  // ---------------------------------------------------------------- settings

  let settingsCache = null;
  async function settings() {
    if (!settingsCache) settingsCache = await S.load(browser.storage.local);
    return settingsCache;
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settingsCache = S.merge(S.DEFAULTS, changes.settings.newValue);
    nativeCheckGen++; // a check still running for the old folder must not overwrite the new state
    nativeState.checkedAt = 0;
    scheduleSync(500);
  });

  /** A random id for this browser's log; lets the native writer recognise lines it already has. */
  async function logId() {
    let id = await DB.kvGet('logId', '');
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await DB.kvSet('logId', id);
    }
    return id;
  }

  // ---------------------------------------------------------------- file sync

  const NATIVE_RECHECK_MS = 60 * 1000;
  const DELAY = { native: 1500, downloads: 20000 };

  const nativeState = { ok: null, checkedAt: 0, error: '', folder: '', version: '' };
  const status = { output: null, lastWriteTs: 0, lastWriteCount: 0, lastError: '', lastErrorTs: 0 };
  let nativeCheckGen = 0;

  async function checkNative(s, force) {
    if (!force && nativeState.ok !== null && Date.now() - nativeState.checkedAt < NATIVE_RECHECK_MS) {
      return nativeState.ok;
    }
    const gen = nativeCheckGen;
    let result;
    try {
      const r = await SINKS.native.hello(s.nativeFolder);
      result = { ok: true, error: '', folder: r.folder || '', version: r.version || '' };
    } catch (e) {
      result = { ok: false, error: String((e && e.message) || e), folder: '', version: '' };
    }
    // Settings changed while we were asking: ask again about the folder that is set now.
    if (gen !== nativeCheckGen) return checkNative(await settings(), true);
    Object.assign(nativeState, result);
    if (result.ok) await DB.kvSet('nativeEverOk', true);
    nativeState.checkedAt = Date.now();
    return nativeState.ok;
  }

  // Firefox for Android: no native messaging, and every download shows a notification there.
  const platformOs = browser.runtime
    .getPlatformInfo()
    .then((p) => p.os)
    .catch(() => '');
  const canDownload = () => !!(browser.downloads && browser.downloads.download);

  /** Which writer to use right now: 'native', 'downloads' or null (wait / keep in the browser). */
  async function chooseOutput(s) {
    if (s.fileOutput === 'off') return null;
    if (s.fileOutput === 'downloads') return canDownload() ? 'downloads' : null;
    // On Android, "automatic" keeps the logs in Firefox (export them from the Logs page) instead of
    // downloading files every few seconds, which would pop up a notification each time.
    if ((await platformOs) === 'android') return null;
    const ok = await checkNative(s);
    if (ok) return 'native';
    if (s.fileOutput === 'native') return null;
    // auto: once the native host has worked, wait for it rather than splitting files across two folders.
    if (await DB.kvGet('nativeEverOk', false)) return null;
    return 'downloads';
  }

  let syncTimer = null;
  let syncDue = 0;
  let syncRunning = null;
  let syncAgain = false;

  // A pending write is never pushed back by new entries (only brought forward), so steady
  // browsing can't postpone writing indefinitely.
  function scheduleSync(delay) {
    const due = Date.now() + delay;
    if (syncTimer && syncDue <= due) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncDue = due;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      runSync().catch(() => {});
    }, delay);
  }

  async function runSync() {
    if (syncRunning) {
      syncAgain = true;
      return syncRunning;
    }
    syncRunning = (async () => {
      try {
        do {
          syncAgain = false;
          await syncOnce();
        } while (syncAgain);
      } finally {
        syncRunning = null;
      }
    })();
    return syncRunning;
  }

  async function syncOnce() {
    const s = await settings();
    const out = await chooseOutput(s);
    status.output = out;
    if (!out) return;
    try {
      const wmKey = watermarkKey(out, s);
      let wm = await DB.kvGet(wmKey, 0);
      for (;;) {
        const batch = await DB.eventsAfter(wm, out === 'native' ? 300 : 5000);
        if (!batch.length) break;
        if (out === 'native') await SINKS.native.write(batch, s.nativeFolder, await logId());
        else await SINKS.downloads.write(batch, s.downloadsFolder, DB);
        wm = batch[batch.length - 1].id;
        await DB.kvSet(wmKey, wm);
        status.lastWriteTs = Date.now();
        status.lastWriteCount = batch.length;
      }
      status.lastError = '';
    } catch (e) {
      status.lastError = String((e && e.message) || e);
      status.lastErrorTs = Date.now();
      if (out === 'native') nativeState.checkedAt = 0;
      throw e;
    }
  }

  /**
   * Progress ("last event written") is remembered per destination folder setting. A folder we haven't
   * written to gets the full history; switching back to an earlier folder carries on where it left off.
   * Re-sending is always safe: the native writer skips lines it already has (per log id and file),
   * and the Downloads writer only rewrites files it created itself.
   */
  function watermarkKey(out, s) {
    const dest =
      out === 'native'
        ? `native:${(s.nativeFolder || '(default)').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}`
        : `downloads:${SINKS.downloads.safeFolder(s.downloadsFolder).toLowerCase()}`;
    return `wm:${dest}`;
  }

  async function fileStatus(forceCheck) {
    const s = await settings();
    if (forceCheck) await checkNative(s, true);
    else if (nativeState.ok === null) await checkNative(s, false);
    const lastId = await DB.lastEventId();
    const out = status.output || (await chooseOutput(s));
    const wm = out ? await DB.kvGet(watermarkKey(out, s), 0) : 0;
    return {
      platform: await platformOs,
      canDownload: canDownload(),
      setting: s.fileOutput,
      output: out,
      pending: out ? Math.max(0, lastId - wm) : lastId,
      native: { ...nativeState },
      nativeEverOk: await DB.kvGet('nativeEverOk', false),
      downloadsFolder: SINKS.downloads.safeFolder(s.downloadsFolder),
      lastWriteTs: status.lastWriteTs,
      lastWriteCount: status.lastWriteCount,
      lastError: status.lastError,
      lastErrorTs: status.lastErrorTs,
    };
  }

  browser.alarms.create('otaat-sync', { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((a) => {
    if (a.name === 'otaat-sync') runSync().catch(() => {});
  });

  // ---------------------------------------------------------------- messages

  async function openPage(page, hash) {
    const base = browser.runtime.getURL(`pages/${page}.html`);
    const url = base + (hash ? `#${hash}` : '');
    try {
      const existing = (await browser.tabs.query({})).find((t) => t.url && t.url.startsWith(base));
      if (existing) {
        await browser.tabs.update(existing.id, { active: true, url });
        if (browser.windows) await browser.windows.update(existing.windowId, { focused: true }); // not on Android
        return;
      }
    } catch (_) {
      /* fall through to a new tab */
    }
    await browser.tabs.create({ url });
  }

  const handlers = {
    async log({ entries }) {
      const s = await settings();
      const list = Array.isArray(entries) ? entries : [];
      const stored = await DB.addEvents(list, s);
      if (stored.length) {
        const out = status.output || (await chooseOutput(s));
        scheduleSync(out === 'downloads' ? DELAY.downloads : DELAY.native);
      }
      // Tell other tabs, so an item sorted here disappears from their feeds too.
      const sortedKeys = stored.filter((e) => e.action !== 'seen').map((e) => e.key);
      if (sortedKeys.length) browser.storage.local.set({ sortedPing: { keys: sortedKeys, ts: Date.now() } }).catch(() => {});
      // `stored` counts entries kept; a repeat sighting dropped by de-duplication still counts as handled.
      return { stored: stored.length, handled: list.length, counts: await DB.countsFor(F.localDate(Date.now())) };
    },
    async filterSorted({ keys }) {
      return { sorted: await DB.filterSorted(Array.isArray(keys) ? keys.slice(0, 2000) : []) };
    },
    async counts() {
      return { counts: await DB.countsFor(F.localDate(Date.now())), date: F.localDate(Date.now()) };
    },
    async totals() {
      return DB.totals();
    },
    async 'events.query'({ filter }) {
      return DB.queryEvents(filter || {});
    },
    async 'later.list'() {
      return { items: await DB.laterList() };
    },
    async 'later.update'({ key, patch }) {
      const allowed = {};
      if (patch && typeof patch.done === 'boolean') {
        allowed.done = patch.done;
        allowed.doneTs = patch.done ? Date.now() : null;
      }
      return { item: await DB.laterUpdate(key, allowed) };
    },
    async 'later.remove'({ key }) {
      await DB.laterRemove(key);
      return { ok: true };
    },
    // YouTube confirmed the Watch Later save: the safety copy on the extension's list isn't needed.
    async 'later.nativeConfirmed'({ key }) {
      if (typeof key === 'string' && key.startsWith('youtube:')) await DB.laterRemove(key);
      return { ok: true };
    },
    async 'sorted.reset'() {
      await DB.resetSorted();
      return { ok: true };
    },
    async 'files.status'({ force }) {
      return fileStatus(!!force);
    },
    async 'files.syncNow'() {
      nativeState.checkedAt = 0;
      try {
        await runSync();
      } catch (_) {
        /* reported through status */
      }
      return fileStatus(false);
    },
    // Write the whole in-browser history again (native: appended; Downloads: its own files rewritten).
    async 'files.rebuild'() {
      const s = await settings();
      const out = await chooseOutput(s);
      if (out) await DB.kvSet(watermarkKey(out, s), 0);
      try {
        await runSync();
      } catch (_) {
        /* reported through status */
      }
      return fileStatus(false);
    },
    async 'files.open'({ path }) {
      const s = await settings();
      const out = await chooseOutput(s);
      if (out === 'native' || (s.fileOutput !== 'downloads' && (await checkNative(s, true)))) {
        await SINKS.native.openFolder(s.nativeFolder, path || '');
        return { ok: true };
      }
      if (out === 'downloads' && browser.downloads.showDefaultFolder) {
        // Firefox can only open the Downloads folder itself; the logs are in the subfolder inside it.
        await browser.downloads.showDefaultFolder();
        return { ok: true, note: `Opened your Downloads folder — the logs are in ${SINKS.downloads.safeFolder(s.downloadsFolder)}.` };
      }
      if ((await platformOs) === 'android') {
        return { ok: false, error: 'On Android your logs are kept in Firefox: use the Export buttons on the Logs page to save them as files.' };
      }
      return { ok: false, error: 'Writing files is turned off, so there is no folder to open.' };
    },
    async openPage({ page, hash }) {
      if (!['logs', 'later', 'options'].includes(page)) throw new Error('unknown page');
      await openPage(page, hash);
      return { ok: true };
    },
  };

  browser.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message.type !== 'string') return undefined;
    // Content scripts may only use the logging/sorting subset.
    const fromPage = sender && sender.url && sender.url.startsWith(browser.runtime.getURL(''));
    const contentAllowed = ['log', 'filterSorted', 'counts', 'openPage', 'later.nativeConfirmed'];
    if (!fromPage && !contentAllowed.includes(message.type)) return undefined;
    const h = handlers[message.type];
    if (!h) return undefined;
    return h(message).catch((e) => ({ error: String((e && e.message) || e) }));
  });

  // ---------------------------------------------------------------- keyboard commands

  // Not available on Firefox for Android (no keyboard shortcuts there).
  if (browser.commands && browser.commands.onCommand) {
    browser.commands.onCommand.addListener(async (name) => {
      const action = { 'otaat-next': 'next', 'otaat-later': 'later', 'otaat-queue': 'queue' }[name];
      if (!action) return;
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab) browser.tabs.sendMessage(tab.id, { type: 'command', name: action }).catch(() => {});
    });
  }

  // ---------------------------------------------------------------- install

  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') openPage('options', 'welcome').catch(() => {});
  });

  // Catch up on anything not yet written (e.g. entries still waiting when Firefox was closed).
  browser.runtime.onStartup.addListener(() => scheduleSync(3000));
  scheduleSync(3000);
})();
