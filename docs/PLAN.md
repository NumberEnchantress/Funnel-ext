# One Thing At A Time — Plan & Architecture

A Firefox extension that (1) turns the recommendation feeds on YouTube, X/Twitter and
Reddit into a one-item-at-a-time queue you sort with **Next / Later / Queue**, and
(2) records everything it shows you in plain local log files.

---

## 1. Goals

| # | Goal | How |
|---|------|-----|
| G1 | Feeds of unrelated content show **one unit at a time** | Per-site adapters hide every feed item except the current one |
| G2 | **Every** unit you see is logged, whatever you do with it | `seen` log for every item shown (feeds, detail pages, and items scrolled past on normal pages) |
| G3 | Sorting controls | Floating bar: **Next** (→ `skipped`), **Later** (→ `deferred` + later queue), **Queue** (YouTube only → `queued` + YouTube play queue) |
| G4 | Logs are local, readable files that are easy to open | Markdown files on disk + a searchable log viewer page inside the extension |
| G5 | Easy access to logs and Later queues | Links in the bar and the toolbar popup; Later page; YouTube Watch Later link |
| G6 | Remove side bombardment | Hide YouTube related videos/end screens, X trending sidebar and "Discover more", Reddit related/sidebar posts |
| G7 | Everything else behaves normally | Native site elements stay in place (we hide siblings, never re-render content), so likes, menus, hover previews and links keep working |
| G8 | Clean, simple, fast | No build step, no dependencies at runtime, no remote code, CSS-first hiding, feed rescans only for changes inside the feed (throttled) |

Non-goals: `old.reddit.com`, cloud sync, undo of YouTube queue adds. (Phones — Firefox for Android
and `m.youtube.com` — were added later; see §3.6.)

---

## 2. What counts as a "feed" (quantized) vs. normal page

Defaults (each one is a toggle in Settings):

| Site | Quantized by default | Left normal (but still logged) | Hidden |
|------|----------------------|--------------------------------|--------|
| YouTube | Home, Subscriptions feed, Shorts player | Channel pages, search, playlists, watch page | Watch-page related videos, end-screen video wall, fullscreen "more videos" grid, ads |
| Reddit | Home, Popular, All, subreddit feeds, custom feeds | User profiles, search, post pages | Related posts under comments, sidebar post lists / popular communities, ads |
| X | Home (For you + Following), Lists | Profiles, search, explore, post pages | Trending/who-to-follow sidebar (search box kept), "Discover more" under replies, promoted posts |

Rule of thumb from the brief: *profile feeds are not quantized; recommended / for-you /
default feeds are.*

---

## 3. Architecture

```
manifest.json (MV3, Firefox ≥ 128)
│
├── background/            event page (wakes on demand)
│   ├── db.js              IndexedDB: events, sorted, seen index, later queue, kv
│   ├── sinks.js           file writers: native host (append) / downloads (snapshot)
│   └── main.js            message router, stats, keyboard commands, sync loop
│
├── content/               runs on youtube.com, reddit.com, x.com, twitter.com
│   ├── core.js            namespace, utils, settings, messaging
│   ├── ui.js              control bar (Shadow DOM) + toasts
│   ├── engine.js          quantizer (collapse / spotlight / native modes),
│   │                      seen tracker, page-item logger, URL watcher
│   ├── sites/youtube.js   adapter
│   ├── sites/reddit.js    adapter
│   ├── sites/x.js         adapter
│   ├── hide.css           CSS gated by attributes on <html>
│   └── yt-main.js         runs in YouTube's page world: Watch Later / Queue commands
│
├── shared/                used by background, pages and tests
│   ├── settings.js        defaults + merge
│   └── format.js          markdown / csv / jsonl rendering, file paths
│
├── pages/                 popup, logs viewer, later queue, settings
└── native/                optional native host (Python) + installers
```

### 3.1 Site adapters

Each adapter answers the same questions, so the engine is site-agnostic:

- `surface(url)` → which surface this is (`home`, `subscriptions`, `profile`, …) and whether it is a feed, a detail page, or neither.
- `items(root)` → the feed's item containers, in display order.
- `info(el)` → `{ key, id, url, title, author, kind, snippet, thumb, extra }`.
- `isAd(el)`
- `mode` → how to show one item:
  - **collapse** (YouTube grid, Reddit): every item except the current one gets `display:none`. The feed's own "load more" trigger is hidden too, otherwise the now-short page makes the site load forever (verified: Reddit went 28 → 153 posts in 5 s). The engine reveals the loader only until one new batch arrives.
  - **spotlight** (X): X's timeline is virtualized, so collapsing breaks it. Other cells get `visibility:hidden` (layout kept) and the page is scrolled so the current post sits at the top. X keeps loading naturally as we move down.
  - **native** (YouTube Shorts): the site already shows one unit; the engine just tracks the current one and drives the site's own "next" button.
