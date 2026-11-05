'use strict';
/* One test per issue found by the adversarial review, so they stay fixed. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makePage, closeAll, fixture, sleep, until } = require('./helpers');

test.afterEach(closeAll);

const current = (doc) => doc.querySelectorAll('[otaat-current]');

function xCell(doc, user, id, y) {
  const cell = doc.createElement('div');
  cell.setAttribute('data-testid', 'cellInnerDiv');
  cell.setAttribute('style', `transform: translateY(${y}px); position: absolute; width: 100%;`);
  cell.innerHTML = `<article data-testid="tweet"><div data-testid="User-Name"><a href="/${user}"><span>${user}</span></a>
    <a href="/${user}/status/${id}"><time datetime="2026-10-14T10:00:00.000Z">1h</time></a></div>
    <div data-testid="tweetText"><span>Post ${id}</span></div></article>`;
  doc.querySelector('[data-testid="primaryColumn"] section > div').append(cell);
}

test('X: keeps scrolling past already-sorted posts instead of giving up', async () => {
  let scrolls = 0;
  const { document, window } = makePage({
    url: 'https://x.com/home',
    bodyHtml: fixture('x-classic-home.html'),
    sorted: ['x:1111111111111111111', 'x:3333333333333333333', 'x:5551', 'x:5552'],
    beforeScripts(w) {
      // Each scroll renders the next posts, like X's virtualized timeline.
      w.scrollTo = () => {
        scrolls++;
        if (scrolls === 1) {
          xCell(w.document, 'old', '5551', 1300);
          xCell(w.document, 'old', '5552', 1700);
        } else if (scrolls === 2) {
          xCell(w.document, 'fresh', '7777', 2100);
        }
      };
    },
  });
  await until(
    () => document.querySelector('[otaat-current] a[href="/fresh/status/7777"]'),
    'the unsorted post after a batch of sorted ones becomes current',
    8000
  );
  assert.equal(window.OTAAT.engine.state.ended, false);
});

test('Shorts: a Short swiped away before its title loads is still logged', async () => {
  const { window, browser } = makePage({
    url: 'https://www.youtube.com/shorts/AAAAAAAAAAA',
    bodyHtml: '<ytd-app><ytd-shorts></ytd-shorts></ytd-app>',
    withBridge: true,
    beforeScripts(w) {
      w.ytcfg = { get: () => true };
    },
  });
  await sleep(500);
  window.history.pushState({}, '', '/shorts/BBBBBBBBBBB'); // the user swipes on
  await until(() => browser.logged.some((e) => e.action === 'seen' && e.item.key === 'youtube:AAAAAAAAAAA'), 'first short logged', 6000);
  const entry = browser.logged.find((e) => e.item.key === 'youtube:AAAAAAAAAAA');
  assert.equal(entry.item.url, 'https://www.youtube.com/shorts/AAAAAAAAAAA');
});

test('In-app navigation into a feed hides it before the new content can paint', async () => {
  const { document, window } = makePage({ url: 'https://x.com/NASA', bodyHtml: fixture('x-classic-home.html') });
  await sleep(300);
  assert.ok(!document.documentElement.hasAttribute('otaat-q'), 'profile is not quantized');
  window.history.pushState({}, '', '/home');
  xCell(document, 'someone', '9999', 2500); // the new page renders
  await Promise.resolve(); // mutation observers run in this microtask checkpoint, before any paint
  assert.equal(document.documentElement.getAttribute('otaat-q'), 'home');
});

test('An item sorted in another tab leaves this tab\'s feed', async () => {
  const { document, window, browser } = makePage({ url: 'https://www.reddit.com/r/popular/', bodyHtml: fixture('reddit-feed.html') });
  await until(() => current(document).length === 1, 'a current post');
  const arts = [...document.querySelectorAll('shreddit-feed > article')];
  const key = window.OTAAT.engine.adapter.info(arts[0]).key;
  browser.fireStorage({ sortedPing: { newValue: { keys: [key], ts: Date.now() } } });
  await until(() => arts[1].hasAttribute('otaat-current'), 'moved on to the next post');
  assert.equal(browser.logged.filter((e) => e.action !== 'seen').length, 0, 'nothing logged twice in this tab');
});

function youtubeHome(opts = {}) {
  const body = `<ytd-app><ytd-page-manager><ytd-browse page-subtype="home">${fixture('youtube-grid.html')}</ytd-browse></ytd-page-manager></ytd-app>`;
  return makePage({
    url: 'https://www.youtube.com/',
    bodyHtml: body,
    withBridge: true,
    beforeScripts(w) {
      w.ytcfg = { get: (k) => k === 'LOGGED_IN' };
      w.document.querySelector('ytd-app').resolveCommand = () => true;
    },
    ...opts,
  });
}

test('Queue with "moves on" turned off keeps the video until Next', async () => {
  const { document, window, browser } = youtubeHome({ settings: { queueAdvances: false } });
  await until(() => current(document).length === 1, 'a current video');
  const items = [...document.querySelectorAll('ytd-rich-item-renderer')];
  window.OTAAT.engine.act('queue');
  await until(() => browser.logged.some((e) => e.action === 'queued'), 'queued', 6000);
  await sleep(400);
  assert.ok(items[0].hasAttribute('otaat-current'), 'still on the queued video');
  window.OTAAT.engine.act('next');
  await until(() => items[1].hasAttribute('otaat-current'), 'Next moves on');
  const keys = browser.logged.filter((e) => e.action !== 'seen').map((e) => `${e.action}:${e.item.key}`);
  const k0 = window.OTAAT.engine.adapter.info(items[0]).key;
  assert.deepEqual(keys, [`queued:${k0}`, `skipped:${k0}`]);
});

test('Changing settings while an action is saving does not leave the feed empty', async () => {
  const { document, browser } = makePage({
    url: 'https://www.reddit.com/r/popular/',
    bodyHtml: fixture('reddit-feed.html'),
    logDelay: 300,
  });
  await until(() => current(document).length === 1, 'a current post');
  document.defaultView.OTAAT.engine.act('next');
  await sleep(100); // the action is now waiting on the (slow) log write
  browser.fireStorage({ settings: { newValue: { barPosition: 'top' } } });
  await until(() => current(document).length === 1, 'an item is shown again', 4000);
});

test('Reddit: a promoted post inside an article is treated as an ad', () => {
  const { window } = makePage({
    url: 'https://example.com/',
    bodyHtml: '<shreddit-feed><article><shreddit-post id="t3_ad" permalink="/r/a/comments/ad/x/" post-title="Buy" promoted></shreddit-post></article></shreddit-feed>',
  });
  const rd = window.OTAAT.adapters.reddit;
  assert.equal(rd.isAd(window.document.querySelector('article')), true);
});

test('Reddit: search results are logged as sightings with the right link', () => {
  const { window } = makePage({
    url: 'https://www.reddit.com/search/?q=x',
    bodyHtml: `<div data-testid="search-post-unit"><a href="/r/space/comments/1wuzdac/solar_sails/" data-testid="post-title" aria-label="Solar sails">Solar sails</a><a href="/r/space/">r/space</a></div>`,
  });
  const rd = window.OTAAT.adapters.reddit;
  const info = rd.sightingInfo(window.document.querySelector('[data-testid="search-post-unit"]'));
  assert.equal(info.key, 'reddit:t3_1wuzdac');
  assert.equal(info.url, 'https://www.reddit.com/r/space/comments/1wuzdac/solar_sails/');
  assert.equal(info.title, 'Solar sails');
  assert.equal(info.extra.community, 'r/space');
});

// ---------------------------------------------------------------- second review

test('A feed that seemed to end loads again once its loader works again', async () => {
  let working = false;
  let pageNo = 0;
  const { document } = makePage({
    url: 'https://www.reddit.com/r/popular/',
    bodyHtml: fixture('reddit-feed.html'),
    beforeScripts(w) {
      w.OTAAT_TEST_TIMING = { load: 150, retry: 400 };
      w.document.querySelector('faceplate-partial[slot="load-after"]').load = () => {
        if (!working) return; // network trouble: nothing arrives
        const feed = w.document.querySelector('shreddit-feed');
        for (let i = 0; i < 3; i++) {
          const art = w.document.createElement('article');
          art.innerHTML = `<shreddit-post id="t3_n${++pageNo}" permalink="/r/t/comments/n${pageNo}/x/" post-title="New ${pageNo}"></shreddit-post>`;
          feed.insertBefore(art, w.document.querySelector('faceplate-partial[slot="load-after"]'));
        }
      };
    },
  });
  const engine = document.defaultView.OTAAT.engine;
  await until(() => engine.state.ended, 'the feed gives up after two empty loads', 4000);
  working = true;
  for (let i = 0; i < 3; i++) {
    await until(() => current(document).length === 1 && !engine.state.busy, 'an item is shown');
    await engine.act('next');
  }
  await until(() => document.querySelector('[otaat-current] shreddit-post[id^="t3_n"]'), 'loading resumed and a new post is shown', 5000);
});

test('X: the loader never scrolls a page the user has moved on to', async () => {
  const scrolls = [];
  const { window } = makePage({
    url: 'https://x.com/home',
    bodyHtml: fixture('x-classic-home.html'),
    sorted: ['x:1111111111111111111', 'x:3333333333333333333'],
    beforeScripts(w) {
      w.OTAAT_TEST_TIMING = { load: 600 };
      w.scrollTo = () => scrolls.push(w.location.pathname);
    },
  });
  await until(() => scrolls.length >= 1, 'the loader scrolls the timeline');
  window.history.pushState({}, '', '/carol/status/4444444444444444444');
  await sleep(1500);
  assert.ok(!scrolls.includes('/carol/status/4444444444444444444'), `scrolled: ${scrolls.join(', ')}`);
});

test('If the feed cannot be found, the page is shown normally instead of blank', async () => {
  const { document } = makePage({
    url: 'https://www.youtube.com/',
    bodyHtml: fixture('youtube-grid.html'), // no ytd-browse around it: the adapter can't find the feed
    beforeScripts(w) {
      w.OTAAT_TEST_TIMING = { grace: 300 };
    },
  });
  await sleep(100);
  assert.equal(document.documentElement.getAttribute('otaat-q'), 'home', 'hidden at first (no flash)');
  await until(() => !document.documentElement.hasAttribute('otaat-q'), 'hiding switched off', 3000);
  const bar = document.querySelector('[data-otaat-bar]').shadowRoot.querySelector('.status').textContent;
  assert.match(bar, /showing the page normally/);
});

test('A feed loaded in a background tab is logged only once the tab is looked at', async () => {
  let hidden = true;
  const { document, browser } = makePage({
    url: 'https://www.reddit.com/r/popular/',
    bodyHtml: fixture('reddit-feed.html'),
    beforeScripts(w) {
      Object.defineProperty(w.document, 'hidden', { get: () => hidden });
    },
  });
  await until(() => current(document).length === 1, 'a current post');
  await sleep(500);
  assert.equal(browser.logged.length, 0, 'nothing logged while the tab is in the background');
  hidden = false;
  document.dispatchEvent(new document.defaultView.Event('visibilitychange'));
  await until(() => browser.logged.some((e) => e.action === 'seen'), 'logged once visible');
  assert.equal(browser.logged.filter((e) => e.action === 'seen').length, 1);
});

test('X: a post that just says "Ad" (or an author named Ad) is not treated as an advert', () => {
  const { window } = makePage({
    url: 'https://example.com/',
    bodyHtml: `<main><div data-testid="primaryColumn">
      <div data-testid="cellInnerDiv"><article data-testid="tweet"><div data-testid="User-Name"><a href="/ad"><span>Ad</span></a></div>
        <a href="/ad/status/1"><time>1h</time></a><div data-testid="tweetText"><span>Ad</span></div></article></div>
    </div></main>`,
  });
  const x = window.OTAAT.adapters.x;
  assert.equal(x.isAd(window.document.querySelector('[data-testid="cellInnerDiv"]')), false);
});

test('X: a post page left before it loaded is logged under its own address', async () => {
  const { window, browser } = makePage({
    url: 'https://x.com/alice/status/1234',
    bodyHtml: '<main><div data-testid="primaryColumn"></div></main>',
  });
  await sleep(400);
  window.history.pushState({}, '', '/bob/status/5678');
  await until(() => browser.logged.some((e) => e.item.key === 'x:1234'), 'first post logged', 6000);
  const entry = browser.logged.find((e) => e.item.key === 'x:1234');
  assert.equal(entry.item.url, 'https://x.com/alice/status/1234');
});

test('X: post text is cut without splitting an emoji', () => {
  const text = 'a'.repeat(139) + '😀 and more text after the cut';
  const { window } = makePage({
    url: 'https://example.com/',
    bodyHtml: `<main><div data-testid="primaryColumn"><div data-testid="cellInnerDiv"><article data-testid="tweet">
      <a href="/u/status/42"><time>1h</time></a><div data-testid="tweetText">${text}</div></article></div></div></main>`,
  });
  const x = window.OTAAT.adapters.x;
  const info = x.info(window.document.querySelector('[data-testid="cellInnerDiv"]'));
  assert.ok(!/[\uD800-\uDBFF]$/.test(info.title), 'title does not end with half an emoji');
});

// ---- Opening an item: the feed being left must not flash (YouTube keeps it on screen ~0.2 s). ----

/** The page's real hiding rules, so what is on screen can be checked, not just our attributes. */
function withHideCss(document) {
  const style = document.createElement('style');
  style.textContent = require('./helpers').read('content/hide.css');
  document.head.append(style);
}
const onScreen = (doc) =>
  [...doc.querySelectorAll('ytd-rich-item-renderer')].filter((el) => {
    for (let p = el; p; p = p.parentElement) if (p.hidden || doc.defaultView.getComputedStyle(p).display === 'none') return false;
    return true;
  });

