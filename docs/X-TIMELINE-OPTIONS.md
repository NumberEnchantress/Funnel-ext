# X timeline: taking control (design note, November 2026)

**Status:** recommendation only; nothing is built yet.

## Today

X's timeline is a **virtualized list**: X lays posts out by measuring each cell and positioning it absolutely,
and it fetches more when the list scrolls near its end. The extension therefore can't `display:none` the
other posts (X would re-measure, shuffle and load forever). It uses **spotlight** mode instead:

- the other posts are `visibility:hidden` but keep their space, so the one post is pinned at the top with
  blank space around it;
- "load more" means scrolling X's list (`spotlightLoad`);
- **Later** can press X's own bookmark button (`x.js`, `bookmark()`).

## Options

### A. Feed X's own timeline one post at a time (recommended)

A MAIN-world script (like `yt-main.js`) wraps `fetch` and `XMLHttpRequest` and sees X's timeline GraphQL
responses: `HomeTimeline`, `HomeLatestTimeline`, `ListLatestTweetsTimeline`. Each one is a list of
*instructions* (`TimelineAddEntries` …) whose entries are posts plus top/bottom *cursors*.

1. **Keep the posts for ourselves.** Store each response's post entries in a queue. Hand X back a response
   with only the **current** post and the bottom cursor.
2. **Hold X's next request until Next.** With a single post, X's list is short, so it immediately asks for
   the next page (the bottom cursor). We don't answer at once: the request stays pending until the user
   presses Next, then resolves with the next queued post and a cursor. When the queue runs low, we let one
   real request through to the server, keep its posts, and answer X with one again.
3. **The list stays tiny.** It only ever holds the posts already shown. So the earlier ones can be
   `display:none` safely: there's nothing to virtualize. The current post can sit in the middle of the
   stage, like Reddit and YouTube.
4. **New-post polling** at the top (the "Show N posts" pill) is answered with nothing; those posts join our
   queue instead.

What it gives:

- **≤ 1 post per frame by construction.** X never has the others to draw. The existing CSS stays as a
  second line of defence.
- **Exact logging.** "Seen" still comes from the post actually drawn (the DOM marks plus sightings), never
  from what X fetched. Queued posts that are never shown are never logged.
- **Everything native keeps working:** likes, replies, reposts, video, X's menus, quoted posts, polls, and
  Later through X's own bookmark button. We never draw a post ourselves.
- **Load more** becomes "release one queued post", plus an occasional real fetch. No scrolling X's list
  any more.

Risks, and how to contain them:

- **X's client may time out a held request** and retry or show an error. *Spike question 1.*
  Fallback: answer at once with an empty page that has a cursor, and re-trigger X's load on Next by nudging
  its list.
- **X's cache.** X caches timelines (Back restores them), and its normalized post store keeps everything
  it has seen. The cache only ever contains what we released, which is exactly what was shown, so this is
  benign. *Spike question 2:* Back/forward and switching tabs (For you / Following) don't replay the
  original full response.
- **Request signing** (`x-client-transaction-id` etc.) isn't touched: we only modify responses, and let
  X's own real requests through.
- **Schema drift.** The instruction/entry shape has been fairly stable for years, but X can change it. The
  rewrite must be **fail-safe**: if a response doesn't parse as expected, pass it through unchanged and
  fall back to today's spotlight mode (and say so in the bar). Never block X's feed.
- **Promoted posts** arrive as entries too and can be dropped from the queue, which is stronger than
  today's DOM ad check.

Effort: about one MAIN-world module (~300 lines) plus engine hooks, and tests built on **synthetic**
GraphQL fixtures.

### B. Draw our own card from the GraphQL data

Use the same interception, but hide X's whole column and render the post ourselves.

- **Pros:** total layout freedom, and no X layout at all.
- **Cons:** likes, replies, reposts, bookmarks (for Later), video (often HLS-only), polls, menus, cards
  and quoted posts all need reimplementing. Reimplementing likes or bookmarks means calling X's mutations,
  which need X's request signing. That is fragile and against X's rules for automated clients.
- **Logging stays exact** (we log what we drew).
- **Verdict:** only worth it if A fails the spike. Even then, a hybrid is better: our card for reading, and
  "open on X" for interacting.

### C. Move or clone X's cell into a container we own

React reconciles the moved node back, or the clone has dead handlers. Two renderers fight over one post.
Fragile, and it gives less than A. **Not recommended.**

## Reddit and desktop YouTube

Not needed. Both already work in collapse mode (`display:none` siblings, no virtualization), and the
centring pass removed their empty space. Reddit loads more as HTML partials, so the same trick would
mean rewriting HTML: no gain.

## Testing and privacy

- **Sign-in.** X needs a signed-in account to test. The user would sign in themself in a test profile; the
  extension and Claude never handle the password. Signed out, only the code paths can be tested, against
  synthetic responses.
- **Fixtures.** Committed fixtures must be **synthetic**: made-up posts, handles and IDs that follow the
  response *shape*. Never commit a capture of a real response (it carries the account's handle, IDs,
  follows and tokens). If a real response is captured to learn the shape, it stays in a scratch folder
  and is deleted after.
- **The spike first:** about half a day, in a test profile signed in by the user.
  1. Can a timeline request be held (30 s+) without X erroring or retrying?
  2. Do Back/forward and tab switches replay only what was released?
  3. Do the earlier cells collapse cleanly with `display:none` in a list this short?
  4. Does a single-entry page plus a cursor keep X asking for more (and not end the timeline)?
- **Then build A** behind a setting (off by default until it has been used for a while), with today's
  spotlight as the automatic fallback.
