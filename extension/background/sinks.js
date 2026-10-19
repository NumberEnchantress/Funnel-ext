/* File writers: mirror the event log to plain files on disk. */
(function (root) {
  'use strict';

  const F = root.OTAAT_FORMAT;
  const NATIVE_APP = 'one_thing_at_a_time';

  // ---- Native host: appends lines to files in any folder (needs a one-time install) ----

  const native = {
    async call(message) {
      const res = await browser.runtime.sendNativeMessage(NATIVE_APP, message);
      if (!res || res.ok !== true) throw new Error((res && res.error) || 'native host returned no result');
      return res;
    },

    hello(folder) {
      return this.call({ type: 'hello', folder: folder || '' });
    },

    // logId identifies this browser's log, so the host can tell which lines it already has.
    async write(events, folder, logId) {
      const files = F.appendsFor(events);
      return this.call({ type: 'append', folder: folder || '', log: logId, files });
    },

    openFolder(folder, path) {
      return this.call({ type: 'open', folder: folder || '', path: path || '' });
    },
  };

  // ---- Downloads: rewrites whole monthly files in the Downloads folder ----

  function safeFolder(name) {
    const cleaned = String(name || '')
      .split(/[\\/]+/)
      .map((p) => p.replace(/[<>:"|?*\x00-\x1f]/g, '').trim())
      .filter((p) => p && p !== '.' && p !== '..')
      .join('/');
    return cleaned || 'OneThingAtATime';
  }

  function waitForDownload(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        browser.downloads.onChanged.removeListener(onChanged);
        reject(new Error('download timed out'));
      }, 30000);
      function onChanged(delta) {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
          clearTimeout(timer);
          browser.downloads.onChanged.removeListener(onChanged);
          if (delta.state.current === 'complete') resolve();
          else reject(new Error('download interrupted' + (delta.error ? ': ' + delta.error.current : '')));
        }
      }
      browser.downloads.onChanged.addListener(onChanged);
      // It may already be finished.
      browser.downloads.search({ id }).then(([item]) => {
        if (item && item.state === 'complete') {
          clearTimeout(timer);
          browser.downloads.onChanged.removeListener(onChanged);
          resolve();
        }
      });
    });
  }

  /** Save text as a file under the Downloads folder. Returns the file name Firefox actually used. */
  async function saveFile(relPath, text, mime, conflictAction) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    try {
      const d = browser.downloads;
      const id = await d.download({ url, filename: relPath, conflictAction, saveAs: false });
      // Firefox for Android only has part of the downloads API: use what is there.
      if (d.onChanged && d.search) await waitForDownload(id);
      else await new Promise((r) => setTimeout(r, 1500));
      const [item] = d.search ? await d.search({ id }).catch(() => []) : [];
      // Keep Firefox's download list clean; the file itself stays on disk.
      if (d.erase) await d.erase({ id }).catch(() => {});
      return item && item.filename ? item.filename.split(/[\\/]/).pop() : relPath.split('/').pop();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  /**
   * Whole-file rewrites are only safe for files this browser's log created. The first write of each file
   * never overwrites ("skipped.md" exists → Firefox picks "skipped(1).md"); later writes overwrite that
   * exact file. So if the in-browser log is ever wiped, older files on disk are never clobbered.
   */
  async function saveOwned(db, folder, rel, text, mime) {
    const kvKey = `dlname:${folder}/${rel}`;
    const owned = await db.kvGet(kvKey, null);
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
    const name = await saveFile(`${folder}/${dir}${owned || rel.slice(dir.length)}`, text, mime, owned ? 'overwrite' : 'uniquify');
    if (name !== owned) await db.kvSet(kvKey, name);
  }

  const downloads = {
    /** Rewrite each (day, action) file touched by these events, plus that day's events.jsonl. Files stay small. */
    async write(events, folderSetting, db) {
      const folder = safeFolder(folderSetting);
      const touched = new Map(); // day -> Set(actions)
      for (const ev of events) {
        const day = F.dayOf(ev);
        if (!touched.has(day)) touched.set(day, new Set());
        touched.get(day).add(ev.action);
      }
      for (const [day, actions] of touched) {
        const dir = F.dayFolder(day);
        const dayEvents = await db.eventsForDay(day);
        for (const action of actions) {
          const list = dayEvents.filter((e) => e.action === action);
          await saveOwned(db, folder, `${dir}/${action}.md`, F.mdDocument(action, day, list), 'text/markdown');
        }
        await saveOwned(db, folder, `${dir}/events.jsonl`, dayEvents.map(F.jsonlLine).join(''), 'application/x-ndjson');
      }
      return { folder };
    },
    safeFolder,
  };

  root.OTAAT_SINKS = { native, downloads, NATIVE_APP };
})(typeof globalThis !== 'undefined' ? globalThis : this);
