import { existsSync, createReadStream, mkdirSync, rmSync, statSync, readdirSync, renameSync, realpathSync, writeFileSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, isAbsolute, sep } from "node:path";
import { deflateSync } from "node:zlib";

/**
 * DSH Media Inline Preview — all-in-one host half.
 *
 * One plugin for all inline media fences in chat, following the house pattern
 * of img-preview / dsh-mermaid / pbr-render:
 *
 *   ```img    → image cards (thumbnails, click-to-lightbox, grids, TGA→PNG)
 *   ```video  → native <video> player (Range seeking, transcode fallback)
 *   ```audio  → native <audio> player (Range seeking, transcode fallback)
 *
 * Registers:
 *  - `img_serve`  tool — validates an image path, mints a servable URL.
 *  - `media_serve` tool — validates a video/audio path, reports kind + URL.
 *  - `/plugins/dsh-media-inline-preview/files`  — image route (whole-read,
 *    TGA transcoded to PNG on the fly; 128 MiB ceiling; ACAO * for embedding).
 *  - `/plugins/dsh-media-inline-preview/media`  — media route (createReadStream
 *    streaming with HTTP Range 206/416 seeking; 2 GiB ceiling; `?tc=1` ffmpeg
 *    transcode fallback for containers browsers cannot decode, cached in
 *    ~/.dsh/media-cache/ keyed by sha256(path|size|mtime), pruned after 7 days).
 *  - `/plugins/dsh-media-inline-preview/token`  — token issuer (GET, trust-
 *    fenced): `?path=<abs>` mints a file-scoped HMAC media token
 *    `{ok, tok, path}`. The page stack (authenticated) calls this, then appends
 *    `?dsh_tok=<tok>` to the media URL.
 *  - `/plugins/dsh-media-inline-preview/__media_auth` — auth verifier for an
 *    nginx `auth_request` subrequest: reads `X-Original-URI`, and passes (200)
 *    if the original media URL carries a valid `dsh_tok`, else falls back to
 *    the cookie gate (forwards the request Cookie to AUTH_GATE_URL). Lets a
 *    cookieless client (Android system media pipeline / stagefright) through a
 *    cookie gate via the token, while cookie clients keep working unchanged.
 *
 * Security model (stricter than the original img-preview):
 *  - Every request passes a browser trust fence (better-sidebar pattern):
 *    the Host header must be loopback or one of the web runtime's
 *    `trustedHosts` (LAN IPs sampled at boot + --trusted-host entries),
 *    `sec-fetch-site: cross-site` is refused, and a present Origin header
 *    must match the request Host. This keeps LAN/mobile GUI access working
 *    while blocking cross-site fetches.
 *  - Only files under a registered workspace root are served, re-checked on
 *    EVERY request after realpath (symlink-escape safe). Only whitelisted
 *    media extensions pass.
 *  - Media tokens are a SECOND, file-scoped credential: `HMAC-SHA256(secret,
 *    "<plugin-id>|<realpath>")` in base64url. The secret is generated once
 *    (0600, outside the workspace) and re-read on mtime change, so rotating it
 *    revokes every outstanding token with no restart. A token grants access to
 *    EXACTLY the file it was minted for (path is inside the HMAC input) and
 *    never weakens the fence for any other request. The media route accepts a
 *    valid token IN LIEU OF the trust fence, which is what lets a cookieless
 *    system media player stream through an auth gate.
 * @module dsh-media-inline-preview
 */

const FILES_ROUTE = "/plugins/dsh-media-inline-preview/files";
const MEDIA_ROUTE = "/plugins/dsh-media-inline-preview/media";
const TOKEN_ROUTE = "/plugins/dsh-media-inline-preview/token";
const AUTH_ROUTE = "/plugins/dsh-media-inline-preview/__media_auth";
const TOKEN_PARAM = "dsh_tok";
const TOKEN_PLUGIN_ID = "dsh-media-inline-preview";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp", ".svg", ".ico", ".tga"]);
const VIDEO_NATIVE_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv", ".ts", ".3gp"]);
const VIDEO_TRANSCODE_EXTS = new Set([".mkv", ".avi", ".flv", ".wmv", ".mpg", ".mpeg"]);
const AUDIO_NATIVE_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".flac", ".opus", ".weba", ".webm"]);
const AUDIO_TRANSCODE_EXTS = new Set([".wma", ".mid", ".midi", ".m4b"]);

const IMAGE_MAX_BYTES = 128 * 1024 * 1024; // 128 MiB (whole-read route)
const MEDIA_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB (streaming route)

const CACHE_DIR = process.env.DSH_MEDIA_CACHE_DIR ?? join(homedir(), ".dsh", "media-cache");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // prune transcoded caches after 7 days
const TRANSCODE_TIMEOUT_MS = 10 * 60 * 1000;

// File-scoped media token (B″): a per-file HMAC credential that lets a
// cookieless client (the Android system media pipeline / stagefright) pass an
// auth gate. The secret lives OUTSIDE the workspace so it is never servable
// via the media route and never lands in the git backup. Env overrides keep
// tests and exotic deployments hermetic.
const TOKEN_SECRET_DIR = process.env.DSH_MEDIA_TOKEN_DIR ?? join(homedir(), ".local", "dsh-media-inline-preview");
const TOKEN_SECRET_FILE = process.env.DSH_MEDIA_TOKEN_SECRET_FILE ?? join(TOKEN_SECRET_DIR, "token-secret");
const TOKEN_SECRET_BYTES = 32;
const AUTH_GATE_URL = process.env.DSH_AUTH_GATE_URL ?? "http://127.0.0.1:18080/auth";

const CONTENT_TYPES = {
  // images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".tga": "image/x-tga",
  // video
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".ogv": "video/ogg",
  ".ts": "video/mp2t",
  ".3gp": "video/3gpp",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".wmv": "video/x-ms-wmv",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  // audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
  ".opus": "audio/opus",
  ".weba": "audio/webm",
  ".wma": "audio/x-ms-wma",
  ".mid": "audio/midi",
  ".midi": "audio/midi",
  ".m4b": "audio/mp4"
};