test('YouTube: opening a video keeps the old feed one-at-a-time until YouTube hides it', async () => {
  const { document, window } = youtubeHome();
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current video');
  assert.equal(onScreen(document).length, 1, 'one video on screen to start with');
  const shown = current(document)[0];
  const grid = document.querySelector('ytd-rich-grid-renderer');

  window.history.pushState({}, '', '/watch?v=NiCgcUTL9_Q'); // the click: the address changes first...
  document.querySelector('ytd-page-manager').append(document.createElement('ytd-watch-flexy')); // ...the new page starts
  await Promise.resolve();
  assert.equal(document.documentElement.getAttribute('otaat-q'), null, 'the watch page itself is not quantized');
  assert.equal(grid.getAttribute('otaat-retired'), 'collapse');
  assert.deepEqual(onScreen(document), [shown], 'still only the video that was clicked');
  await sleep(500);
  assert.deepEqual(onScreen(document), [shown], 'and so it stays while the old page is up');

  document.querySelector('ytd-browse').hidden = true; // YouTube swaps the old page out
  await until(() => !grid.hasAttribute('otaat-retired'), 'the old feed is let go once hidden');
  assert.equal(document.querySelectorAll('[otaat-current], [otaat-has-current]').length, 0, 'no marks left behind');
});

