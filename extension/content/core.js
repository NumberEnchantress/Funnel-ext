/* Content-script core: namespace, small utilities, settings and messaging. */
(function () {
  'use strict';
  if (globalThis.OTAAT) return;

  const O = (globalThis.OTAAT = { adapters: {} });

  O.util = {
    text(el) {
      return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    },

    /** Shorten to at most n UTF-16 units without cutting an emoji in half. */
    cut(text, n) {
      const s = String(text == null ? '' : text);
      if (s.length <= n) return s;
      const code = s.charCodeAt(n - 1);
      return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
    },

    attr(el, name) {
      return el ? el.getAttribute(name) || '' : '';
    },

    abs(href) {
      try {
        return new URL(href, location.origin).href;
      } catch (_) {
        return '';
      }
    },

    sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    },

    /** Poll fn() until it returns a truthy value (or timeout → null). */
    async waitFor(fn, { timeout = 5000, interval = 100 } = {}) {
      const end = Date.now() + timeout;
      for (;;) {
        let v = null;
        try {
          v = fn();
        } catch (_) {
          v = null;
        }
        if (v) return v;
        if (Date.now() >= end) return null;
        await new Promise((r) => setTimeout(r, interval));
      }
    },

    /** Run fn at most once per `ms`, trailing call guaranteed. */
    throttle(fn, ms) {
      let timer = null;
      let last = 0;
      return function throttled() {
        const now = Date.now();
        const wait = Math.max(0, last + ms - now);
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          fn();
        }, wait);
      };
    },

    setFlag(name, on, value = '') {
      const root = document.documentElement;
      if (!root) return;
      if (on) {
        if (root.getAttribute(name) !== value) root.setAttribute(name, value);
      } else if (root.hasAttribute(name)) {
        root.removeAttribute(name);
      }
    },

    /** Access a page-world property in Firefox (X-ray waiver), safely. */
    pageObj(el) {
      try {
        return el && el.wrappedJSObject ? el.wrappedJSObject : el;
      } catch (_) {
        return el;
      }
    },
  };

  O.send = async function send(type, payload = {}) {
    try {
      const res = await browser.runtime.sendMessage({ type, ...payload });
      if (res && res.error) throw new Error(res.error);
      return res;
    } catch (e) {
      console.warn('[One Thing At A Time]', type, e);
      return null;
    }
  };

  // Settings: start from defaults synchronously so CSS gating is right from document_start.
  O.settings = globalThis.OTAAT_SETTINGS.merge(globalThis.OTAAT_SETTINGS.DEFAULTS, null);
  O.settingsReady = globalThis.OTAAT_SETTINGS.load(browser.storage.local)
    .then((s) => (O.settings = s))
    .catch(() => O.settings);

  const settingsListeners = new Set();
  O.onSettings = (fn) => settingsListeners.add(fn);
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    O.settings = globalThis.OTAAT_SETTINGS.merge(globalThis.OTAAT_SETTINGS.DEFAULTS, changes.settings.newValue);
    for (const fn of settingsListeners) {
      try {
        fn(O.settings);
      } catch (e) {
        console.warn('[One Thing At A Time] settings listener', e);
      }
    }
  });
})();