/** The unified fence section injected into every assembled system prompt. */
const MEDIA_SECTION_TEXT = `You can display local IMAGE / VIDEO / AUDIO files INLINE inside your reply by emitting fenced blocks with the language tags \`img\` / \`video\` / \`audio\`, each containing a JSON spec. The chat renders the media right in the message — images as cards (single click opens a fullscreen lightbox with zoom/pan), video/audio as native players (scrubbing, fullscreen, mobile-friendly).

\`\`\`img
{"path":"absolute-or-workspace-relative/path/to/image.png","label":"可选标题"}
\`\`\`
\`\`\`video
{"path":"absolute-or-workspace-relative/path/to/video.mp4","label":"可选标题"}
\`\`\`
\`\`\`audio
{"path":"absolute-or-workspace-relative/path/to/music.mp3","label":"可选标题"}
\`\`\`

Spec fields:
- path: required — a local media file, absolute or relative to the session workspace.
  - Image: .png/.jpg/.jpeg/.webp/.gif/.avif/.bmp/.svg/.ico/.tga (tga auto-converted).
  - Video: .mp4/.webm/.mov/.m4v/.ogv/.ts/.3gp play natively; .mkv/.avi/.flv/.wmv/.mpg auto-transcoded if the browser cannot play them.
  - Audio: .mp3/.wav/.m4a/.aac/.ogg/.flac/.opus play natively; .wma/.mid auto-transcoded.
- label: optional — accepted for compatibility with hand-written fences, but the UI caption/title always shows only the file name (user preference). You do not need to supply it.
- Multiple images: use {"images":[{"path":"...","label":"..."}, ...]} to render a grid.
- url: optional — a full http(s) URL instead of a local path (images).

ACTIVE TRIGGERING — you initiate, never wait to be asked:
- Whenever an image/video/audio file is present or produced in the session — you generated it via an API, downloaded it, converted it (e.g. video→MP3), the user mentioned a path, a screenshot was taken, or one appeared in the workspace — call the matching tool (\`img_serve\` / \`media_serve\`) with the path FIRST, then emit the matching fence in the same reply. Do not ask "want me to show it?" — just show it.
- The user may of course also ask explicitly ("展示图片", "播放这个视频", "把音乐放出来", "show me"); explicit requests are answered the same way.

Rules:
- Call the tool first; it validates the file. Only emit the fence after it succeeds.
- If the tool reports an error (missing file, unsupported extension), report it to the user; do not emit a fence.
- One media item per fence (except the images grid). Do not render the same file twice in one conversation unless the file changed or the user asks again — deduplicate by path.`;

// ---------------------------------------------------------------------------
// Path resolution (multi-root; containment-checked, symlink-safe)
// ---------------------------------------------------------------------------

/** Whether a normalized absolute path stays inside one of the roots. */
function withinAnyRoot(normalized, normalizedRoots) {
  for (const rootNorm of normalizedRoots) {
    if (rootNorm === sep || rootNorm === "/" || normalized === rootNorm || normalized.startsWith(rootNorm + sep) || normalized.startsWith(rootNorm + "/")) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve a user-supplied media path against the allowed roots. Absolute
 * paths are used as-is; relative paths are tried under EVERY root and the
 * first existing match wins. Returns null when the path escapes every root.
 */
function resolveLocalPath(raw, roots) {
  const normalizedRoots = roots.map((r) => normalize(r));
  if (isAbsolute(raw)) {
    const normalized = normalize(raw);
    return withinAnyRoot(normalized, normalizedRoots) ? normalized : null;
  }
  for (const rootNorm of normalizedRoots) {
    const candidate = normalize(resolve(rootNorm, raw));
    if (!withinAnyRoot(candidate, normalizedRoots)) continue; // escapes this root
    if (existsSync(candidate)) return candidate;
  }
  // File missing: return the containment-checked candidate under the first
  // root so the caller can report "not found"; escapes resolve to null.
  const fallback = normalize(resolve(normalizedRoots[0] ?? "", raw));
  return withinAnyRoot(fallback, normalizedRoots) ? fallback : null;
}

// ---------------------------------------------------------------------------
// Trust fence (better-sidebar pattern)
// ---------------------------------------------------------------------------

function headerValue(headers, name) {
  const value = headers[name];
  return typeof value === "string" ? value : void 0;
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return void 0;
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === void 0) return false;
    const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
    const canonical = port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
    return canonical === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
  });
}

/**
 * Same browser-trust fence the /api gateway and /sidebar routes apply:
 * Host is loopback or deployment-trusted, not cross-site, and a present
 * Origin matches the request Host.
 */
