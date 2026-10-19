'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shared } = require('./helpers');

const F = shared('format.js');
const S = shared('settings.js');

const ts = new Date(2026, 9, 14, 14, 3, 22).getTime(); // local time 2026-10-14 14:03:22

const video = {
  id: 7,
  ts,
  action: 'skipped',
  site: 'youtube',
  key: 'youtube:NiCgcUTL9_Q',
  kind: 'video',
  url: 'https://www.youtube.com/watch?v=NiCgcUTL9_Q',
  title: 'The Absurd [Engineering] Behind the Internet',
  author: 'Veritasium',
  surface: 'home',
  extra: { duration: '34:32' },
};

test('markdown line is one readable line with a working link', () => {
  const line = F.mdLine(video);
  assert.equal(
    line,
    '- 2026-10-14 14:03:22 · YouTube · [The Absurd \\[Engineering\\] Behind the Internet](https://www.youtube.com/watch?v=NiCgcUTL9_Q) · Veritasium · 34:32 · home\n'
  );
});

test('newlines in titles never break the line; long text is capped', () => {
  const ev = { ...video, title: 'Line one\nLine two\r\n' + 'x'.repeat(500) };
  const line = F.mdLine(ev);
  assert.equal(line.split('\n').length, 2); // content + trailing newline
  assert.ok(line.length < 400);
});

test('posts get their text as a quoted second line', () => {
  const ev = {
    ...video,
    site: 'x',
    kind: 'tweet',
    url: 'https://x.com/alice/status/1',
    title: 'Hello world',
    snippet: 'Hello world, and a longer body of text',
    author: '@alice',
    extra: {},
  };
  const line = F.mdLine(ev);
  assert.match(line, /^- .* · X · \[Hello world\]\(https:\/\/x\.com\/alice\/status\/1\) · @alice · home\n  > Hello world, and a longer body of text\n$/);
});

test('parentheses and spaces in URLs are encoded so the link survives', () => {
  assert.equal(F.mdUrl('https://a.b/c (d)'), 'https://a.b/c%20%28d%29');
});

test('files are grouped by day (inside month folders) and action, with a header for new files', () => {
  const nov = new Date(2026, 10, 1, 9, 0, 0).getTime();
  const evs = [video, { ...video, id: 8, action: 'seen' }, { ...video, id: 9, ts: nov }];
  const files = F.appendsFor(evs);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    '2026-10/2026-10-14/events.jsonl',
    '2026-10/2026-10-14/seen.md',
    '2026-10/2026-10-14/skipped.md',
    '2026-11/2026-11-01/events.jsonl',
    '2026-11/2026-11-01/skipped.md',
  ]);
  const oct = files.find((f) => f.path === '2026-10/2026-10-14/skipped.md');
  assert.match(oct.header, /^# Skipped \(Next\) — Wednesday,? 14 October 2026/);
  const jsonl = files.find((f) => f.path === '2026-10/2026-10-14/events.jsonl');
  // Lines are numbered with their event id, so the native writer can skip ones it already has.
  assert.deepEqual(jsonl.lines.map(([id]) => id), [7, 8]);
  const records = jsonl.lines.map(([, t]) => JSON.parse(t));
  assert.equal(records[0].url, video.url);
  assert.equal(jsonl.header, '');
});

test('an event stays in the day it was logged on, even if the time zone changes later', () => {
  const ev = { ...video, day: '2026-10-13' }; // stored at logging time
  assert.equal(F.mdPath(ev), '2026-10/2026-10-13/skipped.md');
});

test('CSV cells cannot run as spreadsheet formulas', () => {
  const out = F.csv([{ ...video, title: '=HYPERLINK("https://evil.example")' }]);
  assert.ok(out.includes(`"'=HYPERLINK(""https://evil.example"")"`));
});

test('text is never cut in the middle of an emoji, and lone surrogates are replaced', () => {
  const emoji = '😀'; // two UTF-16 units
  const s = 'a'.repeat(139) + emoji + 'tail';
  const cut = F.cut(s, 140);
  assert.equal(cut, 'a'.repeat(139), 'drops the emoji instead of half of it');
  assert.equal(F.wellFormed('x\uD83Dy'), 'x�y');
  assert.equal(F.wellFormed('ok 😀'), 'ok 😀');
  const line = F.mdLine({ ...video, title: 'b'.repeat(198) + emoji + 'more' });
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(line), 'no lone high surrogate');
  // A record with a lone surrogate (from older data or a site) becomes valid JSON text for any writer.
  const rec = F.jsonlLine({ ...video, snippet: 'half \uD83D' });
  assert.ok(!/\\ud83d/i.test(rec) && rec.includes('�'));
});

test('csv quotes commas, quotes and newlines', () => {
  const out = F.csv([{ ...video, title: 'a, "b"\nc' }]);
  const [head, row] = out.split('\r\n');
  assert.equal(head, 'time,action,site,kind,title,author,url,surface,snippet,key');
  assert.ok(row.includes('"a, ""b""\nc"') || out.includes('"a, ""b""\nc"'));
});

test('settings merge keeps defaults for missing or wrongly-typed values', () => {
  const s = S.merge(S.DEFAULTS, {
    skipSorted: false,
    seenRepeatHours: 'lots',
    surfaces: { youtube: { home: false } },
    unknownKey: 1,
  });
  assert.equal(s.skipSorted, false);
  assert.equal(s.seenRepeatHours, 24);
  assert.equal(s.surfaces.youtube.home, false);
  assert.equal(s.surfaces.youtube.subscriptions, true);
  assert.equal(s.surfaces.reddit.home, true);
  assert.equal(s.unknownKey, undefined);
  assert.notEqual(S.merge(S.DEFAULTS, null).surfaces, S.DEFAULTS.surfaces, 'returns a copy');
});

test('profile feeds are off and recommendation feeds are on by default', () => {
  const d = S.DEFAULTS.surfaces;
  assert.equal(d.youtube.home, true);
  assert.equal(d.youtube.channel, false);
  assert.equal(d.reddit.home, true);
  assert.equal(d.reddit.user, false);
  assert.equal(d.x.home, true);
  assert.equal(d.x.profile, false);
});
