/*
 * X / Twitter adapter. Timelines are virtualized, so feeds use spotlight mode
 * (other posts invisible, current one scrolled to the top).
 * Supports both the classic markup (data-testid="cellInnerDiv"/"tweet") and the 2026 web app (ul > li > article).
 */
(function () {
  'use strict';
  const O = globalThis.OTAAT;
  const U = O.util;
  const XC = 'https://x.com';

  const RESERVED = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search', 'compose', 'login', 'logout',
    'signup', 'tos', 'privacy', 'jobs', 'premium', 'about', 'account', 'download', 'hashtag', 'intent', 'share',
    'lists', 'bookmarks', 'communities', 'jf', 'flow', 'search-advanced', 'grok', 'verified-choose', 'oauth',
    'sw.js', 'robots.txt', 'help', 'ads', 'business', 'topics', 'following', 'followers', 'spaces',
  ]);
  const STATUS_RE = /^\/([A-Za-z0-9_]{1,30})\/status\/(\d+)\/?$/;
  const AD_LABELS = new Set(['Ad', 'Promoted', 'Gesponsert', 'Anzeige', 'Sponsorisé', 'Publicidad', 'Promocionado', 'Patrocinado', 'Sponsorizzato', 'プロモーション', '광고']);

  function surface(loc) {
    const p = loc.pathname.replace(/\/+$/, '') || '/';
    const seg = p.split('/').filter(Boolean);
    const feed = (name) => ({ name, kind: 'feed', mode: 'spotlight' });
    if (p === '/home') return feed('home');
    if (/^\/i\/lists\/\d+$/.test(p)) return feed('lists');
    if (/^\/[^/]+\/status\/\d+/.test(p) || /^\/i\/web\/status\/\d+/.test(p)) return { name: 'status', kind: 'detail' };
    if (seg.length && !RESERVED.has(seg[0].toLowerCase()) && /^[A-Za-z0-9_]{1,30}$/.test(seg[0])) {
      if (seg.length === 1 || (seg.length === 2 && ['with_replies', 'media', 'highlights', 'articles'].includes(seg[1]))) {
        return feed('profile');
      }
      return { name: 'profile-page', kind: 'other' };
    }
    return { name: seg[0] || 'other', kind: 'other' };
  }

  function root() {
    return document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main');
  }

  function cellOf(article) {
    return (
      article.closest('[data-testid="cellInnerDiv"]') ||
      article.closest('[id^="urt:"] > ul > li') ||
      article.closest('li') ||
      article
    );
  }

  function statusHref(cell) {
    const art = cell.matches('article') ? cell : cell.querySelector('article');
    if (!art) return null;
    // Classic: the timestamp link of the post itself (quoted posts come later in the DOM).
    const t = art.querySelector('a[href*="/status/"] time');
    if (t) return t.closest('a').getAttribute('href');
    // 2026 app: the row is a role=link with data-href.
    const dh = cell.querySelector('[data-href*="/status/"]') || (cell.matches('[data-href]') ? cell : null);
    if (dh) return dh.getAttribute('data-href');
    for (const a of art.querySelectorAll('a[href*="/status/"]')) {
      const h = a.getAttribute('href');
      if (STATUS_RE.test(h)) return h;
    }
    return null;
  }

  const NOISE = [
    /^·$/,
    /^@\w{1,30}$/,
    /^\d+[smhd]$/,
    /^(\d{1,2} )?[A-Z][a-z]{2}( \d{1,2})?(, \d{4})?$/,
    /^\d[\d.,]*[KMB]?$/,
    /^(Show more|Show translation|Translate post|Quote|Replying to)$/,
  ];

  function textOf(art, displayName) {
    // Classic: data-testid="tweetText". 2026 app: the body is the first dir="auto" block (quoted posts come later).
    const body = art.querySelector('[data-testid="tweetText"]') || art.querySelector('div[dir="auto"]');
    if (body) return U.text(body);
    const lines = (art.innerText || art.textContent || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => l !== displayName && !NOISE.some((re) => re.test(l)));
    return lines.join(' ').replace(/\s+/g, ' ').trim();
  }

  function displayNameOf(art, handle) {
    // Both markups link the author's name and their @handle to /handle; the name is the one without "@".
    for (const a of art.querySelectorAll(`a[href="/${handle}"]`)) {
      const t = U.text(a);
      if (t && !t.startsWith('@')) return t;
    }
    const classic = art.querySelector('[data-testid="User-Name"]');
    const first = classic ? (classic.innerText || '').split('\n')[0] : '';
    return first ? first.trim() : '';
  }

  function infoFromCell(cell) {
    const href = statusHref(cell);
    if (!href) return null;
    const m = href.match(/^\/([A-Za-z0-9_]{1,30})\/status\/(\d+)/);
    if (!m) return null;
    const [, handle, id] = m;
    const art = cell.matches('article') ? cell : cell.querySelector('article');
    const name = displayNameOf(art, handle);
    const text = textOf(art, name);
    const media = art.querySelector('img[src*="pbs.twimg.com/media"], video[poster]');
    return {
      key: `x:${id}`,
      site: 'x',
      id,
      kind: 'tweet',
      url: `${XC}/${handle}/status/${id}`,
      title: text ? U.cut(text, 140) : '(post without text)',
      author: name ? `${name} (@${handle})` : `@${handle}`,
      snippet: U.cut(text, 600),
      thumb: media ? media.getAttribute('src') || media.getAttribute('poster') || '' : '',
      extra: {},
    };
  }

  // Where a post's own words live: an "Ad" written there (or as someone's name) is content, not a label.
  const CONTENT_AREAS = '[data-testid="tweetText"], div[dir="auto"], a[href^="/"], [data-testid="User-Name"]';

  function isAdCell(cell) {
    const art = cell.querySelector('article');
    if (!art) return false;
    // Classic markup: promoted posts have no timestamp.
    if (art.matches('[data-testid="tweet"]') && !art.querySelector('time')) return true;
    for (const s of art.querySelectorAll('span')) {
      if (s.childElementCount === 0 && AD_LABELS.has(s.textContent.trim()) && !s.closest(CONTENT_AREAS)) return true;
    }
    return false;
  }

  function translateY(el) {
    const m = (el.getAttribute('style') || '').match(/translateY\((-?[\d.]+)px\)/);
    return m ? parseFloat(m[1]) : null;
  }

  // "Discover more" below a post's replies: a heading row without a post, and everything after it.
  let discover = { path: '', y: null, found: false };
  function markDiscover() {
    const r = root();
    if (!r) return;
    if (discover.path !== location.pathname) discover = { path: location.pathname, y: null, found: false };
    // Only the post's own thread: not a feed left behind it (X keeps the timeline under a photo viewer).
    const cells = [...r.querySelectorAll('[data-testid="cellInnerDiv"], [id^="urt:"] > ul > li')].filter(
      (cell) => !cell.hasAttribute('otaat-item') && !cell.closest('[otaat-retired]')
    );
    let after = false;
    cells.forEach((cell, i) => {
      if (!after && i > 0 && !cell.querySelector('article') && cell.querySelector('h2, [role="heading"]')) {
        after = true;
        discover.found = true;
        const y = translateY(cell);
        if (y !== null) discover.y = y;
      }
      const y = translateY(cell);
      const hide = after || (discover.found && discover.y !== null && y !== null && y > discover.y);
      if (hide) {
        if (!cell.hasAttribute('otaat-discover')) cell.setAttribute('otaat-discover', '');
      } else if (cell.hasAttribute('otaat-discover')) {
        cell.removeAttribute('otaat-discover');
      }
    });
  }

  async function bookmark(cell) {
    const art = cell && cell.querySelector('article');
    if (!art) return 'post not found';
    if (art.querySelector('[data-testid="removeBookmark"]')) return 'already bookmarked';
    // Most specific first: the clickable button, not its wrapper.
    const btn = ['[data-testid="bookmark"]', 'button[data-engagement-action="bookmark"]', '[data-engagement-action="bookmark"] button', '[data-engagement-action="bookmark"]']
      .map((sel) => art.querySelector(sel))
      .find(Boolean);
    if (!btn) return 'bookmark button not found';
    if (btn.getAttribute('aria-pressed') === 'true') return 'already bookmarked';
    btn.click();
    return '';
  }

  O.adapters.x = {
    site: 'x',
    matches: (host) => /(^|\.)(x|twitter)\.com$/.test(host),
    surface,
    laterLink: null,
    sightingSelector: 'article',
    hasQueue: false,

    feedRoot: root,

    // Leaving the timeline: only its list of cells is set aside (the column itself is used by the next page).
    retireRoot(r, current) {
      const cell = (current && r.contains(current) && current) || this.items(r).find((c) => !c.closest('[otaat-retired]'));
      return cell && cell.matches('[data-testid="cellInnerDiv"], li') ? cell.parentElement : null;
    },

    items(r) {
      const out = [];
      const seen = new Set();
      for (const art of r.querySelectorAll('article')) {
        const cell = cellOf(art);
        if (seen.has(cell) || !r.contains(cell)) continue;
        seen.add(cell);
        out.push(cell);
      }
      return out;
    },

    info: infoFromCell,

    signature(cell) {
      return statusHref(cell) || '';
    },

    isAd: isAdCell,

    sightingInfo(el) {
      return infoFromCell(cellOf(el));
    },

    async later(cell, info, settings) {
      if (settings.xBookmarkOnLater) {
        const problem = await bookmark(cell);
        return {
          local: true,
          kind: problem ? 'warn' : 'ok',
          message: problem ? `Saved to your Later list (X bookmark: ${problem})` : 'Saved to your Later list and bookmarked on X',
          note: problem ? `bookmark: ${problem}` : 'bookmarked on X',
        };
      }
      return { local: true, message: 'Saved to your Later list' };
    },

    async pageItem() {
      // Everything about the page is taken now, so a later navigation can't mix two posts up.
      const path = location.pathname;
      const m = path.match(/\/status\/(\d+)/);
      if (!m) return null;
      const id = m[1];
      const handle = (path.match(/^\/([A-Za-z0-9_]{1,30})\/status\//) || [])[1] || '';
      const url = handle ? `${XC}/${handle}/status/${id}` : `${XC}${path}`;
      const found = await U.waitFor(
        () => {
          if (location.pathname !== path) return 'left';
          const r = root();
          if (!r) return null;
          for (const art of r.querySelectorAll('article')) {
            const cell = cellOf(art);
            const href = statusHref(cell);
            if (href && href.includes(`/status/${id}`)) return cell;
          }
          // 2026 app: the focal post has no link to itself; it is the first row.
          const first = r.querySelector('[id^="urt:conversation"] > ul > li');
          return first && first.querySelector('article') && !first.querySelector('[data-href]') ? first : null;
        },
        { timeout: 8000, interval: 250 }
      );
      const cell = found && found !== 'left' && location.pathname === path ? found : null;
      let info = cell ? infoFromCell(cell) : null;
      if (info && info.key !== `x:${id}`) info = null; // e.g. the link found was a quoted post's
      if (cell && !info) {
        const found = cell;
        const art = found.querySelector('article');
        const name = displayNameOf(art, handle);
        const text = textOf(art, name);
        info = {
          key: `x:${id}`,
          site: 'x',
          id,
          kind: 'tweet',
          url,
          title: text ? U.cut(text, 140) : '(post without text)',
          author: name ? `${name} (@${handle})` : handle ? `@${handle}` : '',
          snippet: U.cut(text, 600),
          extra: {},
        };
      }
      if (!info) {
        info = { key: `x:${id}`, site: 'x', id, kind: 'tweet', url, title: '(post)', author: handle ? `@${handle}` : '', extra: {} };
      }
      return info;
    },

    decorate(surf, settings) {
      // A post's photo/video viewer is drawn over whatever page it was opened from: leave that page alone.
      if (/\/(photo|video)\/\d+\/?$/.test(location.pathname)) return;
      if (surf.name === 'status' && settings.hide.xDiscover) markDiscover();
      // On a feed, marks left from a post page must go. (Not on e.g. the compose box: the post page is behind it.)
      else if (surf.kind === 'feed') for (const el of document.querySelectorAll('[otaat-discover]')) el.removeAttribute('otaat-discover');
    },
  };
})();