function isTrustedMediaRequest(request, trustedHosts) {
  const host = headerValue(request.headers, "host");
  if (host === void 0) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === void 0) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (headerValue(request.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = headerValue(request.headers, "origin");
  if (origin === void 0) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// TGA (Truevision Targa) decoding + minimal PNG encoding.
// Browsers cannot render .tga natively, so the file route transcodes TGA to
// PNG on the fly. Both halves use only Node builtins (node:zlib), keeping the
// plugin dependency-free. (Ported verbatim from the local img-preview copy.)
// ---------------------------------------------------------------------------

const MAX_TGA_PIXELS = 50_000_000; // decode safety ceiling (50 MP)

/**
 * Decode a TGA buffer into top-left-origin, left-to-right RGBA pixels.
 * Supports image types 1/2/3 (uncompressed color-mapped / true-color /
 * grayscale), 9/10/11 (RLE variants), pixel depths 8/16/24/32, and both
 * origin conventions (descriptor bits 4/5).
 * @param {Buffer} buffer - raw TGA file bytes.
 * @returns {{ rgba: Buffer, width: number, height: number }}
 */
function decodeTga(buffer) {
  if (buffer.length < 18) throw new Error("TGA: header too short");
  const idLength = buffer[0];
  const colorMapType = buffer[1];
  const imageType = buffer[2];
  const cmFirst = buffer[3] | (buffer[4] << 8);
  const cmLength = buffer[5] | (buffer[6] << 8);
  const cmEntryBits = buffer[7];
  const width = buffer[12] | (buffer[13] << 8);
  const height = buffer[14] | (buffer[15] << 8);
  const pixelDepth = buffer[16];
  const descriptor = buffer[17];
  if (width === 0 || height === 0) throw new Error("TGA: zero dimension");
  if (width * height > MAX_TGA_PIXELS) throw new Error("TGA: image too large");

  let offset = 18 + idLength;

  // Color map (palette): entries are 16/24/32-bit BGR(A).
  const palette = [];
  if (colorMapType === 1) {
    const entryBytes = Math.max(1, Math.ceil(cmEntryBits / 8));
    if (offset + cmLength * entryBytes > buffer.length) throw new Error("TGA: truncated color map");
    for (let i = 0; i < cmLength; i++) {
      palette.push(readTgaPixel(buffer, offset + i * entryBytes, cmEntryBits >= 24 ? cmEntryBits : 16));
    }
    offset += cmLength * entryBytes;
  }

  const rle = imageType === 9 || imageType === 10 || imageType === 11;
  const colorMapped = imageType === 1 || imageType === 9;
  const grayscale = imageType === 3 || imageType === 11;
  if (imageType !== 1 && imageType !== 2 && imageType !== 3 && imageType !== 9 && imageType !== 10 && imageType !== 11) {
    throw new Error(`TGA: unsupported image type ${imageType}`);
  }

  const total = width * height;
  const raw = new Uint8Array(total * 4);
  let src = offset;
  let dst = 0;

  const bytesPerPixel = (depth) => (depth === 15 || depth === 16 ? 2 : depth === 24 ? 3 : depth === 32 ? 4 : 1);

  while (dst < total * 4) {
    let count;
    let repeat;
    if (rle) {
      if (src >= buffer.length) throw new Error("TGA: truncated RLE stream");
      const packet = buffer[src++];
      repeat = (packet & 0x80) !== 0;
      count = (packet & 0x7f) + 1;
    } else {
      count = total - dst / 4;
      repeat = false;
    }
    if (src >= buffer.length) throw new Error("TGA: truncated pixel data");
    let px;
    if (colorMapped) {
      const index = buffer[src];
      const entry = palette[index];
      if (entry === undefined) throw new Error(`TGA: palette index ${index} out of range`);
      px = entry;
      src += 1;
    } else if (grayscale) {
      const v = buffer[src];
      px = [v, v, v, 255];
      src += 1;
    } else {
      px = readTgaPixel(buffer, src, pixelDepth);
      src += bytesPerPixel(pixelDepth);
    }
    if (repeat) {
      // RLE run: one pixel repeated `count` times.
      for (let i = 0; i < count && dst < total * 4; i++) {
        raw[dst++] = px[0];
        raw[dst++] = px[1];
        raw[dst++] = px[2];
        raw[dst++] = px[3];
      }
    } else {
      // Raw packet: `count` literal pixels.
      for (let i = 0; i < count && dst < total * 4; i++) {
        raw[dst++] = px[0];
        raw[dst++] = px[1];
        raw[dst++] = px[2];
        raw[dst++] = px[3];
        if (i + 1 < count) {
          if (colorMapped) {
            const index = buffer[src];
            const entry = palette[index];
            if (entry === undefined) throw new Error(`TGA: palette index ${index} out of range`);
            px = entry;
            src += 1;
          } else if (grayscale) {
            const v = buffer[src];
            px = [v, v, v, 255];
            src += 1;
          } else {
            px = readTgaPixel(buffer, src, pixelDepth);
            src += bytesPerPixel(pixelDepth);
          }
        }
      }
    }
  }

  // Normalize orientation to top-left origin, left-to-right.
  const topDown = (descriptor & 0x20) !== 0;
  const rightToLeft = (descriptor & 0x10) !== 0;
  if (topDown && !rightToLeft) return { rgba: Buffer.from(raw), width, height };

  const out = Buffer.alloc(total * 4);
  for (let y = 0; y < height; y++) {
    const srcY = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const srcX = rightToLeft ? width - 1 - x : x;
      const si = (srcY * width + srcX) * 4;
      const di = (y * width + x) * 4;
      out[di] = raw[si];
      out[di + 1] = raw[si + 1];
      out[di + 2] = raw[si + 2];
      out[di + 3] = raw[si + 3];
    }
  }
  return { rgba: out, width, height };
}

/** Read one BGR(A)/gray pixel at `offset` with the given bit depth. */
function readTgaPixel(buffer, offset, depth) {
  switch (depth) {
    case 8: {
      const v = buffer[offset];
      return [v, v, v, 255];
    }
    case 15:
    case 16: {
      const v = buffer[offset] | (buffer[offset + 1] << 8);
      const r = (v >> 10) & 0x1f;
      const g = (v >> 5) & 0x1f;
      const b = v & 0x1f;
      const alpha = (v & 0x8000) !== 0 ? 255 : 0;
      return [r << 3 | r >> 2, g << 3 | g >> 2, b << 3 | b >> 2, alpha];
    }
    case 24:
      return [buffer[offset + 2], buffer[offset + 1], buffer[offset], 255];
    case 32:
      return [buffer[offset + 2], buffer[offset + 1], buffer[offset], buffer[offset + 3]];
    default:
      throw new Error(`TGA: unsupported pixel depth ${depth}`);
  }
}

// --- minimal PNG encoder (RGBA, 8-bit, filter 0) ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Encode top-left-origin RGBA pixels into a PNG buffer (color type 6).
 * @param {Buffer} rgba - width*height*4 bytes.
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} PNG file bytes.
 */
