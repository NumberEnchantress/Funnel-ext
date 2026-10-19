/* Test helpers: a jsdom page with the content scripts loaded and a fake `browser` API. */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');

const CONTENT_SCRIPTS = [
  'shared/settings.js',
  'content/core.js',
  'content/ui.js',
  'content/sites/youtube.js',
  'content/sites/reddit.js',
  'content/sites/x.js',
  'content/engine.js',
];

const read = (rel) => fs.readFileSync(path.join(EXT, rel), 'utf8');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake background: records log entries, answers sorted-status checks. */
function fakeBrowser({ settings, sorted = [], logDelay = 0 } = {}) {
  const sortedSet = new Set(sorted);
  const logged = [];
  const opened = [];
  const messageListeners = [];
  const storageListeners = [];
  const counts = { seen: 0, skipped: 0, deferred: 0, queued: 0 };
  const api = {
    logged,
    opened,
    confirmed: [],
    sortedSet,
    messageListeners,
    /** Simulate a storage.local change (settings, or another tab's sortedPing). */
    fireStorage(changes) {
      for (const fn of storageListeners) fn(changes, 'local');
    },
    storage: {
      local: {
        get: async () => ({ settings }),
        set: async () => {},
      },
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },
    runtime: {
      id: 'test@otaat',
      getURL: (p) => `moz-extension://test/${p}`,
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      async sendMessage(msg) {
        if (logDelay && msg.type === 'log') await sleep(logDelay);
        switch (msg.type) {
          case 'log':
            for (const e of msg.entries) {
              logged.push(e);
              counts[e.action]++;
              if (e.action !== 'seen') sortedSet.add(e.item.key);
            }
            return { stored: msg.entries.length, counts: { ...counts } };
          case 'filterSorted':
            return { sorted: msg.keys.filter((k) => sortedSet.has(k)) };
          case 'counts':
            return { counts: { ...counts } };
          case 'openPage':
            opened.push(msg.page);
            return { ok: true };
          case 'later.nativeConfirmed':
            api.confirmed.push(msg.key);
            return { ok: true };
          default:
            return { error: `unhandled ${msg.type}` };
        }
      },
    },
  };
  return api;
}

/**
 * Build a page at `url` with `bodyHtml`, then load the content scripts (and optionally YouTube's page bridge).
 */
function makePage({ url, bodyHtml, settings, sorted, logDelay, withBridge = false, beforeScripts }) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${bodyHtml}</body></html>`, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const browser = fakeBrowser({ settings, sorted, logDelay });
  window.browser = browser;
  window.scrollTo = () => {};
  window.document.elementsFromPoint = () => [];
  window.IntersectionObserver = class {
    constructor(cb) {
      this.cb = cb;
      this.els = new Set();
    }
    observe(el) {
      this.els.add(el);
    }
    unobserve(el) {
      this.els.delete(el);
    }
    disconnect() {
      this.els.clear();
    }
  };
  if (beforeScripts) beforeScripts(window);
  if (withBridge) window.eval(read('content/yt-main.js'));
  for (const rel of CONTENT_SCRIPTS) window.eval(read(rel));
  openWindows.push(window);
  return { dom, window, document: window.document, browser };
}

const openWindows = [];
/** Close every page (stops the engine's timers so the test process can exit). */
function closeAll() {
  while (openWindows.length) {
    const w = openWindows.pop();
    if (w.OTAAT && w.OTAAT.engine) w.OTAAT.engine.stop();
    w.close();
  }
}

// Work still in flight in a page that a test already closed (it has no document any more) is not a failure.
process.on('unhandledRejection', (e) => {
  if (!/is not defined|reading 'body'|reading 'documentElement'|reading 'querySelector'/.test(String(e && e.message))) throw e;
});

/** Load a plain shared module (settings / format) into Node. */
function shared(name) {
  return require(path.join(EXT, 'shared', name));
}

/** Wait until fn() is truthy (polling), or fail with a message. */
async function until(fn, message, timeout = 4000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${message}`);
    await sleep(25);
  }
}

module.exports = { makePage, closeAll, fixture, sleep, shared, until, read, EXT, ROOT };
