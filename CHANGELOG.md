# Changelog

All notable changes to dsh-media-inline-preview are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- ETag / `If-None-Match` conditional-GET on both file routes — unchanged media
  is revalidated with a 304 and zero transfer, instead of a full re-download
  (`no-cache` + weak validators; a changed file re-sends automatically).
- TGA→PNG conversions are now disk-cached in `~/.dsh/media-cache/`
  (content-addressed by source size+mtime, same 7-day TTL as transcode cache;
  overridable via `DSH_MEDIA_CACHE_DIR` for tests).
- Media players lazy-load: `preload="none"` until the figure scrolls into view
  (IntersectionObserver, 300px margin) — sessions with many media no longer
  open one metadata request per player up front.
- Incremental DOM scanning: the MutationObserver collects only inserted nodes /
  changed blocks into a pending set; the rAF pass scans just those, with a 3s
  full-pass fallback. Media-heavy chats no longer re-scan the whole document
  on every mutation.
- `test/cache.mjs`: ETag/304 conditional-GET + TGA disk-cache coverage.
- CI workflow (`.github/workflows/ci.yml`), `.gitignore`, CHANGELOG.
- File-scoped media tokens (scheme B″): a new `/token` route mints a `?dsh_tok=`
  HMAC-SHA256 credential bound to a single file's realpath, and a `__media_auth`
  route verifies it as an nginx `auth_request` target. Video players now carry
  the token in the URL before their first load, so a cookieless system media
  pipeline (e.g. Android's `stagefright`, which fetches media in its own process
  and cannot send the browser's cookies) can stream through a cookie-gated
  reverse proxy. The secret is auto-generated per deployment (0600 file, outside
  the workspace) and rotation is live — a rotated secret self-heals via a forced
  re-mint on the failure retry. Audio/img are untouched (they fetch in the page
  stack and keep the session cookie). Direct-IP deployments are unaffected: the
  trust fence (loopback / `--trusted-host`) still admits requests, and the token
  is simply an extra credential the media route accepts in lieu of the fence.
  Verification lives in the plugin (portable); the nginx location is an optional
  adapter.

### Changed
- Streaming messages mount media EARLY: a fence inside `[data-streaming]` now
  mounts as soon as it is settled — its JSON spec parses completely AND it has
  a following element sibling (an unclosed fence swallows everything after it,
  so a following sibling proves the fence is closed and frozen by the
  frontend's incremental renderer, which reuses its element across re-renders).
  Last-block fences keep waiting for the message to settle. Injected media
  elements carry a `_dshMediaMounted` marker, so a wrapper node replaced by
  the settle re-render adopts the existing mount when it survives as the
  wrapper's next sibling.
- Player robustness (fixes intermittent "无法播放" cards): every player now
  retries ONCE before showing an error card — transcoded for containers the
  browser cannot decode, same source after a short pause otherwise (transient
  network resets); the error card text now distinguishes decode errors from
  network/load failures (MediaError.code) instead of blaming decoding for
  everything; the load is deferred while the document is hidden (browsers
  throttle hidden-tab media fetches, which used to burn the 15s grace window);
  `reapHandled` now runs the mount's teardown (timers/observers) before
  dropping a virtualized block, and an adopted mount that survived a
  detach/reattach cycle re-arms its load via `_dshMediaResume` (zombie fix).
- `npm test` now runs all three suites (host, cache, client-smoke).
- `package.json` metadata completed (`repository`, `bugs`, `homepage`,
  `author`, `engines`, `sideEffects`).
- System-prompt fence spec: `label` is documented as accepted-for-compat only —
  the UI always shows the file name.
- README/DESIGN rewritten for public consumption (no machine-local paths).
- Settle-render dedup is now ownership-based and position-agnostic (fixes
  "one fence renders as two identical cards until a hard refresh"). On settle
  the frontend re-parses the message with a different React key scheme
  (absolute text offsets → array indices), so it deletes every block after the
  first and re-inserts a fresh code-block wrapper at a position that can leave
  an early-mounted media figure stranded IN FRONT of the new wrapper — the
  adjacent-sibling adoption could not see that and a second mount doubled the
  media. Every mount now records its owning wrapper (`_dshMediaOwner`) and
  media identity (`_dshMediaKey`); adoption transfers ownership, and a sweep
  removes any same-media mount whose owner left the document (the stranded
  duplicate) while leaving whole-subtree detaches (chat virtualization) intact
  for a reattach adoption. Applies to img, video and audio alike.
  (regression scenarios in `test/client-smoke.mjs`)