function encodePng(rgba, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// ffmpeg transcode fallback (cached, content-addressed)
// ---------------------------------------------------------------------------

let ffmpegChecked = false;
let ffmpegAvailable = false;
function checkFfmpeg() {
  if (!ffmpegChecked) {
    try {
      const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 5000 });
      ffmpegAvailable = probe.status === 0;
    } catch {
      ffmpegAvailable = false;
    }
    ffmpegChecked = true;
  }
  return ffmpegAvailable;
}

function cacheKeyFor(absPath, size, mtimeMs) {
  return createHash("sha256").update(`${absPath}|${size}|${mtimeMs}`).digest("hex");
}

function pruneOldCaches() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const now = Date.now();
    for (const name of readdirSync(CACHE_DIR)) {
      const full = join(CACHE_DIR, name);
      try {
        const st = statSync(full);
        if (now - st.mtimeMs > CACHE_TTL_MS) rmSync(full, { force: true });
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* best effort */
  }
}

/** In-flight transcode jobs, keyed by source path (set synchronously before
 * any await so concurrent requests share one job — no double-encode race). */
const transcoding = new Map();

/**
 * Ensure a browser-playable mp4 exists for `source`: resolves to the cached
 * transcoded file path, or null when ffmpeg is missing / the file is too big.
 */
function transcodeToMp4(source, ext) {
  const inflight = transcoding.get(source);
  if (inflight !== void 0) return inflight;
  const job = (async () => {
    if (!checkFfmpeg()) return null;
    const st = await stat(source);
    if (st.size > MEDIA_MAX_BYTES) return null;
    const key = cacheKeyFor(source, st.size, st.mtimeMs);
    const outPath = join(CACHE_DIR, key + (ext.startsWith("video") ? ".mp4" : ".m4a"));
    if (existsSync(outPath)) return outPath;
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmpOut = `${outPath}.part`;
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source];
    if (ext.startsWith("video")) {
      args.push("-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-f", "mp4");
    } else {
      args.push("-vn", "-c:a", "aac", "-b:a", "192k", "-f", "mp4");
    }
    args.push(tmpOut);
    const result = await new Promise((resolvePromise) => {
      const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderrTail = "";
      child.stderr.on("data", (chunk) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-4000);
      });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, TRANSCODE_TIMEOUT_MS);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolvePromise({ code: -1, stderr: String(err?.message ?? err) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolvePromise({ code, stderr: stderrTail });
      });
    });
    if (result.code !== 0) {
      rmSync(tmpOut, { force: true });
      throw new Error(`ffmpeg exited ${result.code}: ${result.stderr.slice(-500)}`);
    }
    // Atomic-ish rename into the cache slot.
    renameSync(tmpOut, outPath);
    return outPath;
  })();
  transcoding.set(source, job);
  void job.then(
    () => transcoding.delete(source),
    () => transcoding.delete(source)
  );
  return job;
}

// ---------------------------------------------------------------------------
// Media tokens (file-scoped HMAC credentials, scheme B″)
//
// The Android system media pipeline (stagefright) fetches media with its own
// cookie-less HTTP stack, so it can never pass a cookie-based auth gate. The
// only channel a web page can steer into that pipeline is the URL itself, so
// the credential rides as `?dsh_tok=<HMAC>` on the media URL. The token is
// minted by an authenticated caller (the page stack) via the /token route and
// bound to ONE file: the realpath is part of the HMAC input. Verification is
// a pure recompute — stateless, permanent until the secret rotates.
// ---------------------------------------------------------------------------

/**
 * Load the HMAC secret (hex string). Generated once on first use (0600 file,
 * 0700 dir) and cached against the file mtime, so overwriting the file
 * (rotation) takes effect on the very next mint/verify — no restart.
 */
let tokenSecretCache = null; // { mtimeMs, value }
function tokenSecret() {
  if (tokenSecretCache !== null) {
    try {
      if (statSync(TOKEN_SECRET_FILE).mtimeMs === tokenSecretCache.mtimeMs) {
        return tokenSecretCache.value;
      }
    } catch {
      /* file vanished — regenerate below */
    }
  }
  try {
    const st = statSync(TOKEN_SECRET_FILE);
    const value = readFileSync(TOKEN_SECRET_FILE, "utf8").trim();
    if (value === "") throw new Error("empty secret file");
    tokenSecretCache = { mtimeMs: st.mtimeMs, value };
    return value;
  } catch {
    const value = randomBytes(TOKEN_SECRET_BYTES).toString("hex");
    try {
      mkdirSync(dirname(TOKEN_SECRET_FILE), { recursive: true, mode: 0o700 });
    } catch {
      /* dir may already exist with other perms */
    }
    writeFileSync(TOKEN_SECRET_FILE, `${value}\n`, { mode: 0o600 });
    tokenSecretCache = { mtimeMs: statSync(TOKEN_SECRET_FILE).mtimeMs, value };
    return value;
  }
}

/** Mint the token for a realpath: base64url(HMAC-SHA256(secret, "<plugin-id>|<realpath>")). */
function mintToken(secret, realPath) {
  return createHmac("sha256", secret).update(`${TOKEN_PLUGIN_ID}|${realPath}`).digest("base64url");
}

