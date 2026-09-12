/**
 * Host unit test: imports lib/index.js and verifies the security-critical
 * pieces — trust fence decisions, workspace containment (incl. the missing
 * file fallback), the TGA→PNG round-trip (ported decoder + encoder), and the
 * kind/extension mapping.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Writable } from "node:stream";

// A throwaway workspace root — tests must never touch real user directories.
const rootDir = mkdtempSync(join(tmpdir(), "dsh-mip-root-"));
const roots = [rootDir];

// Hermetic token machinery: the plugin module reads the secret-file path and
// the auth-gate URL at import time, so both must be pinned BEFORE the dynamic
// import. The gate stub answers 200 for one magic cookie and 401 otherwise —
// mirroring a real cookie gate without touching the running one.
const tokenDir = mkdtempSync(join(tmpdir(), "dsh-mip-tok-"));
process.env.DSH_MEDIA_TOKEN_SECRET_FILE = join(tokenDir, "token-secret");
const gateStub = createServer((req, res) => {
  res.writeHead((req.headers.cookie ?? "") === "session=good" ? 200 : 401);
  res.end();
});
await new Promise((r) => gateStub.listen(0, "127.0.0.1", r));
process.env.DSH_AUTH_GATE_URL = `http://127.0.0.1:${gateStub.address().port}/auth`;

const {
  decodeTga, encodePng, isTrustedMediaRequest, resolveLocalPath, kindForExt, CONTENT_TYPES,
  IMAGE_EXTS, VIDEO_TRANSCODE_EXTS, AUDIO_TRANSCODE_EXTS, inject,
  TOKEN_ROUTE, AUTH_ROUTE, TOKEN_PARAM, TOKEN_SECRET_FILE,
  tokenSecret, mintToken, verifyTokenForPath, resolveMediaReal, verifyRequestToken,
  createTokenIssuerHandler, createAuthVerifierHandler, createMediaHandler, createImageHandler, MEDIA_ROUTE, FILES_ROUTE,
  createImgServeTool, createMediaServeTool, MEDIA_SECTION_TEXT
} = await import("../lib/index.js");

// ---------------------------------------------------------------------------
// resolveLocalPath containment
// ---------------------------------------------------------------------------

// Absolute path inside a root → returned normalized.
assert.equal(resolveLocalPath(join(rootDir, "x.mp4"), roots), join(rootDir, "x.mp4"));
// Absolute path escaping every root → null.
assert.equal(resolveLocalPath(`${rootDir}-other/x.mp4`, roots), null);
assert.equal(resolveLocalPath("/etc/passwd", roots), null);
// Relative path under a root (file may or may not exist) → containment-checked.
assert.equal(resolveLocalPath("sub/x.mp4", roots), join(rootDir, "sub", "x.mp4"));
// Relative escape via .. → null (fallback is containment-checked, not a hole).
assert.equal(resolveLocalPath("../../etc/passwd", roots), null);
assert.equal(resolveLocalPath("../other/x.mp4", roots), null);
// Multi-root: a relative path that exists under the SECOND root resolves
// there (first root misses); a missing file falls back to the FIRST root's
// containment-checked candidate.
const probeFile = join(rootDir, ".host-test-probe.png");
await (await import("node:fs/promises")).writeFile(probeFile, "x");
assert.equal(
  resolveLocalPath(".host-test-probe.png", ["/nonexistent/root", rootDir]),
  probeFile
);
assert.equal(resolveLocalPath("a/b.png", ["/nonexistent/root", rootDir]), "/nonexistent/root/a/b.png");
await (await import("node:fs/promises")).rm(probeFile, { force: true });
// Leading tilde: "~" and "~/" expand to the home directory (the fence
// abbreviation case that used to 404 silently), "~otheruser" stays literal (no
// passwd lookup, so it can never widen the fence), and expansion does NOT skip
// the containment check — a home dir outside every root is still refused.
assert.equal(resolveLocalPath("~", [homedir()]), homedir());
assert.equal(resolveLocalPath("~/dsh-mip-absent/x.png", [homedir()]), join(homedir(), "dsh-mip-absent", "x.png"));
assert.equal(resolveLocalPath("~nobody/x.png", [homedir()]), join(homedir(), "~nobody", "x.png"));
assert.equal(resolveLocalPath("~/x.png", roots), null);
console.log("✓ resolveLocalPath containment (incl. .. fallback escape closed)");

// ---------------------------------------------------------------------------
// Trust fence
// ---------------------------------------------------------------------------

const req = (headers) => ({ method: "GET", url: "/", headers });

// Loopback host → trusted.
assert.equal(isTrustedMediaRequest(req({ host: "127.0.0.1:3080" }), []), true);
assert.equal(isTrustedMediaRequest(req({ host: "localhost:3080" }), []), true);
// Non-loopback host without trustedHosts → refused.
assert.equal(isTrustedMediaRequest(req({ host: "203.0.113.50:3080" }), []), false);
// LAN host present in trustedHosts (bare host[:port] authorities, no scheme
// — the webRuntime shape) → trusted.
assert.equal(isTrustedMediaRequest(req({ host: "203.0.113.50:3080" }), ["203.0.113.50:3080"]), true);
// Port-less entry matches the hostname on ANY port (LAN-sampling shape).
assert.equal(isTrustedMediaRequest(req({ host: "203.0.113.50:3081" }), ["203.0.113.50"]), true);
// ... but an explicit port is an exact-port grant.
assert.equal(isTrustedMediaRequest(req({ host: "203.0.113.50:3081" }), ["203.0.113.50:3080"]), false);
// cross-site fetch is refused even for loopback.
assert.equal(isTrustedMediaRequest(req({ host: "127.0.0.1:3080", "sec-fetch-site": "cross-site" }), []), false);
// A present Origin must match the request Host.
assert.equal(isTrustedMediaRequest(req({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" }), []), true);
assert.equal(isTrustedMediaRequest(req({ host: "127.0.0.1:3080", origin: "http://evil.example" }), []), false);
assert.equal(isTrustedMediaRequest(req({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:9999" }), []), false);
// Missing Host header → refused.
assert.equal(isTrustedMediaRequest(req({}), []), false);
console.log("✓ trust fence (loopback, trustedHosts, sec-fetch-site, Origin)");
// Regression: the plugin must declare `webRuntime` in
// `inject`, or ctx.webRuntime is undefined and the trustedHosts provider
// returns [] — which makes the fence loopback-only and 403s every
// non-loopback request (e.g. a phone reaching DSH through a reverse proxy).
assert.ok(Array.isArray(inject), "inject export must be an array");
assert.ok(inject.includes("webRuntime"), "inject must include webRuntime for trustedHosts");
// Regression: `webServer` must also be injected. This plugin's apply is
// deferred until webRuntime is provided — AFTER the webServer service event
// has fired — so the event-based route registration would miss it and the
// files/media routes would silently 404 (observed 2026-08-30, post-restart).
assert.ok(inject.includes("webServer"), "inject must include webServer (route registration timing)");
console.log("✓ inject declares webRuntime + webServer (service wiring)");

// ---------------------------------------------------------------------------
// TGA → PNG round-trip
// ---------------------------------------------------------------------------

// 2x1, 24-bit, uncompressed (type 2), bottom-left origin (descriptor 0).
const tga24 = Buffer.from([
  0, 0, 2, // idLength, cmType, imageType
  0, 0, 0, 0, 0, // cmFirst(2), cmLength(2), cmBits(1)
  0, 0, 0, 0, // x0(2), y0(2)
  2, 0, 1, 0, // width=2, height=1
  24, 0, // pixelDepth, descriptor (bottom-up)
  0, 0, 255, // pixel 1: red (BGR)
  0, 255, 0 // pixel 2: green (BGR)
]);
{
  const { rgba, width, height } = decodeTga(tga24);
  assert.equal(width, 2);
  assert.equal(height, 1);
  assert.deepEqual([...rgba], [255, 0, 0, 255, 0, 255, 0, 255]);
}
// RLE 24-bit (type 10): run packet 0x81 (repeat, count=1) + one red pixel,
// then raw packet 0x01 (literal, count=1) + one blue pixel.
const tgaRle = Buffer.from([
  0, 0, 10,
  0, 0, 0, 0, 0, // cmFirst(2), cmLength(2), cmBits(1)
  0, 0, 0, 0, // x0(2), y0(2)
  2, 0, 1, 0,
  24, 0x20, // top-down this time
  0x80, 0, 0, 255, // run: count-1=0 → 1 red pixel
  0x01, 255, 0, 0 // literal: count-1=0 → 1 blue pixel
]);
{
  const { rgba, width, height } = decodeTga(tgaRle);
  assert.equal(width, 2);
  assert.equal(height, 1);
  assert.deepEqual([...rgba], [255, 0, 0, 255, 0, 0, 255, 255]);
}
// Palette 8-bit (type 1): 4-entry BGR palette, pixel indices [0,3].
const tgaPal = Buffer.from([
  0, 1, 1,
  0, 0, 4, 0, 24, // cmFirst=0, cmLength=4, cmBits=24
  0, 0, 0, 0,
  2, 0, 1, 0,
  8, 0,
  0, 0, 255, // palette 0: red (BGR)
  0, 255, 0, // palette 1: green (BGR)
  255, 0, 0, // palette 2: blue (BGR)
  10, 20, 30, // palette 3: BGR(10,20,30) → RGB(30,20,10)
  0, 3 // pixel indices
]);
{
  const { rgba, width, height } = decodeTga(tgaPal);
  assert.equal(width, 2);
  assert.equal(height, 1);
  assert.deepEqual([...rgba], [255, 0, 0, 255, 30, 20, 10, 255]);
}
// PNG encode: signature + IHDR dimensions must survive the round-trip.
{
  const { rgba, width, height } = decodeTga(tga24);
  const png = encodePng(rgba, width, height);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 2); // IHDR width
  assert.equal(png.readUInt32BE(20), 1); // IHDR height
  assert.equal(png[24], 8); // bit depth
  assert.equal(png[25], 6); // color type RGBA
  // IDAT must inflate back to filter+pixels. IHDR chunk = 8+4+4+13+4 = 33.
  const { inflateSync } = await import("node:zlib");
  const idatLen = png.readUInt32BE(33);
  const inflated = inflateSync(png.subarray(41, 41 + idatLen));
  assert.equal(inflated.length, (2 * 4 + 1) * 1);
  assert.deepEqual([...inflated], [0, 255, 0, 0, 255, 0, 255, 0, 255]);
}
console.log("✓ TGA decode (24-bit/RLE/palette) + PNG encode round-trip");

// ---------------------------------------------------------------------------
// Kind mapping
// ---------------------------------------------------------------------------

assert.equal(kindForExt(".png"), "img");
assert.equal(kindForExt(".tga"), "img");
assert.equal(kindForExt(".mp4"), "video");
assert.equal(kindForExt(".MKV"), "video");
assert.equal(kindForExt(".mp3"), "audio");
assert.equal(kindForExt(".wma"), "audio");
assert.equal(kindForExt(".txt"), null);
assert.equal(kindForExt(""), null);
for (const ext of IMAGE_EXTS) assert.ok(CONTENT_TYPES[ext], `CONTENT_TYPES missing ${ext}`);
console.log("✓ kindForExt + CONTENT_TYPES coverage");

// ---------------------------------------------------------------------------
// Fence-tag + tool-name contract (v1.4.0 rename): the host side names them in
// exactly two places — the system-prompt section and the serve-tool result
// text. The model copies whatever those say, so both must carry the namespaced
// names and must never advertise a bare tag again; a silent revert would
// re-create the collision with other plugins shipping ```img/```video/```audio
// or registering img_serve/media_serve.
// ---------------------------------------------------------------------------

for (const tag of ["mip-img", "mip-video", "mip-audio"]) {
  assert.ok(MEDIA_SECTION_TEXT.includes("```" + tag), `prompt section must document the ${tag} fence`);
}
// No bare-tag fence EXAMPLE anywhere (a bare tag in prose, single-backticked, is
// fine — that is how the section warns about them).
assert.equal(/\n```(img|video|audio)\s/.test(MEDIA_SECTION_TEXT), false, "prompt section must not show a bare fence example");
// The prompt must name the namespaced TOOLS too (tool names are global: a second
// media plugin registering img_serve/media_serve collides outright).
assert.ok(MEDIA_SECTION_TEXT.includes("mip_img") && MEDIA_SECTION_TEXT.includes("mip_media"), "prompt section must name the mip_* tools");
assert.equal(MEDIA_SECTION_TEXT.includes("img_serve") || MEDIA_SECTION_TEXT.includes("media_serve"), false, "prompt section must not advertise the old tool names");

const imgTool = createImgServeTool(() => []);
assert.equal(imgTool.name, "mip_img");
const imgRender = imgTool.output.render({}, { ok: true, path: "/tmp/x.png", url: "/u" })[0].text;
assert.ok(imgRender.includes("```mip-img"), `mip_img result must name the mip-img fence: ${imgRender}`);
assert.ok(imgRender.startsWith("mip_img:"), `mip_img result must be prefixed with the tool name: ${imgRender}`);

const mediaTool = createMediaServeTool(() => []);
assert.equal(mediaTool.name, "mip_media");
const videoRender = mediaTool.output.render({}, { ok: true, kind: "video", path: "/tmp/x.mp4", url: "/u" })[0].text;
const audioRender = mediaTool.output.render({}, { ok: true, kind: "audio", path: "/tmp/x.mp3", url: "/u" })[0].text;
assert.ok(videoRender.includes("```mip-video"), `mip_media(video) result must name mip-video: ${videoRender}`);
assert.ok(audioRender.includes("```mip-audio"), `mip_media(audio) result must name mip-audio: ${audioRender}`);
assert.ok(videoRender.startsWith("mip_media:"), `mip_media result must be prefixed with the tool name: ${videoRender}`);
console.log("✓ fence-tag + tool-name contract (mip-* in prompt section + tool results)");

// ---------------------------------------------------------------------------
// Client/host transcode-extension sets must stay in sync (both sides maintain
// their own list; a drift would make the ?tc=1 retry fire for a natively
// playable file or never fire for a container that needs it). The client set
// lives in lib/client.js source — parse it here to assert the union.
// ---------------------------------------------------------------------------

const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const clientSetMatch = /TRANSCODE_EXTS\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(clientSource);
assert.ok(clientSetMatch, "client TRANSCODE_EXTS Set must be parseable from source");
const clientTranscode = new Set(
  [...clientSetMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
);
const hostTranscode = new Set([...VIDEO_TRANSCODE_EXTS, ...AUDIO_TRANSCODE_EXTS]);
assert.deepEqual(
  [...clientTranscode].sort(),
  [...hostTranscode].sort(),
  "client TRANSCODE_EXTS must equal host VIDEO+AUDIO_TRANSCODE_EXTS"
);
console.log("✓ client/host transcode extension sets in sync (" + hostTranscode.size + " exts)");

// ---------------------------------------------------------------------------
// Media tokens (scheme B″): secret lifecycle, HMAC binding, issuer, verifier,
// and the media route's token-as-fence-alternative.
// ---------------------------------------------------------------------------

// A real media file inside the root (the media route only serves media exts).
const tokFile = join(rootDir, "tok-test.mp4");
writeFileSync(tokFile, "fake-mp4-bytes-for-token-test");
const otherFile = join(rootDir, "tok-other.mp4");
writeFileSync(otherFile, "another-file");
const getRoots = () => roots;
const getHosts = () => [];
// A real Writable so fs.ReadStream.pipe(res) works natively (backpressure +
// close propagation) and the test can await 'finish' before the temp dir is
// torn down — otherwise the still-open read stream dies on rmSync with an
// unhandled 'error'.
class FakeRes extends Writable {
  status = null;
  headers = null;
  body = "";
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  _write(chunk, _enc, cb) { this.body += chunk.toString(); cb(); }
}
const fakeRes = () => new FakeRes();

// Shared key material: auto-generated once (0600), cached, 64 hex chars.
const secretA = tokenSecret();
assert.equal(/^[0-9a-f]{64}$/.test(secretA), true);
assert.equal(tokenSecret(), secretA, "secret must be cached across calls");
assert.equal(statSync(TOKEN_SECRET_FILE).mode & 0o777, 0o600, "secret file must be 0600");

// Deterministic + file-bound: same path → same token; other path → different;
// a token verifies only for the path it was minted for.
assert.equal(mintToken(secretA, tokFile), mintToken(secretA, tokFile), "mint must be deterministic");
assert.notEqual(mintToken(secretA, tokFile), mintToken(secretA, otherFile), "token must bind the path");
assert.equal(verifyTokenForPath(tokFile, mintToken(secretA, tokFile)), true);
assert.equal(verifyTokenForPath(otherFile, mintToken(secretA, tokFile)), false, "A's token must not open B");
assert.equal(verifyTokenForPath(tokFile, "bogus-token"), false);
assert.equal(verifyTokenForPath(tokFile, ""), false);

// Rotation: overwriting the secret file invalidates old tokens on the next
// verify (no restart). mtime resolution needs a small beat.
await new Promise((r) => setTimeout(r, 5));
writeFileSync(TOKEN_SECRET_FILE, "rotated-secret-".padEnd(64, "0"), { mode: 0o600 });
const secretB = tokenSecret();
assert.notEqual(secretB, secretA, "rotated secret must be picked up");
assert.equal(verifyTokenForPath(tokFile, mintToken(secretA, tokFile)), false, "stale token must die on rotation");
assert.equal(verifyTokenForPath(tokFile, mintToken(secretB, tokFile)), true);

// resolveMediaReal: media-URL pathname → contained realpath, null on failure.
assert.equal(resolveMediaReal(`${MEDIA_ROUTE}//${tokFile}`, getRoots), tokFile);
assert.equal(resolveMediaReal(`${MEDIA_ROUTE}//${otherFile}`, getRoots), otherFile);
assert.equal(resolveMediaReal(`${MEDIA_ROUTE}//etc/passwd`, getRoots), null);
assert.equal(resolveMediaReal("/plugins/some-other-route/x.mp4", getRoots), null);

// verifyRequestToken: URL-level convenience (query + path together).
const tokUrl = new URL(`http://x${MEDIA_ROUTE}//${tokFile}?${TOKEN_PARAM}=${mintToken(secretB, tokFile)}`);
assert.equal(verifyRequestToken(tokUrl, getRoots), true);
const badTokUrl = new URL(`http://x${MEDIA_ROUTE}//${tokFile}?${TOKEN_PARAM}=deadbeef`);
assert.equal(verifyRequestToken(badTokUrl, getRoots), false);
assert.equal(verifyRequestToken(new URL(`http://x${MEDIA_ROUTE}//${tokFile}`), getRoots), false);
console.log("✓ token secret lifecycle + HMAC binding + rotation");

// Issuer route: trust-fenced, containment-checked, mints for regular files.
const issuer = createTokenIssuerHandler(getHosts, getRoots);
let res = fakeRes();
await issuer(
  { method: "GET", url: `${TOKEN_ROUTE}?path=${encodeURIComponent(tokFile)}`, headers: { host: "127.0.0.1:3080" } },
  res
);
assert.equal(res.status, 200, "issuer: loopback + existing file → 200");
const minted = JSON.parse(res.body);
assert.equal(minted.ok, true);
assert.equal(minted.path, tokFile);
assert.equal(verifyTokenForPath(tokFile, minted.tok), true, "issued token must verify");
res = fakeRes();
await issuer(
  { method: "GET", url: `${TOKEN_ROUTE}?path=${encodeURIComponent(tokFile)}`, headers: { host: "198.51.100.99:3080" } },
  res
);
assert.equal(res.status, 403, "issuer: untrusted host → 403");
res = fakeRes();
await issuer(
  { method: "GET", url: `${TOKEN_ROUTE}?path=${encodeURIComponent("/etc/passwd")}`, headers: { host: "127.0.0.1:3080" } },
  res
);
assert.equal(res.status, 403, "issuer: path escape → 403");
res = fakeRes();
await issuer(
  { method: "GET", url: `${TOKEN_ROUTE}?path=${encodeURIComponent(join(rootDir, "missing.mp4"))}`, headers: { host: "127.0.0.1:3080" } },
  res
);
assert.equal(res.status, 404, "issuer: missing file → 404");
res = fakeRes();
await issuer({ method: "GET", url: TOKEN_ROUTE, headers: { host: "127.0.0.1:3080" } }, res);
assert.equal(res.status, 400, "issuer: missing ?path → 400");
res = fakeRes();
await issuer(
  { method: "GET", url: `${TOKEN_ROUTE}/extra?path=${encodeURIComponent(tokFile)}`, headers: { host: "127.0.0.1:3080" } },
  res
);
assert.equal(res.status, 404, "issuer: path beyond the route → 404");
console.log("✓ token issuer route (fence, containment, 200/403/404/400)");

// Verifier route (nginx auth_request target): token branch + cookie fallback.
const verifier = createAuthVerifierHandler(getHosts, getRoots, process.env.DSH_AUTH_GATE_URL);
res = fakeRes();
await verifier(
  {
    method: "GET", url: AUTH_ROUTE,
    headers: { host: "127.0.0.1:3080", "x-original-uri": `${MEDIA_ROUTE}//${tokFile}?${TOKEN_PARAM}=${mintToken(secretB, tokFile)}` }
  },
  res
);
assert.equal(res.status, 200, "verifier: valid token in X-Original-URI → 200");
res = fakeRes();
await verifier(
  {
    method: "GET", url: AUTH_ROUTE,
    headers: { host: "127.0.0.1:3080", "x-original-uri": `${MEDIA_ROUTE}//${tokFile}?${TOKEN_PARAM}=deadbeef` }
  },
  res
);
assert.equal(res.status, 401, "verifier: bad token → 401");
res = fakeRes();
await verifier(
  { method: "GET", url: AUTH_ROUTE, headers: { host: "127.0.0.1:3080", "x-original-uri": `${MEDIA_ROUTE}//${tokFile}` } },
  res
);
assert.equal(res.status, 401, "verifier: no token, no cookie → 401");
res = fakeRes();
await verifier(
  {
    method: "GET", url: AUTH_ROUTE,
    headers: { host: "127.0.0.1:3080", "x-original-uri": `${MEDIA_ROUTE}//${tokFile}`, cookie: "session=good" }
  },
  res
);
assert.equal(res.status, 200, "verifier: cookie accepted by gate → 200");
res = fakeRes();
await verifier(
  {
    method: "GET", url: AUTH_ROUTE,
    headers: { host: "127.0.0.1:3080", "x-original-uri": `${MEDIA_ROUTE}//${tokFile}`, cookie: "session=bad" }
  },
  res
);
assert.equal(res.status, 401, "verifier: cookie rejected by gate → 401");
console.log("✓ auth verifier route (token branch + cookie fallback via gate)");

// Media route: a valid token is accepted IN LIEU OF the trust fence (the
// cookieless stagefright case with no nginx in between); everything else is
// unchanged.
const media = createMediaHandler(getHosts, getRoots);
res = fakeRes();
await media(
  {
    method: "GET",
    url: `${MEDIA_ROUTE}//${tokFile}?${TOKEN_PARAM}=${mintToken(secretB, tokFile)}`,
    headers: { host: "198.51.100.99:3080" } // untrusted host, cookieless client
  },
  res
);
assert.equal(res.status, 200, "media: untrusted host + valid token → 200 (streams)");
await new Promise((r) => res.on("finish", r)); // drain the stream before teardown
res = fakeRes();
await media(
  { method: "GET", url: `${MEDIA_ROUTE}//${tokFile}`, headers: { host: "198.51.100.99:3080" } },
  res
);
assert.equal(res.status, 403, "media: untrusted host, no token → 403 (fence intact)");
res = fakeRes();
await media(
  { method: "GET", url: `${MEDIA_ROUTE}//${tokFile}`, headers: { host: "127.0.0.1:3080" } },
  res
);
assert.equal(res.status, 200, "media: trusted host, no token → 200 (unchanged behavior)");
await new Promise((r) => res.on("finish", r)); // drain the stream before teardown
console.log("✓ media route accepts a valid token in lieu of the fence");

// ---------------------------------------------------------------------------
// Image route + leading-tilde paths — the reported bug: a fence spec that
// abbreviates the absolute path its serve tool returned (/home/<user>/… →
// ~/…) rendered "img 加载失败" in the chat while the file was plainly there.
// The route must serve it, and still refuse a tilde path that leaves the roots.
// ---------------------------------------------------------------------------

const realHome = process.env.HOME;
const fakeHome = mkdtempSync(join(tmpdir(), "dsh-mip-home-"));
const pngSig = Buffer.from("89504e470d0a1a0a", "hex"); // signature bytes: the route is a byte pipe
writeFileSync(join(fakeHome, "tilde-pic.png"), pngSig);
process.env.HOME = fakeHome; // homedir() reads $HOME on POSIX
try {
  const image = createImageHandler(getHosts, () => [fakeHome]);
  let r = fakeRes();
  // Exactly the browser's URL shape: the client percent-encodes the path as one
  // string, so "~/.…/x.png" arrives as "~%2F…".
  await image({ method: "GET", url: `${FILES_ROUTE}/~%2Ftilde-pic.png`, headers: { host: "127.0.0.1:3080" } }, r);
  assert.equal(r.status, 200, "image: ~/… inside the home root → 200");
  assert.equal(r.headers["content-type"], "image/png");
  assert.equal(r.body, pngSig.toString(), "image: tilde request must return the file bytes");

  r = fakeRes();
  await image({ method: "GET", url: `${FILES_ROUTE}/~%2Fabsent.png`, headers: { host: "127.0.0.1:3080" } }, r);
  assert.equal(r.status, 404, "image: tilde path to a missing file → 404 (clear, not silent)");

  r = fakeRes();
  await image({ method: "GET", url: `${FILES_ROUTE}/~%2Ftilde-pic.png`, headers: { host: "127.0.0.1:3080" } }, r);
  assert.equal(r.status, 200, "image: sanity — same request twice stays 200");
} finally {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
}
// Expansion must not become an escape hatch: with the temp test root as the
// ONLY allowed root, a tilde path pointing at the (different) home is refused.
const imageFenced = createImageHandler(getHosts, () => [rootDir]);
const rFenced = fakeRes();
await imageFenced({ method: "GET", url: `${FILES_ROUTE}/~%2Ftilde-pic.png`, headers: { host: "127.0.0.1:3080" } }, rFenced);
assert.equal(rFenced.status, 403, "image: tilde path outside every allowed root → 403 (fence intact)");
rmSync(fakeHome, { recursive: true, force: true });
console.log("✓ image route serves leading-tilde paths (containment still enforced)");

gateStub.close();
rmSync(tokenDir, { recursive: true, force: true });
rmSync(rootDir, { recursive: true, force: true });
console.log("\nALL HOST UNIT TESTS PASSED");
