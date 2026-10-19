/*
 * The engine: picks the site adapter, shows one feed item at a time, handles Next / Later / Queue,
 * logs everything shown, and logs items seen on normal pages.
 */
(function () {
  'use strict';
  const O = globalThis.OTAAT;
  const U = O.util;
  if (O.engine) return;

  const adapter = Object.values(O.adapters).find((a) => a.matches(location.hostname));
  if (!adapter) return;
  const SITE = adapter.site;

  const BUFFER = 3; // keep at least this many unsorted items loaded ahead
  const MAX_EMPTY_BATCHES = 25; // stop loading after this many batches with nothing new to show
  // Timings (tests shorten them through the content-script global; web pages can't reach it).
  const T = Object.assign({ load: 10000, retry: 30000, grace: 5000, retire: 60000 }, globalThis.OTAAT_TEST_TIMING || {});
  const LOAD_TIMEOUT = T.load;
  const RETRY_AFTER = T.retry; // after a feed seemed to end, try loading again after this long
  const FEED_GRACE = T.grace; // if no feed is found by then, stop hiding and show the page normally

  const state = {
    gen: 0,
    url: '',
    surface: { name: 'other', kind: 'other' },
    quantize: false,
    list: [],
    current: null,
    currentInfo: null,
    pathMarks: [],
    nativeInfo: null,
    shownCount: 0,
    sorted: new Set(), // keys sorted (from history or this session)
    checked: new Set(), // keys whose sorted-status is known
    checking: new Set(),
    pageSeen: new Set(), // keys logged as seen during this page visit
    hiddenSeen: new Map(), // items shown while the tab was in the background (logged once it is looked at)
    loading: false,
    ended: false,
    emptyBatches: 0,
    busy: false,
    counts: null,
  };

  const infoCache = new WeakMap(); // el -> { sig, info }

  // Background work never throws into the page; problems go to the console.
  const quiet = (e) => {
    if (!state.stopped) console.warn('[One Thing At A Time]', e);
  };

  function getInfo(el) {
    const sig = adapter.signature(el);
    const hit = infoCache.get(el);
    if (hit && hit.sig === sig) return hit.info;
    let info = null;
    try {
      info = sig ? adapter.info(el) : null;
    } catch (e) {
      info = null;
    }
    // Don't cache incomplete extractions; the element may still be rendering.
    if (info && info.title) infoCache.set(el, { sig, info });
    return info;
  }

  // ---------------------------------------------------------------- flags on <html> (drive hide.css)

  function applyFlags() {
    const s = O.settings;
    const h = s.hide;
    U.setFlag('otaat-site', true, SITE);
    U.setFlag('otaat-surface', true, state.surface.name);
    U.setFlag('otaat-q', state.quantize && state.surface.mode !== 'native' && !state.feedMissing, state.surface.name);
    U.setFlag('otaat-mode', state.quantize, state.surface.mode || '');
    U.setFlag('otaat-hide-ads', h.ads);
    U.setFlag('otaat-hide-yt-related', SITE === 'youtube' && h.ytRelated);
    U.setFlag('otaat-hide-yt-endscreen', SITE === 'youtube' && h.ytEndscreen);
    U.setFlag('otaat-hide-yt-search', SITE === 'youtube' && h.ytSearchShelves);
    U.setFlag('otaat-hide-reddit-related', SITE === 'reddit' && h.redditRelated);
    U.setFlag('otaat-hide-reddit-sidebar', SITE === 'reddit' && h.redditSidebar);
    U.setFlag('otaat-hide-x-sidebar', SITE === 'x' && h.xSidebar);
    U.setFlag('otaat-hide-x-discover', SITE === 'x' && h.xDiscover);
    U.setFlag('otaat-retiring', retired.size > 0); // a feed just left is still on screen (see retire())
  }

  // ---------------------------------------------------------------- logging

  let seenQueue = [];
  let seenTimer = null;

  function logSeen(info, surfaceName) {
    if (!info || !info.key || state.pageSeen.has(info.key)) return;
    // A tab loading in the background hasn't been seen yet: hold it until the tab is looked at.
    if (document.hidden) {
      state.hiddenSeen.set(info.key, { info, surfaceName, url: location.href });
      return;
    }
    state.pageSeen.add(info.key);
    seenQueue.push({ action: 'seen', item: info, surface: surfaceName, pageUrl: location.href, ts: Date.now() });
    scheduleSeenFlush(250);
  }

  function scheduleSeenFlush(ms) {
    if (!seenTimer) seenTimer = setTimeout(() => flushSeen().catch(quiet), ms);
  }

  async function flushSeen() {
    seenTimer = null;
    if (!seenQueue.length) return;
    const entries = seenQueue;
    seenQueue = [];
    const res = await O.send('log', { entries });
    if (!res) {
      // Keep them for the next attempt rather than losing them.
      seenQueue = entries.concat(seenQueue);
      scheduleSeenFlush(3000);
    } else {
      setCounts(res.counts);
    }
  }

  // Don't lose a pending batch when the tab is closed or navigated away.
  window.addEventListener('pagehide', () => {
    if (seenQueue.length) flushSeen().catch(quiet);
  });

  // When a background tab is first looked at: log what is on screen now.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || state.stopped) return;
    const held = [...state.hiddenSeen.values()];
    state.hiddenSeen.clear();
    for (const h of held) {
      const k = h.info.key;
      const onScreen =
        (state.currentInfo && state.currentInfo.key === k) ||
        (state.nativeInfo && state.nativeInfo.key === k) ||
        (state.surface.kind === 'detail' && h.url === location.href);
      if (onScreen) logSeen(h.info, h.surfaceName);
    }
    // Sightings: observing afresh reports everything currently on screen.
    if (sightings.active) sightings.start();
  });

  function setCounts(counts) {
    if (!counts) return;
    state.counts = counts;
    updateBar();
  }

  // ---------------------------------------------------------------- sorted-status checks

  async function checkSorted(keys) {
    keys.forEach((k) => state.checking.add(k));
    let sorted = [];
    if (O.settings.skipSorted) {
      const res = await O.send('filterSorted', { keys });
      if (!res) {
        // Background unreachable: try again shortly instead of guessing.
        keys.forEach((k) => state.checking.delete(k));
        setTimeout(scheduleScan, 1000);
        return;
      }
      sorted = res.sorted || [];
    }
    sorted.forEach((k) => state.sorted.add(k));
    keys.forEach((k) => {
      state.checking.delete(k);
      state.checked.add(k);
    });
    scheduleScan();
  }

  // ---------------------------------------------------------------- feed scanning

  function scan() {
    if (state.stopped) return;
    if (refreshList()) ensureCurrent();
    else updateBar();
  }

  /** Collect the feed's items in order. Returns false when there is no feed to work on. */
  function refreshList() {
    if (!state.quantize || state.surface.mode === 'native') return false;
    const root = adapter.feedRoot();
    if (!root) {
      state.root = null;
      state.list = [];
      // The site's page doesn't look the way we expect: stop hiding, so it shows normally (still logged).
      if (!state.feedMissing && Date.now() - state.setupAt >= FEED_GRACE) {
        state.feedMissing = true;
        applyFlags();
      }
      return false;
    }
    if (state.feedMissing) {
      state.feedMissing = false;
      applyFlags();
    }
    const { away, stale } = leftovers(root);
    if (away.some((box) => box === root || box.contains(root))) return waitForLeaving(away);
    let items = adapter.items(root);
    if (away.length || stale.length) {
      const own = items.filter((el) => ![...away, ...stale].some((box) => box.contains(el)));
      if (own.length || away.length) items = own;
      else stale.forEach(unretire); // nothing else here after all: it is this page's feed
    }
    if (away.length && !items.length) return waitForLeaving(away);
    state.root = root;
    const unknown = [];
    const list = [];
    for (const el of items) {
      if (!el.hasAttribute('otaat-item')) el.setAttribute('otaat-item', '');
      const info = getInfo(el);
      if (!info) continue;
      list.push({ el, info, ad: adapter.isAd(el), sig: adapter.signature(el) });
      if (!state.checked.has(info.key) && !state.checking.has(info.key)) unknown.push(info.key);
    }
    state.list = list;
    if (unknown.length) checkSorted(unknown).catch(quiet);
    return true;
  }

  const scheduleScan = U.throttle(scan, 120);

  function eligible(x) {
    if (x.ad && O.settings.hide.ads) return false;
    if (adapter.hiddenBySite ? adapter.hiddenBySite(x.el) : x.el.hasAttribute('hidden')) return false;
    return !state.sorted.has(x.info.key);
  }

  /** First unsorted item in feed order. undefined = must wait for a sorted-status check. */
  function pickNext() {
    for (const x of state.list) {
      if (!eligible(x)) continue;
      if (!state.checked.has(x.info.key)) return undefined;
      return x;
    }
    return null;
  }

  function pendingAfterCurrent() {
    let n = 0;
    let passed = !state.current;
    for (const x of state.list) {
      if (x.el === state.current) {
        passed = true;
        continue;
      }
      if (passed && eligible(x)) n++;
    }
    return n;
  }

  // The current item stays while it is unsorted, or when it was queued with "Queue moves on" turned off.
  const stillWanted = (key) => !state.sorted.has(key) || key === state.keepKey;

  function ensureCurrent() {
    if (state.busy) return;
    if (state.current) {
      const entry = state.list.find((x) => x.el === state.current);
      if (entry && state.current.isConnected && entry.info.key === state.currentInfo.key && stillWanted(entry.info.key)) {
        keepMarks();
        topUp();
        updateBar();
        return;
      }
      // The site re-used or removed the element: follow the same item if it moved.
      const same = state.list.find((x) => x.info.key === state.currentInfo.key && stillWanted(x.info.key));
      clearCurrent();
      if (same) {
        setCurrent(same, false);
        return;
      }
    }
    const next = pickNext();
    if (next) setCurrent(next, true);
    else if (next === null) requestMore();
    updateBar();
  }

  function setCurrent(x, isNew) {
    clearCurrent();
    state.current = x.el;
    state.currentInfo = x.info;
    keepMarks();
    if (isNew && x.info.key !== state.lastShownKey) state.shownCount++;
    state.lastShownKey = x.info.key;
    reveal(x.el);
    logSeen(x.info, state.surface.name);
    topUp();
    updateBar();
  }

  function keepMarks() {
    const el = state.current;
    if (!el) return;
    if (!el.hasAttribute('otaat-current')) el.setAttribute('otaat-current', '');
    const root = adapter.feedRoot();
    const marks = [];
    for (let p = el.parentElement; p && p !== root && p !== document.body; p = p.parentElement) {
      if (!p.hasAttribute('otaat-has-current')) p.setAttribute('otaat-has-current', '');
      marks.push(p);
    }
    for (const old of state.pathMarks) if (!marks.includes(old)) old.removeAttribute('otaat-has-current');
    state.pathMarks = marks;
  }

  function clearCurrent() {
    if (state.current) state.current.removeAttribute('otaat-current');
    for (const p of state.pathMarks) p.removeAttribute('otaat-has-current');
    state.pathMarks = [];
    state.current = null;
    state.currentInfo = null;
  }

  function clearAllMarks() {
    // Every mark, including ones on elements the site has already removed (it may put them back later).
    // Marks inside a retired feed stay until it is gone (see retire()).
    for (const el of [...document.querySelectorAll('[otaat-current], [otaat-has-current]'), state.current, ...state.pathMarks]) {
      if (!el) continue;
      const box = el.closest('[otaat-retired]');
      if (box && retired.has(box)) continue;
      el.removeAttribute('otaat-current');
      el.removeAttribute('otaat-has-current');
    }
    // Left over from a feed no longer tracked (e.g. by the previous copy of this script, before an update).
    for (const box of document.querySelectorAll('[otaat-retired]')) if (!retired.has(box)) unretire(box);
    state.pathMarks = [];
    state.current = null;
    state.currentInfo = null;
  }

  // ---------------------------------------------------------------- leaving a feed without a flash

  /*
   * When you open an item (or navigate anywhere else), the address changes at once but the site keeps the
   * old feed on screen until the new page is ready (YouTube: ~0.2 s, longer on slow connections; X keeps
   * the timeline behind a post's photo viewer or the compose box). If the feed's hiding were switched off
   * with the address, every item in it would flash into view. Instead the old feed's container is
   * "retired": it stays one-at-a-time, on its own, until the site hides or removes it, or fills it with the
   * next page's content. Only that container is affected, so the new page shows normally.
   */
  const RETIRE_MAX = T.retire; // safety net for a retired feed that changed but wasn't recognised as a new page
  const LEAVE_WAIT = FEED_GRACE; // the longest a new feed waits for the old one (in the same place) to go
  const retired = new Map(); // container -> { since, page, surface, base: Map(item -> signature), anchor, sig, key, shown }
  const SIG_ATTRS = ['href', 'id', 'data-href']; // what the adapters' signatures are read from
  const pageOf = (href) => {
    const u = new URL(href);
    return (u.origin + u.pathname.replace(/\/+$/, '')).toLowerCase();
  };

  // Watches only the retired containers, so a site re-using one for the next page is noticed straight away.
  const retiredWatch = new MutationObserver(() => checkRetired(true));
  function watchRetired() {
    if (retiredWatch.takeRecords().length) scheduleRetiredCheck();
    retiredWatch.disconnect();
    for (const box of retired.keys()) {
      retiredWatch.observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: SIG_ATTRS });
    }
  }

  function markShown(box, el) {
    el.setAttribute('otaat-current', '');
    for (let p = el.parentElement; p && p !== box; p = p.parentElement) p.setAttribute('otaat-has-current', '');
  }

  function clearMarksIn(box) {
    for (const el of [box, ...box.querySelectorAll('[otaat-current], [otaat-has-current]')]) {
      el.removeAttribute('otaat-current');
      el.removeAttribute('otaat-has-current');
    }
  }

  function retire() {
    const root = state.root;
    const box = root && root.isConnected && (adapter.retireRoot ? adapter.retireRoot(root, state.current) : root);
    if (!box) return;
    // What the feed showed, as of the last scan (the site may already be changing it for the next page).
    const base = new Map();
    for (const x of state.list) if (x.sig && box.contains(x.el)) base.set(x.el, x.sig);
    if (!base.size) return; // nothing in it that could flash
    const key = state.currentInfo && state.currentInfo.key;
    let anchor = state.current && base.has(state.current) ? state.current : null;
    if (!anchor && key) {
      // Re-rendered since the last scan: the same item in a new element.
      anchor = adapter.items(box).find((el) => (getInfo(el) || {}).key === key) || null;
      if (anchor) {
        markShown(box, anchor);
        if (!base.has(anchor)) base.set(anchor, adapter.signature(anchor));
      }
    }
    const shown = !!anchor;
    if (!anchor) anchor = base.keys().next().value; // nothing on show: the first item is just a landmark
    box.setAttribute('otaat-retired', state.surface.mode);
    retired.set(box, {
      since: Date.now(),
      page: pageOf(state.url), // (still the address of the page being left)
      surface: state.surface.name,
      base,
      anchor,
      sig: base.get(anchor),
      sigs: new Set(base.values()),
      key,
      shown,
    });
    watchRetired();
  }

  const asItWas = (box, r) => box.contains(r.anchor) && adapter.signature(r.anchor) === r.sig;

  /**
   * The site has filled the old container with the next page's content: most of what it showed is gone,
   * replaced by something else. (Items re-rendered as new elements still count as there; more items
   * arriving is the old page growing; items merely dropped may be a virtualized list trimming itself.)
   * quick: skip the count while the item on show is as it was (cheap enough for every change).
   */
  function takenOver(box, r, quick) {
    if (quick && asItWas(box, r)) return false;
    const items = adapter.items(box);
    const now = items.map((el) => adapter.signature(el));
    let kept = 0;
    for (const sig of new Set(now)) if (r.sigs.has(sig)) kept++;
    if (kept * 2 < r.sigs.size && (kept === 0 || now.some((sig) => !r.sigs.has(sig)))) return true;
    if (!r.shown && !asItWas(box, r)) {
      // The landmark went: take another item that is still there, so the quick check stays quick.
      const i = now.findIndex((sig) => r.sigs.has(sig));
      if (i >= 0) {
        r.anchor = items[i];
        r.sig = now[i];
      }
    }
    if (r.shown && !asItWas(box, r)) {
      // Still the old page, with the item on show re-rendered (or dropped): follow it.
      clearMarksIn(box);
      const same = items.find((el) => (getInfo(el) || {}).key === r.key);
      if (same) {
        markShown(box, same);
        r.anchor = same;
        r.sig = adapter.signature(same);
      }
    }
    return false;
  }

  function unretire(box) {
    retired.delete(box);
    box.removeAttribute('otaat-retired');
    clearMarksIn(box);
    watchRetired();
    applyFlags();
  }

  /** New content placed before what was there: the container was rebuilt for this page, not added to. */
  function rebuilt(box, r) {
    let fresh = false;
    for (const el of adapter.items(box)) {
      if (!r.sigs.has(adapter.signature(el))) fresh = true;
      else if (fresh) return true;
    }
    return false;
  }

  /**
   * Retired feeds in or around this page's feed. Those of this very page (e.g. back on it), or rebuilt for
   * it, are live again. The others are the page just left: `away` while the site may still be building
   * this one (LEAVE_WAIT); after that, `stale` if they sit beside this page's feed (kept out of it while it
   * has items of its own), or live again if they are the only feed there is.
   */
  function leftovers(root) {
    const away = [];
    const stale = [];
    for (const box of [root.closest('[otaat-retired]'), ...root.querySelectorAll('[otaat-retired]')]) {
      if (!box) continue;
      const r = retired.get(box);
      if (!r || r.page === pageOf(location.href) || rebuilt(box, r)) unretire(box);
      else if (Date.now() - r.since < LEAVE_WAIT) away.push(box);
      else if (box === root || box.contains(root)) unretire(box);
      else stale.push(box);
    }
    return { away, stale };
  }

  /** No feed to work on yet; look again once the old one can't be in the way any more. */
  let leaveTimer = null;
  function waitForLeaving(away) {
    state.list = [];
    if (!leaveTimer) {
      const until = Math.min(...away.map((box) => retired.get(box).since)) + LEAVE_WAIT;
      leaveTimer = setTimeout(() => {
        leaveTimer = null;
        scheduleScan();
      }, Math.max(0, until - Date.now()) + 50);
    }
    return false;
  }

  function isDisplayed(el) {
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      if (p.hidden || getComputedStyle(p).display === 'none') return false;
    }
    return true;
  }

  /** quick: only what is cheap enough to check on every change (removed, or plainly taken over). */
  function checkRetired(quick = false) {
    if (state.stopped) return;
    let released = false;
    for (const [box, r] of retired) {
      let go = !box.isConnected || takenOver(box, r, quick);
      if (!go && !quick) {
        // Still on screen and unchanged, it is still the old page (e.g. behind X's compose box): it stays.
        go = !isDisplayed(box) || (Date.now() - r.since > RETIRE_MAX && !asItWas(box, r));
      }
      if (go) {
        unretire(box);
        released = true;
      }
    }
    if (released && state.quantize) scheduleScan(); // a feed waiting for it can start now
  }
  const scheduleRetiredCheck = U.throttle(() => checkRetired(), 100);

  function topOffset(el) {
    // Height of sticky/fixed headers covering the top of the item's column.
    const rect = el.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + Math.min(rect.width / 2, 200)));
    // The bar itself, when it sits at the top.
    let bottom = O.ui.reservedTop();
    // Only the topmost page element at the top edge matters (walking every element in the stack is costly).
    const hit = document.elementsFromPoint(x, 2).find((e) => !O.ui.isOwn(e));
    for (let p = hit; p && p !== document.documentElement; p = p.parentElement) {
      const pos = getComputedStyle(p).position;
      if (pos === 'fixed' || pos === 'sticky') {
        bottom = Math.max(bottom, p.getBoundingClientRect().bottom);
        break;
      }
    }
    return Math.min(bottom, window.innerHeight / 2);
  }

  function reveal(el) {
    const rect = el.getBoundingClientRect();
    const offset = topOffset(el) + 8;
    // Keep the item clear of the button bar (taller on phones, and raised above the site's bottom bar).
    const bottomLimit = window.innerHeight - O.ui.reservedBottom();
    const cutOff = rect.bottom > bottomLimit;
    if (state.surface.mode === 'spotlight' || rect.top < offset || cutOff) {
      // Fits on screen: show all of it, as low as possible (keeps page context above). Too tall: align its top.
      const fits = rect.height <= bottomLimit - offset;
      const delta =
        state.surface.mode !== 'spotlight' && fits && rect.top >= offset ? rect.bottom - bottomLimit : rect.top - offset;
      window.scrollTo({ top: Math.max(0, window.scrollY + delta), behavior: 'instant' });
    }
  }

  // ---------------------------------------------------------------- loading more

  function itemCount() {
    const root = adapter.feedRoot();
    return root ? adapter.items(root).length : 0;
  }

  function waitForGrowth(timeout = LOAD_TIMEOUT) {
    return new Promise((resolve) => {
      const start = itemCount();
      let done = false;
      const finish = (grew) => {
        if (done) return;
        done = true;
        mo.disconnect();
        clearTimeout(timer);
        resolve(grew);
      };
      const mo = new MutationObserver(() => {
        if (itemCount() > start) finish(true);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(() => finish(itemCount() > start), timeout);
    });
  }

  let loaderRevealed = false;
  function setLoader(on) {
    loaderRevealed = on;
    U.setFlag('otaat-loadmore', on);
  }

  /** Show the feed's own "load more" trigger just long enough for one new batch to arrive. */
  function revealLoaderUntilGrowth(timeout = LOAD_TIMEOUT) {
    return new Promise((resolve) => {
      const root = adapter.feedRoot();
      if (!root) return resolve(false);
      const start = adapter.items(root).length;
      let done = false;
      const finish = (grew) => {
        if (done) return;
        done = true;
        setLoader(false);
        mo.disconnect();
        clearTimeout(timer);
        resolve(grew);
      };
      // Runs as a microtask right after the DOM changes, before the next frame,
      // so the site never sees its loader visible a second time.
      const mo = new MutationObserver(() => {
        if (adapter.items(root).length > start) finish(true);
      });
      mo.observe(root, { childList: true, subtree: true });
      const timer = setTimeout(() => finish(adapter.items(root).length > start), timeout);
      setLoader(true);
    });
  }

  /**
   * Virtualized timelines (X) render more posts as the page scrolls down. Any post we haven't seen in the
   * list before counts as progress, even an already-sorted one, so we keep scrolling past sorted posts.
   */
  async function spotlightLoad() {
    const gen = state.gen;
    const known = new Set(state.list.map((x) => x.info.key));
    const progressed = () => !!state.current || state.list.some((x) => !known.has(x.info.key));
    const scrollAndWait = async (y, wait) => {
      if (gen !== state.gen) return false; // the user went elsewhere: never scroll their new page
      window.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
      const end = Date.now() + wait;
      while (Date.now() < end) {
        await U.sleep(250);
        if (gen !== state.gen) return false;
        scan(); // shows the next post as soon as one is eligible
        if (progressed()) return true;
      }
      return false;
    };
    const last = state.list.length ? state.list[state.list.length - 1].el : null;
    const y = last
      ? window.scrollY + last.getBoundingClientRect().bottom - window.innerHeight * 0.5
      : document.documentElement.scrollHeight;
    if (await scrollAndWait(y, LOAD_TIMEOUT)) return true;
    return scrollAndWait(document.documentElement.scrollHeight, 3000);
  }

  async function loadMore() {
    if (state.loading || state.ended) return;
    state.loading = true;
    const gen = state.gen;
    updateBar();
    let grew = false;
    try {
      if (state.surface.mode === 'spotlight') grew = await spotlightLoad();
      else if (adapter.loadMore) grew = await adapter.loadMore(api);
      else grew = await revealLoaderUntilGrowth();
    } catch (e) {
      grew = false;
    }
    if (gen !== state.gen) return;
    state.loading = false;
    refreshList();
    if (grew) {
      state.emptyBatches = pickNext() !== null ? 0 : state.emptyBatches + 1;
      if (state.emptyBatches >= MAX_EMPTY_BATCHES) state.ended = true;
    } else {
      state.emptyBatches++;
      if (state.emptyBatches >= 2) state.ended = true;
    }
    if (state.ended) {
      // Feeds sometimes recover (slow network, late injection): try again quietly in a while.
      state.endedAt = Date.now();
      setTimeout(() => {
        if (gen !== state.gen || !state.ended) return;
        state.ended = false;
        state.emptyBatches = 0;
        scan();
      }, RETRY_AFTER);
    } else {
      scan();
    }
    updateBar();
  }

  function requestMore() {
    // A feed that seemed to end gets another chance once a while has passed.
    if (state.ended && Date.now() - state.endedAt > RETRY_AFTER) {
      state.ended = false;
      state.emptyBatches = 0;
    }
    if (!state.loading && !state.ended) loadMore().catch(quiet);
  }

  function topUp() {
    if (state.surface.mode === 'collapse' && pendingAfterCurrent() < BUFFER) requestMore();
  }

  // ---------------------------------------------------------------- actions

  async function act(name) {
    if (name === 'logs') return O.send('openPage', { page: 'logs' });
    if (name === 'later-list') return O.send('openPage', { page: 'later' });
    if (!['next', 'later', 'queue'].includes(name)) return;
    if (!state.quantize) {
      O.ui.toast('One Thing At A Time: this page is not a feed it manages.', 'warn');
      return;
    }
    if (state.busy) return;
    const native = state.surface.mode === 'native';
    const el = native ? null : state.current;
    const info = native ? state.nativeInfo : state.currentInfo;
    if (!info) {
      O.ui.toast('Nothing to sort yet.', 'warn');
      return;
    }
    if (name === 'queue' && !(adapter.canQueue && adapter.canQueue(info))) {
      O.ui.toast(adapter.hasQueue ? 'Only videos can be queued.' : 'Queue is only available on YouTube.', 'warn');
      return;
    }

    state.busy = true;
    updateBar();
    const gen = state.gen;
    try {
      const entry = { item: info, surface: state.surface.name, pageUrl: location.href, ts: Date.now() };
      let toast = null;
      let confirmLater = null;
      if (name === 'next') {
        entry.action = 'skipped';
      } else if (name === 'later') {
        entry.action = 'deferred';
        const r = adapter.later ? await adapter.later(el, info, O.settings) : { local: true };
        entry.localLater = r.local !== false;
        if (r.note) entry.note = r.note;
        toast = [r.message || 'Saved for later', r.kind || 'ok'];
        if (r.confirm) confirmLater = r;
      } else {
        entry.action = 'queued';
        const r = await adapter.queue(el, info);
        if (!r.ok) {
          O.ui.toast(r.message || 'Could not add to the queue.', 'err', 4500);
          return;
        }
        toast = [r.message || 'Added to the queue', 'ok'];
      }

      const res = await O.send('log', { entries: [entry] });
      if (!res || !res.stored) {
        O.ui.toast('Could not write to your log, so nothing was changed. Please try again.', 'err', 6000);
        return;
      }
      setCounts(res.counts);
      if (toast) O.ui.toast(toast[0], toast[1]);
      if (confirmLater) {
        // Logged already; now see whether the site confirms its own later queue.
        confirmLater
          .confirm()
          .then((ok) => {
            if (ok) O.send('later.nativeConfirmed', { key: info.key });
            O.ui.toast(ok ? confirmLater.confirmedMessage : confirmLater.unconfirmedMessage, ok ? 'ok' : 'warn', 4000);
          })
          .catch(quiet);
      }
      state.sorted.add(info.key);
      if (el) el.setAttribute('otaat-sorted', '');
      if (gen !== state.gen) return;
      const advance = name !== 'queue' || O.settings.queueAdvances;
      // Queue with "moves on" turned off: the item stays until Next or Later.
      state.keepKey = advance ? null : info.key;
      if (!advance) return;
      if (native) {
        state.nativeInfo = null;
        if (!adapter.nativeNext()) O.ui.toast('Could not find the next button; scroll to continue.', 'warn');
      } else {
        clearCurrent();
      }
    } finally {
      state.busy = false;
      // Always rescan: if the page or settings changed meanwhile, the new page still needs its item.
      if (state.surface.mode !== 'native') scan();
      updateBar();
    }
  }

  // ---------------------------------------------------------------- the bar

  function updateBar() {
    if (!state.quantize) {
      O.ui.update({ visible: false });
      return;
    }
    const native = state.surface.mode === 'native';
    const info = native ? state.nativeInfo : state.currentInfo;
    let status;
    let notable = true; // worth showing even on a phone, where the bar keeps only its buttons
    if (state.busy) status = 'Saving…';
    else if (info && native && state.nativeSorted) status = 'Already sorted before';
    else if (info) {
      status = native ? 'This one' : `#${state.shownCount}`;
      notable = false;
    } else if (state.loading) status = 'Loading more…';
    else if (state.ended) status = 'Nothing new left here — reload the page for more';
    else if (!native && state.feedMissing) status = "Couldn't find this feed — showing the page normally";
    else if (!native && !adapter.feedRoot()) status = 'Waiting for the feed…';
    else status = 'Finding the next item…';
    const c = state.counts;
    const sortedToday = c ? (c.skipped || 0) + (c.deferred || 0) + (c.queued || 0) : null;
    const ready = !!info && !state.busy;
    O.ui.update({
      visible: true,
      position: O.settings.barPosition,
      status,
      statusNotable: notable,
      nextEnabled: ready,
      laterEnabled: ready,
      showQueue: !!adapter.hasQueue,
      queueEnabled: ready && !!adapter.canQueue && adapter.canQueue(info),
      countText: sortedToday === null ? '' : `${sortedToday} sorted today`,
      laterHref: adapter.laterLink ? adapter.laterLink.href : '',
      laterLabel: adapter.laterLink ? adapter.laterLink.label : '',
      laterTitle: adapter.laterLink ? adapter.laterLink.title : '',
      keepClear: adapter.barKeepClear || '',
    });
  }

  O.ui.onAction((name) => act(name).catch(quiet));

  // ---------------------------------------------------------------- sightings on normal pages

  const sightings = {
    io: null,
    observed: new WeakSet(),
    active: false,

    start() {
      this.stop();
      const t = Math.min(1, Math.max(0.05, Number(O.settings.sightingThreshold) || 0.5));
      this.threshold = t;
      // Fine-grained steps, so an item taller than the screen is still caught once it fills enough of it.
      const steps = Array.from({ length: 21 }, (_, i) => i / 20);
      this.io = new IntersectionObserver((entries) => this.onIntersect(entries), { threshold: steps });
      this.active = true;
      this.collect();
    },

    stop() {
      if (this.io) this.io.disconnect();
      this.io = null;
      this.observed = new WeakSet();
      this.active = false;
    },

    collect() {
      if (!this.active || !adapter.sightingSelector) return;
      for (const el of document.querySelectorAll(adapter.sightingSelector)) {
        if (this.observed.has(el)) continue;
        this.observed.add(el);
        this.io.observe(el);
      }
    },

    onIntersect(entries) {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const enough = e.intersectionRatio >= this.threshold * 0.98 || e.intersectionRect.height >= window.innerHeight * this.threshold;
        if (!enough || !isShown(e.target)) continue;
        let info = null;
        try {
          info = adapter.sightingInfo(e.target);
        } catch (_) {
          info = null;
        }
        if (info) logSeen(info, state.surface.name);
      }
    },
  };

  function isShown(el) {
    if (el.closest('[otaat-discover], [otaat-retired]')) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }

  const scheduleCollect = U.throttle(() => sightings.collect(), 400);
  const scheduleDecorate = U.throttle(() => {
    if (adapter.decorate) adapter.decorate(state.surface, O.settings);
  }, 200);

  // ---------------------------------------------------------------- page setup

  async function logPageItem(gen) {
    if (!adapter.pageItem) return;
    const surfaceName = state.surface.name;
    const info = await adapter.pageItem(state.surface);
    if (!info) return;
    // It was on screen, so it is logged even if the user has already moved on (e.g. a quick swipe in Shorts).
    if (gen !== state.gen) {
      logSeenElsewhere(info, surfaceName);
      return;
    }
    logSeen(info, surfaceName);
    if (state.quantize && state.surface.mode === 'native') {
      state.nativeInfo = info;
      state.nativeSorted = false;
      updateBar();
      if (O.settings.skipSorted) {
        const res = await O.send('filterSorted', { keys: [info.key] });
        if (gen === state.gen && res && res.sorted && res.sorted.includes(info.key)) {
          state.nativeSorted = true;
          updateBar();
        }
      }
    }
  }

  // Log a sighting from a page we already left (its own de-duplication set is gone).
  function logSeenElsewhere(info, surfaceName) {
    if (state.pageSeen.has(info.key)) return;
    seenQueue.push({ action: 'seen', item: info, surface: surfaceName, pageUrl: info.url, ts: Date.now() });
    scheduleSeenFlush(250);
  }

  function setup({ navigating = false } = {}) {
    // Leaving a one-at-a-time feed for another page: keep it hidden until the site has swapped it out.
    const otherPage = navigating && pageOf(location.href) !== pageOf(state.url);
    if (otherPage && state.quantize && state.surface.mode !== 'native' && !state.feedMissing) retire();
    // A settings change: feeds no longer to be shown one at a time (e.g. paused) show in full at once.
    if (!navigating) {
      const on = O.settings.surfaces[SITE] || {};
      for (const [box, r] of retired) if (O.settings.paused[SITE] || !on[r.surface]) unretire(box);
    }
    state.root = null;
    state.gen++;
    const gen = state.gen;
    state.url = location.href;
    clearAllMarks();
    state.list = [];
    state.nativeInfo = null;
    state.shownCount = 0;
    state.lastShownKey = null;
    state.loading = false;
    state.ended = false;
    state.emptyBatches = 0;
    state.pageSeen = new Set();
    state.keepKey = null;
    state.nativeSorted = false;
    state.feedMissing = false;
    state.setupAt = Date.now();
    state.hiddenSeen = new Map();
    setLoader(false);

    const s = O.settings;
    state.surface = adapter.surface(location);
    const enabled = state.surface.kind === 'feed' && !!(s.surfaces[SITE] && s.surfaces[SITE][state.surface.name]);
    state.quantize = enabled && !s.paused[SITE];
    applyFlags();
    if (retired.size) checkRetired(); // the site may have re-used the old feed in the same step

    // Sightings run everywhere, feeds included: hidden items never count (display:none never intersects,
    // visibility:hidden is filtered), so anything the hiding misses is still logged.
    if (s.logSightings) sightings.start();
    else sightings.stop();
    if (state.surface.kind === 'detail' || (state.quantize && state.surface.mode === 'native')) logPageItem(gen).catch(quiet);
    if (adapter.onPage) adapter.onPage(state.surface, s);
    if (adapter.decorate) scheduleDecorate();
    if (state.quantize) {
      O.send('counts').then((r) => r && gen === state.gen && setCounts(r.counts));
      scheduleScan();
      // Re-check once the grace period is over, even if the page is quiet by then.
      setTimeout(() => gen === state.gen && scan(), FEED_GRACE + 100);
    }
    updateBar();
  }

  function onUrlMaybeChanged() {
    if (location.href !== state.url) setup({ navigating: true });
  }

  // ---------------------------------------------------------------- wiring

  const mo = new MutationObserver((records) => {
    // In-app navigation (pushState) can't be observed directly, but the new page's DOM changes can:
    // re-run setup here, before the new content is painted, so a feed never shows unhidden.
    if (location.href !== state.url) setup({ navigating: true });
    if (retired.size) checkRetired(true);
    if (state.quantize && state.surface.mode !== 'native') {
      // Only changes in (or around) the feed matter; skip e.g. a video player's ticking clock.
      const root = adapter.feedRoot();
      if (!root || records.some((r) => root.contains(r.target) || r.target.contains(root))) scheduleScan();
    }
    if (sightings.active) scheduleCollect();
    if (adapter.decorate) scheduleDecorate();
  });

  // Sites swap pages by toggling `hidden` (YouTube's ytd-browse/ytd-watch): an address change can show up
  // first as such a toggle, and a retired feed may just have been hidden. Cheap: only `hidden` is watched.
  const pageSwap = new MutationObserver(() => {
    if (location.href !== state.url) setup({ navigating: true });
    if (retired.size) scheduleRetiredCheck();
  });

  // Some sites (X) rewrite <html>'s attributes after loading; put ours back straight away.
  const flagGuard = new MutationObserver((records) => {
    if (!records.some((r) => r.attributeName && r.attributeName.startsWith('otaat-'))) return;
    applyFlags();
    if (loaderRevealed) U.setFlag('otaat-loadmore', true);
  });

  let urlTimer = null;

  /** Detach everything (used by the tests between pages). */
  function stop() {
    state.stopped = true;
    mo.disconnect();
    pageSwap.disconnect();
    [...retired.keys()].forEach(unretire);
    retiredWatch.disconnect();
    flagGuard.disconnect();
    sightings.stop();
    clearInterval(urlTimer);
    clearTimeout(seenTimer);
    clearTimeout(leaveTimer);
  }

  function start() {
    // Flags first (with default settings) so the feed never flashes before we take over.
    state.surface = adapter.surface(location);
    state.quantize =
      state.surface.kind === 'feed' && !!(O.settings.surfaces[SITE] && O.settings.surfaces[SITE][state.surface.name]);
    applyFlags();
    flagGuard.observe(document.documentElement, { attributes: true });

    O.settingsReady.then(() => {
      if (state.stopped) return;
      setup();
      mo.observe(document.documentElement, { childList: true, subtree: true });
      pageSwap.observe(document.documentElement, { attributes: true, attributeFilter: ['hidden'], subtree: true });
      urlTimer = setInterval(() => {
        onUrlMaybeChanged();
        if (retired.size) checkRetired(); // e.g. the site re-used the old feed's elements in place
      }, 300);
      window.addEventListener('popstate', onUrlMaybeChanged);
      document.addEventListener('yt-navigate-finish', onUrlMaybeChanged);
    });

    O.onSettings(() => {
      state.checked.clear();
      state.sorted.clear();
      setup({ navigating: location.href !== state.url }); // (the address may have changed a moment ago)
    });

    // Items sorted in another tab leave this tab's feed too.
    browser.storage.onChanged.addListener((changes, area) => {
      const ping = area === 'local' && changes.sortedPing && changes.sortedPing.newValue;
      if (!ping || !Array.isArray(ping.keys) || !O.settings.skipSorted) return;
      for (const k of ping.keys) {
        state.sorted.add(k);
        state.checked.add(k);
      }
      if (state.nativeInfo && ping.keys.includes(state.nativeInfo.key)) {
        state.nativeSorted = true;
        updateBar();
      }
      if (!state.busy && state.currentInfo && ping.keys.includes(state.currentInfo.key) && state.currentInfo.key !== state.keepKey) {
        clearCurrent();
        scheduleScan();
      }
    });

    browser.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg.type !== 'string') return undefined;
      if (msg.type === 'command') {
        act(msg.name).catch(quiet);
        return undefined;
      }
      if (msg.type === 'status') {
        const info = state.surface.mode === 'native' ? state.nativeInfo : state.currentInfo;
        return Promise.resolve({
          site: SITE,
          surface: state.surface.name,
          kind: state.surface.kind,
          quantize: state.quantize,
          paused: !!O.settings.paused[SITE],
          surfaceEnabled: !!(O.settings.surfaces[SITE] && O.settings.surfaces[SITE][state.surface.name]),
          current: info ? { title: info.title, url: info.url, author: info.author } : null,
          shown: state.shownCount,
        });
      }
      return undefined;
    });
  }

  const api = { waitForGrowth, revealLoaderUntilGrowth, act, stop, state, adapter };
  O.engine = api;
  start();
})();