/** Constant-time check of a token against a realpath (re-reads the secret: rotation-aware). */
function verifyTokenForPath(realPath, tok) {
  if (typeof tok !== "string" || tok === "") return false;
  const expected = mintToken(tokenSecret(), realPath);
  const a = Buffer.from(tok);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Resolve a media-route request pathname (already a URL pathname, i.e. the
 * query stripped) to its contained realpath, or null on any failure
 * (bad prefix, bad percent-encoding, escape, missing file, symlink escape).
 */
function resolveMediaReal(pathname, getRoots) {
  if (typeof pathname !== "string" || !pathname.startsWith(`${MEDIA_ROUTE}/`)) return null;
  const rel = pathname.slice(MEDIA_ROUTE.length + 1);
  if (rel === "") return null;
  let target;
  try {
    target = rel.split("/").map((seg) => decodeURIComponent(seg)).join("/");
  } catch {
    return null;
  }
  target = normalize(target);
  if (resolveLocalPath(target, getRoots()) === null) return null;
  let real;
  try {
    real = realpathSync(target);
  } catch {
    return null;
  }
  if (resolveLocalPath(real, getRoots().map(realpathOf)) === null) return null;
  return real;
}

/** True when this URL carries a `dsh_tok` that verifies for its own file. */
function verifyRequestToken(url, getRoots) {
  const tok = url.searchParams.get(TOKEN_PARAM);
  if (tok === null || tok === "") return false;
  const real = resolveMediaReal(url.pathname, getRoots);
  if (real === null) return false;
  return verifyTokenForPath(real, tok);
}

/**
 * Token issuer: GET TOKEN_ROUTE?path=<abs> → {ok, tok, path}.
 * Trust-fenced like the media routes; path containment + realpath + isFile
 * checked before minting. Returns only for regular files inside a root.
 */
function createTokenIssuerHandler(getTrustedHosts, getRoots) {
  return async (req, res) => {
    const send = (status, body, type = "application/json; charset=utf-8") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-cache" });
      res.end(body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    if (!isTrustedMediaRequest(req, getTrustedHosts())) {
      send(403, "dsh-media-inline-preview: request authority not trusted", "text/plain; charset=utf-8");
      return;
    }
    let url;
    try {
      url = new URL(req.url ?? "/", "http://x");
    } catch {
      send(400, "bad request");
      return;
    }
    if (url.pathname !== TOKEN_ROUTE) {
      send(404, "not found");
      return;
    }
    const raw = url.searchParams.get("path");
    if (typeof raw !== "string" || raw === "") {
      send(400, "dsh-media-inline-preview: missing ?path=", "text/plain; charset=utf-8");
      return;
    }
    const target = normalize(raw);
    if (resolveLocalPath(target, getRoots()) === null) {
      send(403, "dsh-media-inline-preview: path outside allowed workspace roots", "text/plain; charset=utf-8");
      return;
    }
    let real;
    try {
      real = realpathSync(target);
    } catch {
      send(404, "not found");
      return;
    }
    if (resolveLocalPath(real, getRoots().map(realpathOf)) === null) {
      send(403, "dsh-media-inline-preview: realpath outside allowed workspace roots", "text/plain; charset=utf-8");
      return;
    }
    let st;
    try {
      st = statSync(real);
    } catch {
      send(404, "not found");
      return;
    }
    if (!st.isFile()) {
      send(404, "not found");
      return;
    }
    send(200, JSON.stringify({ ok: true, tok: mintToken(tokenSecret(), real), path: real }));
  };
}

/**
 * Auth verifier for an nginx `auth_request` subrequest (nginx sets
 * X-Original-URI to the original request URI). 200 = let through:
 *  - original URI carries a valid `dsh_tok` for its own file, OR
 *  - no token and the request Cookie is accepted by the cookie gate
 *    (AUTH_GATE_URL) — the pre-token behavior, kept for page-stack clients.
 * 401 in all other cases (nginx then 302s to the login page as before).
 */
function createAuthVerifierHandler(getTrustedHosts, getRoots, authGateUrl = AUTH_GATE_URL) {
  return async (req, res) => {
    const finish = (status) => {
      res.writeHead(status);
      res.end();
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    // Subrequests arrive from the reverse proxy (loopback Host → trusted).
    if (!isTrustedMediaRequest(req, getTrustedHosts())) {
      finish(401);
      return;
    }
    let original;
    try {
      original = new URL(headerValue(req.headers, "x-original-uri") ?? req.url ?? "/", "http://x");
    } catch {
      finish(401);
      return;
    }
    const tok = original.searchParams.get(TOKEN_PARAM);
    if (tok !== null && tok !== "") {
      const real = resolveMediaReal(original.pathname, getRoots);
      if (real !== null && verifyTokenForPath(real, tok)) {
        finish(200);
        return;
      }
      finish(401);
      return;
    }
    const cookie = headerValue(req.headers, "cookie");
    if (cookie === undefined) {
      finish(401);
      return;
    }
    try {
      const gate = await fetch(new URL(authGateUrl), {
        method: "GET",
        headers: { cookie }
      });
      finish(gate.status === 200 ? 200 : 401);
    } catch {
      finish(401);
    }
  };
}

// ---------------------------------------------------------------------------
// File routes
// ---------------------------------------------------------------------------

function extOf(path) {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i).toLowerCase();
}

function kindForExt(ext) {
  ext = ext.toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "img";
  if (VIDEO_NATIVE_EXTS.has(ext) || VIDEO_TRANSCODE_EXTS.has(ext)) return "video";
  if (AUDIO_NATIVE_EXTS.has(ext) || AUDIO_TRANSCODE_EXTS.has(ext)) return "audio";
  return null;
}

/** Weak entity tag for a file: size + mtime — cheap, changes on edit. */
function etagFor(size, mtimeMs) {
  return `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

/** True when the request carries an If-None-Match matching our etag → 304. */
function isNotModified(req, etag) {
  const inm = typeof req.headers["if-none-match"] === "string" ? req.headers["if-none-match"].trim() : "";
  return inm !== "" && inm === etag;
}

/** Stream `file` to `res`, honoring a single `bytes=` Range request. */
function streamFile(req, res, file, contentType) {
  const st = statSync(file);
  const size = st.size;
  const etag = etagFor(size, st.mtimeMs);
  // Conditional GET: browser already has this exact version → 304, no body.
  // (Pairs with `cache-control: no-cache`: the client revalidates each time
  // but transfers zero bytes while the file is unchanged.)
  if (isNotModified(req, etag)) {
    res.writeHead(304, {
      etag,
      "cache-control": "no-cache",
      "accept-ranges": "bytes"
    });
    res.end();
    return;
  }
  const range = req.headers.range;
  if (range !== void 0) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match !== null) {
      const start = match[1] === "" ? 0 : Number(match[1]);
      const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size) {
        res.writeHead(206, {
          "content-type": contentType,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${size}`,
          "accept-ranges": "bytes",
          "cache-control": "no-cache",
          etag
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes" });
    res.end();
    return;
  }
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": String(size),
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
    etag
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

/**
 * Shared request preamble for both routes: trust fence, URL parse, rel
 * extraction for `routePrefix`, path decode (whole-string for the files
 * route, per-segment for the media route), containment + realpath checks.
 * Resolves to { real, ext, url } or throws { status, message, headers? }.
 */
async function prepareFileRequest(req, routePrefix, getTrustedHosts, getRoots, perSegment, allowToken = false) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    throw { status: 405, headers: { allow: "GET, HEAD" } };
  }
  let url;
  try {
    url = new URL(req.url ?? "/", "http://x");
  } catch {
    throw { status: 400 };
  }
  // Trust fence FIRST — before touching the filesystem at all. A valid
  // file-scoped media token is an accepted alternative credential (allowToken
  // routes only): it is the channel a cookieless client such as the Android
  // system media pipeline can carry, and it never weakens the fence for any
  // other request (the token is bound to this exact file's realpath).
  const trusted = isTrustedMediaRequest(req, getTrustedHosts());
  if (!trusted && !(allowToken && verifyRequestToken(url, getRoots))) {
    throw { status: 403, message: "request authority not trusted" };
  }
  const rel = url.pathname.startsWith(`${routePrefix}/`) ? url.pathname.slice(routePrefix.length + 1) : null;
  if (rel === null || rel === "") {
    throw { status: 404 };
  }
  let target;
  try {
    target = perSegment
      ? rel.split("/").map((seg) => decodeURIComponent(seg)).join("/")
      : decodeURIComponent(rel);
  } catch {
    throw { status: 400 };
  }
  target = normalize(target);
  // Re-check workspace containment on every request.
  if (resolveLocalPath(target, getRoots()) === null) {
    throw { status: 403, message: "path outside allowed workspace roots" };
  }
  let real;
  try {
    real = realpathSync(target);
  } catch {
    throw { status: 404 };
  }
  if (resolveLocalPath(real, getRoots().map(realpathOf)) === null) {
    throw { status: 403, message: "realpath outside allowed workspace roots" };
  }
  const ext = extOf(real);
  return { real, ext, url };
}

