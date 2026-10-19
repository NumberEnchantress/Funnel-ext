/* Log formatting: Markdown lines, file layout, CSV, JSONL. Shared by background, pages and tests. */
(function (root) {
  'use strict';

  const SITE_NAMES = { youtube: 'YouTube', reddit: 'Reddit', x: 'X' };
  const ACTIONS = ['seen', 'skipped', 'deferred', 'queued'];
  const ACTION_TITLES = {
    seen: 'Seen',
    skipped: 'Skipped (Next)',
    deferred: 'Deferred (Later)',
    queued: 'Queued (YouTube queue)',
  };

  const pad = (n, w = 2) => String(n).padStart(w, '0');

  function localDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function localStamp(ts) {
    const d = new Date(ts);
    return `${localDate(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function monthOf(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }

  function dayTitle(day) {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }

  // Half of an emoji (a lone UTF-16 surrogate) can't be written as UTF-8; replace it.
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
  function wellFormed(text) {
    return String(text).replace(LONE_SURROGATE, '�');
  }

  // Shorten to at most n UTF-16 units without cutting an emoji in half.
  function cut(text, n) {
    const s = wellFormed(text == null ? '' : text);
    if (s.length <= n) return s;
    const code = s.charCodeAt(n - 1);
    return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
  }

  // One line of plain text: no newlines, collapsed whitespace, length-capped.
  function clean(text, max = 300) {
    if (text == null) return '';
    let s = wellFormed(text).replace(/\s+/g, ' ').trim();
    if (s.length > max) s = cut(s, max - 1).trimEnd() + '…';
    return s;
  }

  // Only escape what would break the link syntax, so the files stay readable as plain text.
  function mdText(text, max) {
    return clean(text, max).replace(/([\\[\]])/g, '\\$1');
  }

  function mdUrl(url) {
    return String(url || '').replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
  }

  function titleOf(ev) {
    return clean(ev.title) || clean(ev.snippet, 120) || ev.url || ev.key || '(untitled)';
  }

  // "- 2026-10-14 14:03:22 · YouTube · [Title](url) · Channel · 12:34 · home"
  function mdLine(ev) {
    const parts = [localStamp(ev.ts), SITE_NAMES[ev.site] || ev.site];
    const title = mdText(titleOf(ev), 200);
    parts.push(ev.url ? `[${title}](${mdUrl(ev.url)})` : title);
    if (ev.author) parts.push(mdText(ev.author, 80));
    if (ev.extra && ev.extra.community) parts.push(mdText(ev.extra.community, 80));
    if (ev.extra && ev.extra.duration) parts.push(mdText(ev.extra.duration, 20));
    if (ev.kind && ev.kind !== 'video' && ev.kind !== 'post' && ev.kind !== 'tweet') parts.push(ev.kind);
    if (ev.surface) parts.push(mdText(ev.surface, 40));
    if (ev.note) parts.push(mdText(ev.note, 120));
    let line = `- ${parts.join(' · ')}`;
    if (ev.snippet && ev.title && clean(ev.snippet) !== clean(ev.title)) {
      line += `\n  > ${mdText(ev.snippet, 280)}`;
    }
    return line + '\n';
  }

  function fileHeader(action, day) {
    return (
      `# ${ACTION_TITLES[action] || action} — ${dayTitle(day)}\n\n` +
      `Written by the One Thing At A Time Firefox extension. Newest entries at the bottom.\n\n`
    );
  }

  // The day an event belongs to: the one stored when it was logged (so a later time-zone change can't move it).
  function dayOf(ev) {
    return /^\d{4}-\d{2}-\d{2}$/.test(ev.day || '') ? ev.day : localDate(ev.ts);
  }

  // One folder per month, one per day inside it: 2026-10/2026-10-14/skipped.md
  function dayFolder(day) {
    return `${day.slice(0, 7)}/${day}`;
  }

  function mdPath(ev) {
    return `${dayFolder(dayOf(ev))}/${ev.action}.md`;
  }

  function jsonlPath(ev) {
    return `${dayFolder(dayOf(ev))}/events.jsonl`;
  }

  /** Deep copy with every string made well-formed (safe to encode as UTF-8). */
  function sanitize(v) {
    if (typeof v === 'string') return wellFormed(v);
    if (Array.isArray(v)) return v.map(sanitize);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = sanitize(v[k]);
      return out;
    }
    return v;
  }

  // Stable, compact record for machine-readable output.
  function exportRecord(ev) {
    const r = {
      id: ev.id,
      time: new Date(ev.ts).toISOString(),
      action: ev.action,
      site: ev.site,
      key: ev.key,
      kind: ev.kind,
      url: ev.url,
      title: ev.title,
      author: ev.author,
      snippet: ev.snippet,
      surface: ev.surface,
      pageUrl: ev.pageUrl,
      thumb: ev.thumb,
      extra: ev.extra,
      note: ev.note,
    };
    for (const k of Object.keys(r)) if (r[k] === undefined || r[k] === '' || r[k] === null) delete r[k];
    return sanitize(r);
  }

  function jsonlLine(ev) {
    return JSON.stringify(exportRecord(ev)) + '\n';
  }

  function mdDocument(action, day, events) {
    return fileHeader(action, day) + events.map(mdLine).join('');
  }

  // Group events into per-file appends of numbered lines: [{ path, header, lines: [[id, text], ...] }]
  function appendsFor(events) {
    const files = new Map();
    const add = (path, header, id, text) => {
      if (!files.has(path)) files.set(path, { path, header, lines: [] });
      files.get(path).lines.push([id, text]);
    };
    for (const ev of events) {
      add(mdPath(ev), fileHeader(ev.action, dayOf(ev)), ev.id, mdLine(ev));
      add(jsonlPath(ev), '', ev.id, jsonlLine(ev));
    }
    return [...files.values()];
  }

  const CSV_COLUMNS = ['time', 'action', 'site', 'kind', 'title', 'author', 'url', 'surface', 'snippet', 'key'];

  function csvCell(v) {
    let s = v == null ? '' : String(v);
    // A cell starting with = + - @ (or a tab/return) would run as a formula in Excel / Sheets.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function csv(events) {
    const rows = [CSV_COLUMNS.join(',')];
    for (const ev of events) {
      const r = { ...exportRecord(ev), time: localStamp(ev.ts) };
      rows.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(','));
    }
    return rows.join('\r\n') + '\r\n';
  }

  function markdownExport(events, title) {
    let out = `# ${title}\n\nExported ${localStamp(Date.now())} · ${events.length} entries\n\n`;
    for (const ev of events) {
      out += mdLine(ev).replace(/^- /, `- **${ev.action}** · `);
    }
    return out;
  }

  const api = {
    SITE_NAMES,
    ACTIONS,
    ACTION_TITLES,
    localDate,
    localStamp,
    monthOf,
    dayTitle,
    dayOf,
    dayFolder,
    wellFormed,
    cut,
    sanitize,
    clean,
    mdText,
    mdUrl,
    titleOf,
    mdLine,
    fileHeader,
    mdPath,
    jsonlPath,
    exportRecord,
    jsonlLine,
    mdDocument,
    appendsFor,
    csv,
    markdownExport,
  };
  root.OTAAT_FORMAT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