test('YouTube: going back to the feed before it was swapped out picks it up again', async () => {
  const { document, window } = youtubeHome();
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current video');
  const grid = document.querySelector('ytd-rich-grid-renderer');
  window.history.pushState({}, '', '/watch?v=NiCgcUTL9_Q');
  await until(() => grid.hasAttribute('otaat-retired'), 'retired on leaving');
  window.history.back();
  await until(() => !grid.hasAttribute('otaat-retired') && document.documentElement.getAttribute('otaat-q') === 'home', 'live again');
  await until(() => current(document).length === 1, 'a current video again');
  assert.equal(onScreen(document).length, 1);
});

test('Pausing shows the feed at once (a settings change is not leaving the page)', async () => {
  const { document, browser } = youtubeHome();
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current video');
  browser.fireStorage({ settings: { newValue: { paused: { youtube: true } } } });
  await until(() => onScreen(document).length > 1, 'the whole feed shows');
  assert.equal(document.querySelectorAll('[otaat-retired]').length, 0);
});

test('A feed container the next page re-uses for its own content is let go at once', async () => {
  const { document, window } = youtubeHome();
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current video');
  const grid = document.querySelector('ytd-rich-grid-renderer');
  const total = document.querySelectorAll('ytd-rich-item-renderer').length;
  window.history.pushState({}, '', '/@veritasium/videos'); // channel pages are not quantized by default
  await until(() => grid.hasAttribute('otaat-retired'), 'retired on leaving');
  await sleep(300);
  assert.ok(grid.hasAttribute('otaat-retired'), 'same old content: stays retired');
  refill(document); // YouTube re-uses the grid's elements for the channel's videos
  await Promise.resolve();
  assert.ok(!grid.hasAttribute('otaat-retired'), 'let go as soon as the content is the new page\'s');
  assert.equal(onScreen(document).length, total, 'the channel page shows normally');
});

/** Every video in the grid now shows a different video (elements re-used in place, as YouTube does). */
function refill(document) {
  let n = 0;
  for (const item of document.querySelectorAll('ytd-rich-item-renderer')) {
    const id = `NEWVIDEO${String(n++).padStart(3, '0')}`;
    for (const a of item.querySelectorAll('a[href*="/watch"]')) a.setAttribute('href', `/watch?v=${id}`);
  }
}