/** In-flight TGA→PNG jobs, keyed by source (same share pattern as
 * transcoding): concurrent requests for the same TGA decode once. */
const tgaPngJobs = new Map();

/**
 * Ensure a PNG version of `real` (a .tga) exists. The decoded+encoded PNG is
 * cached on disk under CACHE_DIR (content-addressed by source size+mtime, so
 * an edited TGA re-transcodes automatically) and returned as a buffer.
 */
function pngForTga(real, size, mtimeMs) {
  const key = cacheKeyFor(real, size, mtimeMs);
  const inflight = tgaPngJobs.get(key);
  if (inflight !== void 0) return inflight;
  const job = (async () => {
    const outPath = join(CACHE_DIR, `tga-${key}.png`);
    if (existsSync(outPath)) return readFile(outPath);
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmpOut = `${outPath}.part`;
    const raw = await readFile(real);
    const { rgba, width, height } = decodeTga(raw);
    const png = encodePng(rgba, width, height);
    // Atomic-ish publish so concurrent losers never serve a partial file.
    writeFileSync(tmpOut, png);
    renameSync(tmpOut, outPath);
    return png;
  })();
  tgaPngJobs.set(key, job);
  void job.then(
    () => tgaPngJobs.delete(key),
    () => tgaPngJobs.delete(key)
  );
  return job;
}

/** Image route: whole-read (128 MiB), TGA→PNG (disk-cached), ACAO * for embedding. */
function createImageHandler(getTrustedHosts, getRoots) {
  return async (req, res) => {
    let ctx;
    try {
      ctx = await prepareFileRequest(req, FILES_ROUTE, getTrustedHosts, getRoots, false);
    } catch (err) {
      res.writeHead(err.status ?? 500, { "content-type": "text/plain; charset=utf-8", ...(err.headers ?? {}) });
      res.end(err.message ?? "");
      return;
    }
    const { real, ext } = ctx;
    const contentType = CONTENT_TYPES[ext];
    if (contentType === undefined) {
      res.writeHead(415, { "content-type": "text/plain; charset=utf-8" });
      res.end(`dsh-media-inline-preview: unsupported image extension "${ext}"`);
      return;
    }
    let info;
    try {
      info = await stat(real);
      if (!info.isFile() || info.size > IMAGE_MAX_BYTES) {
        res.writeHead(413);
        res.end();
        return;
      }
    } catch {
      res.writeHead(500);
      res.end();
      return;
    }
    // Conditional GET: unchanged file → 304, zero bytes re-sent.
    const etag = etagFor(info.size, info.mtimeMs);
    if (isNotModified(req, etag)) {
      res.writeHead(304, { etag, "cache-control": "no-cache" });
      res.end();
      return;
    }
    let body;
    let finalType = contentType;
    try {
      if (ext === ".tga") {
        // TGA is not renderable by browsers — transcode to PNG (disk-cached).
        body = await pngForTga(real, info.size, info.mtimeMs);
        finalType = "image/png";
      } else {
        body = await readFile(real);
      }
    } catch (error) {
      const msg = ext === ".tga" ? `TGA decode failed: ${String(error?.message ?? error)}` : "";
      res.writeHead(ext === ".tga" ? 400 : 500, { "content-type": "text/plain; charset=utf-8" });
      res.end(msg);
      return;
    }
    res.writeHead(200, {
      "content-type": finalType,
      "content-length": String(body.length),
      "cache-control": "no-cache",
      etag,
      "access-control-allow-origin": "*"
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}

/** Media route: streaming with Range; `?tc=1` triggers the ffmpeg fallback. */
function createMediaHandler(getTrustedHosts, getRoots) {
  return async (req, res) => {
    let ctx;
    try {
      // allowToken=true: a valid file-scoped token is accepted in lieu of the
      // trust fence (cookieless system media pipeline, scheme B″).
      ctx = await prepareFileRequest(req, MEDIA_ROUTE, getTrustedHosts, getRoots, true, true);
    } catch (err) {
      res.writeHead(err.status ?? 500, { "content-type": "text/plain; charset=utf-8", ...(err.headers ?? {}) });
      res.end(err.message ?? "");
      return;
    }
    const { real, ext, url } = ctx;
    const kind = kindForExt(ext);
    if (kind !== "video" && kind !== "audio") {
      res.writeHead(415, { "content-type": "text/plain; charset=utf-8" });
      res.end(`dsh-media-inline-preview: unsupported media extension "${ext}"`);
      return;
    }
    let st;
    try {
      st = await stat(real);
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!st.isFile() || st.size > MEDIA_MAX_BYTES) {
      res.writeHead(413);
      res.end();
      return;
    }
    // ?tc=1 → transcode fallback (browsers cannot play the container).
    if (url.searchParams.get("tc") === "1") {
      if (!(VIDEO_TRANSCODE_EXTS.has(ext) || AUDIO_TRANSCODE_EXTS.has(ext))) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("dsh-media-inline-preview: file kind is natively playable, no transcode needed");
        return;
      }
      try {
        const outPath = await transcodeToMp4(real, kind);
        if (outPath === null || !existsSync(outPath)) {
          res.writeHead(501, { "content-type": "text/plain; charset=utf-8" });
          res.end("dsh-media-inline-preview: ffmpeg unavailable — cannot transcode");
          return;
        }
        streamFile(req, res, outPath, outPath.endsWith(".m4a") ? "audio/mp4" : "video/mp4");
        return;
      } catch (error) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`dsh-media-inline-preview: transcode failed: ${String(error?.message ?? error).slice(0, 300)}`);
        return;
      }
    }
    streamFile(req, res, real, CONTENT_TYPES[ext] ?? "application/octet-stream");
  };
}

