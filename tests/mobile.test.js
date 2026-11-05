'use strict';
/* Phones: YouTube's mobile site (m.youtube.com, what Firefox for Android gets) and the phone button bar. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makePage, closeAll, fixture, sleep, until } = require('./helpers');

test.afterEach(closeAll);

const current = (doc) => doc.querySelectorAll('[otaat-current]');

function mobileHome(opts = {}) {
  return makePage({ url: 'https://m.youtube.com/', bodyHtml: fixture('m-youtube-grid.html'), withBridge: true, ...opts });
}

test('m.youtube.com: items are read from the phone markup', () => {
  const { window } = makePage({ url: 'https://example.com/', bodyHtml: fixture('m-youtube-grid.html') });
  const yt = window.OTAAT.adapters.youtube;
  const items = yt.items(window.document.querySelector('ytm-rich-grid-renderer'));
  assert.equal(items.length, 3);
  const info = yt.info(items[0]);
  assert.equal(info.key, 'youtube:NiCgcUTL9_Q');
  assert.equal(info.title, 'The Absurd Engineering Behind the Internet');
  assert.equal(info.extra.duration, '34:32');
});

test('m.youtube.com home: one video at a time, and no Queue button (the phone site has no queue)', async () => {
  const { document, window } = mobileHome();
  await until(() => current(document).length === 1, 'a current video');
  const items = [...document.querySelectorAll('ytm-rich-item-renderer')];
  assert.ok(items[0].hasAttribute('otaat-current'));
  assert.equal(document.documentElement.getAttribute('otaat-q'), 'home');
  const bar = document.querySelector('[data-otaat-bar]').shadowRoot;
  assert.ok(bar.querySelector('[data-act="queue"]').hidden, 'Queue hidden on the phone site');
  window.OTAAT.engine.act('next');
  await until(() => items[1].hasAttribute('otaat-current'), 'Next moves on');
});

test('m.youtube.com: the feed loader is revealed only until the next batch arrives', async () => {
  const { document } = mobileHome();
  const html = document.documentElement;
  await until(() => html.hasAttribute('otaat-loadmore'), 'loader revealed (only 3 videos)');
  const contents = document.querySelector('.rich-grid-renderer-contents');
  const item = document.createElement('ytm-rich-item-renderer');
  item.innerHTML = '<a href="/watch?v=BBBBBBBBBBB"><h4>Another</h4></a>';
  contents.insertBefore(item, contents.querySelector('ytm-continuation-item-renderer'));
  await until(() => !html.hasAttribute('otaat-loadmore'), 'loader hidden again');
});

test('m.youtube.com: Later saves to Watch later through YouTube\'s API and logs what YouTube answered', async () => {
  const requests = [];
  const { document, window, browser } = mobileHome({
    beforeScripts(w) {
      w.ytcfg = {
        get: (k) => ({ LOGGED_IN: true, INNERTUBE_API_KEY: 'k', INNERTUBE_CONTEXT: { client: { clientName: 'MWEB' } }, SESSION_INDEX: 0 })[k],
      };
      w.document.cookie = 'SAPISID=abc123';
      // jsdom has no WebCrypto; use Node's.
      Object.defineProperty(w.crypto, 'subtle', { value: globalThis.crypto.subtle, configurable: true });
      w.TextEncoder = globalThis.TextEncoder;
      w.fetch = async (url, init) => {
        requests.push({ url, init });
        return { ok: true, json: async () => ({ status: 'STATUS_SUCCEEDED' }) };
      };
    },
  });
  await until(() => current(document).length === 1, 'a current video');
  window.OTAAT.engine.act('later');
  await until(() => browser.logged.some((e) => e.action === 'deferred'), 'deferred logged', 6000);
  const entry = browser.logged.find((e) => e.action === 'deferred');
  assert.equal(entry.note, 'watch later');
  assert.equal(entry.localLater, false, 'confirmed by YouTube: no safety copy needed');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^\/youtubei\/v1\/browse\/edit_playlist\?/);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.playlistId, 'WL');
  assert.deepEqual(body.actions, [{ addedVideoId: 'NiCgcUTL9_Q', action: 'ACTION_ADD_VIDEO' }]);
  assert.match(requests[0].init.headers.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}$/);
});

test('m.youtube.com: if the API says no, the item stays on the extension\'s Later list', async () => {
  const { document, window, browser } = mobileHome({
    beforeScripts(w) {
      w.ytcfg = { get: (k) => ({ LOGGED_IN: true, INNERTUBE_CONTEXT: {} })[k] };
      w.fetch = async () => ({ ok: false, json: async () => ({ error: { code: 401 } }) });
    },
  });
  await until(() => current(document).length === 1, 'a current video');
  window.OTAAT.engine.act('later');
  await until(() => browser.logged.some((e) => e.action === 'deferred'), 'deferred logged', 6000);
  const entry = browser.logged.find((e) => e.action === 'deferred');
  assert.equal(entry.localLater, true);
  assert.match(entry.note, /refused/, 'the log says it was refused, not "watch later"');
  await sleep(500);
  assert.equal(browser.confirmed.length, 0);
});

test('m.youtube.com: a page kept hidden in the background is never used as the feed', async () => {
  const body = `<div style="display:none">${fixture('m-youtube-grid.html')}</div>`;
  const { document, browser } = makePage({ url: 'https://m.youtube.com/', bodyHtml: body });
  await sleep(600);
  assert.equal(current(document).length, 0, 'nothing hidden becomes current');
  assert.equal(browser.logged.length, 0, 'and nothing is logged as seen');
});

test('m.youtube.com: the channel name is read from the title\'s label', () => {
  const { window } = makePage({ url: 'https://example.com/', bodyHtml: fixture('m-youtube-grid.html') });
  const yt = window.OTAAT.adapters.youtube;
  const info = yt.info(window.document.querySelector('ytm-rich-item-renderer'));
  assert.equal(info.author, 'Veritasium');
});

test('Phone bar: big Next/Later buttons plus a ⋯ menu holding the links', async () => {
  const { document } = mobileHome();
  await until(() => current(document).length === 1, 'a current video');
  const bar = document.querySelector('[data-otaat-bar]').shadowRoot;
  const menu = bar.querySelector('.menu');
  assert.ok(bar.querySelector('.more'), 'a ⋯ button');
  const labels = [...menu.querySelectorAll('button, a')].filter((e) => !e.hidden).map((e) => e.textContent);
  assert.deepEqual(labels, ['Logs', 'Watch later', 'Later list']);
  assert.match(bar.querySelector('style').textContent, /@media \(max-width: 640px\)/);
  assert.ok(document.defaultView.OTAAT.ui.reservedBottom() >= 16);
});

test('Bar placement: above bottom bars and floating buttons; steps aside for a full-screen dialog', async () => {
  const { window } = makePage({
    url: 'https://example.com/',
    bodyHtml: `<div id="content"></div><nav id="nav" style="position:fixed"></nav>
      <button id="fab" style="position:fixed"></button><div id="dlg" role="dialog" style="position:fixed"></div>`,
  });
  const d = window.document;
  const H = window.innerHeight;
  const W = window.innerWidth;
  const box = (el, top, bottom, left, right) => {
    el.getBoundingClientRect = () => ({ top, bottom, left, right, height: bottom - top, width: right - left, x: left, y: top });
  };
  const [content, nav, fab, dlg] = ['content', 'nav', 'fab', 'dlg'].map((id) => d.getElementById(id));
  box(nav, H - 57, H, 0, W); // e.g. YouTube's Home / Shorts / You bar
  box(fab, H - 57 - 16 - 56, H - 57 - 16, W - 110, W - 16); // e.g. X's compose button, floating above it
  box(dlg, 0, H, 0, W);
  let dialogOpen = false;
  d.elementsFromPoint = (x, y) => {
    const out = [];
    if (dialogOpen) out.push(dlg);
    if (y >= H - 57) out.push(nav);
    else if (x >= W - 110 && x <= W - 16 && y >= H - 129 && y <= H - 73) out.push(fab);
    out.push(content);
    return out;
  };
  const ui = window.OTAAT.ui;
  ui.update({ visible: true, position: 'bottom', nextEnabled: true, laterEnabled: true, status: '#1' });
  const wrap = d.querySelector('[data-otaat-bar]').shadowRoot.querySelector('.wrap');
  assert.equal(wrap.style.getPropertyValue('--otaat-bottom'), '129px', 'lifted above the floating button, not just the bar');
  assert.ok(!wrap.classList.contains('yield'));
  dialogOpen = true;
  d.body.append(d.createElement('span')); // the page changes: the bar re-checks
  await until(() => wrap.classList.contains('yield'), 'steps aside while the dialog is open', 2000);
  dialogOpen = false;
  d.body.append(d.createElement('span'));
  await until(() => !wrap.classList.contains('yield'), 'comes back when it closes', 2000);

  // A site's menu sheet dims the page with a full-screen layer (no dialog role): also step aside.
  const scrim = d.createElement('div');
  scrim.setAttribute('style', 'position:fixed');
  d.body.append(scrim);
  box(scrim, 0, H, 0, W);
  const plain = d.elementsFromPoint;
  d.elementsFromPoint = (x, y) => (y < H - 200 ? [scrim, content] : plain(x, y));
  d.body.append(d.createElement('span'));
  await until(() => wrap.classList.contains('yield'), 'steps aside for a dimmed page', 2000);
});

test('Bar placement: an app laid out in a full-screen fixed container does not hide the bar', async () => {
  const { window } = makePage({ url: 'https://example.com/', bodyHtml: '<div id="shell" style="position:fixed"><p id="post">post</p></div>' });
  const d = window.document;
  const shell = d.getElementById('shell');
  const post = d.getElementById('post');
  shell.getBoundingClientRect = () => ({ top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth, height: window.innerHeight, width: window.innerWidth });
  d.elementsFromPoint = () => [post, shell];
  window.OTAAT.ui.update({ visible: true, position: 'bottom', nextEnabled: true, laterEnabled: true });
  const wrap = d.querySelector('[data-otaat-bar]').shadowRoot.querySelector('.wrap');
  assert.ok(!wrap.classList.contains('yield'), 'the content is on top, so this is not an overlay');
  assert.equal(wrap.style.getPropertyValue('--otaat-bottom'), '0px');
});

test('Shorts on the phone site: Next uses the carousel\'s own next button', async () => {
  let clicked = 0;
  const { document, window } = makePage({
    url: 'https://m.youtube.com/shorts/AAAAAAAAAAA',
    bodyHtml: `<shorts-carousel><div class="hidden-a11y-nav ytShortsCarouselShortsA11yNav">
      <button aria-label="Previous video"></button><button aria-label="Next video" id="nx"></button></div></shorts-carousel>`,
    withBridge: true,
    beforeScripts(w) {
      w.document.getElementById('nx').addEventListener('click', () => clicked++);
    },
  });
  assert.equal(window.OTAAT.adapters.youtube.nativeNext(), true);
  assert.equal(clicked, 1);
  assert.ok(document);
});

function placementPage(keepClearBoxes) {
  const { window } = makePage({
    url: 'https://example.com/',
    bodyHtml: keepClearBoxes.map((_, i) => `<div class="clear" id="c${i}"></div>`).join(''),
  });
  const d = window.document;
  const box = (el, [left, top, right, bottom]) => {
    el.getBoundingClientRect = () => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top });
  };
  keepClearBoxes.forEach((b, i) => box(d.getElementById(`c${i}`), b));
  const ui = window.OTAAT.ui;
  ui.update({ visible: true, position: 'bottom', nextEnabled: true, laterEnabled: true, keepClear: '.clear' });
  const shadow = d.querySelector('[data-otaat-bar]').shadowRoot;
  return { window, d, ui, wrap: shadow.querySelector('.wrap'), bar: shadow.querySelector('.bar'), box };
}

test('Bar placement: on a phone Short, above its title panel and clear of its column of buttons', async () => {
  const W = 1024;
  const H = 768;
  const { d, wrap, bar, box } = placementPage([
    [16, H - 84, W - 80, H], // channel / Subscribe / title
    [W - 64, H - 250, W - 16, H - 40], // like / comment / share
  ]);
  box(bar, [8, H - 72, W - 8, H - 8]); // a full-width strip at the bottom
  d.body.append(d.createElement('span')); // the page changes: the bar re-checks
  await until(() => wrap.style.getPropertyValue('--otaat-bottom') === '84px', 'lifted above the title panel', 2000);
  assert.equal(wrap.style.getPropertyValue('--otaat-right'), '64px', 'kept left of the buttons');
  assert.ok(!wrap.classList.contains('docked'));
});

test('Bar placement: on a wide screen, moved into free space beside a Short instead of over its title', async () => {
  const H = 768;
  const { d, wrap, bar, box } = placementPage([
    [400, H - 120, 620, H - 30], // title panel under the video
    [630, H - 400, 680, H - 30], // buttons beside it
  ]);
  box(bar, [250, H - 60, 774, H - 16]); // the centered pill
  d.body.append(d.createElement('span'));
  await until(() => wrap.classList.contains('docked'), 'moved aside', 2000);
  assert.equal(wrap.style.getPropertyValue('--dock-left'), '16px', 'into the widest free stretch (left of the video)');
  assert.equal(wrap.style.getPropertyValue('--dock-right'), `${1024 - 400 + 16}px`);
  assert.equal(wrap.style.getPropertyValue('--otaat-bottom'), '0px', 'and not lifted');
});

test('Bar placement: controls it does not cover change nothing', async () => {
  const H = 768;
  const { d, wrap, bar, box } = placementPage([[400, 100, 620, 300]]);
  box(bar, [250, H - 60, 774, H - 16]);
  d.body.append(d.createElement('span'));
  await sleep(500);
  assert.ok(!wrap.classList.contains('docked'));
  assert.equal(wrap.style.getPropertyValue('--otaat-bottom'), '0px');
  assert.equal(wrap.style.getPropertyValue('--otaat-right'), '');
});

test('m.youtube.com watch page: the phone site\'s autoplay switch is turned off too (once it is on screen)', async () => {
  const body = `<div id="movie_player" class="html5-video-player playing-mode"></div>`;
  let clicks = 0;
  const { document } = makePage({ url: 'https://m.youtube.com/watch?v=NiCgcUTL9_Q', bodyHtml: body, withBridge: true });
  await sleep(1700);
  assert.equal(clicks, 0, 'nothing to do while the controls (and so the switch) are hidden');
  // The user taps the video: the controls, and the switch, appear.
  const sw = document.createElement('button');
  sw.className = 'ytwAutonavToggleButtonHost';
  sw.setAttribute('aria-pressed', 'true');
  sw.setAttribute('aria-label', 'Autoplay is on');
  sw.addEventListener('click', () => {
    clicks++;
    sw.setAttribute('aria-pressed', 'false');
    sw.setAttribute('aria-label', 'Autoplay is off');
  });
  document.querySelector('#movie_player').append(sw);
  await until(() => sw.getAttribute('aria-pressed') === 'false', 'autoplay switched off', 4000);
  assert.equal(clicks, 1);
});
