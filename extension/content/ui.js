/*
 * In-page control bar and toasts, isolated in a Shadow DOM so site CSS cannot touch them.
 * Wide screens: one pill with every control. Phones / narrow windows (≤ 640 px): a full-width strip
 * of large Next / Later (/ Queue) buttons plus a ⋯ menu for the rest, sitting above whatever the
 * site pins to the bottom of the screen (YouTube's and X's bottom navigation bars, banners, …).
 */
(function () {
  'use strict';
  const O = globalThis.OTAAT;
  if (O.ui) return;

  const CSS = `
    :host { all: initial; }
    [hidden] { display: none !important; }
    .wrap {
      --gap: 16px;
      position: fixed; left: 50%; transform: translateX(-50%);
      /* (without a width, left: 50% would let the pill grow only to half the window before wrapping) */
      width: max-content; max-width: calc(100vw - 32px);
      z-index: 2147483646; display: flex; flex-direction: column; align-items: center; gap: 8px;
      font: 13px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      pointer-events: none;
    }
    /* Moved beside the site's own controls (see placeClear), wrapping onto more rows if it must. */
    .wrap.docked {
      left: var(--dock-left, 16px); right: var(--dock-right, 16px); width: auto; max-width: none; transform: none;
    }
    .wrap.docked .bar { max-width: 100%; border-radius: 18px; }
    .wrap.docked .sep { display: none; }
    .wrap.bottom {
      bottom: calc(var(--otaat-bottom, 0px) + var(--gap) + env(safe-area-inset-bottom, 0px));
      flex-direction: column-reverse;
    }
    .wrap.top { top: calc(var(--otaat-top, 0px) + 8px + env(safe-area-inset-top, 0px)); }
    .wrap.top .bar { order: -1; }
    /* A site dialog covers the screen: step aside until it closes. */
    .wrap.yield { visibility: hidden; }
    .bar {
      pointer-events: auto; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: center;
      max-width: calc(100vw - 32px); box-sizing: border-box;
      padding: 6px 8px 6px 12px; border-radius: 999px;
      background: rgba(24, 24, 27, 0.95); color: #f4f4f5;
      box-shadow: 0 6px 24px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.08);
    }
    .brand { font-weight: 700; letter-spacing: .02em; color: #a1a1aa; margin-right: 2px; white-space: nowrap; }
    .status { color: #d4d4d8; min-width: 0; white-space: nowrap; margin-right: 4px; }
    .links { display: contents; }
    button, a.btn {
      all: unset; cursor: pointer; box-sizing: border-box; white-space: nowrap;
      padding: 7px 14px; border-radius: 999px; font-weight: 600; font-size: 13px;
      background: #3f3f46; color: #fafafa; text-decoration: none; text-align: center;
      transition: background .12s ease; -webkit-tap-highlight-color: transparent; touch-action: manipulation;
    }
    button:hover, a.btn:hover { background: #52525b; }
    button:focus-visible, a.btn:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }
    button.primary { background: #2563eb; }
    button.primary:hover { background: #1d4ed8; }
    button.queue { background: #b91c1c; }
    button.queue:hover { background: #991b1b; }
    button[disabled] { opacity: .45; cursor: default; }
    .sep { width: 1px; height: 22px; background: rgba(255,255,255,.15); margin: 0 4px; }
    .count { color: #a1a1aa; white-space: nowrap; margin: 0 4px; }
    a.btn.link, button.link { background: transparent; color: #93c5fd; padding: 7px 8px; font-weight: 500; }
    a.btn.link:hover, button.link:hover { background: rgba(255,255,255,.08); }
    .more { display: none; }
    .menu {
      display: none; pointer-events: auto; flex-direction: column; gap: 2px; box-sizing: border-box;
      min-width: 220px; padding: 6px; border-radius: 16px;
      background: rgba(24, 24, 27, 0.98); color: #f4f4f5;
      box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.08);
    }
    .menu.open { display: flex; }
    .menu-head { padding: 8px 12px 6px; color: #a1a1aa; font-size: 13px; }
    .menu button, .menu a.btn {
      background: transparent; border-radius: 10px; padding: 12px; font-size: 15px; font-weight: 500; text-align: left;
    }
    .menu button:hover, .menu a.btn:hover { background: rgba(255,255,255,.08); }
    .toast {
      pointer-events: auto; max-width: min(560px, calc(100vw - 32px)); box-sizing: border-box;
      padding: 8px 14px; border-radius: 10px; background: rgba(24,24,27,.96); color: #fafafa;
      box-shadow: 0 6px 24px rgba(0,0,0,.35); opacity: 0; transition: opacity .15s ease;
    }
    .toast:not(.show) { visibility: hidden; }
    .toast.show { opacity: 1; }
    .toast.ok { box-shadow: 0 0 0 1px #16a34a, 0 6px 24px rgba(0,0,0,.35); }
    .toast.warn { box-shadow: 0 0 0 1px #f59e0b, 0 6px 24px rgba(0,0,0,.35); }
    .toast.err { box-shadow: 0 0 0 1px #ef4444, 0 6px 24px rgba(0,0,0,.35); }

    /* ---- touch screens (tablets too): finger-sized buttons ---- */
    @media (pointer: coarse) {
      button, a.btn { min-height: 44px; padding: 10px 16px; font-size: 15px; }
      a.btn.link, button.link { padding: 10px; }
    }

    /* ---- phones (portrait, or landscape with little height) and narrow windows ---- */
    @media (max-width: 640px), (pointer: coarse) and (max-height: 500px) {
      .wrap {
        --gap: 8px; left: calc(8px + var(--otaat-left, 0px)); right: calc(8px + var(--otaat-right, 0px));
        width: auto; max-width: none; transform: none; align-items: stretch;
      }
      .bar {
        max-width: none; border-radius: 18px; padding: 8px; gap: 8px;
        justify-content: stretch; flex-wrap: wrap;
      }
      .brand, .sep, .count, .links { display: none; }
      .status { display: none; flex: 1 0 100%; margin: 0; text-align: center; font-size: 13px; white-space: normal; }
      .bar.notable .status { display: block; }
      .bar > button.act {
        flex: 1 1 0; min-width: 0; min-height: 48px; padding: 0 8px; border-radius: 12px;
        font-size: 16px; display: flex; align-items: center; justify-content: center;
      }
      .more {
        display: flex; align-items: center; justify-content: center;
        flex: 0 0 48px; min-height: 48px; padding: 0; border-radius: 12px; font-size: 22px; line-height: 1;
      }
      .menu { align-self: flex-end; min-width: min(280px, 100%); }
      .toast { align-self: center; max-width: 100%; font-size: 14px; }
    }
  `;

  let host = null;
  let root = null;
  let els = {};
  let actionHandler = () => {};
  let toastTimer = null;
  let state = { visible: false };

  function h(tag, attrs = {}, text = '') {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    if (text) el.textContent = text;
    return el;
  }

  // Logs / Watch later / Later list: inline on wide screens, in the ⋯ menu on narrow ones.
  function linkSet(menu) {
    const cls = menu ? '' : 'link';
    return {
      logs: h('button', { class: cls, 'data-act': 'logs', title: 'Open your logs' }, 'Logs'),
      laterLink: h('a', { class: `btn ${cls}`, target: '_blank', rel: 'noopener', hidden: true }),
      laterList: h('button', { class: cls, 'data-act': 'later-list', title: "Open the extension's Later list" }, 'Later list'),
    };
  }

  function build() {
    // A plain <div> host: some sites hide undefined custom elements (`:not(:defined)`).
    host = document.createElement('div');
    host.setAttribute('data-otaat-bar', '');
    for (const [prop, value] of [
      ['all', 'initial'],
      ['display', 'block'],
      ['visibility', 'visible'],
      ['opacity', '1'],
      ['position', 'static'],
    ]) {
      host.style.setProperty(prop, value, 'important');
    }
    root = host.attachShadow({ mode: 'open' });
    const style = h('style');
    style.textContent = CSS;
    const inline = linkSet(false);
    const menuLinks = linkSet(true);
    els = {
      wrap: h('div', { class: 'wrap bottom' }),
      bar: h('div', { class: 'bar', role: 'toolbar', 'aria-label': 'One Thing At A Time' }),
      brand: h('span', { class: 'brand', title: 'One Thing At A Time' }, '1 at a time'),
      status: h('span', { class: 'status', 'aria-live': 'polite' }),
      next: h('button', { class: 'act primary', 'data-act': 'next', title: 'Next: log as skipped and show the next item (Alt+Shift+N)' }, 'Next →'),
      later: h('button', { class: 'act', 'data-act': 'later', title: 'Later: save for later and show the next item (Alt+Shift+L)' }, 'Later'),
      queue: h('button', { class: 'act queue', 'data-act': 'queue', title: "Queue: add to YouTube's play queue (Alt+Shift+Q)", hidden: true }, 'Queue'),
      sep: h('span', { class: 'sep' }),
      count: h('span', { class: 'count', title: 'Items sorted today' }),
      links: h('span', { class: 'links' }),
      more: h('button', { class: 'more', 'data-act': 'more', 'aria-label': 'More: logs and Later lists', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, '⋯'),
      menu: h('div', { class: 'menu', role: 'menu' }),
      menuHead: h('div', { class: 'menu-head' }),
      inline,
      menuLinks,
      toast: h('div', { class: 'toast', role: 'status' }),
    };
    els.links.append(inline.logs, inline.laterLink, inline.laterList);
    els.menu.append(els.menuHead, menuLinks.logs, menuLinks.laterLink, menuLinks.laterList);
    els.bar.append(els.brand, els.status, els.next, els.later, els.queue, els.sep, els.count, els.links, els.more);
    els.wrap.append(els.bar, els.menu, els.toast);
    root.append(style, els.wrap);

    root.addEventListener('click', (e) => {
      const target = e.target.closest('button[data-act], a.btn');
      if (!target) return;
      if (target.matches('a.btn')) {
        setMenu(false); // a normal link: let it open, just close the menu
        return;
      }
      // Only real clicks/taps (or Enter/Space on a focused button): page scripts can't press these for you.
      if (target.disabled || !e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      if (target.dataset.act === 'more') {
        setMenu(!els.menu.classList.contains('open'));
        return;
      }
      setMenu(false);
      actionHandler(target.dataset.act);
    });
    // Keep site keyboard shortcuts from firing while the bar has focus; Escape closes the menu.
    for (const type of ['keydown', 'keyup', 'keypress']) {
      root.addEventListener(type, (e) => {
        if (type === 'keydown' && e.key === 'Escape') setMenu(false);
        e.stopPropagation();
      });
    }
    // A tap anywhere else closes the menu (taps inside the shadow root are retargeted to the host).
    document.addEventListener('pointerdown', (e) => {
      if (e.target !== host) setMenu(false);
    }, true);
    window.addEventListener('resize', scheduleMeasure, { passive: true });
    window.addEventListener('scroll', scheduleMeasure, { passive: true });
  }

  function setMenu(open) {
    if (!els.menu) return;
    els.menu.classList.toggle('open', open);
    els.more.setAttribute('aria-expanded', String(open));
  }

  function attach() {
    if (!host) build();
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
  }

  // ---- keep clear of the site's own fixed bars, floating buttons and sheets

  const DIALOG = '[role="dialog"], [aria-modal="true"], dialog';

  /**
   * Looks at what the site has pinned along the bottom (and top) edge of the screen:
   *  - bottom: how far to lift the bar (navigation bars, banners, floating buttons, bottom sheets),
   *  - top: how far down to put it when it sits at the top (headers),
   *  - overlay: a dialog covers the screen, so the bar steps aside until it closes.
   */
  function scanEdges() {
    const H = window.innerHeight;
    const W = window.innerWidth;
    const memo = new Map(); // element -> its fixed/sticky ancestor (or null); shared ancestors are walked once
    const fixedAncestor = (el) => {
      const path = [];
      let found = null;
      for (let p = el; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        if (memo.has(p)) {
          found = memo.get(p);
          break;
        }
        path.push(p);
        const pos = getComputedStyle(p).position;
        if (pos === 'fixed' || pos === 'sticky') {
          found = p;
          break;
        }
      }
      for (const p of path) memo.set(p, found);
      return found;
    };
    const topmost = (x, y) => {
      for (const el of document.elementsFromPoint(Math.round(x), Math.round(y))) if (el !== host) return el;
      return null;
    };
    const done = new Set();
    let bottom = 0;
    let top = 0;
    let overlay = false;
    const visit = (x, y, edge) => {
      const hit = topmost(x, y);
      const f = hit && fixedAncestor(hit);
      if (!f || done.has(f)) return;
      done.add(f);
      const r = f.getBoundingClientRect();
      if (r.height > H * 0.7) {
        // A full-screen layer: a dialog means "step aside"; anything else (an app shell) is ignored.
        if (f.matches(DIALOG) || f.querySelector(DIALOG)) overlay = true;
        return;
      }
      if (edge === 'bottom' && r.top > H * 0.25) bottom = Math.max(bottom, H - r.top);
      if (edge === 'top' && r.bottom < H * 0.4) top = Math.max(top, r.bottom);
    };
    // A site menu or dialog dims the whole page with a full-screen layer: if that layer itself is what's
    // on top in the middle of the screen (an app shell would have its content on top instead), step aside.
    const mid = topmost(W / 2, H / 2);
    if (mid && mid === fixedAncestor(mid)) {
      const r = mid.getBoundingClientRect();
      if (r.height > H * 0.7 && r.width > W * 0.9) overlay = true;
    }
    // Several heights: things that float a little above the edge (compose buttons, mini-players) count too.
    for (const dy of [3, 40, 80, 120]) for (const fx of [0.1, 0.5, 0.9]) visit(W * fx, H - dy, 'bottom');
    for (const dy of [3, 40]) for (const fx of [0.1, 0.5, 0.9]) visit(W * fx, dy, 'top');
    if (!overlay) {
      for (const d of document.querySelectorAll('[aria-modal="true"], dialog[open]')) {
        const r = d.getBoundingClientRect();
        if (r.width * r.height > W * H * 0.25 && getComputedStyle(d).visibility !== 'hidden') overlay = true;
      }
    }
    return { bottom: Math.round(Math.min(bottom, H * 0.6)), top: Math.round(Math.min(top, H * 0.4)), overlay };
  }

  // ---- keep clear of the site's controls drawn over its content (e.g. a Short's title and buttons)

  /** On-screen boxes of what the site adapter says the bar must not cover. */
  function clearRects() {
    if (!state.keepClear) return [];
    const W = window.innerWidth;
    const H = window.innerHeight;
    return [...document.querySelectorAll(state.keepClear)]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < H && r.right > 0 && r.left < W);
  }

  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const DOCK_MIN = 300; // narrowest free stretch worth moving into (the bar wraps onto more rows there)
  const DOCK_BAND = 220; // how far up from the bottom the bar may reach once wrapped

  /**
   * If the bar would cover any of them: beside them when the bottom edge has room (a Short in the middle of
   * a wide window: the widest free stretch), otherwise above them, out of any column of buttons along a side
   * (a Short on a phone). Returns how far up the bar must sit.
   */
  function placeClear(bottom) {
    const wrap = els.wrap;
    wrap.classList.remove('docked');
    for (const v of ['--dock-left', '--dock-right', '--otaat-left', '--otaat-right']) wrap.style.removeProperty(v);
    if (state.position === 'top') return bottom;
    const rects = clearRects();
    if (!rects.some((r) => overlaps(r, els.bar.getBoundingClientRect()))) return bottom;
    const W = window.innerWidth;
    const H = window.innerHeight;

    const bandTop = H - bottom - DOCK_BAND;
    const blocked = rects
      .filter((r) => r.top < H - bottom && r.bottom > bandTop)
      .map((r) => [r.left, r.right])
      .sort((a, b) => a[0] - b[0]);
    let best = [0, 0];
    let x = 0;
    for (const [l, r] of [...blocked, [W, W]]) {
      if (l - x > best[1] - best[0]) best = [x, l];
      x = Math.max(x, r);
    }
    if (best[1] - best[0] >= DOCK_MIN) {
      wrap.classList.add('docked');
      wrap.style.setProperty('--dock-left', `${Math.round(Math.max(0, best[0])) + 16}px`);
      wrap.style.setProperty('--dock-right', `${Math.round(Math.max(0, W - best[1])) + 16}px`);
      return bottom;
    }

    for (const r of rects) if (r.width >= W * 0.5 && r.top > H * 0.4) bottom = Math.max(bottom, Math.round(H - r.top));
    bottom = Math.min(bottom, Math.round(H * 0.6));
    const barH = els.bar.getBoundingClientRect().height || 64;
    const zoneTop = H - bottom - barH - 16;
    let left = 0;
    let right = 0;
    for (const r of rects) {
      if (r.width >= W * 0.5 || r.top >= H - bottom || r.bottom <= zoneTop) continue;
      if (r.left + r.width / 2 > W / 2) right = Math.max(right, Math.round(W - r.left));
      else left = Math.max(left, Math.round(r.right));
    }
    if (left) wrap.style.setProperty('--otaat-left', `${left}px`);
    if (right) wrap.style.setProperty('--otaat-right', `${right}px`);
    return bottom;
  }

  let measureTimer = null;
  let measured = false;
  function scheduleMeasure() {
    if (measureTimer || !state.visible) return;
    measureTimer = setTimeout(() => {
      measureTimer = null;
      measure();
    }, 250);
  }

  // Sheets and dialogs often appear outside the feed (e.g. X's #layers), so watch the whole page cheaply.
  const pageWatcher = new MutationObserver(scheduleMeasure);

  function measure() {
    if (!host || !state.visible) return;
    measured = true;
    try {
      const edges = scanEdges();
      els.wrap.style.setProperty('--otaat-bottom', `${edges.bottom}px`);
      els.wrap.style.setProperty('--otaat-top', `${edges.top}px`);
      const bottom = placeClear(edges.bottom);
      if (bottom !== edges.bottom) els.wrap.style.setProperty('--otaat-bottom', `${bottom}px`);
      els.wrap.classList.toggle('yield', edges.overlay);
      if (edges.overlay) setMenu(false);
    } catch (_) {
      /* elementsFromPoint can fail on odd documents; keep the last values */
    }
  }

  O.ui = {
    onAction(fn) {
      actionHandler = fn;
    },

    update(next) {
      state = { ...state, ...next };
      if (!state.visible) {
        setMenu(false);
        pageWatcher.disconnect();
        measured = false;
        if (host && host.isConnected) host.remove();
        return;
      }
      attach();
      pageWatcher.observe(document.documentElement, { childList: true, subtree: true });
      els.wrap.className = `wrap ${state.position === 'top' ? 'top' : 'bottom'}`;
      els.status.textContent = state.status || '';
      els.bar.classList.toggle('notable', !!state.statusNotable);
      els.next.disabled = !state.nextEnabled;
      els.later.disabled = !state.laterEnabled;
      els.queue.hidden = !state.showQueue;
      els.queue.disabled = !state.queueEnabled;
      els.count.textContent = state.countText || '';
      els.menuHead.textContent = [state.status, state.countText].filter(Boolean).join(' · ');
      // The site's own later queue (YouTube Watch later), when there is one; the extension's list always.
      for (const set of [els.inline, els.menuLinks]) {
        set.laterLink.hidden = !state.laterHref;
        if (state.laterHref) {
          set.laterLink.href = state.laterHref;
          set.laterLink.textContent = state.laterLabel || 'Later';
          set.laterLink.title = state.laterTitle || '';
        }
      }
      if (!measured) measure();
      else scheduleMeasure();
    },

    toast(text, kind = 'info', ms = 2800) {
      if (!state.visible) attach();
      els.toast.textContent = text;
      els.toast.className = `toast show ${kind}`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        els.toast.className = 'toast';
        if (!state.visible && host) host.remove();
      }, ms);
    },

    /** Pixels at the bottom of the screen covered by the bar (so content can be kept clear of it). */
    reservedBottom() {
      if (!host || !host.isConnected || !state.visible || state.position === 'top') return 16;
      const r = els.bar.getBoundingClientRect();
      return r.height ? Math.max(16, Math.round(window.innerHeight - r.top + 8)) : 84;
    },

    /** Pixels at the top of the screen covered by the bar when it sits at the top. */
    reservedTop() {
      if (!host || !host.isConnected || !state.visible || state.position !== 'top') return 0;
      const r = els.bar.getBoundingClientRect();
      return r.height ? Math.round(r.bottom + 8) : 0;
    },

    isOwn(node) {
      return !!(node && host && (node === host || host.contains(node)));
    },
  };
})();
