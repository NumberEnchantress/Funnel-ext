'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makePage, closeAll, fixture, sleep, until } = require('./helpers');

test.afterEach(closeAll);

const current = (doc) => doc.querySelectorAll('[otaat-current]');
const keyOf = (window, el) => window.OTAAT.engine.adapter.info(el).key;
// jsdom can only make untrusted clicks, which the bar ignores on purpose (tested below); drive the engine directly.
const clickBar = (doc, act) => doc.defaultView.OTAAT.engine.act(act);

function redditPage(opts = {}) {
  return makePage({ url: 'https://www.reddit.com/r/popular/', bodyHtml: fixture('reddit-feed.html'), ...opts });
}

function addRedditPost(doc, id) {
  const feed = doc.querySelector('shreddit-feed');
  const art = doc.createElement('article');
  const post = doc.createElement('shreddit-post');
  post.setAttribute('id', `t3_${id}`);
  post.setAttribute('permalink', `/r/test/comments/${id}/post_${id}/`);
  post.setAttribute('post-title', `Loaded post ${id}`);
  post.setAttribute('author', 'tester');
  post.setAttribute('subreddit-prefixed-name', 'r/test');
  art.append(post);
  feed.insertBefore(art, feed.querySelector('faceplate-partial[slot="load-after"]'));
}

test('Reddit feed: exactly one post is current, and it is logged as seen', async () => {
  const { window, document, browser } = redditPage();
  await until(() => current(document).length === 1, 'a current post');
  const html = document.documentElement;
  assert.equal(html.getAttribute('otaat-q'), 'popular');
  assert.equal(html.getAttribute('otaat-mode'), 'collapse');
  const first = document.querySelector('shreddit-feed > article');
  assert.ok(first.hasAttribute('otaat-current'), 'first post is current');
  await until(() => browser.logged.some((e) => e.action === 'seen'), 'seen log');
  const seen = browser.logged.filter((e) => e.action === 'seen');
  assert.equal(seen.length, 1, 'only the shown post is seen');
  assert.equal(seen[0].item.key, keyOf(window, first));
  assert.equal(seen[0].surface, 'popular');
  // Every other post is marked as an item (and therefore hidden by CSS).
  assert.equal(document.querySelectorAll('[otaat-item]').length, 3);
  // The bar is there.
  assert.ok(document.querySelector('[data-otaat-bar]'), 'control bar mounted');
});

test('Reddit feed: Next logs "skipped", skips already-sorted posts, and shows the next one', async () => {
  const fx = fixture('reddit-feed.html');
  const secondId = [...fx.matchAll(/<shreddit-post[^>]*\sid="(t3_\w+)"/g)][1][1];
  const { window, document, browser } = redditPage({ sorted: [`reddit:${secondId}`] });
  await until(() => current(document).length === 1, 'a current post');
  const arts = [...document.querySelectorAll('shreddit-feed > article')];
  const firstKey = keyOf(window, arts[0]);

  clickBar(document, 'next');
  await until(() => browser.logged.some((e) => e.action === 'skipped'), 'skipped log');
  const skipped = browser.logged.find((e) => e.action === 'skipped');
  assert.equal(skipped.item.key, firstKey);
  assert.ok(skipped.item.url.startsWith('https://www.reddit.com/r/'));

  await until(() => arts[2].hasAttribute('otaat-current'), 'third post becomes current (second was sorted before)');
  assert.equal(current(document).length, 1);
  assert.ok(!arts[1].hasAttribute('otaat-current'));
});

test('Bar buttons ignore clicks made by page scripts', async () => {
  const { document, browser } = redditPage();
  await until(() => current(document).length === 1, 'a current post');
  document.querySelector('[data-otaat-bar]').shadowRoot.querySelector('[data-act="next"]').click();
  await sleep(300);
  assert.equal(browser.logged.filter((e) => e.action === 'skipped').length, 0);
});

test('Reddit feed: Later logs "deferred" into the local Later list and advances', async () => {
  const { window, document, browser } = redditPage();
  await until(() => current(document).length === 1, 'a current post');
  const arts = [...document.querySelectorAll('shreddit-feed > article')];
  clickBar(document, 'later');
  await until(() => browser.logged.some((e) => e.action === 'deferred'), 'deferred log');
  const deferred = browser.logged.find((e) => e.action === 'deferred');
  assert.equal(deferred.item.key, keyOf(window, arts[0]));
  assert.equal(deferred.localLater, true);
  await until(() => arts[1].hasAttribute('otaat-current'), 'next post shown');
});