- `later(item)`, `queue(item)` → site-specific side effects.
- `pageItem()` → the main item on a detail page (video, post, tweet) for the `seen` log.

### 3.2 Engine flow on a feed

1. At `document_start`, `<html>` gets `otaat-q` + `otaat-mode`; CSS hides all feed items immediately (no flash of the full feed). In-app navigation is detected inside the mutation callback for the new page's DOM, before it paints. An attribute observer puts the flags back if a site strips them.
2. A throttled MutationObserver (reacting only to changes inside the feed) collects new items; their keys are checked against the **sorted** set in the background. Items you already sorted never come back, and an item sorted in another tab leaves this tab's feed too (broadcast through `storage.local`). The exception is the Shorts player, where YouTube picks the next video; the bar says "Already sorted before" there.
3. The first unsorted, non-ad item becomes current → shown → logged as `seen`.
4. The engine keeps a small buffer (≥ 3 pending items) by asking the adapter to load more. On X, posts that appear but were already sorted still count as progress, so the engine keeps scrolling past them.
5. **Next / Later / Queue** → side effect (if any) → log → mark sorted → show the next item.
6. The sighting logger runs on every page, feeds included. Hidden items never count, so anything the hiding misses is still logged.
7. Nothing in a background tab counts as seen until the tab is looked at.
8. If a feed's container can't be found within 5 s (a site redesign), hiding is switched off for that page, so it shows normally and is logged by the sighting logger, instead of staying blank.
9. A feed that seemed to end (two loads with nothing new) is retried after 30 s, or on the next action after that.

### 3.3 YouTube actions

YouTube's own feed items carry the exact commands their hover buttons run
(`playlistEditEndpoint` for Watch Later, `addToPlaylistCommand` with
`PLAYLIST_EDIT_LIST_TYPE_QUEUE` for the queue). `yt-main.js` (page world) hands those
commands to YouTube's own `resolveCommand`, so YouTube does the authenticated request,
shows its normal toast and opens the miniplayer queue. No scraping of menu text, no
language dependence. Later is logged as soon as the command is dispatched, with a safety copy
on the extension's own Later list. The copy is dropped only once YouTube shows its "Saved"
toast, so closing the tab mid-way or a silent failure can't lose the item. Signed out, the item
goes on the extension's list. The bridge's DOM events are visible to YouTube's own scripts, so
the bridge is exactly as trustworthy as the YouTube page itself.

### 3.4 Logging

Actions: `seen`, `skipped` (Next), `deferred` (Later), `queued` (Queue).

Each event: time, site, action, item key, URL, title/snippet, author, kind, surface,
page URL, thumbnail, extras (duration, subreddit…).

- **Canonical store:** IndexedDB in the extension (fast, queryable, survives restarts).
- **`seen` de-duplication:** an item already logged as seen within the last *N* hours
  (default 24, configurable, 0 = log every sighting) is not logged again.
- **All text is well-formed and length-capped before it is stored.** Truncation never splits an
  emoji, and lone surrogates are replaced, so no writer can choke on an entry.
- **Files on disk** (a folder per day inside month folders keeps files small):

  ```
  OneThingAtATime/
    2026-10/
      2026-10-14/
        seen.md
        skipped.md
        deferred.md
        queued.md
        events.jsonl        ← every event, machine-readable
  ```

  Line format:
  `- 2026-10-14 14:03:22 · YouTube · [Video title](https://youtube.com/watch?v=…) · Channel · home`

- **File writers** (Settings → File output):
  - **Native host** (recommended): tiny Python program registered with Firefox; appends
    lines instantly to `Documents\OneThingAtATime` (or any folder), can open the folder.
  - **Downloads folder** (zero setup): rewrites the touched day's files in
    `Downloads\OneThingAtATime` within ~20 s of new entries (and at least once a minute).
  - **Auto** (default): native when installed, otherwise Downloads.
  - A watermark (last written event id) means nothing is lost if a writer is offline;
    it catches up next time. Each destination folder has its own watermark, so a new folder
    receives the full history, and switching back to an earlier folder carries on without duplicates.
  - **Files are never clobbered, and lines are never written twice.** The native host can only
    append (it has no overwrite command). Every line carries its event id. The host records, per
    browser log id and file, the highest id written (`.otaat-state.json`) and skips anything at or
    below it. So a retry after a partial failure (one file locked by another program) or a re-send
    to the same folder never duplicates a line. A reinstalled extension has a new log id, so its
    restarted ids are never mistaken for old ones.
    The Downloads writer only rewrites files it created itself: the first write of each file uses
    Firefox's "uniquify", so if the in-browser log is wiped (reinstall) it starts `skipped(1).md`
    instead of overwriting older history.

