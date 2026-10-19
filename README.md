# One Thing At A Time

A Firefox extension for YouTube, X (Twitter) and Reddit that:

1. **Shows recommendation feeds one item at a time.** You decide what happens to each item with
   **Next**, **Later** or (on YouTube) **Queue**, and then the next one appears.
2. **Logs everything it shows you** to plain, readable files on your computer, whatever you do with it.
3. **Hides side feeds:** YouTube's recommended videos, X's trending sidebar, and Reddit's related and sidebar posts.

Everything stays on your computer. The extension sends nothing anywhere: it only talks to the sites
you are already on (and their own image servers, for thumbnails on the Later page), and to the
optional file writer on your own machine.

---

## Using it

Open YouTube, X or Reddit. On a feed, you see a single item and a bar at the bottom of the page:

| Button | What it does | Log file |
|---|---|---|
| **Next →** | Shows the next item | `skipped.md` |
| **Later** | Saves the item for later, then shows the next one. On YouTube it goes into your **Watch later** playlist. On X and Reddit it goes on the extension's **Later list**. | `deferred.md` |
| **Queue** (YouTube only) | Adds the video to YouTube's play queue (the mini-player), then shows the next one | `queued.md` |
| **Logs** | Opens the log viewer | |
| **Watch later** / **Later list** | Opens your Later queue | |

Every item that appears on screen is also written to `seen.md`. The item you are shown in a feed
counts, and so do items you scroll past on normal pages such as profiles, search results and replies.
To keep `seen.md` readable, an item you already saw within the last 24 hours isn't written again. You
can change that window in Settings → Logging; set it to 0 to log every sighting. A page that loads
in a background tab is logged when you switch to it, not before.

**Keyboard shortcuts:** `Alt+Shift+N` (Next), `Alt+Shift+L` (Later), `Alt+Shift+Q` (Queue). To change
them, go to `about:addons` → ⚙ → *Manage Extension Shortcuts*.

**Toolbar button:** shows today's counts and what the extension is doing on the current tab. From
there you can pause a site and open your logs, your Later list, the log folder or Settings.

Once you have pressed Next, Later or Queue on an item, it doesn't come back in your feeds, including
feeds already open in other tabs. You can reset this in Settings → Data. The one exception is the
Shorts player, where YouTube picks the next video. If a Short you already sorted comes up again, the
bar says **Already sorted before**.

On YouTube, **Later** puts the video in your Watch later playlist. The entry is logged and a safety
copy goes on the extension's Later list straight away. The copy is removed once YouTube confirms the
save, so if YouTube doesn't confirm (or you're signed out) the video can't get lost.

### What is shown one at a time

These are the defaults. Each one can be switched on or off in Settings.

| Site | One at a time | Left as normal (but still logged) | Hidden |
|---|---|---|---|
| YouTube | Home, Subscriptions (grid view), Shorts player | Channel pages, search, playlists, watch page | Recommended videos next to and under the video, end-of-video suggestion wall, fullscreen "more videos", autoplay of the next recommendation, Shorts / "For you" shelves inside search results, ads |
| Reddit | Home, Popular, All, subreddits, custom feeds | User profiles, search, post pages | "More posts" under the comments, related posts beside a post, sidebar post lists and popular communities, community highlights above feeds, ads |
| X | Home (For you and Following), Lists | Profiles, search, Explore, post pages | Trending / who-to-follow sidebar (the search box stays), "Who to follow" blocks inside profiles, "Discover more" under replies, promoted posts |

Profile feeds are left alone, as asked. Recommended, "for you" and default feeds are shown one at a time.

---

## Your log files

The logs are kept in two places:

- **Inside Firefox**, in the **Logs** page. You can filter it by log (seen, skipped, deferred,
  queued), by site and by text, and export it as Markdown, CSV or JSON.
- **As files on disk**, one folder per month with a folder per day inside it:

  ```
  OneThingAtATime/
    2026-10/
      2026-10-14/
        seen.md          ← everything shown to you
        skipped.md       ← Next
        deferred.md      ← Later
        queued.md        ← Queue
        events.jsonl     ← every detail of every entry, one JSON object per line
  ```

  Each line can be read in any text editor and has a working link:

  ```
  - 2026-10-14 14:30:30 · Reddit · [Got fired this morning…](https://www.reddit.com/r/…) · u/someone · r/KitchenConfidential · popular
  ```