/** realpath of a root, falling back to its normalized form when absent. */
function realpathOf(p) {
  try {
    return realpathSync(p);
  } catch {
    return normalize(p);
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Encode an absolute path into a servable URL under one of the routes. */
function urlFor(route, absPath) {
  const forward = absPath.split(sep === "\\" ? "\\" : "/").map((seg) => encodeURIComponent(seg)).join("/");
  return `${route}/${forward}`;
}

/** The `img_serve` tool: validate an image path and confirm it is servable. */
function createImgServeTool(rootProvider) {
  return {
    name: "img_serve",
    description:
      "Prepare a local image file for inline display in the chat: validates the path, verifies the extension (.png/.jpg/.jpeg/.webp/.gif/.avif/.bmp/.svg/.ico/.tga), and confirms the file is servable to the browser. Call this BEFORE emitting a ```img fence. Returns the confirmed absolute path and the served URL.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the image file. Absolute, or relative to the session workspace. Must end in .png, .jpg, .jpeg, .webp, .gif, .avif, .bmp, .svg, .ico or .tga."
        }
      },
      required: ["path"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          path: { type: "string" },
          url: { type: "string" },
          error: { type: "string" }
        },
        required: ["ok"],
        additionalProperties: false
      },
      render(args, value) {
        return [
          {
            type: "text",
            text: value.ok
              ? `img_serve: ✅ ${value.path} is ready — emit a \`\`\`img fence with {"path":"${value.path.replace(/\\/g, "/")}"} to display it inline.`
              : `img_serve: ❌ ${value.error ?? "cannot serve this file"}`
          }
        ];
      },
      presentationMeta(args, value) {
        return value;
      }
    },
    async execute(args, exec) {
      const raw = typeof args?.path === "string" ? args.path.trim() : "";
      if (raw === "") {
        return { ok: false, error: "image path is required" };
      }
      // Prefer the calling session's cwd (its workspace); fall back to global roots.
      const sessionCwd = exec?.agent?.session?.header?.cwd;
      const roots = sessionCwd ? [sessionCwd, ...rootProvider()] : rootProvider();
      const resolved = resolveLocalPath(raw, roots);
      if (resolved === null) {
        return { ok: false, error: "path escapes every allowed workspace root" };
      }
      if (!existsSync(resolved)) {
        return { ok: false, error: `file not found: ${raw}` };
      }
      const ext = extOf(resolved);
      if (!IMAGE_EXTS.has(ext)) {
        return { ok: false, error: `unsupported image extension "${ext}" — use .png, .jpg, .jpeg, .webp, .gif, .avif, .bmp, .svg, .ico or .tga` };
      }
      return { ok: true, path: resolved, url: urlFor(FILES_ROUTE, resolved) };
    }
  };
}

