(function () {
  'use strict';
  const { send, h } = window.PAGE;
  const S = window.OTAAT_SETTINGS;
  const SITE_NAMES = { youtube: 'YouTube', reddit: 'Reddit', x: 'X' };

  const $ = (id) => document.getElementById(id);

  async function renderStats() {
    const res = await send('counts').catch(() => null);
    const c = (res && res.counts) || {};
    const box = $('stats');
    box.replaceChildren(
      ...[
        ['seen', 'Seen'],
        ['skipped', 'Next'],
        ['deferred', 'Later'],
        ['queued', 'Queued'],
      ].map(([k, label]) => h('div', { class: 'stat' }, h('b', { text: String(c[k] || 0) }), h('span', { class: 'muted small', text: label })))
    );
    box.title = 'Today';
  }

  async function renderTab() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    let st = null;
    try {
      st = await browser.tabs.sendMessage(tab.id, { type: 'status' });
    } catch (_) {
      st = null;
    }
    if (!st) return;
    const site = SITE_NAMES[st.site] || st.site;
    let text;
    if (st.quantize) text = `${site} · ${st.surface}: one item at a time.`;
    else if (st.kind === 'feed' && st.paused) text = `${site} · ${st.surface}: paused (still logging what you see).`;
    else if (st.kind === 'feed') text = `${site} · ${st.surface}: shown normally (turned off in Settings).`;
    else text = `${site} · ${st.surface}: normal page, logging what you see.`;
    $('tabText').textContent = text;
    if (st.current) {
      $('current').hidden = false;
      $('current').textContent = `Now showing: ${st.current.title || st.current.url}`;
    }
    $('pauseRow').hidden = false;
    $('pauseLabel').textContent = st.paused ? `${site} is paused` : `${site} is active`;
    const btn = $('pause');
    btn.textContent = st.paused ? `Resume ${site}` : `Pause ${site}`;
    btn.onclick = async () => {
      await S.save(browser.storage.local, (s) => {
        s.paused[st.site] = !st.paused;
        return s;
      });
      window.close();
    };
  }

  async function renderFiles() {
    const st = await send('files.status').catch(() => null);
    const el = $('files');
    if (!st) {
      el.textContent = 'File output status unavailable.';
      return;
    }
    $('folder').disabled = !(st.native.ok || st.output === 'downloads');
    $('folder').title = st.native.ok
      ? st.native.folder
      : st.output === 'downloads'
        ? `Opens your Downloads folder (logs are in ${st.downloadsFolder})`
        : 'Writing files is turned off (see Settings → Files)';
    const pending = st.pending ? ` · ${st.pending} waiting to be written` : '';
    if (st.output === 'native') el.textContent = `Log files: ${st.native.folder}${pending}`;
    else if (st.output === 'downloads') el.textContent = `Log files: Downloads/${st.downloadsFolder}${pending}`;
    else if (st.setting === 'off') el.textContent = 'Log files are turned off (logs are kept in the browser).';
    else if (st.platform === 'android') el.textContent = 'Logs are kept in Firefox. Open logs → Export or Copy to save them now and then.';
    else el.textContent = `Log files: waiting for the native file writer${pending}`;
    if (st.lastError) el.textContent += ` · last error: ${st.lastError}`;
  }

  $('logs').onclick = () => send('openPage', { page: 'logs' }).then(() => window.close());
  $('later').onclick = () => send('openPage', { page: 'later' }).then(() => window.close());
  $('options').onclick = () => browser.runtime.openOptionsPage().then(() => window.close());
  $('folder').onclick = async () => {
    const r = await send('files.open', { path: '' }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok || r.note) $('files').textContent = r.error || r.note;
    else window.close();
  };

  renderStats();
  renderTab();
  renderFiles();
})();
