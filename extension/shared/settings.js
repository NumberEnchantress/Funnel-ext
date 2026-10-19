/* Settings: defaults and merging. Shared by background, content scripts, pages and tests. */
(function (root) {
  'use strict';

  const DEFAULTS = {
    // Per-site pause: logging continues, feeds are shown normally.
    paused: { youtube: false, reddit: false, x: false },

    // Which surfaces are shown one item at a time.
    surfaces: {
      youtube: { home: true, subscriptions: true, shorts: true, channel: false },
      reddit: { home: true, popular: true, all: true, subreddit: true, customFeed: true, user: false },
      x: { home: true, lists: true, profile: false },
    },

    // Side "bombardment" to remove.
    hide: {
      ytRelated: true, // watch-page recommended videos
      ytEndscreen: true, // end-of-video wall, fullscreen grid, autoplay overlay
      ytAutoplay: true, // keep YouTube's autoplay-next switch off (queues and playlists still play)
      ytSearchShelves: true, // Shorts / "For you" / "People also watched" shelves injected into search results
      redditRelated: true, // posts under comments / beside a post
      redditSidebar: true, // sidebar post lists and popular communities
      xSidebar: true, // trending / who to follow (search box stays)
      xDiscover: true, // "Discover more" under a post's replies
      ads: true, // promoted items everywhere
    },

    skipSorted: true, // never show an item again once it was skipped / deferred / queued
    queueAdvances: true, // Queue also moves on to the next item
    xBookmarkOnLater: false, // Later on X also bookmarks the post on X

    seenRepeatHours: 24, // re-log a repeat sighting only after this many hours (0 = every time)
    logSightings: true, // log items you scroll past on normal (non-feed) pages
    sightingThreshold: 0.5, // fraction of an item that must be on screen to count as seen

    fileOutput: 'auto', // auto | native | downloads | off
    downloadsFolder: 'OneThingAtATime', // inside Firefox's download folder
    nativeFolder: '', // empty = the writer's default (chosen at install, else Documents/OneThingAtATime)

    barPosition: 'bottom', // bottom | top
  };

  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  function merge(base, over) {
    if (!isPlainObject(over)) return structuredCloneSafe(base);
    const out = {};
    for (const k of Object.keys(base)) {
      const b = base[k];
      const o = over[k];
      if (isPlainObject(b)) out[k] = merge(b, o);
      else if (o === undefined || (b !== null && typeof o !== typeof b)) out[k] = b;
      else out[k] = o;
    }
    return out;
  }

  function structuredCloneSafe(v) {
    return JSON.parse(JSON.stringify(v));
  }

  async function load(storageArea) {
    const got = await storageArea.get('settings');
    return merge(DEFAULTS, got && got.settings);
  }

  async function save(storageArea, patchFn) {
    const current = await load(storageArea);
    const next = patchFn(current) || current;
    await storageArea.set({ settings: next });
    return next;
  }

  const api = { DEFAULTS, merge, load, save };
  root.OTAAT_SETTINGS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
