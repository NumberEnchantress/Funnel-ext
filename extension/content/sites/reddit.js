/* Reddit adapter (www.reddit.com "shreddit" UI). Feeds use collapse mode. */
(function () {
  'use strict';
  const O = globalThis.OTAAT;
  const U = O.util;
  const RD = 'https://www.reddit.com';
  const SORTS = new Set(['best', 'hot', 'new', 'top', 'rising', 'controversial']);

  function surface(loc) {
    const p = loc.pathname.replace(/\/+$/, '') || '/';
    const seg = p.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    const feed = (name) => ({ name, kind: 'feed', mode: 'collapse' });
    if (seg.length === 0 || (seg.length === 1 && SORTS.has(seg[0]))) return feed('home');
    if (seg[0] === 'comments' || seg[2] === 'comments') return { name: 'post', kind: 'detail' };
    if (seg[0] === 'r' && seg[1]) {
      const rest = seg.slice(2);
      const isListing = rest.length === 0 || (rest.length === 1 && SORTS.has(rest[0]));
      if (!isListing) return { name: 'subreddit-page', kind: 'other' };
      const sub = seg[1].toLowerCase();
      if (sub === 'popular') return feed('popular');
      if (sub === 'all') return feed('all');
      return feed('subreddit');
    }
    if ((seg[0] === 'user' || seg[0] === 'u') && seg[1]) {
      if (seg[2] === 'm' && seg[3] && (seg.length === 4 || (seg.length === 5 && SORTS.has(seg[4])))) {
        return feed('customFeed');
      }
      if (seg.length === 2 || (seg.length === 3 && (seg[2] === 'submitted' || seg[2] === 'overview'))) {
        return feed('user');
      }
      return { name: 'user-page', kind: 'other' };
    }
    if (seg[0] === 'search') return { name: 'search', kind: 'other' };
    return { name: seg[0] || 'other', kind: 'other' };
  }

  function postInfo(post) {
    if (!post) return null;
    const id = post.getAttribute('id') || '';
    const permalink = post.getAttribute('permalink') || '';
    if (!/^t3_\w+$/.test(id) || !permalink) return null;
    const community = post.getAttribute('subreddit-prefixed-name') || '';
    const author = post.getAttribute('author') || '';
    const contentHref = post.getAttribute('content-href') || '';
    const type = post.getAttribute('post-type') || '';
    const extra = {};
    if (community) extra.community = community;
    if (type) extra.postType = type;
    const created = post.getAttribute('created-timestamp');
    if (created) extra.created = created;
    if (contentHref && !contentHref.startsWith(RD + permalink) && !contentHref.includes(permalink)) {
      extra.link = contentHref;
    }
    let thumb = '';
    if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(contentHref)) thumb = contentHref;
    else {
      const img = post.querySelector('img[src*="preview.redd.it"], img[src*="i.redd.it"], img[src*="external-preview"]');
      if (img) thumb = img.getAttribute('src');
    }
    const body = post.querySelector('[slot="text-body"], shreddit-post-text-body, [id$="-post-rtjson-content"]');
    return {
      key: `reddit:${id}`,
      site: 'reddit',
      id,
      kind: 'post',
      url: RD + permalink,
      title: post.getAttribute('post-title') || U.text(post.querySelector('[slot="title"]')),
      author: author ? `u/${author}` : '',
      snippet: body ? U.cut(U.text(body), 500) : '',
      thumb,
      extra,
    };
  }

  // Search results are a different element with just a title link.
  function searchResultInfo(unit) {
    const a = unit.querySelector('a[data-testid="post-title"]') || unit.querySelector('a[href*="/comments/"]');
    const href = a && a.getAttribute('href');
    const m = href && href.match(/\/comments\/(\w+)/);
    if (!m) return null;
    const community = U.text(unit.querySelector('a[href^="/r/"]:not([href*="/comments/"])'));
    return {
      key: `reddit:t3_${m[1]}`,
      site: 'reddit',
      id: `t3_${m[1]}`,
      kind: 'post',
      url: U.abs(href),
      title: a.getAttribute('aria-label') || U.text(a),
      extra: community ? { community } : {},
    };
  }

  function lastLoader() {
    const all = document.querySelectorAll('shreddit-feed faceplate-partial[slot="load-after"]');
    return all.length ? all[all.length - 1] : null;
  }

  O.adapters.reddit = {
    site: 'reddit',
    matches: (host) => /(^|\.)reddit\.com$/.test(host) && !/^old\./.test(host),
    surface,
    laterLink: null,
    sightingSelector: 'shreddit-post, [data-testid="search-post-unit"]',
    hasQueue: false,

    feedRoot() {
      return document.querySelector('shreddit-feed');
    },

    items(root) {
      const out = [];
      for (const post of root.querySelectorAll('shreddit-post')) {
        const art = post.closest('article') || post;
        if (root.contains(art) && out[out.length - 1] !== art) out.push(art);
      }
      return out;
    },

    loaderSelector: 'shreddit-feed faceplate-partial[slot="load-after"]',

    async loadMore(engine) {
      const loader = lastLoader();
      if (!loader) return false;
      const page = U.pageObj(loader);
      if (typeof page.load === 'function') {
        const grew = engine.waitForGrowth();
        try {
          page.load();
        } catch (_) {
          return engine.revealLoaderUntilGrowth();
        }
        return grew;
      }
      return engine.revealLoaderUntilGrowth();
    },

    info(el) {
      return postInfo(el.matches('shreddit-post') ? el : el.querySelector('shreddit-post'));
    },

    signature(el) {
      const post = el.matches('shreddit-post') ? el : el.querySelector('shreddit-post');
      return post ? post.getAttribute('id') || '' : '';
    },

    isAd(el) {
      return !!(
        el.matches('shreddit-ad-post, [promoted]') ||
        el.querySelector('shreddit-ad-post, shreddit-post[promoted]')
      );
    },

    sightingInfo(el) {
      return el.matches('shreddit-post') ? postInfo(el) : searchResultInfo(el);
    },

    async later() {
      return { local: true, message: 'Saved to your Later list' };
    },

    async pageItem() {
      const path = location.pathname;
      const post = await U.waitFor(
        () => {
          for (const p of document.querySelectorAll('shreddit-post')) {
            const link = p.getAttribute('permalink') || '';
            if (link && path.startsWith(link.replace(/\/+$/, ''))) return p;
          }
          return document.querySelector('shreddit-post[view-context="CommentsPage"]');
        },
        { timeout: 8000, interval: 200 }
      );
      return postInfo(post);
    },
  };
})();
