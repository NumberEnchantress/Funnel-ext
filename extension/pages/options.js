(function () {
  'use strict';
  const { send } = window.PAGE;
  const S = window.OTAAT_SETTINGS;
  const $ = (id) => document.getElementById(id);

  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => o[k], obj);
    target[last] = value;
  }

  let savedTimer = null;
  function flashSaved() {
    $('saved').classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => $('saved').classList.remove('show'), 1200);
  }

  async function save(path, value) {
    await S.save(browser.storage.local, (s) => {
      setPath(s, path, value);
      return s;
    });
    flashSaved();
  }

  async function load() {
    const s = await S.load(browser.storage.local);
    for (const el of document.querySelectorAll('[data-path]')) {
      const v = getPath(s, el.dataset.path);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v == null ? '' : String(v);
    }
    for (const r of document.querySelectorAll('input[name="fileOutput"]')) r.checked = r.value === s.fileOutput;
  }

  function wire() {
    for (const el of document.querySelectorAll('[data-path]')) {
      const evt = el.type === 'text' || el.type === 'number' ? 'change' : 'input';
      el.addEventListener(evt, () => {
        let v;
        if (el.type === 'checkbox') v = el.checked;
        else if (el.dataset.type === 'number') {
          v = Number(el.value);
          if (!Number.isFinite(v) || v < 0) v = getPath(S.DEFAULTS, el.dataset.path);
        } else v = el.value.trim();
        save(el.dataset.path, v).then(() => {
          if (el.dataset.path.endsWith('Folder')) setTimeout(renderFileStatus, 800);
        });
      });
    }
    for (const r of document.querySelectorAll('input[name="fileOutput"]')) {
      r.addEventListener('change', () => r.checked && save('fileOutput', r.value).then(() => setTimeout(renderFileStatus, 800)));
    }
  }

  function describe(st) {
    const lines = [];
    let cls = 'ok';
    if (st.platform === 'android') {
      if (st.output === 'downloads') {
        lines.push(`Files are being written to Downloads/${st.downloadsFolder}/ (Firefox may show a download notification each time).`);
      } else {
        lines.push('On Firefox for Android your logs are kept in Firefox. Save them any time with Export or Copy on the Logs page.');
      }
      cls = 'warn';
      if (st.lastError) {
        lines.push(`Last error: ${st.lastError}`);
        cls = 'err';
      }
      return { text: lines.join(' '), cls };
    }
    if (st.native.ok) lines.push(`Native file writer: installed (v${st.native.version}), writing to ${st.native.folder}`);
    else lines.push(`Native file writer: not available${st.native.error ? ` (${st.native.error})` : ''}`);
    if (st.output === 'native') lines.push('Files are being written by the native writer.');
    else if (st.output === 'downloads') lines.push(`Files are being written to Downloads/${st.downloadsFolder}/.`);
    else if (st.setting === 'off') {
      lines.push('Writing files is off. Logs are kept in the browser only.');
      cls = 'warn';
    } else {
      lines.push('Waiting for the native writer — nothing is lost, it catches up once it is available.');
      cls = 'warn';
    }
    if (st.pending) lines.push(`${st.pending} entries waiting to be written.`);
    if (st.lastWriteTs) lines.push(`Last write: ${new Date(st.lastWriteTs).toLocaleTimeString()}.`);
    if (st.lastError) {
      lines.push(`Last error: ${st.lastError}`);
      cls = 'err';
    }
    return { text: lines.join(' '), cls };
  }

  async function renderFileStatus(st) {
    try {
      st = st || (await send('files.status'));
      const d = describe(st);
      $('fileStatus').textContent = d.text;
      $('fileStatus').className = `small status ${d.cls}`;
      $('folder').disabled = !(st.native.ok || st.output === 'downloads');
    } catch (e) {
      $('fileStatus').textContent = `Status unavailable: ${e.message}`;
    }
  }

  async function busy(btn, fn) {
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      $('fileStatus').textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  $('test').addEventListener('click', () => busy($('test'), async () => renderFileStatus(await send('files.status', { force: true }))));
  $('sync').addEventListener('click', () => busy($('sync'), async () => renderFileStatus(await send('files.syncNow'))));
  $('rebuild').addEventListener('click', () => {
    const ok = confirm(
      'Write your full in-browser history to the log files again?\n\n' +
        'With the native writer this is appended, so existing entries will appear twice unless you deleted or moved the old files first. ' +
        'Existing files are never deleted.'
    );
    if (ok) busy($('rebuild'), async () => renderFileStatus(await send('files.rebuild')));
  });
  $('folder').addEventListener('click', () =>
    busy($('folder'), async () => {
      const r = await send('files.open', { path: '' });
      if (!r.ok || r.note) $('fileStatus').textContent = r.error || r.note;
    })
  );
  $('resetSorted').addEventListener('click', async () => {
    if (!confirm('Let items you already sorted appear in your feeds again? Your logs are not changed.')) return;
    await send('sorted.reset');
    renderTotals();
  });

  async function renderTotals() {
    const t = await send('totals');
    $('totals').textContent = `${t.events} log entries · ${t.sorted} sorted items remembered · ${t.later} on the Later list.`;
  }

  if (location.hash === '#welcome') $('welcome').hidden = false;
  $('extId').textContent = browser.runtime.id;
  load().then(wire);
  renderFileStatus();
  renderTotals();
})();
