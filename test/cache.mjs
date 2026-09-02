/**
 * Cache-layer tests: the ETag/304 conditional-GET logic and the TGA→PNG
 * disk cache. Uses a throwaway cache dir (DSH_MEDIA_CACHE_DIR) so the real
 * ~/.dsh/media-cache/ is never touched.
 *
 * Run: node test/cache.mjs
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the module at a scratch cache dir BEFORE importing it.
process.env.DSH_MEDIA_CACHE_DIR = mkdtempSync(join(tmpdir(), "dsh-mip-cache-"));
const { etagFor, isNotModified, streamFile, pngForTga, cacheKeyFor } = await import("../lib/index.js");

const scratch = process.env.DSH_MEDIA_CACHE_DIR;

// ---------------------------------------------------------------------------
// etagFor / isNotModified
// ---------------------------------------------------------------------------

// Same size+mtime → same etag (stable across calls); different size → different.
const e1 = etagFor(1024, 1_700_000_000_000);
const e2 = etagFor(1024, 1_700_000_000_000);
assert.equal(e1, e2, "etag must be deterministic for identical size+mtime");
assert.notEqual(etagFor(2048, 1_700_000_000_000), e1, "etag must change with size");
assert.notEqual(etagFor(1024, 1_700_000_000_001), e1, "etag must change with mtime");

// Weak etag format (W/"...").
assert.match(e1, /^W\/"/, "etag must be a weak validator");

// isNotModified: exact match true; empty/missing/other false; whitespace trimmed.
assert.equal(isNotModified({ headers: { "if-none-match": e1 } }, e1), true);
assert.equal(isNotModified({ headers: { "if-none-match": `  ${e1}  ` } }, e1), true);
assert.equal(isNotModified({ headers: { "if-none-match": "W/\"other\"" } }, e1), false);
assert.equal(isNotModified({ headers: {} }, e1), false);
console.log("✓ etagFor / isNotModified (deterministic weak validators)");

// ---------------------------------------------------------------------------
// streamFile: 200 with etag, 304 on matching If-None-Match, 206 Range
// ---------------------------------------------------------------------------

const file = join(scratch, "sample.mp4");
writeFileSync(file, Buffer.from("0123456789abcdef")); // 16 bytes

function capture() {
  const res = new EventEmitter();
  res.status = 0;
  res.headers = null;
  res.chunks = [];
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  res.write = (chunk) => {
    res.chunks.push(Buffer.from(chunk));
    return true;
  };
  res.end = (body) => {
    if (body !== void 0 && body !== null) res.chunks.push(Buffer.from(body));
    res.emit("finish");
  };
  return res;
}

// Plain GET → 200, etag header present, full body.
{
  const res = capture();
  streamFile({ method: "GET", headers: {} }, res, file, "video/mp4");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "video/mp4");
  assert.equal(res.headers["content-length"], "16");
  assert.ok(res.headers.etag, "200 must carry an etag");
  await new Promise((resolvePromise) => {
    res.on("finish", resolvePromise);
  });
  assert.equal(Buffer.concat(res.chunks).toString(), "0123456789abcdef");
  // sanity: the file's etag matches what etagFor computed from stat
  const st = statSync(file);
  assert.equal(res.headers.etag, etagFor(st.size, st.mtimeMs));
}
// Conditional GET with the current etag → 304, no body.
{
  const st = statSync(file);
  const etag = etagFor(st.size, st.mtimeMs);
  const res = capture();
  streamFile({ method: "GET", headers: { "if-none-match": etag } }, res, file, "video/mp4");
  assert.equal(res.status, 304);
  assert.equal(res.headers.etag, etag);
}
// Range request → 206 + Content-Range (streaming route still works).
{
  const res = capture();
  streamFile({ method: "GET", headers: { range: "bytes=2-5" } }, res, file, "video/mp4");
  assert.equal(res.status, 206);
  assert.equal(res.headers["content-range"], "bytes 2-5/16");
  assert.equal(res.headers["content-length"], "4");
}
// Invalid range → 416.
{
  const res = capture();
  streamFile({ method: "GET", headers: { range: "bytes=99-100" } }, res, file, "video/mp4");
  assert.equal(res.status, 416);
  assert.equal(res.headers["content-range"], "bytes */16");
}
console.log("✓ streamFile (200+etag / 304 conditional / 206 range / 416)");

// ---------------------------------------------------------------------------
// TGA→PNG disk cache: first call writes, second call reads the same bytes;
// a changed source (size+mtime) re-transcodes under a new key.
// ---------------------------------------------------------------------------

// Minimal 1x1 24-bit TGA (bottom-left origin).
const tga = Buffer.from([
  0, 0, 2,
  0, 0, 0, 0, 0,
  0, 0, 0, 0,
  1, 0, 1, 0,
  24, 0,
  255, 0, 0 // one red pixel (BGR)
]);
const tgaPath = join(scratch, "pixel.tga");
writeFileSync(tgaPath, tga);
const st1 = statSync(tgaPath);

const png1 = await pngForTga(tgaPath, st1.size, st1.mtimeMs);
assert.ok(Buffer.isBuffer(png1), "pngForTga must return a PNG buffer");
assert.deepEqual([...png1.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");

// A cache file must now exist under the content-addressed name.
const key = cacheKeyFor(tgaPath, st1.size, st1.mtimeMs);
const cachedPath = join(scratch, `tga-${key}.png`);
const onDisk = readFileSync(cachedPath);
assert.deepEqual([...onDisk], [...png1], "cached PNG must equal the first result");

// Second call (same source stat) → same bytes, served from cache.
const png2 = await pngForTga(tgaPath, st1.size, st1.mtimeMs);
assert.deepEqual([...png2], [...png1], "second call must be served from the cache");

// Touch the file (new mtime) → new cache key, decode happens again.
writeFileSync(tgaPath, tga); // same content, fresh mtime
const st2 = statSync(tgaPath);
const png3 = await pngForTga(tgaPath, st2.size, st2.mtimeMs);
assert.deepEqual([...png3], [...png1], "re-transcode must produce identical pixels");
assert.notEqual(cacheKeyFor(tgaPath, st2.size, st2.mtimeMs), key, "changed mtime → new cache key");
console.log("✓ TGA→PNG disk cache (content-addressed, re-transcodes on change)");

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

rmSync(scratch, { recursive: true, force: true });
console.log("\nALL CACHE TESTS PASSED");