### Where the files go

- **Out of the box: your Downloads folder** (`Downloads\OneThingAtATime`). Nothing needs to be set up.
  New entries reach the files within about 20 seconds (and at least once a minute). Only that day's
  files are rewritten, so they stay small. Firefox may show its download icon each time. To stop the
  downloads panel from opening, set `browser.download.alwaysOpenPanel` to `false` in `about:config`.
  In this mode, **Open log folder** opens your Downloads folder.
- **Recommended: the native file writer** (`Documents\OneThingAtATime`, or any folder you choose). Entries
  are appended the moment they happen, nothing shows in the download panel, and the **Open log folder**
  buttons work. Set it up once:
  1. Install [Python 3](https://www.python.org/downloads/) and tick "Add to PATH".
  2. Right-click `native\install-windows.ps1` → **Run with PowerShell**. On macOS / Linux, run `native/install-unix.sh` instead.
     To choose where the logs go, run it from PowerShell with a folder, for example:
     ```bash
     pwsh -ExecutionPolicy Bypass -File native\install-windows.ps1 -LogFolder "$HOME\Documents\OTAAT"
     ```
     The folder is created if it doesn't exist. It is the writer's default; the extension's
     *Native writer folder* setting can still override it.
  3. In the extension's Settings → Files, press **Check native writer**.

  To remove it, run `native\uninstall-windows.ps1`. Your log files are left where they are.

**Safety rules for your files.** The native writer only ever adds lines to the end of a file.
It never shortens, replaces or deletes a file, and it never writes outside its folder. Every line
carries its entry number. The writer keeps a small bookkeeping file (`.otaat-state.json`) recording
what each file already has, and skips anything it has already written. So if one file is locked (for
example open in Excel) and the write is retried later, no line is ever written twice. Text that can't
be stored as UTF-8 (such as half of an emoji) is replaced, so it can't block the writer.
The Downloads writer only rewrites files it created itself. If Firefox's copy of the logs is ever wiped
(for example after reinstalling), it starts new files (`skipped(1).md`) and leaves the old ones alone.
If a writer is unavailable, nothing is lost: entries wait in Firefox and are written as soon as it is
back. Each folder keeps track of what it has received, so switching folders and back never writes an
entry twice.

---

## Installing

Firefox only keeps unsigned extensions until it restarts. You have three options:

- **Try it now (until Firefox restarts):** open `about:debugging#/runtime/this-firefox` → **Load
  Temporary Add-on…** → choose `extension/manifest.json`.
- **Keep it permanently (recommended): sign it privately with Mozilla.** This is free, and the
  extension is not published anywhere.
  1. Create an account at [addons.mozilla.org](https://addons.mozilla.org) and get API keys under *Tools → Manage API Keys*.
  2. In this folder, run:
     ```bash
     npx web-ext sign --source-dir extension --channel unlisted --api-key YOUR_KEY --api-secret YOUR_SECRET
     ```
  3. Open the `.xpi` file it creates (in `web-ext-artifacts/`) with Firefox to install it.
- **Firefox Developer Edition or Nightly:** set `xpinstall.signatures.required` to `false` in
  `about:config`, run `npm run build`, then install `dist/*.zip` from `about:addons` → ⚙ → *Install Add-on From File*.

You need Firefox 128 or newer. After installing, Firefox asks you to allow access to YouTube, X and
Reddit. The extension needs that access to work.

---

## Good to know

- **Sign in to the sites.** YouTube's Home feed is empty when you're signed out, and X's Home needs an
  account. YouTube's **Later** uses your Watch later playlist, so it needs you signed in to YouTube.
  When you're signed out, Later on YouTube uses the extension's Later list instead and tells you so.
- **Queue** works the way YouTube's own "Add to queue" does. The first video you queue opens the mini-player.
- On X, posts other than the current one are made invisible rather than removed, because removing them
  would break X's timeline. If you scroll away from the current post you will only see empty space.
  Press **Next** to move on.
- Sites change their pages often. All site-specific details live in `extension/content/sites/`.
  If a site update breaks something, the **Pause** switch (toolbar popup or Settings) returns that site
  to normal immediately, and logging keeps working.
- If a site changes its page so that the extension can't find its feed, the feed stays hidden for a
  few seconds, in case it is just slow to load. Then the page shows normally, the bar says
  **Couldn't find this feed — showing the page normally**, and items on screen are still logged.
- YouTube's Subscriptions *list* view isn't shown one at a time; the default grid view is.
- Not supported: `old.reddit.com`.

---

## On a phone (Firefox for Android)

The extension also works in Firefox for Android (version 128 or newer), and on narrow desktop windows.

- **The button bar becomes a full-width strip** with big **Next** and **Later** buttons (and **Queue** on
  desktop YouTube), plus **⋯** for today's count, Logs, Watch later and the Later list. This happens on
  narrow screens, and on touch screens held sideways. It sits above whatever the site pins to the bottom:
  YouTube's Home/Shorts/You bar, X's tab bar and compose button, app banners, and menus that slide up
  from the bottom. On a Short it stays clear of the channel / title line and the like / comment / share
  buttons (above them on a phone; beside the video in a wide window). It steps aside while a site dialog
  covers the screen. When something needs saying ("Loading more…"), a short line appears above the buttons.
- **YouTube on phones** serves its mobile site (`m.youtube.com`), and the extension supports it: one video
  at a time on Home and Subscriptions, related videos hidden, and Shorts with Next/Later. YouTube's mobile
  site has no play queue, so there is no **Queue** button there. **Later** saves to Watch later through
  YouTube's own API and logs what YouTube answered. If YouTube refuses or doesn't answer, the video goes
  on the extension's Later list instead. *Keep autoplay off* works on desktop YouTube only.
- **Reddit and X** use their normal pages at phone width, so the extension behaves as on desktop.
- **Logs on Android:** Firefox for Android gives add-ons no way to write files on their own (no native
  file writer, no downloads access). So on Android your logs are kept in Firefox. Open **Logs** (⋯ → Logs)
  and use **Export** (Markdown, CSV or JSON) or **Copy** (paste into any note or file) to save them.
  **Do this now and then:** logs kept only in Firefox are lost if you remove the extension or clear its data.
- No keyboard shortcuts on phones; use the buttons.
- Checked so far on the live sites at phone width and against YouTube's real mobile markup, but not yet on
  an actual Android phone.
- **Installing on Android:** Firefox for Android only installs signed add-ons. Sign it privately as
  described above (the same signed `.xpi` works on desktop and Android), copy the file to the phone, then
  in Firefox for Android go to *Settings → About Firefox*, tap the Firefox logo five times to unlock the
  debug menu, and use *Install extension from file* (available in recent versions). For development,
  `npx web-ext run --target=firefox-android` installs it temporarily over USB debugging.

---

## Development

```bash
npm install           # dev tools: jsdom, fake-indexeddb, web-ext
npm test              # unit, engine and background tests (node:test + jsdom)
npm run test:host     # native file writer tests (Python)
npm run lint          # web-ext lint
npm run check         # all of the above
npm start             # launch Firefox with the extension loaded
npm run build         # zip for installation/signing → dist/
```

Layout:

```
extension/
  manifest.json
  background/   db.js (IndexedDB) · sinks.js (file writers) · main.js (messages, sync, shortcuts)
  content/      core.js · ui.js (button bar) · engine.js (one-at-a-time + logging) · hide.css
                sites/youtube.js · sites/reddit.js · sites/x.js · yt-main.js (YouTube page bridge)
  shared/       settings.js · format.js (Markdown / CSV / JSONL)
  pages/        popup · logs · later · options
native/         otaat_host.py · install-windows.ps1 · uninstall-windows.ps1 · install-unix.sh
tests/          *.test.js · native_host_test.py · fixtures/ (markup captured from the live sites)
docs/PLAN.md    plan and architecture
```