test('Re-used for the next page in the same step as the address change: let go at once', async () => {
  const { document, window } = youtubeHome();
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current video');
  const grid = document.querySelector('ytd-rich-grid-renderer');
  window.history.pushState({}, '', '/@veritasium/videos');
  refill(document);
  document.body.append(document.createElement('span'));
  await Promise.resolve();
  assert.ok(!grid.hasAttribute('otaat-retired'));
  assert.equal(onScreen(document).length, document.querySelectorAll('ytd-rich-item-renderer').length);
});

test('With nothing on show when leaving, the old page growing is not mistaken for the next page', async () => {
  const { document, window, browser } = youtubeHome();
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current video');
  const items = [...document.querySelectorAll('ytd-rich-item-renderer')];
  const keys = items.map((el) => window.OTAAT.engine.adapter.info(el).key);
  browser.fireStorage({ sortedPing: { newValue: { keys, ts: Date.now() } } }); // everything sorted: nothing on show
  await until(() => current(document).length === 0, 'nothing current');
  const grid = document.querySelector('ytd-rich-grid-renderer');
  window.history.pushState({}, '', '/watch?v=NiCgcUTL9_Q');
  await until(() => grid.hasAttribute('otaat-retired'), 'retired on leaving');
  const late = items[0].cloneNode(true); // a batch that was already loading arrives
  for (const a of late.querySelectorAll('a[href*="/watch"]')) a.setAttribute('href', '/watch?v=LATEARRIVAL');
  grid.querySelector('#contents').append(late);
  await sleep(300);
  assert.ok(grid.hasAttribute('otaat-retired'), 'still retired');
  assert.equal(onScreen(document).length, 0, 'and nothing of it on screen');
});

test('YouTube home → Subscriptions: the old page is not taken for the new feed while it is still up', async () => {
  const { document, window, browser } = youtubeHome();
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current video');
  const home = document.querySelector('ytd-browse');
  await until(() => browser.logged.some((e) => e.surface === 'home'), 'the home video logged under home', 2000);
  window.history.pushState({}, '', '/feed/subscriptions');
  await until(() => home.querySelector('[otaat-retired]'), 'home retired on leaving');
  await sleep(400);
  assert.equal(browser.logged.filter((e) => e.surface === 'subscriptions').length, 0, 'nothing logged from the old page');
  assert.equal(onScreen(document).length, 1, 'and still one video on screen');
  // YouTube's subscriptions page arrives and the home page is hidden.
  const subs = document.createElement('ytd-browse');
  subs.setAttribute('page-subtype', 'subscriptions');
  subs.innerHTML = fixture('youtube-grid.html').replace(/NiCgcUTL9_Q/g, 'SUBSCRIBE01');
  home.hidden = true;
  home.after(subs);
  await until(() => subs.querySelector('[otaat-current]'), 'a video from the subscriptions feed');
  await until(() => browser.logged.some((e) => e.surface === 'subscriptions'), 'logged', 2000);
  const seen = browser.logged.filter((e) => e.surface === 'subscriptions');
  assert.deepEqual(seen.map((e) => e.item.key), ['youtube:SUBSCRIBE01']);
});

test('X: leaving the timeline keeps every other cell (posts and "Who to follow") invisible until it is gone', async () => {
  const { document, window } = makePage({ url: 'https://x.com/home', bodyHtml: fixture('x-classic-home.html') });
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current post');
  const list = current(document)[0].parentElement;
  const cells = [...list.children];
  const hidden = () => cells.filter((c) => window.getComputedStyle(c).visibility === 'hidden').length;
  assert.equal(hidden(), cells.length - 1, 'one cell visible to start with');

  window.history.pushState({}, '', '/alice/status/1111111111111111111');
  document.querySelector('[data-testid="primaryColumn"]').append(document.createElement('div')); // the post page starts
  await Promise.resolve();
  assert.equal(document.documentElement.getAttribute('otaat-q'), null);
  assert.equal(list.getAttribute('otaat-retired'), 'spotlight');
  assert.ok(!document.querySelector('[data-testid="primaryColumn"]').hasAttribute('otaat-retired'), 'the column stays free for the post page');
  assert.equal(hidden(), cells.length - 1, 'still only the post that was on show');
  assert.ok(document.documentElement.hasAttribute('otaat-retiring'));

  list.remove(); // X unmounts the timeline
  await until(() => !list.hasAttribute('otaat-retired'), 'let go once removed', 1000);
  assert.equal(list.querySelectorAll('[otaat-current]').length, 0, 'no marks kept on the removed timeline');
  assert.ok(!document.documentElement.hasAttribute('otaat-retiring'));
});

test('Reddit: a feed taken out and put back (Back) shows one post, not two', async () => {
  const { document, window, browser } = makePage({ url: 'https://www.reddit.com/r/popular/', bodyHtml: fixture('reddit-feed.html') });
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current post');
  const feed = document.querySelector('shreddit-feed');
  const parent = feed.parentElement;
  const first = current(document)[0];
  window.history.pushState({}, '', '/r/popular/comments/abc123/a_post/');
  await until(() => feed.hasAttribute('otaat-retired'), 'retired on leaving');
  feed.remove(); // the post page replaces the feed
  await until(() => !feed.hasAttribute('otaat-retired'), 'let go once removed', 1000);
  browser.fireStorage({ sortedPing: { newValue: { keys: [window.OTAAT.engine.adapter.info(first).key], ts: Date.now() } } });
  window.history.back();
  parent.append(feed); // the site restores the cached feed
  await until(() => document.documentElement.getAttribute('otaat-q') && current(document).length >= 1, 'the feed is live again');
  await sleep(300);
  assert.equal(current(document).length, 1, 'exactly one post marked');
  assert.ok(!first.hasAttribute('otaat-current'), 'the post sorted meanwhile is not shown');
  const shown = [...feed.querySelectorAll('article')].filter((a) => window.getComputedStyle(a).display !== 'none');
  assert.equal(shown.length, 1, 'one post on screen');
});

