/* Helpers shared by the extension pages. */
(function () {
  'use strict';

  async function send(type, payload = {}) {
    const res = await browser.runtime.sendMessage({ type, ...payload });
    if (res && res.error) throw new Error(res.error);
    return res;
  }

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function relTime(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
  }

  // Only ever link to the sites this extension works with.
  function safeUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
    } catch (_) {
      return '';
    }
  }

  function download(filename, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Firefox for Android: pages are full-screen and some desktop-only controls are hidden (class "android").
  const platform = browser.runtime
    .getPlatformInfo()
    .then((p) => p.os)
    .catch(() => '');
  platform.then((os) => {
    if (os === 'android') document.documentElement.classList.add('android');
  });

  window.PAGE = { send, h, relTime, safeUrl, download, platform };
})();
