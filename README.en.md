# dsh-media-inline-preview

[![CI](https://github.com/seeingrain/dsh-media-inline-preview/actions/workflows/ci.yml/badge.svg)](https://github.com/seeingrain/dsh-media-inline-preview/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 🇨🇳 中文: [README.md](README.md)

**The all-in-one media viewer for DeepSeek Harness (DSH) chat** — one plugin, three fences (```` ```img ```` / ```` ```video ```` / ```` ```audio ````), covering **36 local media formats**. Images render as cards with a full-screen lightbox, video/audio render as native players — all **inline inside chat messages**: no sidebar, no new tabs, mounting even while the message is still streaming. Merges and supersedes the separate img-preview (image fence) and video/audio fence plugins.

## 📱 Preview

| Image cards (JPG / PNG / SVG / TGA…) | Animated GIF + vector SVG inline | Native MP4 / MP3 players |
| :---: | :---: | :---: |
| ![Image cards + lightbox](https://raw.githubusercontent.com/seeingrain/dsh-media-inline-preview/main/assets/preview-1-images.jpg) | ![GIF and SVG vector](https://raw.githubusercontent.com/seeingrain/dsh-media-inline-preview/main/assets/preview-2-gif-svg.jpg) | ![MP4 and MP3 players](https://raw.githubusercontent.com/seeingrain/dsh-media-inline-preview/main/assets/preview-3-video-audio.jpg) |

## Supported formats (36)

| Category | Formats | Notes |
|------|------|------|
| Images (10) | `.png .jpg .jpeg .webp .gif .avif .bmp .svg .ico .tga` | Cards + lightbox; `.tga` auto-converted to PNG host-side (pure-JS decoder: uncompressed/RLE, 8/15/16/24/32-bit, palette); GIF plays inline as-is |
| Video · native (7) | `.mp4 .webm .mov .m4v .ogv .ts .3gp` | Browser-native, HTTP Range streaming |
| Audio · native (9) | `.mp3 .wav .m4a .aac .ogg .oga .flac .opus .weba` | Native `<audio>` players |
| Video · transcode (6) | `.mkv .avi .flv .wmv .mpg .mpeg` | On playback failure the client auto-retries with `?tc=1`; host transcodes via ffmpeg to H.264/AAC mp4 |
| Audio · transcode (4) | `.wma .mid .midi .m4b` | Same fallback; transcode results cached content-addressed for 7 days |

## Features

- **Images (`img`)** — thumbnail cards (caption shows **only the file name**), single-click fullscreen lightbox (desktop: wheel zoom / drag pan / double-click toggle 100%↔2.5x / ESC close; **mobile: two-finger pinch zoom (around the midpoint) + two-finger drag pan**, single finger drags too; top toolbar with −/＋/fit/100%/✕); `{"images":[...]}` grids; external `url` passthrough.
- **Video / audio (`video` / `audio`)** — native `<video>` / `<audio>` players rendered right in the message (seek, fullscreen, `playsinline` on mobile), file-name caption; no sidebar needed.
- **HTTP Range streaming** (media route): `createReadStream` piping with full 206/416 handling — large files seek smoothly with constant memory; 2 GiB cap.
- **Transcode fallback**: containers browsers cannot play (mkv/avi/flv/wmv/wma…) trigger an automatic client retry with `?tc=1`; the host transcodes via ffmpeg and caches to `~/.dsh/media-cache/` (content-addressed, 7-day TTL).
- **Bandwidth-friendly**: ETag / `If-None-Match` conditional GET on both routes (unchanged files revalidate with a 304 and zero transfer); TGA→PNG and ffmpeg transcode results disk-cached; players lazy-load via IntersectionObserver until scrolled into view.
- **Fence syntax persists** — the fence is just Markdown, so session history keeps it natively; reloading never loses media.
- **Streaming early mount** — once a fence inside a still-streaming message is settled (full JSON spec + a following sibling proves closure), it mounts and plays immediately instead of waiting for the message to finish.
- **Zero configuration** — after install, when media files appear or are produced in a session the agent calls `img_serve` / `media_serve` first and emits the fence; cards/players show up right in the message. Hand-written fences work too (below).

## Fence syntax

```img
{"path":"/absolute/path/to/image.png","label":"optional"}
```
```video
{"path":"/absolute/path/to/video.mp4","label":"optional"}
```
```audio
{"path":"/absolute/path/to/music.mp3","label":"optional"}
```

The `label` field is still parsed (hand-written fence compatibility), but the UI caption always shows the file name. Multi-image grid: `{"images":[{"path":"..."},{"path":"..."}]}`.

## Architecture (house pattern)

- **host (`lib/index.js`)** — `systemPrompt.section` injects the unified fence teaching (three fences + active triggering + dedup); `img_serve` / `media_serve` tools validate paths and return `{ok, ..., path, url}`; routes:
  - `/plugins/dsh-media-inline-preview/files` — image route (whole-read, 128 MiB cap, TGA→PNG on the fly with disk cache, `ACAO *`)
  - `/plugins/dsh-media-inline-preview/media` — media route (Range streaming, 2 GiB cap, `?tc=1` transcode fallback)
  - `/plugins/dsh-media-inline-preview/token` + `__media_auth` — **file-scoped HMAC tokens** (`?dsh_tok=`): a credential bound to a single file's realpath, verified as an nginx `auth_request` target, so cookieless system media pipelines (e.g. Android's `stagefright`, which fetches media in its own process without the browser's cookies) can stream through a cookie-gated reverse proxy; the secret is auto-generated per deployment (0600, outside the workspace) and rotation is live (a rotated secret self-heals via a forced re-mint on the failure retry).
- **client (`lib/client.js`)** — `window.__ModuleLoader__` registration; incremental MutationObserver scan (rAF-coalesced, plus a 3s full-pass fallback) with **three-tier collision-free detection**:
  1. `div.infostring` text exactly `img`/`video`/`audio` (primary; empty while streaming so half-streamed fences never match)
  2. Text opens with `` ```img `` / `` ```video `` / `` ```audio `` (surface fallback)
  3. JSON spec kind inferred from the `path` extension (disjoint extension sets — a bare JSON body never cross-triggers another media kind)
  
  Nested `pre` inside a wrapper is skipped (single mount target, no double-mount); playback failure auto-retries `?tc=1`, a second failure swaps in an error card.
- **Security** (see DESIGN.md):
  - Both routes pass a browser trust fence on **every request**: Host must be loopback or one of `webRuntime.trustedHosts` (LAN IPs sampled at boot + `--trusted-host` entries), `sec-fetch-site: cross-site` refused, a present Origin must match the Host — **LAN/mobile GUI access keeps working while cross-site fetches are blocked** (stricter than the original img-preview).
  - Workspace containment re-checked per request, `realpath` closes symlink escapes (including the missing-file fallback), extension whitelist only, 128 MiB / 2 GiB caps.

## Usage

After installation nothing to configure: when images/videos/audio appear or are produced in a session, the agent calls `img_serve` / `media_serve` first, then emits the fence — cards/players show up right in the message. You can also hand-write the fences above.

## Tests

```sh
npm test                  # host + cache + client smoke (all suites)
node test/host.mjs        # host unit: trust fence / path escape / TGA→PNG / type mapping
node test/cache.mjs       # cache: ETag/304 conditional GET + TGA disk cache
node test/client-smoke.mjs  # stubbed-DOM smoke: detection / cross-kind / mount / lazy-load / tokens
```

## Installation

```sh
dsh plugin --profile web add github:seeingrain/dsh-media-inline-preview
# host half needs a web restart; client half loads on the next page refresh
```

## License

MIT — see [LICENSE](LICENSE).