test('A feed removed together with the address change leaves no marks behind', async () => {
  const { document, window } = makePage({ url: 'https://www.reddit.com/r/popular/', bodyHtml: fixture('reddit-feed.html') });
  await until(() => current(document).length === 1, 'a current post');
  const feed = document.querySelector('shreddit-feed');
  window.history.pushState({}, '', '/r/popular/comments/abc123/a_post/');
  feed.remove(); // in the same task: never retired, since it is already gone
  await until(() => document.documentElement.getAttribute('otaat-q') === null, 'left the feed');
  assert.equal(feed.querySelectorAll('[otaat-current], [otaat-has-current]').length, 0);
  assert.ok(!feed.hasAttribute('otaat-retired'));
});

test('Pausing while a feed just left is still on screen shows it at once', async () => {
  const { document, window, browser } = youtubeHome();
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current video');
  const grid = document.querySelector('ytd-rich-grid-renderer');
  window.history.pushState({}, '', '/watch?v=NiCgcUTL9_Q');
  await until(() => grid.hasAttribute('otaat-retired'), 'retired on leaving');
  browser.fireStorage({ settings: { newValue: { paused: { youtube: true } } } });
  await until(() => !grid.hasAttribute('otaat-retired'), 'let go on pause');
  assert.equal(onScreen(document).length, document.querySelectorAll('ytd-rich-item-renderer').length);
});

test('A video the site re-rendered just before the click is still the one kept on screen', async () => {
  const { document, window } = youtubeHome();
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current video');
  const grid = document.querySelector('ytd-rich-grid-renderer');
  const old = current(document)[0];
  const copy = old.cloneNode(true);
  copy.removeAttribute('otaat-current');
  old.replaceWith(copy); // re-rendered, and the click lands before the next scan
  window.history.pushState({}, '', '/watch?v=NiCgcUTL9_Q');
  await Promise.resolve();
  assert.ok(grid.hasAttribute('otaat-retired'));
  assert.deepEqual(onScreen(document), [copy]);
  await sleep(400);
  assert.ok(grid.hasAttribute('otaat-retired'), 'not mistaken for the next page taking over');
  assert.deepEqual(onScreen(document), [copy]);
});

test('X: the timeline behind the compose box stays one-at-a-time, however long it is open', async () => {
  const { document, window, browser } = makePage({
    url: 'https://x.com/home',
    bodyHtml: fixture('x-classic-home.html'),
    beforeScripts(w) {
      w.OTAAT_TEST_TIMING = { retire: 300 };
    },
  });
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current post');
  const list = current(document)[0].parentElement;
  const cells = [...list.children];
  const hidden = () => cells.filter((c) => window.getComputedStyle(c).visibility === 'hidden').length;
  window.history.pushState({}, '', '/compose/post');
  document.body.append(document.createElement('div')); // the compose box opens over the timeline
  await until(() => list.hasAttribute('otaat-retired'), 'retired on leaving');
  await sleep(800); // well past the safety limit
  browser.fireStorage({ settings: { newValue: { barPosition: 'top' } } }); // an unrelated settings change
  await sleep(200);
  assert.ok(list.hasAttribute('otaat-retired'), 'unchanged and on screen: still the old page');
  assert.equal(hidden(), cells.length - 1);
  const pill = document.createElement('div');
  pill.setAttribute('data-testid', 'pillLabel');
  document.querySelector('[data-testid="primaryColumn"]').prepend(pill);
  assert.equal(window.getComputedStyle(pill).display, 'none', '"Show new posts" stays hidden too');
});

test('A left feed that changed without becoming a new page is let go after the safety limit', async () => {
  const { document, window } = youtubeHome({
    beforeScripts(w) {
      w.ytcfg = { get: (k) => k === 'LOGGED_IN' };
      w.document.querySelector('ytd-app').resolveCommand = () => true;
      w.OTAAT_TEST_TIMING = { retire: 400 };
    },
  });
  await until(() => current(document).length === 1, 'a current video');
  const grid = document.querySelector('ytd-rich-grid-renderer');
  window.history.pushState({}, '', '/watch?v=NiCgcUTL9_Q');
  await until(() => grid.hasAttribute('otaat-retired'), 'retired on leaving');
  current(document)[0].querySelector('a[href*="/watch"]').setAttribute('href', '/watch?v=CCCCCCCCCCC');
  await sleep(150);
  assert.ok(grid.hasAttribute('otaat-retired'), 'one changed video is not a new page');
  await until(() => !grid.hasAttribute('otaat-retired'), 'let go after the limit', 2000);
});

// ---- Feed → feed: the page just left is never taken for the next feed ----

function xTimeline(doc, label, posts) {
  const wrap = doc.createElement('div');
  wrap.setAttribute('aria-label', label);
  wrap.innerHTML = `<section role="region"><div style="position: relative;">${posts
    .map(
      ([user, id], i) => `<div data-testid="cellInnerDiv" style="transform: translateY(${i * 400}px); position: absolute; width: 100%;">
        <article data-testid="tweet"><div data-testid="User-Name"><a href="/${user}"><span>${user}</span></a>
        <a href="/${user}/status/${id}"><time datetime="2026-10-14T10:00:00.000Z">1h</time></a></div>
        <div data-testid="tweetText"><span>Post ${id}</span></div></article></div>`
    )
    .join('')}</div></section>`;
  return wrap;
}