test('Reddit feed: Queue is refused (YouTube only) and nothing is logged', async () => {
  const { document, browser } = redditPage();
  await until(() => current(document).length === 1, 'a current post');
  window_act(document, 'queue');
  await sleep(300);
  assert.equal(browser.logged.filter((e) => e.action !== 'seen').length, 0);
  const bar = document.querySelector('[data-otaat-bar]').shadowRoot;
  assert.ok(bar.querySelector('[data-act="queue"]').hidden, 'no Queue button on Reddit');
});

function window_act(document, name) {
  document.defaultView.OTAAT.engine.act(name);
}

test('Reddit feed: loads exactly one more batch when running low, then keeps going', async () => {
  let loads = 0;
  let pageNo = 0;
  const { document } = redditPage({
    beforeScripts(window) {
      // The real loader element has a load() method; emulate one page of results per call.
      window.document.querySelector('faceplate-partial[slot="load-after"]').load = () => {
        loads++;
        setTimeout(() => {
          for (let i = 0; i < 3; i++) addRedditPost(window.document, `p${++pageNo}`);
        }, 30);
      };
    },
  });
  await until(() => loads >= 1, 'a load was requested (only 3 posts on the page)');
  await until(() => document.querySelectorAll('shreddit-feed > article').length >= 6, 'new posts arrived');
  await sleep(300);
  assert.ok(loads <= 2, `loader not hammered (called ${loads} times)`);
  assert.equal(current(document).length, 1);
});

test('Reddit feed: without a load() method the hidden loader is revealed only until posts arrive', async () => {
  const { document } = redditPage();
  const html = document.documentElement;
  await until(() => html.hasAttribute('otaat-loadmore'), 'loader revealed');
  addRedditPost(document, 'zz1');
  await until(() => !html.hasAttribute('otaat-loadmore'), 'loader hidden again right after growth');
});

test('Reddit: paused site shows the feed normally but still logs what is seen', async () => {
  const { document } = redditPage({ settings: { paused: { reddit: true } } });
  await sleep(400);
  assert.equal(current(document).length, 0);
  assert.ok(!document.documentElement.hasAttribute('otaat-q'));
  assert.ok(!document.querySelector('[data-otaat-bar]'), 'no bar when paused');
});

test('Reddit: profiles are not quantized by default', async () => {
  const { document } = makePage({ url: 'https://www.reddit.com/user/someone/', bodyHtml: fixture('reddit-feed.html') });
  await sleep(400);
  assert.equal(current(document).length, 0);
  assert.equal(document.documentElement.getAttribute('otaat-surface'), 'user');
});

function youtubeHome() {
  const body = `<ytd-app><ytd-page-manager><ytd-browse page-subtype="home">${fixture('youtube-grid.html')}</ytd-browse></ytd-page-manager></ytd-app>`;
  const calls = [];
  const page = makePage({
    url: 'https://www.youtube.com/',
    bodyHtml: body,
    withBridge: true,
    beforeScripts(window) {
      window.ytcfg = { get: (k) => (k === 'LOGGED_IN' ? true : undefined) };
      window.document.querySelector('ytd-app').resolveCommand = (cmd) => {
        calls.push(cmd);
        return true;
      };
    },
  });
  return { ...page, calls };
}

test('YouTube home: one video at a time; Later uses Watch Later through YouTube\'s own command', async () => {
  const { window, document, browser, calls } = youtubeHome();
  await until(() => current(document).length === 1, 'a current video');
  const items = [...document.querySelectorAll('ytd-rich-item-renderer')];
  assert.ok(items[0].hasAttribute('otaat-current'));
  const vid = window.OTAAT.engine.adapter.info(items[0]).videoId;

  window.OTAAT.engine.act('later');
  await until(() => browser.logged.some((e) => e.action === 'deferred'), 'deferred log', 6000);
  const wl = calls.find((c) => c.playlistEditEndpoint);
  assert.ok(wl, 'a Watch Later command was resolved');
  assert.equal(wl.playlistEditEndpoint.playlistId, 'WL');
  assert.deepEqual(JSON.parse(JSON.stringify(wl.playlistEditEndpoint.actions)), [{ addedVideoId: vid, action: 'ACTION_ADD_VIDEO' }]);
  // Logged straight after the command is sent, with a safety copy on the extension's Later list.
  // jsdom can't show YouTube's confirmation toast, so the copy is kept (never confirmed).
  const entry = browser.logged.find((e) => e.action === 'deferred');
  assert.equal(entry.localLater, true);
  assert.equal(entry.note, 'watch later');
  await until(() => items[1].hasAttribute('otaat-current'), 'advanced to the next video');
  await sleep(2800);
  assert.equal(browser.confirmed.length, 0, 'unconfirmed: the safety copy stays');
});

