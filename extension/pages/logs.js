(function () {
  'use strict';
  const { send, h, safeUrl, download } = window.PAGE;
  const F = window.OTAAT_FORMAT;
  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 150;

  const filter = { action: '', site: '', q: '' };
  let oldestId = null;
  let lastDay = '';
  let loading = false;

  // Allow deep links like logs.html#deferred
  const fromHash = location.hash.slice(1);
  if (F.ACTIONS.includes(fromHash)) filter.action = fromHash;

  function syncSeg() {
    for (const b of $('actionSeg').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.action === filter.action));
    }
  }

  async function renderStats() {
    const [today, totals] = await Promise.all([send('counts'), send('totals')]);
    const c = today.counts;
    $('stats').replaceChildren(
      ...[
        ['Seen today', c.seen],
        ['Skipped today', c.skipped],
        ['Deferred today', c.deferred],
        ['Queued today', c.queued],
        ['All entries', totals.events],
        ['On Later list', totals.later],
      ].map(([label, n]) => h('div', { class: 'stat' }, h('b', { text: String(n || 0) }), h('span', { class: 'muted small', text: label })))
    );
  }

  function row(ev) {
    const d = new Date(ev.ts);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const url = safeUrl(ev.url);
    const title = F.titleOf(ev);
    const meta = [ev.author, ev.extra && ev.extra.community, ev.extra && ev.extra.duration, ev.kind !== 'video' && ev.kind !== 'post' && ev.kind !== 'tweet' ? ev.kind : '', ev.surface, ev.note]
      .filter(Boolean)
      .join(' · ');
    return h(
      'div',
      { class: 'row' },
      h('span', { class: 'time', title: F.localStamp(ev.ts), text: time }),
      h('span', {}, h('span', { class: `badge ${ev.action}`, text: ev.action })),
      h('span', { class: 'site', text: F.SITE_NAMES[ev.site] || ev.site }),
      h(
        'div',
        { class: 'main' },
        h('div', { class: 'title' }, url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: title }) : title),
        meta ? h('div', { class: 'meta', text: meta }) : null,
        ev.snippet && ev.title && F.clean(ev.snippet) !== F.clean(ev.title) ? h('div', { class: 'snippet', text: F.clean(ev.snippet, 280) }) : null
      )
    );
  }

  async function load(reset) {
    if (loading) return;
    loading = true;
    if (reset) {
      oldestId = null;
      lastDay = '';
      $('list').replaceChildren();
    }
    try {
      const res = await send('events.query', { filter: { ...filter, beforeId: oldestId, limit: PAGE_SIZE } });
      const frag = document.createDocumentFragment();
      for (const ev of res.events) {
        const day = F.localDate(ev.ts);
        if (day !== lastDay) {
          lastDay = day;
          frag.append(h('div', { class: 'day', text: new Date(ev.ts).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) }));
        }
        frag.append(row(ev));
        oldestId = ev.id;
      }
      $('list').append(frag);
      if (!$('list').childElementCount) {
        $('list').append(h('div', { class: 'empty', text: filter.q || filter.site || filter.action ? 'Nothing matches these filters.' : 'Nothing logged yet. Visit YouTube, X or Reddit to start.' }));
      }
      $('more').hidden = res.events.length < PAGE_SIZE;
    } finally {
      loading = false;
    }
  }

  async function exportAll(kind) {
    // Page through everything (newest first), then put it in time order.
    const all = [];
    let beforeId = null;
    for (;;) {
      const res = await send('events.query', { filter: { ...filter, beforeId, limit: 5000 } });
      all.push(...res.events);
      if (res.events.length < 5000) break;
      beforeId = res.events[res.events.length - 1].id;
    }
    const events = all.reverse(); // oldest first
    const stamp = F.localDate(Date.now());
    const label = [filter.action || 'all', filter.site || 'all-sites'].join('-');
    if (kind === 'copy') {
      // Works everywhere, including phones where saving a file may not.
      await navigator.clipboard.writeText(F.markdownExport(events, `One Thing At A Time — ${label}`));
      $('fileStatus').textContent = `Copied ${events.length} entries as text. Paste them into a note or file.`;
      return;
    }
    if (kind === 'md') {
      download(`otaat-${label}-${stamp}.md`, F.markdownExport(events, `One Thing At A Time — ${label}`), 'text/markdown');
    } else if (kind === 'csv') {
      download(`otaat-${label}-${stamp}.csv`, '﻿' + F.csv(events), 'text/csv');
    } else {
      download(`otaat-${label}-${stamp}.json`, JSON.stringify(events.map(F.exportRecord), null, 2), 'application/json');
    }
  }

  async function renderFileStatus(st) {
    st = st || (await send('files.status'));
    const el = $('fileStatus');
    $('folder').disabled = !(st.native.ok || st.output === 'downloads');
    if (st.output === 'native') el.textContent = `Files are written to ${st.native.folder}.`;
    else if (st.output === 'downloads') el.textContent = `Files are written to your Downloads folder, in ${st.downloadsFolder}/ (new entries arrive within about 20 seconds).`;
    else if (st.platform === 'android') {
      el.textContent =
        'On Firefox for Android everything is kept here, in Firefox. Use Export or Copy above to save it, and do so now and then: logs kept only in Firefox are lost if the extension is removed.';
    }
    else if (st.setting === 'off') el.textContent = 'Writing files is turned off in Settings. Everything is still kept here.';
    else el.textContent = 'Waiting for the native file writer (see Settings → Files). Nothing is lost; it catches up when available.';
    if (st.pending) el.textContent += ` ${st.pending} entries waiting to be written.`;
    if (st.lastError) el.textContent += ` Last error: ${st.lastError}`;
  }

  $('actionSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filter.action = b.dataset.action;
    history.replaceState(null, '', filter.action ? `#${filter.action}` : location.pathname);
    syncSeg();
    load(true);
  });
  $('site').addEventListener('change', (e) => {
    filter.site = e.target.value;
    load(true);
  });
  let qTimer = null;
  $('q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      filter.q = e.target.value;
      load(true);
    }, 200);
  });
  $('more').addEventListener('click', () => load(false));
  $('exportMd').addEventListener('click', () => exportAll('md'));
  $('exportCsv').addEventListener('click', () => exportAll('csv'));
  $('exportJson').addEventListener('click', () => exportAll('json'));
  $('copyMd').addEventListener('click', () =>
    exportAll('copy').catch((e) => ($('fileStatus').textContent = `Couldn't copy: ${e.message}`))
  );
  $('folder').addEventListener('click', async () => {
    const r = await send('files.open', { path: '' });
    if (!r.ok || r.note) $('fileStatus').textContent = r.error || r.note;
  });
  $('sync').addEventListener('click', async () => {
    $('sync').disabled = true;
    try {
      renderFileStatus(await send('files.syncNow'));
    } finally {
      $('sync').disabled = false;
    }
  });

  syncSeg();
  renderStats();
  renderFileStatus();
  load(true);
})();