test('X: Home → a list: the Home posts still mounted are not shown or logged as the list', async () => {
  const { document, window, browser } = makePage({ url: 'https://x.com/home', bodyHtml: fixture('x-classic-home.html') });
  withHideCss(document);
  await until(() => browser.logged.some((e) => e.surface === 'home'), 'a Home post logged', 2000);
  const column = document.querySelector('[data-testid="primaryColumn"]');
  const homeTimeline = column.querySelector('[aria-label="Home timeline"]');
  window.history.pushState({}, '', '/i/lists/123456');
  document.body.append(document.createElement('span'));
  await sleep(400);
  assert.equal(browser.logged.filter((e) => e.surface === 'lists').length, 0, 'nothing logged from the Home timeline');
  column.append(xTimeline(document, 'Timeline: List', [['dora', '9990001'], ['ed', '9990002']])); // the list arrives
  await until(() => document.querySelector('[aria-label="Timeline: List"] [otaat-current]'), 'a post from the list');
  await until(() => browser.logged.some((e) => e.surface === 'lists'), 'logged', 2000);
  assert.deepEqual(browser.logged.filter((e) => e.surface === 'lists').map((e) => e.item.key), ['x:9990001']);
  homeTimeline.remove();
  await until(() => !document.documentElement.hasAttribute('otaat-retiring'), 'the old timeline let go');
});

test('Reddit: one listing → another (same kind): the old listing is not used while it is still up', async () => {
  const { document, window, browser } = makePage({ url: 'https://www.reddit.com/r/popular/', bodyHtml: fixture('reddit-feed.html') });
  withHideCss(document);
  await until(() => browser.logged.some((e) => e.action === 'seen'), 'a post logged', 2000);
  const old = document.querySelector('shreddit-feed');
  window.history.pushState({}, '', '/r/popular/top/');
  document.body.append(document.createElement('span'));
  await sleep(400);
  assert.equal(browser.logged.filter((e) => e.pageUrl.includes('/top/')).length, 0, 'nothing logged from the old listing');
  const fresh = document.createElement('div');
  fresh.innerHTML = fixture('reddit-feed.html').replace(/1x5/g, '9z9');
  old.replaceWith(fresh); // the new listing replaces the old one
  await until(() => fresh.querySelector('[otaat-current]'), 'a post from the new listing');
  await until(() => browser.logged.some((e) => e.pageUrl.includes('/top/')), 'logged', 2000);
  assert.ok(browser.logged.filter((e) => e.pageUrl.includes('/top/')).every((e) => e.item.key.includes('9z9')));
});

test('YouTube: a feed already built behind the old one starts as soon as the old one is hidden', async () => {
  const { document, window } = youtubeHome();
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current video');
  const home = document.querySelector('ytd-browse');
  const subs = document.createElement('ytd-browse');
  subs.setAttribute('page-subtype', 'subscriptions');
  subs.innerHTML = fixture('youtube-grid.html').replace(/NiCgcUTL9_Q/g, 'SUBSCRIBE01');
  window.history.pushState({}, '', '/feed/subscriptions');
  home.after(subs); // YouTube builds the new page first...
  await sleep(400);
  assert.equal(subs.querySelectorAll('[otaat-current]').length, 0, 'waits while the old page is in front');
  home.hidden = true; // ...then swaps (an attribute change only)
  await until(() => subs.querySelector('[otaat-current]'), 'the new feed starts right away', 1000);
});

test('An old feed re-drawn with new elements (same videos) is still the old feed', async () => {
  const { document, window } = youtubeHome();
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current video');
  const grid = document.querySelector('ytd-rich-grid-renderer');
  window.history.pushState({}, '', '/watch?v=NiCgcUTL9_Q');
  await until(() => grid.hasAttribute('otaat-retired'), 'retired on leaving');
  for (const item of [...document.querySelectorAll('ytd-rich-item-renderer')]) {
    const copy = item.cloneNode(true);
    copy.removeAttribute('otaat-current');
    item.replaceWith(copy);
  }
  await sleep(400);
  assert.ok(grid.hasAttribute('otaat-retired'), 'not mistaken for the next page');
  assert.equal(onScreen(document).length, 1, 'and the same video is still the only one on screen');
  assert.ok(onScreen(document)[0].querySelector('a[href*="NiCgcUTL9_Q"]'));
});

test('Re-used for the next page with the same first video: still recognised as the next page', async () => {
  const { document, window } = youtubeHome();
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current video');
  const grid = document.querySelector('ytd-rich-grid-renderer');
  window.history.pushState({}, '', '/@veritasium/videos');
  await until(() => grid.hasAttribute('otaat-retired'), 'retired on leaving');
  let n = 0;
  for (const item of document.querySelectorAll('ytd-rich-item-renderer:not([otaat-current])')) {
    for (const a of item.querySelectorAll('a[href*="/watch"]')) a.setAttribute('href', `/watch?v=OTHERVIDE${n}0`);
    n++;
  }
  await until(() => !grid.hasAttribute('otaat-retired'), 'let go', 1000);
});

test('Back on the same video after opening it: the bar counts it as #1, not #0', async () => {
  const { document, window } = youtubeHome();
  await until(() => current(document).length === 1, 'a current video');
  window.history.pushState({}, '', '/watch?v=NiCgcUTL9_Q');
  document.body.append(document.createElement('span'));
  await sleep(100);
  window.history.pushState({}, '', '/');
  document.body.append(document.createElement('span'));
  await until(() => window.OTAAT.engine.state.current, 'current again');
  assert.equal(window.OTAAT.engine.state.shownCount, 1);
});

test('X: after a photo viewer over Home, the post on show is still visible', async () => {
  const { document, window } = makePage({ url: 'https://x.com/home', bodyHtml: fixture('x-classic-home.html') });
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current post');
  const cells = [...document.querySelectorAll('[data-testid="cellInnerDiv"]')];
  window.OTAAT.engine.act('next'); // move past the first post, so "Who to follow" sits above the current one
  await until(() => current(document)[0] && current(document)[0] !== cells[0], 'moved on');
  window.history.pushState({}, '', '/alice/status/1111111111111111111/photo/1');
  document.body.append(document.createElement('div')); // the viewer opens over the timeline
  await sleep(400);
  window.history.pushState({}, '', '/home');
  document.body.append(document.createElement('span'));
  await until(() => current(document).length === 1, 'current again');
  await sleep(300);
  assert.equal(document.querySelectorAll('[otaat-discover]').length, 0, 'no "Discover more" marks on the timeline');
  assert.equal(window.getComputedStyle(current(document)[0]).visibility, 'visible');
});