### 3.5 UI

- **Control bar** (bottom centre, Shadow DOM so site CSS can't break it):
  `Next →` `Later` `Queue` (YouTube) · progress · `Logs` `Later list` / `Watch later`.
  Keyboard: `Alt+Shift+N`, `Alt+Shift+L`, `Alt+Shift+Q` (changeable in Firefox's
  *Manage Extension Shortcuts*).
- **Toolbar popup:** today's counts, pause per site, links to logs / later / folder / settings.
- **Logs page:** grouped by day, filter by action, site and text; export Markdown / CSV / JSON (all entries).
- Bar buttons only respond to real clicks (`isTrusted`), so page scripts can't press them.
- **Later page:** extension Later list (X, Reddit, signed-out YouTube) with open / done /
  remove; link to YouTube Watch Later (a private playlist cannot be embedded).
- **Settings page:** surfaces, hiding, logging, file output, native host status.

---

### 3.6 Phones (Firefox for Android) and narrow windows

- **Bar:** at ≤ 640 px the bar is a full-width strip of 48 px buttons (Next, Later, and Queue where it
  exists) plus a ⋯ menu (count, Logs, Watch later, Later list). Status text appears only when it
  matters (loading, end of feed, feed not found). The bar measures fixed elements at the bottom of
  the screen (`elementsFromPoint` at three points) and sits above them. It respects
  `env(safe-area-inset-*)`, and the engine scrolls items clear of the bar's real height.
- **YouTube phone site (`m.youtube.com`):** `ytm-rich-grid-renderer` / `ytm-rich-item-renderer` /
  `ytm-continuation-item-renderer` (same one-batch loader trick, verified live), related videos in
  `.related-items-container`, Shorts via the carousel's accessibility buttons. It has no
  `resolveCommand` and no play queue, so Watch Later goes through InnerTube `browse/edit_playlist`
  (SAPISIDHASH auth, like YouTube's page), and the answer confirms the save. Queue is hidden.
- **Android limits:** no `commands`, `windows`, native messaging or `downloads` API for add-ons. All
  are feature-detected. On Android, logs are kept in Firefox, and the Logs page offers Export
  (file download from the page) and Copy (clipboard), with a reminder to save regularly. Pages get
  `html.android`: full-width popup, touch-sized controls, desktop-only controls hidden.
- **Placement:** the bar samples 12 points along the bottom edge and 6 along the top, walking each
  hit up to its fixed/sticky ancestor once (memoised). It lifts above bars, floating buttons and
  bottom sheets (up to 60% of the screen), and hides while a full-screen dialog is open. It
  re-measures on scroll, resize and page mutations (throttled to 4 per second).

## 4. Testing strategy

1. **Unit tests** (`node --test`): formatting, URL → surface rules for every site,
   extraction from captured DOM fixtures (jsdom), engine sorting/advancing logic.
2. **Lint:** `web-ext lint`.
3. **Native host:** protocol round-trip test (length-prefixed JSON over stdio).
4. **Live:** load the extension temporarily into Firefox and drive real pages
   (Reddit feeds; YouTube grid on a channel page with that surface switched on for the
   test; X profile in the same way), checking hiding, advancing, loading and the logs.
5. **Adversarial grader:** a fresh sub-agent with only the original brief and the repo
   tries to break it; findings are fixed and re-checked.

---

## 5. Known risks

| Risk | Mitigation |
|------|------------|
| Sites change their markup | Selectors live only in adapters, use stable hooks (tag names, `href`s, ids, `data-*`), with fallbacks; X supports both its classic and 2026 web app markup |
| X / YouTube home need sign-in to test live | Adapters tested against captured markup + logged-out equivalents (channel grid, profile timeline) |
| Unsigned extensions only load temporarily in release Firefox | README covers signing as an unlisted add-on (free, private) or using Developer Edition |
| Event page unloads | All state in IndexedDB; alarms re-run pending file writes |
| Sites strip foreign attributes / hide unknown elements | Flags on `<html>` are re-applied by an attribute observer (X does this); the bar's host is a plain `<div>` with inline `!important` styles (Reddit hides undefined custom elements) |
| Firefox content-script sandbox | Shared state lives on `globalThis` (the sandbox), never on `window` (the page's Xray wrapper) |

## 6. Roadmap after v1

Undo last action · old.reddit.com · Reddit native "Save" on Later · per-day summary file ·
optional thread grouping on X.