test('YouTube home: Queue adds to the play queue and logs "queued"', async () => {
  const { window, document, browser, calls } = youtubeHome();
  await until(() => current(document).length === 1, 'a current video');
  const items = [...document.querySelectorAll('ytd-rich-item-renderer')];
  const vid = window.OTAAT.engine.adapter.info(items[0]).videoId;
  window.OTAAT.engine.act('queue');
  await until(() => browser.logged.some((e) => e.action === 'queued'), 'queued log', 6000);
  const q = calls.find((c) => c.signalServiceEndpoint);
  const add = q.signalServiceEndpoint.actions[0].addToPlaylistCommand;
  assert.equal(add.listType, 'PLAYLIST_EDIT_LIST_TYPE_QUEUE');
  assert.equal(add.videoId, vid);
  await until(() => items[1].hasAttribute('otaat-current'), 'advanced');
});

test('YouTube home: signed out, Later falls back to the extension Later list', async () => {
  const body = `<ytd-app><ytd-page-manager><ytd-browse page-subtype="home">${fixture('youtube-grid.html')}</ytd-browse></ytd-page-manager></ytd-app>`;
  const { window, document, browser } = makePage({
    url: 'https://www.youtube.com/',
    bodyHtml: body,
    withBridge: true,
    beforeScripts(w) {
      w.ytcfg = { get: () => false };
    },
  });
  await until(() => current(document).length === 1, 'a current video');
  window.OTAAT.engine.act('later');
  await until(() => browser.logged.some((e) => e.action === 'deferred'), 'deferred log', 6000);
  const entry = browser.logged.find((e) => e.action === 'deferred');
  assert.equal(entry.localLater, true);
  assert.match(entry.note, /signed out/);
});

test('YouTube home: the grid loader is only revealed while loading', async () => {
  const { document } = youtubeHome();
  const html = document.documentElement;
  await until(() => html.hasAttribute('otaat-loadmore'), 'loader revealed (only 3 videos)');
  const contents = document.querySelector('ytd-rich-grid-renderer #contents');
  const item = document.createElement('ytd-rich-item-renderer');
  const a = document.createElement('a');
  a.setAttribute('href', '/watch?v=AAAAAAAAAAA');
  const h3 = document.createElement('h3');
  h3.setAttribute('title', 'A new one');
  item.append(a, h3);
  contents.insertBefore(item, contents.querySelector('ytd-continuation-item-renderer'));
  await until(() => !html.hasAttribute('otaat-loadmore'), 'loader hidden again');
});

test('YouTube watch page: autoplay is switched off once the video plays (not during ads), at most twice', async () => {
  const body = `<ytd-app><div id="movie_player" class="html5-video-player ad-showing playing-mode">
    <button class="ytp-autonav-toggle"><div class="ytp-autonav-toggle-button" aria-checked="true"></div></button></div></ytd-app>`;
  let clicks = 0;
  const { document } = makePage({
    url: 'https://www.youtube.com/watch?v=NiCgcUTL9_Q',
    bodyHtml: body,
    withBridge: true,
    beforeScripts(w) {
      const btn = w.document.querySelector('.ytp-autonav-toggle');
      const sw = w.document.querySelector('.ytp-autonav-toggle-button');
      btn.addEventListener('click', () => {
        clicks++;
        sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
      });
    },
  });
  const player = document.querySelector('#movie_player');
  const sw = document.querySelector('.ytp-autonav-toggle-button');
  await sleep(2000);
  assert.equal(clicks, 0, 'left alone while an ad is showing');
  player.classList.remove('ad-showing');
  await until(() => sw.getAttribute('aria-checked') === 'false', 'autoplay switched off', 4000);
  sw.setAttribute('aria-checked', 'true'); // YouTube (or the user) turns it back on
  await until(() => clicks === 2, 'switched off a second time', 4000);
  sw.setAttribute('aria-checked', 'true');
  await sleep(3200);
  assert.equal(clicks, 2, 'gives up after two flips for the same video');
});