test('The same feed under a rewritten address (Reddit adds ?feed=home) carries on at once', async () => {
  const { document, window } = makePage({ url: 'https://www.reddit.com/', bodyHtml: fixture('reddit-feed.html') });
  withHideCss(document);
  await until(() => window.OTAAT.engine.state.current, 'a current post');
  window.history.replaceState({}, '', '/?feed=home');
  document.body.append(document.createElement('span'));
  await until(() => window.OTAAT.engine.state.current, 'a current post again', 1000);
  assert.equal(document.querySelectorAll('[otaat-retired]').length, 0, 'nothing set aside');
});

test('A listing rebuilt in place for the next page (new posts first) is used at once, not after the wait', async () => {
  const { document, window, browser } = makePage({ url: 'https://www.reddit.com/r/popular/', bodyHtml: fixture('reddit-feed.html') });
  withHideCss(document);
  await until(() => window.OTAAT.engine.state.current, 'a current post');
  const feed = document.querySelector('shreddit-feed');
  window.history.pushState({}, '', '/r/popular/top/');
  document.body.append(document.createElement('span'));
  await until(() => feed.hasAttribute('otaat-retired'), 'retired on leaving');
  const top = feed.querySelector('article').cloneNode(true);
  top.removeAttribute('otaat-current');
  top.removeAttribute('otaat-item');
  top.innerHTML = top.innerHTML.replace(/1x5\w+/g, '9toppost');
  feed.prepend(top); // Reddit re-fills the same feed: the new listing's first post comes first
  await until(() => top.hasAttribute('otaat-current'), 'the new listing starts', 1000);
  await until(() => browser.logged.some((e) => e.pageUrl.includes('/top/')), 'logged', 2000);
  assert.ok(browser.logged.filter((e) => e.pageUrl.includes('/top/')).every((e) => e.item.key.includes('9toppost')));
});

test('X: a Home timeline left mounted beside a list stays out of the list, even after the wait', async () => {
  const { document, window, browser } = makePage({
    url: 'https://x.com/home',
    bodyHtml: fixture('x-classic-home.html'),
    beforeScripts(w) {
      w.OTAAT_TEST_TIMING = { grace: 300 };
    },
  });
  await until(() => browser.logged.some((e) => e.surface === 'home'), 'a Home post logged', 2000);
  const column = document.querySelector('[data-testid="primaryColumn"]');
  window.history.pushState({}, '', '/i/lists/123456');
  column.append(xTimeline(document, 'Timeline: List', [['dora', '9990001'], ['ed', '9990002']]));
  await until(() => document.querySelector('[aria-label="Timeline: List"] [otaat-current]'), 'a post from the list');
  await sleep(600); // past the wait
  window.OTAAT.engine.act('next');
  await until(() => browser.logged.some((e) => e.action === 'skipped'), 'skipped', 2000);
  await sleep(500);
  const keys = browser.logged.filter((e) => e.surface === 'lists').map((e) => e.item.key);
  assert.ok(keys.length >= 2 && keys.every((k) => k.startsWith('x:999')), `only list posts: ${keys}`);
});

const X_POST_PAGE = `<main><div data-testid="primaryColumn"><section><div>
    <div data-testid="cellInnerDiv" style="transform: translateY(0px)"><article data-testid="tweet"><a href="/a"><span>A</span></a><a href="/a/status/1"><time>1h</time></a><div data-testid="tweetText">Focal</div></article></div>
    <div data-testid="cellInnerDiv" style="transform: translateY(300px)"><article data-testid="tweet"><a href="/b"><span>B</span></a><a href="/b/status/2"><time>1h</time></a><div data-testid="tweetText">A reply</div></article></div>
    <div data-testid="cellInnerDiv" style="transform: translateY(500px)"><div><h2 role="heading">Discover more</h2></div></div>
    <div data-testid="cellInnerDiv" style="transform: translateY(600px)"><article data-testid="tweet"><a href="/c"><span>C</span></a><a href="/c/status/3"><time>1h</time></a><div data-testid="tweetText">Unrelated</div></article></div>
  </div></section></div></main>`;

test('X: replying from a post page keeps "Discover more" hidden behind the compose box', async () => {
  const { document, window } = makePage({ url: 'https://x.com/a/status/1', bodyHtml: X_POST_PAGE });
  const cells = [...document.querySelectorAll('[data-testid="cellInnerDiv"]')];
  await until(() => cells[3].hasAttribute('otaat-discover'), 'discover section marked');
  window.history.pushState({}, '', '/compose/post');
  document.body.append(document.createElement('div'));
  await sleep(500);
  assert.ok(cells[3].hasAttribute('otaat-discover') && cells[2].hasAttribute('otaat-discover'));
});

test('X: the timeline to set aside is the live one, not an older one still mounted', () => {
  const { window } = makePage({ url: 'https://example.com/', bodyHtml: '' });
  const d = window.document;
  const column = d.createElement('div');
  column.setAttribute('data-testid', 'primaryColumn');
  const old = xTimeline(d, 'Home timeline', [['old', '1000001']]);
  old.querySelector('section > div').setAttribute('otaat-retired', 'spotlight');
  const live = xTimeline(d, 'Timeline: List', [['dora', '9990001']]);
  column.append(old, live);
  d.body.append(column);
  const x = window.OTAAT.adapters.x;
  assert.equal(x.retireRoot(column, null), live.querySelector('section > div'));
});

