'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makePage, closeAll, fixture } = require('./helpers');

test.afterEach(closeAll);

// Adapters only (engine idle on an unrelated page).
function adapters() {
  const { window } = makePage({ url: 'https://example.com/', bodyHtml: '' });
  return window.OTAAT.adapters;
}

// Objects come from the jsdom realm; compare them as plain data.
const surfaceOf = (adapter, url) => JSON.parse(JSON.stringify(adapter.surface(new URL(url))));

test('YouTube: which pages are feeds', () => {
  const yt = adapters().youtube;
  const s = (u) => surfaceOf(yt, u);
  assert.deepEqual(s('https://www.youtube.com/'), { name: 'home', kind: 'feed', mode: 'collapse' });
  assert.equal(s('https://www.youtube.com/feed/subscriptions').name, 'subscriptions');
  assert.deepEqual(s('https://www.youtube.com/shorts/abcDEF12345'), { name: 'shorts', kind: 'feed', mode: 'native' });
  assert.equal(s('https://www.youtube.com/watch?v=abc').kind, 'detail');
  assert.equal(s('https://www.youtube.com/@veritasium/videos').name, 'channel');
  assert.equal(s('https://www.youtube.com/@veritasium').kind, 'other');
  assert.equal(s('https://www.youtube.com/results?search_query=x').kind, 'other');
  assert.equal(s('https://www.youtube.com/playlist?list=WL').kind, 'other');
});

test('Reddit: which pages are feeds', () => {
  const rd = adapters().reddit;
  const s = (u) => surfaceOf(rd, u);
  assert.equal(s('https://www.reddit.com/').name, 'home');
  assert.equal(s('https://www.reddit.com/?feed=home').name, 'home');
  assert.equal(s('https://www.reddit.com/best/').name, 'home');
  assert.equal(s('https://www.reddit.com/r/popular/').name, 'popular');
  assert.equal(s('https://www.reddit.com/r/all/top/').name, 'all');
  assert.equal(s('https://www.reddit.com/r/AskHistorians/').name, 'subreddit');
  assert.equal(s('https://www.reddit.com/r/AskHistorians/new/').name, 'subreddit');
  assert.equal(s('https://www.reddit.com/r/AskHistorians/comments/abc/some_title/').kind, 'detail');
  assert.equal(s('https://www.reddit.com/r/AskHistorians/wiki/index').kind, 'other');
  assert.equal(s('https://www.reddit.com/user/spez/').name, 'user');
  assert.equal(s('https://www.reddit.com/user/spez/m/news/').name, 'customFeed');
  assert.equal(s('https://www.reddit.com/user/spez/saved/').kind, 'other');
  assert.equal(s('https://www.reddit.com/search/?q=cats').kind, 'other');
});

test('X: which pages are feeds', () => {
  const x = adapters().x;
  const s = (u) => surfaceOf(x, u);
  assert.deepEqual(s('https://x.com/home'), { name: 'home', kind: 'feed', mode: 'spotlight' });
  assert.equal(s('https://x.com/i/lists/123456').name, 'lists');
  assert.equal(s('https://x.com/NASA/status/2110389272024867195').kind, 'detail');
  assert.equal(s('https://x.com/NASA').name, 'profile');
  assert.equal(s('https://x.com/NASA/media').name, 'profile');
  assert.equal(s('https://x.com/explore').kind, 'other');
  assert.equal(s('https://x.com/notifications').kind, 'other');
  assert.equal(s('https://x.com/i/bookmarks').kind, 'other');
  assert.equal(s('https://x.com/search?q=a').kind, 'other');
});

test('YouTube: extracts video items from real grid markup', () => {
  const { window } = makePage({ url: 'https://example.com/', bodyHtml: fixture('youtube-grid.html') });
  const yt = window.OTAAT.adapters.youtube;
  const grid = window.document.querySelector('ytd-rich-grid-renderer');
  const items = yt.items(grid);
  assert.equal(items.length, 3);
  const info = yt.info(items[0]);
  assert.equal(info.kind, 'video');
  assert.match(info.key, /^youtube:[\w-]{11}$/);
  assert.equal(info.url, `https://www.youtube.com/watch?v=${info.id}`);
  assert.ok(info.title.length > 5, 'has a title');
  assert.match(info.extra.duration, /^\d+:\d{2}/);
  assert.equal(yt.isAd(items[0]), false);
  assert.ok(yt.canQueue(info));
});

test('YouTube: extracts Shorts from real shelf markup', () => {
  const { window } = makePage({ url: 'https://example.com/', bodyHtml: fixture('youtube-shorts-grid.html') });
  const yt = window.OTAAT.adapters.youtube;
  const items = yt.items(window.document.querySelector('ytd-rich-grid-renderer'));
  const info = yt.info(items[0]);
  assert.equal(info.kind, 'short');
  assert.match(info.url, /^https:\/\/www\.youtube\.com\/shorts\/[\w-]+$/);
  assert.ok(info.title, 'has a title');
});

test('Reddit: extracts posts from real feed markup and spots ads', () => {
  const { window } = makePage({ url: 'https://example.com/', bodyHtml: fixture('reddit-feed.html') });
  const rd = window.OTAAT.adapters.reddit;
  const feed = window.document.querySelector('shreddit-feed');
  const items = rd.items(feed);
  assert.equal(items.length, 3, 'three posts, the ad is not a post');
  const info = rd.info(items[0]);
  assert.match(info.key, /^reddit:t3_\w+$/);
  assert.match(info.url, /^https:\/\/www\.reddit\.com\/r\/[^/]+\/comments\//);
  assert.ok(info.title.length > 3);
  assert.match(info.author, /^u\//);
  assert.match(info.extra.community, /^r\//);
  assert.equal(rd.isAd(window.document.querySelector('shreddit-ad-post')), true);
});

test('X (2026 web app): extracts posts from real profile markup', () => {
  const { window } = makePage({ url: 'https://example.com/', bodyHtml: fixture('x-new-profile.html') });
  const x = window.OTAAT.adapters.x;
  const items = x.items(x.feedRoot());
  assert.ok(items.length >= 2);
  assert.equal(items[0].tagName, 'LI');
  const info = x.info(items[0]);
  assert.equal(info.key, 'x:2110389272024867195');
  assert.equal(info.url, 'https://x.com/NASA/status/2110389272024867195');
  assert.match(info.author, /@NASA\)?$/);
  assert.ok(info.snippet.length > 10, 'has the post text');
  assert.ok(!/^NASA\b.*@NASA/.test(info.snippet), 'name and handle are not part of the text');
});

test('X (classic markup): post, quoted post, ad and non-post cells', () => {
  const { window } = makePage({ url: 'https://example.com/', bodyHtml: fixture('x-classic-home.html') });
  const x = window.OTAAT.adapters.x;
  const items = x.items(x.feedRoot());
  assert.equal(items.length, 3, 'the "Who to follow" cell is not a post');
  const first = x.info(items[0]);
  assert.equal(first.key, 'x:1111111111111111111');
  assert.equal(first.author, 'Alice Example (@alice)');
  assert.equal(first.snippet, 'Hello world, this is the first post.');
  assert.equal(x.isAd(items[0]), false);
  assert.equal(x.isAd(items[1]), true);
  const quoting = x.info(items[2]);
  assert.equal(quoting.key, 'x:3333333333333333333', 'the outer post, not the quoted one');
});