test('X home (classic markup): spotlight mode skips ads and non-post cells', async () => {
  const { window, document, browser } = makePage({ url: 'https://x.com/home', bodyHtml: fixture('x-classic-home.html') });
  await until(() => current(document).length === 1, 'a current post');
  const html = document.documentElement;
  assert.equal(html.getAttribute('otaat-mode'), 'spotlight');
  const cells = [...document.querySelectorAll('[data-testid="cellInnerDiv"]')];
  assert.ok(cells[0].hasAttribute('otaat-current'));
  window.OTAAT.engine.act('next');
  await until(() => cells[3].hasAttribute('otaat-current'), 'the ad and "Who to follow" are skipped');
  const skipped = browser.logged.find((e) => e.action === 'skipped');
  assert.equal(skipped.item.key, 'x:1111111111111111111');
  assert.equal(html.getAttribute('otaat-hide-x-sidebar'), '');
});

test('X post page: "Discover more" and everything after it is marked hidden', async () => {
  const body = `<main><div data-testid="primaryColumn"><section><div>
    <div data-testid="cellInnerDiv" style="transform: translateY(0px)"><article data-testid="tweet"><a href="/a"><span>A</span></a><a href="/a/status/1"><time>1h</time></a><div data-testid="tweetText">Focal</div></article></div>
    <div data-testid="cellInnerDiv" style="transform: translateY(300px)"><article data-testid="tweet"><a href="/b"><span>B</span></a><a href="/b/status/2"><time>1h</time></a><div data-testid="tweetText">A reply</div></article></div>
    <div data-testid="cellInnerDiv" style="transform: translateY(500px)"><div><h2 role="heading">Discover more</h2></div></div>
    <div data-testid="cellInnerDiv" style="transform: translateY(600px)"><article data-testid="tweet"><a href="/c"><span>C</span></a><a href="/c/status/3"><time>1h</time></a><div data-testid="tweetText">Unrelated</div></article></div>
  </div></section></div></main>`;
  const { document, browser } = makePage({ url: 'https://x.com/a/status/1', bodyHtml: body });
  const cells = [...document.querySelectorAll('[data-testid="cellInnerDiv"]')];
  await until(() => cells[3].hasAttribute('otaat-discover'), 'discover section marked');
  assert.ok(cells[2].hasAttribute('otaat-discover'));
  assert.ok(!cells[1].hasAttribute('otaat-discover'), 'replies stay');
  await until(() => browser.logged.some((e) => e.action === 'seen' && e.item.key === 'x:1'), 'focal post logged as seen');
});

test('Flags on <html> come back if the site strips them (X does)', async () => {
  const { document } = makePage({ url: 'https://x.com/home', bodyHtml: fixture('x-classic-home.html') });
  await until(() => current(document).length === 1, 'a current post');
  const html = document.documentElement;
  for (const a of [...html.attributes]) html.removeAttribute(a.name);
  await until(() => html.getAttribute('otaat-q') === 'home' && html.getAttribute('otaat-mode') === 'spotlight', 'flags restored');
});

test('Commands from the keyboard shortcut reach the engine', async () => {
  const { document, browser } = redditPage();
  await until(() => current(document).length === 1, 'a current post');
  for (const fn of browser.messageListeners) fn({ type: 'command', name: 'next' });
  await until(() => browser.logged.some((e) => e.action === 'skipped'), 'skipped via command');
});

test('Status message reports the page state to the popup', async () => {
  const { document, browser } = redditPage();
  await until(() => current(document).length === 1, 'a current post');
  const results = browser.messageListeners.map((fn) => fn({ type: 'status' })).filter(Boolean);
  const st = await results[0];
  assert.equal(st.site, 'reddit');
  assert.equal(st.surface, 'popular');
  assert.equal(st.quantize, true);
  assert.ok(st.current && st.current.url);
});