/** The `media_serve` tool: validate a video/audio path and confirm it is servable. */
function createMediaServeTool(rootProvider) {
  return {
    name: "media_serve",
    description:
      "Prepare a local video/audio file for inline playback in the chat: validates the path against the session workspace, verifies the extension (video: mp4/webm/mov/m4v/ogv/ts/3gp/mkv/avi/flv/wmv/mpg/mpeg; audio: mp3/wav/m4a/aac/ogg/oga/flac/opus/weba/wma/mid/midi/m4b), and confirms the file is servable. Call this BEFORE emitting a ```video or ```audio fence. Returns the confirmed absolute path, its kind (video|audio), and the served URL.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the media file. Absolute, or relative to the session workspace."
        }
      },
      required: ["path"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          kind: { type: "string" },
          path: { type: "string" },
          url: { type: "string" },
          error: { type: "string" }
        },
        required: ["ok"],
        additionalProperties: false
      },
      render(args, value) {
        return [
          {
            type: "text",
            text: value.ok
              ? `media_serve: ✅ ${value.path} is ready (kind=${value.kind}) — emit a \`\`\`${value.kind} fence with {"path":"${value.path.replace(/\\/g, "/")}"} to play it inline in the chat.`
              : `media_serve: ❌ ${value.error ?? "cannot serve this file"}`
          }
        ];
      },
      presentationMeta(args, value) {
        return value;
      }
    },
    async execute(args, exec) {
      const raw = typeof args?.path === "string" ? args.path.trim() : "";
      if (raw === "") {
        return { ok: false, error: "media path is required" };
      }
      const sessionCwd = exec?.agent?.session?.header?.cwd;
      const roots = sessionCwd ? [sessionCwd, ...rootProvider()] : rootProvider();
      const resolved = resolveLocalPath(raw, roots);
      if (resolved === null) {
        return { ok: false, error: "path escapes every allowed workspace root" };
      }
      if (!existsSync(resolved)) {
        return { ok: false, error: `file not found: ${raw}` };
      }
      const ext = extOf(resolved);
      const kind = kindForExt(ext);
      if (kind !== "video" && kind !== "audio") {
        return { ok: false, error: `unsupported media extension "${ext}" — video: ${[...VIDEO_NATIVE_EXTS, ...VIDEO_TRANSCODE_EXTS].join(" ")}; audio: ${[...AUDIO_NATIVE_EXTS, ...AUDIO_TRANSCODE_EXTS].join(" ")}` };
      }
      return { ok: true, kind, path: resolved, url: urlFor(MEDIA_ROUTE, resolved) };
    }
  };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

// webServer is injected (not just reflect.get'd) because this plugin's apply
// is deferred until `webRuntime` is provided — which happens AFTER the
// webServer service event has already fired, so the event-based registration
// path would miss it. Injection guarantees ctx.webServer exists at apply time.
const inject = ["systemPrompt", "webServer", "webRuntime"];

function apply(ctx) {
  /** All allowed roots: every registered workspace + env/cwd fallback, deduped. */
  const rootProvider = () => {
    const roots = [];
    const seen = new Set();
    const add = (p) => {
      if (typeof p !== "string" || p === "") return;
      const norm = normalize(p);
      if (!seen.has(norm)) {
        seen.add(norm);
        roots.push(norm);
      }
    };
    try {
      const registry = ctx.workspaceRegistry ?? ctx.reflect.get("workspaceRegistry", false);
      const workspaces = registry?.list?.() ?? [];
      for (const ws of workspaces) add(ws.path);
    } catch {
      /* fall through */
    }
    add(process.env.DSH_WORKSPACE);
    add(process.cwd());
    return roots.length > 0 ? roots : [process.cwd()];
  };

  /** Deployment-trusted non-loopback authorities, read live per request. */
  const trustedHostsProvider = () => {
    try {
      const rt = ctx.webRuntime ?? ctx.reflect.get("webRuntime", false);
      const hosts = rt?.trustedHosts;
      if (Array.isArray(hosts)) return hosts.filter((h) => typeof h === "string");
    } catch {
      /* fall through */
    }
    return [];
  };

  ctx.systemPrompt.section({
    name: "dsh-media-inline-preview:fence",
    order: 115,
    text: MEDIA_SECTION_TEXT
  });

  let toolRegistered = false;
  const tryRegisterTools = (value) => {
    if (toolRegistered) return;
    const tools = value ?? ctx.reflect.get("tools", false);
    if (tools === void 0) return;
    tools.register(createImgServeTool(rootProvider));
    tools.register(createMediaServeTool(rootProvider));
    toolRegistered = true;
  };
  tryRegisterTools(void 0);
  ctx.on("internal/service", (name, value) => {
    if (name === "tools") tryRegisterTools(value);
  });

  let routeRegistered = false;
  const tryRegisterRoutes = (value) => {
    if (routeRegistered) return;
    const webServer = value ?? ctx.webServer ?? ctx.reflect.get("webServer", false);
    if (webServer === void 0) return;
    pruneOldCaches();
    // Reap stale transcoded caches daily (best effort, detached).
    const t = setInterval(pruneOldCaches, 24 * 60 * 60 * 1000);
    if (typeof t.unref === "function") t.unref();
    // Token issuer + auth verifier (scheme B″). Registered before the file
    // routes; their prefixes are mutually non-overlapping so order is only a
    // readability choice.
    webServer.register({
      kind: "prefix",
      path: TOKEN_ROUTE,
      handler: createTokenIssuerHandler(trustedHostsProvider, rootProvider)
    });
    webServer.register({
      kind: "prefix",
      path: AUTH_ROUTE,
      handler: createAuthVerifierHandler(trustedHostsProvider, rootProvider)
    });
    webServer.register({
      kind: "prefix",
      path: FILES_ROUTE,
      handler: createImageHandler(trustedHostsProvider, rootProvider)
    });
    webServer.register({
      kind: "prefix",
      path: MEDIA_ROUTE,
      handler: createMediaHandler(trustedHostsProvider, rootProvider)
    });
    routeRegistered = true;
  };
  tryRegisterRoutes(void 0);
  ctx.on("internal/service", (name, value) => {
    if (name === "webServer") tryRegisterRoutes(value);
  });
}

export { apply, inject, decodeTga, encodePng, isTrustedMediaRequest, resolveLocalPath, kindForExt, CONTENT_TYPES, etagFor, isNotModified, streamFile, pngForTga, cacheKeyFor, CACHE_DIR };
export { IMAGE_EXTS, VIDEO_NATIVE_EXTS, VIDEO_TRANSCODE_EXTS, AUDIO_NATIVE_EXTS, AUDIO_TRANSCODE_EXTS, FILES_ROUTE, MEDIA_ROUTE };
export { TOKEN_ROUTE, AUTH_ROUTE, TOKEN_PARAM, TOKEN_PLUGIN_ID, TOKEN_SECRET_FILE, AUTH_GATE_URL, tokenSecret, mintToken, verifyTokenForPath, resolveMediaReal, verifyRequestToken, createTokenIssuerHandler, createAuthVerifierHandler, createImageHandler, createMediaHandler };
