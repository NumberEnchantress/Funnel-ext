(function () {
  'use strict';
  const { send, h, relTime, safeUrl } = window.PAGE;
  const F = window.OTAAT_FORMAT;
  const $ = (id) => document.getElementById(id);

  async function render() {
    const { items } = await send('later.list');
    const site = $('site').value;
    const showDone = $('showDone').checked;
    const open = items.filter((i) => !i.done);
    $('count').textContent = `· ${open.length} to go`;
    const shown = items.filter((i) => (!site || i.site === site) && (showDone || !i.done));
    const list = $('list');
    if (!shown.length) {
      list.replaceChildren(h('div', { class: 'empty', text: items.length ? 'Nothing here with these filters.' : 'Your Later list is empty.' }));
      return;
    }
    list.replaceChildren(...shown.map(itemRow));
  }

  // Thumbnails only from the sites' own image servers (never from links a post points to).
  const THUMB_HOSTS = /^(i\.ytimg\.com|i\d?\.ytimg\.com|i\.redd\.it|preview\.redd\.it|external-preview\.redd\.it|pbs\.twimg\.com)$/;
  function thumbOf(it) {
    const u = safeUrl(it.thumb);
    try {
      return u && u.startsWith('https:') && THUMB_HOSTS.test(new URL(u).hostname) ? u : '';
    } catch (_) {
      return '';
    }
  }

  function itemRow(it) {
    const url = safeUrl(it.url);
    const thumbUrl = thumbOf(it);
    const thumb = thumbUrl
      ? h('img', { class: 'thumb', src: thumbUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
      : h('div', { class: 'thumb blank', text: F.SITE_NAMES[it.site] || it.site });
    const meta = [F.SITE_NAMES[it.site] || it.site, it.author, it.extra && it.extra.community, `added ${relTime(it.addedTs)}`, it.done && it.doneTs ? `done ${relTime(it.doneTs)}` : '']
      .filter(Boolean)
      .join(' · ');
    const title = F.titleOf(it);
    return h(
      'div',
      { class: `item${it.done ? ' done' : ''}` },
      url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', tabindex: '-1' }, thumb) : thumb,
      h(
        'div',
        {},
        h('div', { class: 'title' }, url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: title }) : title),
        h('div', { class: 'meta', text: meta }),
        it.snippet && F.clean(it.snippet) !== F.clean(it.title) ? h('div', { class: 'snippet', text: F.clean(it.snippet, 240) }) : null
      ),
      h(
        'div',
        { class: 'actions' },
        h('button', {
          text: it.done ? 'Not done' : 'Done',
          title: it.done ? 'Put it back on the list' : 'Mark as done (stays in your logs)',
          onclick: async () => {
            await send('later.update', { key: it.key, patch: { done: !it.done } });
            render();
          },
        }),
        h('button', {
          text: 'Remove',
          title: 'Remove from this list (stays in your logs)',
          onclick: async () => {
            await send('later.remove', { key: it.key });
            render();
          },
        })
      )
    );
  }

  $('site').addEventListener('change', render);
  $('showDone').addEventListener('change', render);
  render();
})();
