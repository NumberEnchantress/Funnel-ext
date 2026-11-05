/* YouTube adapter. Feeds: Home, Subscriptions (grid, collapse mode) and the Shorts player (native mode). */
(function () {
  'use strict';
  const O = globalThis.OTAAT;
  const U = O.util;
  const YT = 'https://www.youtube.com';
  const WATCH_LATER_URL = `${YT}/playlist?list=WL`;

  // ---------------------------------------------------------------- page-world bridge (see yt-main.js)

  let seq = 0;
  const pending = new Map();
  document.addEventListener('otaat-yt-response', (e) => {
    let res;
    try {
      res = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    const p = pending.get(res && res.id);
    if (!p) return;
    pending.delete(res.id);
    clearTimeout(p.timer);
    p.resolve(res.result || { ok: false, error: res.error || 'no result' });
  });

  function rawCall(method, args, timeout) {
    return new Promise((resolve) => {
      // Random ids keep concurrent requests apart. These DOM events are visible to YouTube's own scripts,
      // so the bridge is exactly as trustworthy as the YouTube page (which runs these commands anyway).
      const id = crypto.randomUUID ? crypto.randomUUID() : `${Math.random().toString(36).slice(2)}-${++seq}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'YouTube did not respond' });
      }, timeout);
      pending.set(id, { resolve, timer });
      document.dispatchEvent(new CustomEvent('otaat-yt-request', { detail: JSON.stringify({ id, method, args }) }));
    });
  }

  // Both scripts start at document_start in no fixed order: ping until the page-world side answers.
  let ready = null;
  function bridgeReady() {
    if (!ready) {
      ready = (async () => {
        for (let i = 0; i < 50; i++) {
          if ((await rawCall('ping', {}, 200)).ok) return true;
        }
        ready = null; // try again on the next call
        return false;
      })();
    }
    return ready;
  }

  async function call(method, args = {}, timeout = 6000) {
    if (!(await bridgeReady())) return { ok: false, error: 'YouTube page bridge not available' };
    return rawCall(method, args, timeout);
  }

  // ---------------------------------------------------------------- extraction

  // m.youtube.com (what Firefox for Android gets) is a different app: ytm-* elements, no play queue.
  const isMobile = () => location.hostname === 'm.youtube.com';

  const LINK_SEL = 'a[href*="/watch?v="], a[href^="/shorts/"], a[href*="/post/"], a[href^="/playlist?list="]';
  const AD_SEL = [
    'ytd-ad-slot-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-display-ad-renderer',
    'ytd-promoted-video-renderer',
    'ad-badge-view-model',
    'feed-ad-metadata-view-model',
    'ytm-ad-slot-renderer',
    'ytm-promoted-sparkles-web-renderer',
    'ytm-promoted-video-renderer',
    'ad-slot-renderer',
  ].join(', ');
  const SIGHTING_SEL = [
    // m.youtube.com
    'ytm-rich-item-renderer',
    'ytm-video-with-context-renderer',
    'ytm-compact-video-renderer',
    'ytm-playlist-video-renderer',
    'ytm-reel-item-renderer',
    'ytm-backstage-post-thread-renderer',
    // www.youtube.com
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-playlist-video-renderer',
    'ytd-playlist-panel-video-renderer',
    'ytd-reel-item-renderer',
    'ytm-shorts-lockup-view-model',
    'ytm-shorts-lockup-view-model-v2',
    'yt-lockup-view-model',
    'ytd-backstage-post-thread-renderer',
    'ytd-post-renderer',
    'ytd-notification-renderer',
  ].join(',');

  function parseLink(href) {
    let u;
    try {
      u = new URL(href, YT);
    } catch (_) {
      return null;
    }
    if (u.pathname === '/watch') {
      const v = u.searchParams.get('v');
      const list = u.searchParams.get('list');
      if (list) {
        const kind = list.startsWith('RD') ? 'mix' : 'playlist';
        return { kind, id: list, key: `youtube:${kind}:${list}`, url: `${YT}/watch?v=${v}&list=${list}`, videoId: v };
      }
      if (!v) return null;
      return { kind: 'video', id: v, key: `youtube:${v}`, url: `${YT}/watch?v=${v}`, videoId: v };
    }
    const shorts = u.pathname.match(/^\/shorts\/([\w-]+)/);
    if (shorts) {
      const id = shorts[1];
      return { kind: 'short', id, key: `youtube:${id}`, url: `${YT}/shorts/${id}`, videoId: id };
    }
    if (u.pathname === '/playlist') {
      const list = u.searchParams.get('list');
      if (!list) return null;
      return { kind: 'playlist', id: list, key: `youtube:playlist:${list}`, url: `${YT}/playlist?list=${list}` };
    }
    const post = u.pathname.match(/\/post\/([\w-]+)/);
    if (post) return { kind: 'post', id: post[1], key: `youtube:post:${post[1]}`, url: `${YT}${u.pathname}` };
    return null;
  }

  function lockupData(el) {
    try {
      const d = U.pageObj(el).data;
      return d && d.content && d.content.lockupViewModel;
    } catch (_) {
      return null;
    }
  }

  function titleOf(el, link) {
    const h3 = el.querySelector('h3[title]');
    if (h3) return h3.getAttribute('title');
    const candidates = [
      el.querySelector('#video-title'),
      el.querySelector('h3'),
      el.querySelector('h4'), // m.youtube.com compact items
      el.querySelector('[class*="Title"], [class*="Headline"], .media-item-headline'),
      el.querySelector('#content-text, #post-text, yt-formatted-string#content-text'),
      el.querySelector('.message'), // bell-menu notifications
    ];
    for (const c of candidates) {
      const t = U.text(c) || U.attr(c, 'title');
      if (t) return t;
    }
    return U.attr(link, 'title') || U.attr(link, 'aria-label') || '';
  }

  function authorOf(el) {
    const links = el.querySelectorAll(
      'ytd-channel-name a, #channel-name a, a[href^="/@"], a[href^="/channel/"], a[href^="/c/"], a[href^="/user/"]'
    );
    for (const a of links) {
      const t = U.text(a);
      if (t) return t;
    }
    const name = U.text(el.querySelector('ytd-channel-name, #channel-name, #author-text'));
    if (name) return name;
    try {
      const rows = lockupData(el).metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows;
      const part = rows[0].metadataParts[0].text.content;
      if (part) return String(part);
    } catch (_) {
      /* no data */
    }
    return mobileAuthorOf(el);
  }

  // m.youtube.com: the channel name is the first part of the byline, in the title's label, or in the data.
  function mobileAuthorOf(el) {
    const byline = el.querySelector('ytm-badge-and-byline-renderer, [class*="Byline"]');
    const first = byline && (byline.querySelector('span') || byline);
    const t = first ? U.text(first).split(' • ')[0].split(' · ')[0] : '';
    if (t) return t;
    // e.g. aria-label="The Absurd Engineering Behind the Internet by Veritasium 5,232,553 views 2 days ago …"
    const labelled = el.querySelector('h3 [aria-label], h4 [aria-label], [class*="Headline"] [aria-label]');
    const m = labelled && labelled.getAttribute('aria-label').match(/ by (.+?) [\d.,]+[KMB]? (?:views|watching)/i);
    if (m) return m[1];
    try {
      const inner = el.querySelector('ytm-video-with-context-renderer, ytm-compact-video-renderer') || el;
      const d = U.pageObj(inner).data || {};
      const runs = (d.shortBylineText || d.longBylineText || d.ownerText || {}).runs;
      if (runs && runs[0] && runs[0].text) return String(runs[0].text);
    } catch (_) {
      /* no data */
    }
    return '';
  }

  function durationOf(el) {
    for (const b of el.querySelectorAll('badge-shape, #time-status, .badge-shape-wiz__text, [class*="Badge"]')) {
      const t = U.text(b);
      if (/^\d{1,2}(:\d{2}){1,2}$/.test(t)) return t;
    }
    return '';
  }

  function infoFrom(el) {
    const link = el.matches && el.matches(LINK_SEL) ? el : el.querySelector(LINK_SEL);
    if (!link) return null;
    const p = parseLink(link.getAttribute('href'));
    if (!p) return null;
    const info = {
      key: p.key,
      site: 'youtube',
      id: p.id,
      kind: p.kind,
      url: p.url,
      title: titleOf(el, link),
      author: authorOf(el),
      videoId: p.videoId || '',
      extra: {},
    };
    if (p.kind === 'video' || p.kind === 'short') info.thumb = `https://i.ytimg.com/vi/${p.id}/mqdefault.jpg`;
    const d = durationOf(el);
    if (d) info.extra.duration = d;
    if (p.kind === 'post') info.snippet = U.text(el.querySelector('#content-text, #post-text, #content'));
    return info;
  }

  function surface(loc) {
    const p = loc.pathname.replace(/\/+$/, '') || '/';
    if (p === '/') return { name: 'home', kind: 'feed', mode: 'collapse' };
    if (p === '/feed/subscriptions') return { name: 'subscriptions', kind: 'feed', mode: 'collapse' };
    if (/^\/shorts\/[\w-]+$/.test(p)) return { name: 'shorts', kind: 'feed', mode: 'native' };
    if (p === '/watch') return { name: 'watch', kind: 'detail' };
    if (/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/(videos|shorts|streams)$/.test(p)) {
      return { name: 'channel', kind: 'feed', mode: 'collapse' };
    }
    if (/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.test(p)) return { name: 'channel-page', kind: 'other' };
    if (p === '/results') return { name: 'search', kind: 'other' };
    if (p === '/playlist') return { name: 'playlist', kind: 'other' };
    return { name: p.split('/')[1] || 'other', kind: 'other' };
  }

  // Not inside anything hidden (a page the site keeps around but doesn't show).
  function isDisplayed(el) {
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      if (p.hidden || getComputedStyle(p).display === 'none') return false;
    }
    return true;
  }

  function activeBrowse() {
    return (
      document.querySelector('ytd-page-manager > ytd-browse:not([hidden])') ||
      document.querySelector('ytd-browse:not([hidden])')
    );
  }

  /**
   * The phone site keeps its autoplay switch in the PREF cookie (f5=30000 off, f5=20000 on), so it can be set
   * off at the source there, where the switch itself is only on screen after the player controls have shown.
   * Only while "Keep autoplay off" is on; the other PREF settings are kept. Desktop YouTube ignores f5 for
   * autoplay (it keeps the choice per tab), so there the switch-flipping guard does the job.
   */
  function autoplayOffInPrefs() {
    const m = document.cookie.match(/(?:^|;\s*)PREF=([^;]*)/);
    const parts = (m ? m[1] : '').split('&').filter((p) => p && !p.startsWith('f5='));
    parts.push('f5=30000');
    const value = parts.join('&');
    if (m && m[1] === value) return;
    // Same domain and path as YouTube's own PREF, so it replaces it instead of adding a second one.
    document.cookie = `PREF=${value}; domain=.youtube.com; path=/; max-age=${2 * 365 * 24 * 3600}; secure; samesite=lax`;
  }

  O.adapters.youtube = {
    site: 'youtube',
    matches: (host) => /(^|\.)youtube\.com$/.test(host),
    surface,
    laterLink: { href: WATCH_LATER_URL, label: 'Watch later', title: 'Open your YouTube Watch Later playlist' },
    sightingSelector: SIGHTING_SEL,
    // Drawn over a Short (desktop and phone): its channel / title / Subscribe panel and its column of buttons.
    barKeepClear: [
      '.ytReelPlayerOverlayViewModelMetadataContainerMetapanel',
      'yt-reel-metapanel-view-model',
      'reel-action-bar-view-model',
      'ytd-reel-player-overlay-renderer #metapanel',
      'ytd-reel-player-overlay-renderer #actions',
    ].join(', '),

    // The phone site has no play queue, so no Queue button there.
    get hasQueue() {
      return !isMobile();
    },

    feedRoot() {
      if (isMobile()) {
        // Only the grid of the page currently shown: old pages can linger, hidden, in the DOM, and must
        // never supply the "current" item (it would be logged as seen without being on screen).
        return [...document.querySelectorAll('ytm-rich-grid-renderer')].find(isDisplayed) || null;
      }
      const browse = activeBrowse();
      return browse ? browse.querySelector('ytd-rich-grid-renderer') : null;
    },

    items(root) {
      return [...root.querySelectorAll('ytd-rich-item-renderer, ytm-rich-item-renderer')];
    },

    loaderSelector: 'ytd-continuation-item-renderer, ytm-continuation-item-renderer',

    info: infoFrom,

    signature(el) {
      const link = el.querySelector(LINK_SEL);
      return link ? link.getAttribute('href') : '';
    },

    isAd(el) {
      return !!el.querySelector(AD_SEL);
    },

    // Items YouTube itself keeps hidden (e.g. the rest of a shelf behind "Show more") are never picked.
    hiddenBySite(el) {
      return el.hasAttribute('hidden') || el.hasAttribute('is-show-more-hidden') || !!el.closest('[hidden]');
    },

    sightingInfo(el) {
      return infoFrom(el);
    },

    isVideo(info) {
      return !!info && (info.kind === 'video' || info.kind === 'short') && !!info.videoId;
    },

    canQueue(info) {
      return this.hasQueue && this.isVideo(info);
    },

    async later(el, info) {
      if (!this.isVideo(info)) {
        return { local: true, message: 'Saved to your Later list (only videos can go into Watch Later)' };
      }
      const r = await call('watchLater', { videoId: info.videoId });
      if (r.ok && r.via === 'api') {
        // Phone site: YouTube's API gives a definite answer within a moment, so log what really happened.
        const c = await call('confirmWatchLater', {}, 8000);
        if (c.ok && c.verified) return { local: false, kind: 'ok', message: 'Saved to Watch later', note: 'watch later' };
        return {
          local: true,
          kind: 'warn',
          message: c.ok
            ? "YouTube didn't accept it for Watch later — saved to your Later list instead"
            : 'No answer from YouTube — saved to your Later list (it may also be in Watch later)',
          note: c.ok ? 'watch later refused: extension Later list' : 'watch later unconfirmed: extension Later list',
        };
      }
      if (r.ok) {
        // Logged straight away with a safety copy on the extension's list; the copy is dropped
        // once YouTube shows its "Saved to Watch later" confirmation.
        return {
          local: true,
          kind: 'ok',
          message: 'Saving to Watch later…',
          note: 'watch later',
          confirm: async () => {
            const c = await call('confirmWatchLater', {}, 5000);
            return !!(c.ok && c.verified);
          },
          confirmedMessage: 'Saved to Watch later',
          unconfirmedMessage: "YouTube didn't confirm Watch later — it's also on your Later list",
        };
      }
      if (r.reason === 'signed-out') {
        return {
          local: true,
          kind: 'warn',
          message: 'Not signed in to YouTube — saved to the extension\'s Later list instead',
          note: 'signed out: extension Later list',
        };
      }
      return {
        local: true,
        kind: 'warn',
        message: `Watch Later failed (${r.error || 'unknown'}) — saved to the extension's Later list instead`,
        note: 'watch later failed: extension Later list',
      };
    },

    async queue(el, info) {
      if (!this.canQueue(info)) return { ok: false, message: this.hasQueue ? 'Only videos can be queued' : "YouTube's phone site has no play queue" };
      const r = await call('queue', { videoId: info.videoId });
      if (r.ok) return { ok: true, message: 'Added to the queue' };
      return { ok: false, message: `Could not add to the queue (${r.error || 'unknown'})` };
    },

    async pageItem(surf) {
      const p = surf.name === 'shorts' ? location.pathname.match(/^\/shorts\/([\w-]+)/) : null;
      const id = p ? p[1] : new URLSearchParams(location.search).get('v');
      if (!id) return null;
      const href = location.href;
      // Ask the player which video it has loaded; wait until it matches the URL.
      let data = null;
      for (let i = 0; i < 40 && location.href === href; i++) {
        const r = await call('videoData', { videoId: id }, 2000);
        if (r.ok && r.title) {
          data = r;
          break;
        }
        await U.sleep(250);
      }
      // If the user already moved on, we still know the video from its URL: log it without a title
      // rather than not at all (the page title may already belong to the next video).
      const stillHere = location.href === href;
      const kind = surf.name === 'shorts' ? 'short' : 'video';
      let title = data ? data.title : '';
      let author = data ? data.author : '';
      if (!title && stillHere) title = document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '');
      if (!author && kind === 'short' && stillHere) {
        author = U.text(document.querySelector('ytd-reel-video-renderer a[href^="/@"]'));
      }
      return {
        key: `youtube:${id}`,
        site: 'youtube',
        id,
        kind,
        url: kind === 'short' ? `${YT}/shorts/${id}` : `${YT}/watch?v=${id}`,
        title,
        author,
        videoId: id,
        thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
        extra: {},
      };
    },

    nativeNext() {
      // In priority order (a comma list would return the outer wrapper first, which ignores clicks).
      for (const sel of ['#navigation-button-down button', '#navigation-button-down [role="button"]']) {
        const btn = document.querySelector(sel);
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
      }
      // m.youtube.com: the carousel's (visually hidden) accessibility buttons — Previous, then Next.
      const a11y = document.querySelectorAll('shorts-carousel [class*="A11yNav"] button, shorts-carousel .hidden-a11y-nav button');
      const next = a11y.length >= 2 ? a11y[a11y.length - 1] : null;
      if (next && !next.disabled) {
        next.click();
        return true;
      }
      return false;
    },

    onPage(surf, settings) {
      if (settings.hide.ytAutoplay && isMobile()) autoplayOffInPrefs();
      call('autoplayGuard', { on: surf.name === 'watch' && !!settings.hide.ytAutoplay });
    },
  };
})();
