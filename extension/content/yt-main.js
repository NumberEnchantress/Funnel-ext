/*
 * Runs in YouTube's own page world (manifest "world": "MAIN").
 * Executes YouTube's own commands for Watch Later and Add to queue, exactly like its hover buttons do,
 * and reads the player's current video. Talks to the content script through DOM events carrying JSON strings.
 */
(function () {
  'use strict';
  if (window.__otaatBridge) return;
  window.__otaatBridge = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function findCommand(root, pred) {
    const seen = new Set();
    const stack = [root];
    let steps = 0;
    while (stack.length && steps++ < 20000) {
      const o = stack.pop();
      if (!o || typeof o !== 'object' || seen.has(o)) continue;
      seen.add(o);
      try {
        if (pred(o)) return o;
      } catch (_) {
        /* ignore odd shapes */
      }
      for (const k in o) {
        const v = o[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return null;
  }

  function itemFor(videoId) {
    const cur = document.querySelector('[otaat-current]');
    if (cur && cur.querySelector(`a[href*="${videoId}"]`)) return cur;
    const link = document.querySelector(`ytd-rich-item-renderer a[href*="${videoId}"]`);
    return link ? link.closest('ytd-rich-item-renderer') : null;
  }

  function resolver(el) {
    if (el && typeof el.resolveCommand === 'function') return el;
    const app = document.querySelector('ytd-app');
    if (app && typeof app.resolveCommand === 'function') return app;
    return null;
  }

  function signedIn() {
    try {
      return !!(window.ytcfg && window.ytcfg.get && window.ytcfg.get('LOGGED_IN'));
    } catch (_) {
      return false;
    }
  }

  function toastVisible() {
    const toasts = document.querySelectorAll('tp-yt-paper-toast, yt-notification-action-renderer');
    for (const t of toasts) {
      const style = getComputedStyle(t);
      if (t.offsetParent !== null && style.visibility !== 'hidden' && style.display !== 'none' && (t.opened || t.hasAttribute('opened') || t.textContent.trim())) {
        return true;
      }
    }
    return false;
  }

  // ---- YouTube's InnerTube API, authorised like YouTube's own page does it (SAPISIDHASH).

  function cookie(name) {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function sha1Hex(text) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function innertube(path, body) {
    const cfg = window.ytcfg;
    const headers = {
      'Content-Type': 'application/json',
      'X-Origin': location.origin,
      'X-Goog-AuthUser': String(cfg.get('SESSION_INDEX') || 0),
    };
    const sapisid = cookie('SAPISID') || cookie('__Secure-3PAPISID');
    if (sapisid) {
      const ts = Math.floor(Date.now() / 1000);
      headers.Authorization = `SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${sapisid} ${location.origin}`)}`;
    }
    const page = cfg.get('DELEGATED_SESSION_ID');
    if (page) headers['X-Goog-PageId'] = page;
    const key = cfg.get('INNERTUBE_API_KEY');
    const res = await fetch(`/youtubei/v1/${path}?prettyPrint=false${key ? `&key=${encodeURIComponent(key)}` : ''}`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context: cfg.get('INNERTUBE_CONTEXT'), ...body }),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, json };
  }

  async function addToWatchLaterViaApi(videoId) {
    const r = await innertube('browse/edit_playlist', {
      playlistId: 'WL',
      actions: [{ addedVideoId: videoId, action: 'ACTION_ADD_VIDEO' }],
    });
    return r.ok && r.json && r.json.status === 'STATUS_SUCCEEDED';
  }

  let lastWatchLater = null;
  const guard = { timer: null, video: '', clicks: 0 };
  function guardTick() {
    if (location.pathname !== '/watch') return;
    const player = document.querySelector('#movie_player');
    const btn = player && player.querySelector('.ytp-autonav-toggle-button');
    if (!btn || player.classList.contains('ad-showing') || player.classList.contains('unstarted-mode')) return;
    const video = new URLSearchParams(location.search).get('v') || '';
    if (video !== guard.video) {
      guard.video = video;
      guard.clicks = 0;
    }
    if (btn.getAttribute('aria-checked') === 'true' && guard.clicks < 2) {
      (btn.closest('button') || btn).click();
      guard.clicks++;
    }
  }

  const methods = {
    async ping() {
      return { ok: true };
    },

    async watchLater({ videoId }) {
      if (!videoId) return { ok: false, error: 'no video id' };
      if (!signedIn()) return { ok: false, reason: 'signed-out' };
      const el = itemFor(videoId);
      let cmd = el
        ? findCommand(
            el.data,
            (o) =>
              o.playlistEditEndpoint &&
              o.playlistEditEndpoint.playlistId === 'WL' &&
              (o.playlistEditEndpoint.actions || []).some(
                (a) => a.action === 'ACTION_ADD_VIDEO' && a.addedVideoId === videoId
              )
          )
        : null;
      if (!cmd) {
        cmd = {
          commandMetadata: { webCommandMetadata: { sendPost: true, apiUrl: '/youtubei/v1/browse/edit_playlist' } },
          playlistEditEndpoint: { playlistId: 'WL', actions: [{ addedVideoId: videoId, action: 'ACTION_ADD_VIDEO' }] },
        };
      }
      const target = resolver(el);
      if (!target) {
        // m.youtube.com has no command handler: make the same request YouTube's page would, whose answer
        // also tells us for certain whether it worked.
        lastWatchLater = { result: addToWatchLaterViaApi(videoId) };
        return { ok: true, via: 'api' };
      }
      lastWatchLater = { hadToast: toastVisible() };
      target.resolveCommand(cmd);
      // Answer straight away, so the entry is logged before anything else can go wrong;
      // confirmWatchLater() then waits for YouTube's "Saved to Watch later" toast.
      return { ok: true };
    },

    async confirmWatchLater() {
      if (lastWatchLater && lastWatchLater.result) {
        return { ok: true, verified: await lastWatchLater.result.catch(() => false) };
      }
      const hadToast = lastWatchLater ? lastWatchLater.hadToast : false;
      for (let i = 0; i < 25; i++) {
        if (!hadToast && toastVisible()) return { ok: true, verified: true };
        await sleep(100);
      }
      return { ok: true, verified: false };
    },

    async queue({ videoId }) {
      if (!videoId) return { ok: false, error: 'no video id' };
      const el = itemFor(videoId);
      let cmd = el
        ? findCommand(
            el.data,
            (o) =>
              o.signalServiceEndpoint &&
              (o.signalServiceEndpoint.actions || []).some(
                (a) =>
                  a.addToPlaylistCommand &&
                  a.addToPlaylistCommand.listType === 'PLAYLIST_EDIT_LIST_TYPE_QUEUE' &&
                  a.addToPlaylistCommand.videoId === videoId
              )
          )
        : null;
      if (!cmd) {
        cmd = {
          commandMetadata: { webCommandMetadata: { sendPost: true } },
          signalServiceEndpoint: {
            signal: 'CLIENT_SIGNAL',
            actions: [
              {
                addToPlaylistCommand: {
                  openMiniplayer: true,
                  videoId,
                  listType: 'PLAYLIST_EDIT_LIST_TYPE_QUEUE',
                  onCreateListCommand: {
                    commandMetadata: {
                      webCommandMetadata: { sendPost: true, apiUrl: '/youtubei/v1/playlist/create' },
                    },
                    createPlaylistServiceEndpoint: { videoIds: [videoId], params: 'CAQ%3D' },
                  },
                  videoIds: [videoId],
                },
              },
            ],
          },
        };
      }
      const target = resolver(el);
      if (!target) return { ok: false, error: 'YouTube command handler not found' };
      target.resolveCommand(cmd); // YouTube opens the mini-player with its queue: visible to the user at once
      return { ok: true };
    },

    async videoData({ videoId }) {
      const players = document.querySelectorAll('#shorts-player, #movie_player, .html5-video-player');
      for (const p of players) {
        try {
          const d = typeof p.getVideoData === 'function' ? p.getVideoData() : null;
          if (d && d.video_id === videoId && d.title) {
            return { ok: true, title: d.title, author: d.author || '' };
          }
        } catch (_) {
          /* not ready */
        }
      }
      return { ok: false };
    },

    // The autoplay switch only sticks once the player has started (and not during ads),
    // so check it periodically on watch pages. At most two flips per video, so it never fights you.
    async autoplayGuard({ on }) {
      if (on && !guard.timer) guard.timer = setInterval(guardTick, 1500);
      if (!on && guard.timer) {
        clearInterval(guard.timer);
        guard.timer = null;
      }
      return { ok: true };
    },
  };

  document.addEventListener('otaat-yt-request', async (e) => {
    let req;
    try {
      req = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    if (!req || !Object.prototype.hasOwnProperty.call(methods, req.method)) return;
    const args = req.args || {};
    if (args.videoId !== undefined && !/^[\w-]{6,20}$/.test(String(args.videoId))) {
      args.videoId = '';
    }
    let out;
    try {
      out = { id: req.id, result: await methods[req.method](args) };
    } catch (err) {
      out = { id: req.id, error: String((err && err.message) || err) };
    }
    document.dispatchEvent(new CustomEvent('otaat-yt-response', { detail: JSON.stringify(out) }));
  });
})();