test('X: posts trimmed from the timeline behind a modal do not count as a new page', async () => {
  const { document, window } = makePage({ url: 'https://x.com/home', bodyHtml: fixture('x-classic-home.html') });
  withHideCss(document);
  await until(() => current(document).length === 1, 'a current post');
  const list = current(document)[0].parentElement;
  window.history.pushState({}, '', '/compose/post');
  document.body.append(document.createElement('div'));
  await until(() => list.hasAttribute('otaat-retired'), 'retired on leaving');
  for (const cell of [...list.children].filter((c) => !c.hasAttribute('otaat-current'))) cell.remove(); // virtualized list trims
  await sleep(400);
  assert.ok(list.hasAttribute('otaat-retired'), 'still the old timeline');
  const visible = [...list.children].filter((c) => window.getComputedStyle(c).visibility !== 'hidden');
  assert.equal(visible.length, 1);
});

// ---- No empty page around the one item ----

test('The one item is given the free space below a feed that starts high up (to sit in its middle)', async () => {
  const { document, window } = youtubeHome();
  await until(() => current(document).length === 1, 'a current video');
  const grid = document.querySelector('ytd-rich-grid-renderer');
  const stage = parseInt(grid.style.getPropertyValue('--otaat-stage'), 10);
  assert.ok(stage > 0 && stage < window.innerHeight, `space given: ${stage}`);
});

test('...but not below a tall page header (the item would drift away from it)', async () => {
  const { document } = youtubeHome({
    beforeScripts(w) {
      w.ytcfg = { get: (k) => k === 'LOGGED_IN' };
      w.document.querySelector('ytd-app').resolveCommand = () => true;
      const grid = w.document.querySelector('ytd-rich-grid-renderer');
      grid.getBoundingClientRect = () => ({ top: 500, bottom: 900, left: 0, right: 800, width: 800, height: 400, x: 0, y: 500 });
    },
  });
  await until(() => current(document).length === 1, 'a current video');
  assert.equal(document.querySelector('ytd-rich-grid-renderer').style.getPropertyValue('--otaat-stage'), '');
});

test('An item pushed under the bar while the page settles is brought back into view, until the user scrolls', async () => {
  const observers = [];
  const scrolls = [];
  const { document, window } = youtubeHome({
    beforeScripts(w) {
      w.ytcfg = { get: (k) => k === 'LOGGED_IN' };
      w.document.querySelector('ytd-app').resolveCommand = () => true;
      w.ResizeObserver = class {
        constructor(cb) { this.cb = cb; observers.push(this); }
        observe() {}
        disconnect() { this.off = true; }
      };
      w.scrollTo = (o) => scrolls.push(o.top);
    },
  });
  await until(() => current(document).length === 1, 'a current video');
  const item = current(document)[0];
  const H = window.innerHeight;
  if (scrolls.length) window.dispatchEvent(new window.Event('scroll')); // the first reveal's own scroll
  const before = scrolls.length;
  // The channel header's pictures load: the item now sits half under the bottom edge.
  item.getBoundingClientRect = () => ({ top: H - 100, bottom: H + 200, left: 0, right: 600, width: 600, height: 300, x: 0, y: H - 100 });
  const ro = observers.find((o) => !o.off);
  ro.cb([]);
  assert.equal(scrolls.length, before + 1, 'scrolled to bring it back');
  window.dispatchEvent(new window.Event('scroll')); // (our own scroll)
  window.dispatchEvent(new window.Event('scroll')); // the user scrolls
  ro.cb([]);
  assert.equal(scrolls.length, before + 1, 'then leaves the page where the user put it');
  assert.ok(ro.off, 'and stops watching');
});

test('A retired feed says which feed it was (for its own CSS) until it is let go', async () => {
  const { document, window } = youtubeHome();
  await until(() => current(document).length === 1, 'a current video');
  const grid = document.querySelector('ytd-rich-grid-renderer');
  window.history.pushState({}, '', '/watch?v=NiCgcUTL9_Q');
  await until(() => grid.hasAttribute('otaat-retired'), 'retired on leaving');
  assert.equal(grid.getAttribute('otaat-from'), 'home');
  document.querySelector('ytd-browse').hidden = true;
  await until(() => !grid.hasAttribute('otaat-retired'), 'let go');
  assert.ok(!grid.hasAttribute('otaat-from'));
});

function phoneHome(cookie, settings) {
  return makePage({
    url: 'https://m.youtube.com/',
    bodyHtml: fixture('m-youtube-grid.html'),
    withBridge: true,
    settings,
    beforeScripts(w) {
      w.document.cookie = `PREF=${cookie}; domain=.youtube.com; path=/`;
    },
  });
}
const prefOf = (doc) => (doc.cookie.match(/(?:^|;\s*)PREF=([^;]*)/) || [])[1];

test('Keep autoplay off (phone site): YouTube\'s own autoplay preference is switched off at the source, other prefs kept', async () => {
  const { document } = phoneHome('tz=Etc.UTC&f5=20000&f6=40000000');
  await until(() => current(document).length === 1, 'a current video');
  assert.deepEqual(prefOf(document).split('&').sort(), ['f5=30000', 'f6=40000000', 'tz=Etc.UTC']);
  assert.equal(document.cookie.match(/PREF=/g).length, 1, 'one PREF cookie, not two');
});

test('...left alone when the setting is off, and on desktop YouTube (which keeps autoplay elsewhere)', async () => {
  const off = phoneHome('f5=20000', { hide: { ytAutoplay: false } });
  await until(() => current(off.document).length === 1, 'a current video');
  assert.equal(prefOf(off.document), 'f5=20000');
  const { document } = youtubeHome({
    beforeScripts(w) {
      w.ytcfg = { get: (k) => k === 'LOGGED_IN' };
      w.document.querySelector('ytd-app').resolveCommand = () => true;
      w.document.cookie = 'PREF=f5=20000; domain=.youtube.com; path=/';
    },
  });
  await until(() => current(document).length === 1, 'a current video');
  assert.equal(prefOf(document), 'f5=20000');
});
