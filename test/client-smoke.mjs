/**
 * Client smoke test: loads lib/client.js in a stubbed browser environment and
 * verifies:
 *  - fence detection (infostring tier 1, ```tag tier 2, JSON-spec extension
 *    tier 3) for all three fence languages
 *  - cross-kind collision safety (a video spec never mounts as an image)
 *  - streaming skip, malformed-spec skip
 *  - img mounting (single card, grid, url-only) with the files route URL
 *  - video/audio mounting with the media route URL
 *  - the transcode retry swap + second-failure error card
 *  - dispose
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Minimal DOM stubs
// ---------------------------------------------------------------------------

class FakeElement {
  constructor(tag) {
    this.nodeType = 1; // DOM Element
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.style = { cssText: "" };
    this.dataset = {};
    this.attributes = new Map();
    this._text = "";
    this.src = "";
    this.controls = false;
    this.preload = "";
    this.playsInline = false;
    this.parentElement = null;
  }
  // Real-DOM semantics: textContent aggregates descendant text.
  get textContent() {
    return this._text + (this.children ?? []).map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this._text = v;
  }
  appendChild(child) {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  replaceChild(newNode, oldNode) {
    const i = this.children.indexOf(oldNode);
    if (i !== -1) this.children[i] = newNode;
    newNode.parentElement = this;
    return oldNode;
  }
  after(el) {
    if (this.parentElement === null) return;
    const i = this.parentElement.children.indexOf(this);
    this.parentElement.children.splice(i + 1, 0, el);
    el.parentElement = this.parentElement;
  }
  remove() {
    const p = this.parentElement;
    if (p === null) return;
    const i = p.children.indexOf(this);
    if (i !== -1) p.children.splice(i, 1);
    this.parentElement = null;
  }
  get nextElementSibling() {
    if (this.parentElement === null) return null;
    const siblings = this.parentElement.children;
    const i = siblings.indexOf(this);
    if (i === -1) return null;
    for (let j = i + 1; j < siblings.length; j++) {
      if (siblings[j].nodeType === 1) return siblings[j];
    }
    return null;
  }
  querySelector(sel) {
    // Supports tag selectors ("pre", "img", "video", "audio") and
    // "[class*='infostring']".
    const walk = (el) => {
      for (const child of el.children ?? []) {
        if (/^[a-z]+$/.test(sel) && child.tagName === sel.toUpperCase()) return child;
        if (sel.includes("infostring") && typeof child.className === "string" && child.className.includes("infostring")) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
  querySelectorAll(sel) {
    // Supports ".class", "[data-streaming]" and bare tag selectors,
    // comma-combined (mirrors the client's BLOCK_SELECTOR).
    const out = [];
    const walk = (el) => {
      for (const child of el.children ?? []) {
        if (sel.split(", ").some((s) => {
          if (s.startsWith(".")) return typeof child.className === "string" && child.className.includes(s.slice(1));
          if (s.startsWith("[data-streaming]")) return child.hasAttribute("data-streaming");
          return child.tagName === s.toUpperCase();
        })) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  closest(sel) {
    if (sel === "[data-streaming]") {
      let cur = this;
      while (cur) {
        if (cur.hasAttribute("data-streaming")) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    // Class-list selector like ".md-code-block, .code-block, .code-block-small"
    const parts = sel.split(",").map((s) => s.trim().replace(/^\./, ""));
    let cur = this; // DOM closest() includes the element itself
    while (cur) {
      if (typeof cur.className === "string" && parts.some((p) => cur.className.includes(p))) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  matches(sel) {
    // Same semantics as querySelectorAll's per-node check.
    return sel.split(",").some((s) => {
      if (s.trim().startsWith(".")) return typeof this.className === "string" && this.className.includes(s.trim().slice(1));
      if (s.trim().startsWith("[data-streaming]")) return this.hasAttribute("data-streaming");
      return this.tagName === s.trim().toUpperCase();
    });
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
  get isConnected() {
    // Real-DOM semantics: connected only if an ancestor chain reaches the body.
    let cur = this;
    while (cur && cur !== documentStub.body) cur = cur.parentElement;
    return cur === documentStub.body;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (list) {
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    }
  }
  dispatchEvent(type, extra = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, ...extra });
  }
  load() {
    this.loaded = (this.loaded ?? 0) + 1;
  }
  pause() {}
}

// The scanned code block: .md-code-block with infostring banner + <pre> body.
// `withInfostring: ""` models the streaming real DOM (infostring element
// present but empty); `withInfostring: false` omits it entirely.
function makeCodeBlock(lang, body, { streaming = false, withInfostring = true } = {}) {
  const block = new FakeElement("div");
  block.className = "md-code-block";
  if (withInfostring !== false) {
    const banner = new FakeElement("div");
    banner.className = "code-block-banner infostring";
    banner.textContent = withInfostring === true ? lang : "";
    block.appendChild(banner);
  }
  const pre = new FakeElement("pre");
  pre.textContent = body;
  block.appendChild(pre);
  if (streaming) block.attributes.set("data-streaming", "1");
  return block;
}

// A bare <pre> surface (no wrapper): the body text is the raw fence content.
function makeBarePre(body) {
  const pre = new FakeElement("pre");
  pre.textContent = body;
  return pre;
}

const docListeners = new Map();
const documentStub = {
  body: new FakeElement("body"),
  createElement: (tag) => new FakeElement(tag),
  querySelectorAll: (sel) => documentStub.body.querySelectorAll(sel),
  addEventListener: (type, fn) => {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  },
  removeEventListener: (type, fn) => {
    const list = docListeners.get(type);
    if (list) {
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    }
  }
};

let rafQueue = [];
const windowStub = {
  __ModuleLoader__: {
    load: (spec) => {
      windowStub.__loaded = spec;
    }
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: (fn) => {
    windowStub.__timers.push(fn);
    return windowStub.__timers.length;
  },
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: (fn) => {
    rafQueue.push(fn);
    return rafQueue.length;
  }
};
windowStub.__timers = [];
globalThis.window = windowStub;
globalThis.document = documentStub;
globalThis.__moCallback = null;
globalThis.MutationObserver = class {
  constructor(cb) {
    globalThis.__moCallback = cb;
  }
  observe() {}
  disconnect() {}
};

// IntersectionObserver stub: by default fires synchronously on observe() to
// model an in-viewport player (eager-load parity with the old client); tests
// may set globalThis.__ioAutoFire = false to exercise the lazy path.
globalThis.__ioAutoFire = true;
globalThis.__ioInstance = null;
globalThis.IntersectionObserver = class {
  constructor(cb) {
    this.cb = cb;
    this.els = [];
    globalThis.__ioInstance = this;
  }
  observe(el) {
    this.els.push(el);
    if (globalThis.__ioAutoFire) this.cb([{ target: el, isIntersecting: true }]);
  }
  unobserve() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = windowStub.requestAnimationFrame;

/** Simulate a DOM mutation: fire the observer callback, then flush rAF. */
function mutate(records) {
  if (globalThis.__moCallback) globalThis.__moCallback(records);
  rafQueue.splice(0).forEach((fn) => fn());
}

/**
 * Flush microtasks. The client gates the real player load behind the (async)
 * token-mint promise, so tests must let that settle before dispatching player
 * events or asserting load side effects.
 */
const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// Load the client and materialize the factory
// ---------------------------------------------------------------------------

const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
// The file is a plain script (no imports); eval it in this scope.
(0, eval)(clientSource);
const spec = windowStub.__loaded;
if (!spec || spec.id !== "dsh-media-inline-preview") throw new Error(`module not registered (id=${spec?.id})`);
const mod = spec.factory(() => ({}));
if (typeof mod.apply !== "function" || typeof mod.dispose !== "function") {
  throw new Error("factory must return {apply, dispose}");
}
mod.apply();

const FILES_URL = "/plugins/dsh-media-inline-preview/files/";
const MEDIA_URL = "/plugins/dsh-media-inline-preview/media/";

// ---------------------------------------------------------------------------
// Scenario 1: settled ```video fence with infostring → mounts <video>
// ---------------------------------------------------------------------------

const body = documentStub.body;
const videoFence = makeCodeBlock("video", '```video\n{"path":"/tmp/media/xhs_video.mp4","label":"测试视频"}\n```');
body.appendChild(videoFence);
mutate();
const videoEl = videoFence.parentElement.querySelectorAll("video");
if (videoEl.length !== 1) throw new Error(`expected 1 <video>, got ${videoEl.length}`);
if (videoFence.style.display !== "none") throw new Error("source block must be hidden");
const src = videoEl[0].src;
if (!src.startsWith(MEDIA_URL)) throw new Error(`bad src: ${src}`);
if (!src.includes("/tmp/media/xhs_video.mp4")) throw new Error(`src must carry the path: ${src}`);
console.log("✓ video fence mounts (infostring tier):", src);

// ---------------------------------------------------------------------------
// Scenario 2: ```audio fence via ```tag fallback (empty infostring) → <audio>
// ---------------------------------------------------------------------------

const audioFence = makeCodeBlock("audio", '```audio\n{"path":"/tmp/media/xhs_music.mp3"}\n```', { withInfostring: "" });
body.appendChild(audioFence);
mutate();
const audioEls = audioFence.parentElement.querySelectorAll("audio");
if (audioEls.length !== 1) throw new Error(`expected 1 <audio>, got ${audioEls.length}`);
if (!audioEls[0].src.startsWith(MEDIA_URL)) throw new Error(`bad audio src: ${audioEls[0].src}`);
console.log("✓ audio fence mounts (tag tier):", audioEls[0].src);

// ---------------------------------------------------------------------------
// Scenario 3: streaming message — the LAST fence (no following sibling) waits
// ---------------------------------------------------------------------------

const streamingMsg = new FakeElement("div"); // message root with data-streaming
streamingMsg.attributes.set("data-streaming", "1");
body.appendChild(streamingMsg);
const streamingFence = makeCodeBlock("video", '```video\n{"path":"/tmp/v.mp4"}\n```', { withInfostring: "" });
streamingMsg.appendChild(streamingFence); // last block of the streaming message
mutate();
if (body.querySelectorAll("video").length !== 1) throw new Error("last streaming fence must not mount");
console.log("✓ streaming: last fence waits for settle");

// ---------------------------------------------------------------------------
// Scenario 4: malformed JSON (half-streamed) does not mount
// ---------------------------------------------------------------------------

const badFence = makeCodeBlock("video", '```video\n{"path":"/tmp/broken.mp"\n```', { withInfostring: false });
body.appendChild(badFence);
mutate();
if (body.querySelectorAll("video").length !== 1) throw new Error("malformed fence must not mount");
console.log("✓ malformed fence skipped");

// ---------------------------------------------------------------------------
// Scenario 5: unsupported-container error → tc retry swaps src
// ---------------------------------------------------------------------------

const mkvFence = makeCodeBlock("video", '```video\n{"path":"/tmp/media/demo.mkv"}\n```');
body.appendChild(mkvFence);
mutate();
const mkvVideo = [...body.querySelectorAll("video")].find((v) => v.src.includes("demo.mkv"));
if (!mkvVideo) throw new Error("mkv video not mounted");
await flush(); // token gate: the load (and its error listener) arms async
mkvVideo.dispatchEvent("error");
if (!mkvVideo.src.includes("tc=1")) throw new Error(`error must trigger tc retry, src now: ${mkvVideo.src}`);
console.log("✓ error on mkv triggers ?tc=1 retry:", mkvVideo.src);

// A second error (transcode also failed) → error card replaces the player
mkvVideo.dispatchEvent("error");
const fig = mkvVideo.parentElement;
if (fig.querySelectorAll("video").length !== 0) throw new Error("second failure must swap to error card");
console.log("✓ second failure swaps to error card");

// ---------------------------------------------------------------------------
// Scenario 6: img fence (infostring tier) → single card under the files route
// ---------------------------------------------------------------------------

const imgFence = makeCodeBlock("img", '```img\n{"path":"/tmp/media/pic.png","label":"截图"}\n```');
body.appendChild(imgFence);
mutate();
const imgGrids = body.querySelectorAll(".img-preview-grid");
if (imgGrids.length !== 1) throw new Error(`expected 1 img grid, got ${imgGrids.length}`);
const imgCards = body.querySelectorAll("img");
if (imgCards.length !== 1) throw new Error(`expected 1 img card, got ${imgCards.length}`);
if (!imgCards[0].src.startsWith(FILES_URL)) throw new Error(`bad img src: ${imgCards[0].src}`);
if (!imgCards[0].src.includes("/tmp/media/pic.png")) throw new Error(`img src must carry the path: ${imgCards[0].src}`);
if (imgFence.style.display !== "none") throw new Error("img source block must be hidden");
console.log("✓ img fence mounts single card:", imgCards[0].src);

// ---------------------------------------------------------------------------
// Scenario 7: img grid spec (images array) → one card per entry
// ---------------------------------------------------------------------------

const gridSpec = JSON.stringify({
  images: [
    { path: "/tmp/media/a.png", label: "A" },
    { path: "/tmp/media/b.jpg" },
    { path: "" } // invalid entry — must be dropped
  ]
});
const gridFence = makeCodeBlock("img", "```img\n" + gridSpec + "\n```");
body.appendChild(gridFence);
mutate();
if (body.querySelectorAll("img").length !== 3) throw new Error(`expected 3 img cards (1+2), got ${body.querySelectorAll("img").length}`);
console.log("✓ img grid mounts 2 valid cards (invalid entry dropped)");

// ---------------------------------------------------------------------------
// Scenario 8: url-only img spec → card src is the external URL
// ---------------------------------------------------------------------------

const urlFence = makeCodeBlock("img", '```img\n{"url":"https://example.com/x.png","label":"远程图"}\n```');
body.appendChild(urlFence);
mutate();
const urlImgs = body.querySelectorAll("img");
if (urlImgs.length !== 4) throw new Error(`expected 4 img cards total, got ${urlImgs.length}`);
if (urlImgs[3].src !== "https://example.com/x.png") throw new Error(`url-only spec must keep the URL: ${urlImgs[3].src}`);
console.log("✓ url-only img spec mounts with the raw URL");

// ---------------------------------------------------------------------------
// Scenario 9: bare <pre> JSON png (no infostring, no tag) → tier 3 → img
// ---------------------------------------------------------------------------

const barePng = makeBarePre('{"path":"/tmp/media/t.png"}');
body.appendChild(barePng);
mutate();
if (body.querySelectorAll("img").length !== 5) throw new Error(`expected 5 img cards (tier-3 png), got ${body.querySelectorAll("img").length}`);
console.log("✓ bare JSON png infers img kind (tier 3)");

// ---------------------------------------------------------------------------
// Scenario 10: cross-kind collision safety
// ---------------------------------------------------------------------------
// (a) bare JSON mp4 body must mount a <video>, never an image card.
const bareMp4 = makeBarePre('{"path":"/tmp/media/c.mp4"}');
body.appendChild(bareMp4);
mutate();
if (body.querySelectorAll("video").length !== 2) throw new Error(`bare JSON mp4 must mount <video> (expected 2, got ${body.querySelectorAll("video").length})`);
if (body.querySelectorAll("img").length !== 5) throw new Error("bare JSON mp4 must NOT mount an image card");
// (b) an infostring "video" block with a JSON body stays a video even though
// the body is also a parseable img-spec shape.
const clashFence = makeCodeBlock("video", '{"path":"/tmp/media/d.mp4"}');
body.appendChild(clashFence);
mutate();
if (body.querySelectorAll("video").length !== 3) throw new Error(`infostring video must win over spec shape (expected 3 videos, got ${body.querySelectorAll("video").length})`);
if (body.querySelectorAll("img").length !== 5) throw new Error("infostring video fence must not mount images");
console.log("✓ cross-kind collision safe (mp4→video, infostring wins)");

// ---------------------------------------------------------------------------
// Scenario 11: TGA img spec mounts (host transcodes to PNG on serve)
// ---------------------------------------------------------------------------

const tgaFence = makeCodeBlock("img", '```img\n{"path":"/tmp/media/snap.tga"}\n```');
body.appendChild(tgaFence);
mutate();
const tgaImgs = body.querySelectorAll("img");
if (tgaImgs.length !== 6) throw new Error(`expected 6 img cards, got ${tgaImgs.length}`);
if (!tgaImgs[5].src.endsWith(".tga")) throw new Error(`tga card must point at the .tga (host transcodes): ${tgaImgs[5].src}`);
console.log("✓ TGA img spec mounts (transcode is host-side)");

// ---------------------------------------------------------------------------
// Scenario 13: captions show ONLY the file name (spec label ignored)
// ---------------------------------------------------------------------------
// The video fence in scenario 1 carried label "测试视频"; the caption must be
// the file name instead.
const videoFigure = body.children.find((c) =>
  (c.children ?? []).some((ch) => ch.tagName === "VIDEO")
);
if (!videoFigure) throw new Error("video figure not found");
const videoCaption = (videoFigure.children ?? []).find((c) => c.tagName === "FIGCAPTION");
if (!videoCaption || videoCaption.textContent !== "xhs_video.mp4") {
  throw new Error(`video caption must be the file name, got: ${videoCaption?.textContent}`);
}
// The img card in scenario 6 carried label "截图"; caption must be pic.png.
const firstGrid = body.querySelectorAll(".img-preview-grid")[0];
const firstCard = firstGrid.children[0];
const imgCaption = (firstCard.children ?? []).find((c) => c.tagName === "FIGCAPTION");
if (!imgCaption || imgCaption.textContent !== "pic.png") {
  throw new Error(`img caption must be the file name, got: ${imgCaption?.textContent}`);
}
console.log("✓ captions show file name only (label ignored)");

// ---------------------------------------------------------------------------
// Scenario 14: lightbox title is the file name (not the label, not the URL)
// ---------------------------------------------------------------------------
const cardImg = firstCard.querySelector("img");
cardImg.dispatchEvent("click");
const overlay = body.children.find((c) => c.className === "img-preview-lightbox");
if (!overlay) throw new Error("lightbox overlay not opened by card click");
const lightboxBar = overlay.children[0];
const lightboxTitle = lightboxBar.children[0];
if (lightboxTitle.textContent !== "pic.png") {
  throw new Error(`lightbox title must be the file name, got: ${lightboxTitle.textContent}`);
}
console.log("✓ lightbox title shows file name only");

// ---------------------------------------------------------------------------
// Scenario 15: lightbox touch — pinch zooms, two-finger drag pans
// ---------------------------------------------------------------------------
const stage = overlay.children[1];
const lbImg = stage.children[0];
const scaleOf = (t) => {
  const m = /scale\(([\d.]+)\)/.exec(t ?? "");
  return m ? parseFloat(m[1]) : NaN;
};
stage.dispatchEvent("pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
stage.dispatchEvent("pointerdown", { pointerId: 2, clientX: 300, clientY: 100 });
// Spread the two fingers apart (distance 200 → 260, midpoint moves +50x):
// must zoom AND pan.
stage.dispatchEvent("pointermove", { pointerId: 1, clientX: 120, clientY: 120 });
stage.dispatchEvent("pointermove", { pointerId: 2, clientX: 380, clientY: 120 });
const t1 = lbImg.style.transform;
const s1 = scaleOf(t1);
if (Number.isNaN(s1) || Math.abs(s1 - 1.3) > 0.02) {
  throw new Error(`pinch must zoom by the distance ratio (~1.3), transform: ${t1}`);
}
if (t1 === "translate(calc(-50% + 0px), calc(-50% + 0px)) scale(1)") {
  throw new Error("pinch must also pan with the midpoint movement");
}
// Small two-finger translation (both +6x/+6y, finger by finger): pans; the
// per-finger intermediate states keep the scale wobble under 1% (the same
// sequential semantics a real browser produces).
stage.dispatchEvent("pointermove", { pointerId: 1, clientX: 126, clientY: 126 });
stage.dispatchEvent("pointermove", { pointerId: 2, clientX: 386, clientY: 126 });
const t2 = lbImg.style.transform;
const s2 = scaleOf(t2);
if (t2 === t1) throw new Error("two-finger drag must pan the image");
if (Math.abs(s2 - s1) > 0.01) throw new Error(`two-finger drag must keep the scale (~${s1}), got ${s2}`);
// Lift one finger: the remaining finger keeps panning (hand-off).
stage.dispatchEvent("pointerup", { pointerId: 1 });
stage.dispatchEvent("pointermove", { pointerId: 2, clientX: 430, clientY: 210 });
const t3 = lbImg.style.transform;
if (t3 === t2) throw new Error("remaining single finger must keep panning");
stage.dispatchEvent("pointerup", { pointerId: 2 });
console.log("✓ lightbox pinch zooms + two-finger drag pans (all four directions)");

// ---------------------------------------------------------------------------
// Scenario 16: incremental scan — records-driven mutation mounts new fences
// without a full-document pass
// ---------------------------------------------------------------------------
const incFence = makeCodeBlock("video", '```video\n{"path":"/tmp/media/inc.mp4"}\n```');
body.appendChild(incFence);
mutate([{ type: "childList", addedNodes: [incFence] }]);
const incVideos = body.querySelectorAll("video");
if (![...incVideos].some((v) => v.src.includes("inc.mp4"))) {
  throw new Error("incremental scan must mount a fence delivered via addedNodes");
}
console.log("✓ incremental scan mounts fences from mutation records");

// ---------------------------------------------------------------------------
// Scenario 17: lazy loading — a player below the fold does not load until
// the IntersectionObserver reports it in view
// ---------------------------------------------------------------------------
globalThis.__ioAutoFire = false;
const lazyFence = makeCodeBlock("audio", '```audio\n{"path":"/tmp/media/lazy.mp3"}\n```');
body.appendChild(lazyFence);
mutate([{ type: "childList", addedNodes: [lazyFence] }]);
const lazyAudio = [...body.querySelectorAll("audio")].find((a) => a.src.includes("lazy.mp3"));
if (!lazyAudio) throw new Error("lazy audio fence not mounted");
if (lazyAudio.preload !== "none") throw new Error(`lazy player must start with preload=none, got: ${lazyAudio.preload}`);
if ((lazyAudio.loaded ?? 0) !== 0) throw new Error("lazy player must not load() before entering the viewport");
// Scroll into view → IntersectionObserver callback fires → load starts.
globalThis.__ioInstance.cb([{ target: lazyAudio.parentElement, isIntersecting: true }]);
await flush(); // token gate: startLoad runs in the microtask after the gate
if (lazyAudio.preload !== "metadata") throw new Error("in-view player must switch to preload=metadata");
if ((lazyAudio.loaded ?? 0) !== 1) throw new Error("in-view player must call load() exactly once");
globalThis.__ioAutoFire = true;
console.log("✓ lazy loading: players wait for the viewport (IntersectionObserver)");

// ---------------------------------------------------------------------------
// Scenario 18: streaming message — a settled fence (has a following sibling)
// mounts EARLY, while the message is still streaming
// ---------------------------------------------------------------------------

const streamMsg = new FakeElement("div"); // message root (data-streaming on ancestor)
streamMsg.attributes.set("data-streaming", "1");
body.appendChild(streamMsg);
const earlyFence = makeCodeBlock("video", '```video\n{"path":"/tmp/media/early.mp4"}\n```', { withInfostring: "" });
const earlyTail = new FakeElement("p");
earlyTail.textContent = "trailing text";
streamMsg.appendChild(earlyFence);
streamMsg.appendChild(earlyTail);
mutate();
if (streamMsg.querySelectorAll("video").length !== 1) {
  throw new Error("settled fence inside a streaming message must mount early");
}
if (earlyFence.style.display !== "none") {
  throw new Error(`early-mounted fence source must be hidden (display=${earlyFence.style.display})`);
}
console.log("✓ streaming: settled fence mounts early (before the message ends)");

// ---------------------------------------------------------------------------
// Scenario 19: streaming message — a LAST fence (no following sibling) waits,
// then mounts once content follows it
// ---------------------------------------------------------------------------

const lastFence = makeCodeBlock("img", '```img\n{"path":"/tmp/img/late.png"}\n```', { withInfostring: "" });
streamMsg.appendChild(lastFence); // last child → the fence may still be open
mutate();
if (streamMsg.querySelectorAll(".img-preview-grid").length !== 0) {
  throw new Error("last streaming fence must not mount before settle");
}
const lateTail = new FakeElement("p");
lateTail.textContent = "content after the fence";
streamMsg.appendChild(lateTail); // fence now has a following sibling → settled
mutate();
if (streamMsg.querySelectorAll(".img-preview-grid").length !== 1) {
  throw new Error("last fence must mount once content follows it");
}
console.log("✓ streaming: last fence waits, then mounts when a following sibling appears");

// ---------------------------------------------------------------------------
// Scenario 20: wrapper node replaced (streaming→settled re-render) — the
// surviving injected figure is adopted, no duplicate media, source hidden
// ---------------------------------------------------------------------------

const replacedWrapper = makeCodeBlock("video", '```video\n{"path":"/tmp/media/early.mp4"}\n```', { withInfostring: "" });
{
  const i = streamMsg.children.indexOf(earlyFence);
  if (i === -1) throw new Error("early fence not found in stream message");
  streamMsg.children[i] = replacedWrapper; // frontend re-render swaps the node; figure survives
  replacedWrapper.parentElement = streamMsg;
}
mutate();
if (streamMsg.querySelectorAll("video").length !== 1) {
  throw new Error("wrapper replacement must adopt the existing player, not mount a second one");
}
if (replacedWrapper.style.display !== "none") {
  throw new Error(`replaced wrapper must be hidden after adoption (display=${replacedWrapper.style.display})`);
}
console.log("✓ wrapper replaced on re-render: existing mount adopted, no duplicate");

// ---------------------------------------------------------------------------
// Scenario 21: settle transition — removing data-streaming mounts the waiting fence
// ---------------------------------------------------------------------------

const settleMsg = new FakeElement("div");
settleMsg.attributes.set("data-streaming", "1");
body.appendChild(settleMsg);
const settleFence = makeCodeBlock("audio", '```audio\n{"path":"/tmp/media/settle.mp3"}\n```', { withInfostring: "" });
settleMsg.appendChild(settleFence);
mutate();
if (settleMsg.querySelectorAll("audio").length !== 0) throw new Error("waiting fence must not mount while streaming");
settleMsg.attributes.delete("data-streaming"); // the message settled
mutate();
if (settleMsg.querySelectorAll("audio").length !== 1) throw new Error("settled message must mount its fence");
console.log("✓ settle transition: waiting fence mounts exactly once");

// ---------------------------------------------------------------------------
// Scenario 22: virtualization — the message leaves the DOM mid-load and comes
// back; the adopted player must revive its load (no zombie, no duplicate)
// ---------------------------------------------------------------------------

const virtMsg = new FakeElement("div");
body.appendChild(virtMsg);
const virtFence = makeCodeBlock("video", '```video\n{"path":"/tmp/media/virt.mp4"}\n```', { withInfostring: "" });
const virtTail = new FakeElement("p");
virtTail.textContent = "tail";
virtMsg.appendChild(virtFence);
virtMsg.appendChild(virtTail);
mutate();
await flush(); // token gate: first load arms in a microtask
const virtVideo = virtMsg.querySelectorAll("video")[0];
if (!virtVideo || (virtVideo.loaded ?? 0) !== 1) throw new Error("virtualization test: player must load once first");
// The chat virtualizes: the whole message leaves the document
body.children.splice(body.children.indexOf(virtMsg), 1);
virtMsg.parentElement = null;
mutate(); // scan → reapHandled → cleanup tears the load machinery down
// …and later comes back
body.appendChild(virtMsg);
mutate(); // surviving figure right after the wrapper → adoption + resume
await flush(); // resume re-arms the load through the (already settled) token gate
if ((virtVideo.loaded ?? 0) < 2) throw new Error("revived player must load again after reattach");
if (virtMsg.querySelectorAll("video").length !== 1) throw new Error("reattach must not duplicate the player");
console.log("✓ detach/reattach: adopted player revives its load, no duplicate");

// ---------------------------------------------------------------------------
// Scenario 23: hidden tab — the load (and its grace window) waits for visibility
// ---------------------------------------------------------------------------

documentStub.hidden = true;
const visMsg = new FakeElement("div");
body.appendChild(visMsg);
const visFence = makeCodeBlock("audio", '```audio\n{"path":"/tmp/media/vis.mp3"}\n```');
visMsg.appendChild(visFence);
mutate();
await flush(); // token gate: the hidden-tab deferral (vis listener) arms async
const visAudio = visMsg.querySelectorAll("audio")[0];
if (!visAudio) throw new Error("hidden-tab test: the player must still mount (only the load is deferred)");
if ((visAudio.loaded ?? 0) !== 0) throw new Error("hidden tab: the load must be deferred until the tab is visible");
documentStub.hidden = false;
for (const fn of [...docListeners.get("visibilitychange")]) fn();
if ((visAudio.loaded ?? 0) !== 1) throw new Error("becoming visible must start the load exactly once");
console.log("✓ hidden tab: load deferred until visible, then starts once");

// ---------------------------------------------------------------------------
// Scenario 24: media tokens (scheme B-prime-prime) — a video src gains
// ?dsh_tok= (one mint per file, cached), audio/img are skipped, a mint failure
// degrades to the bare URL, a tc retry keeps the token, and a secret rotation
// self-heals via a forced re-mint on the retry.
// ---------------------------------------------------------------------------

const TOKEN_URL = "/plugins/dsh-media-inline-preview/token";
const realFetch = globalThis.fetch;
let nextTok = "TOK-A";
let fetchMode = "ok"; // "ok" | "reject"
const tokenFetches = [];
globalThis.fetch = (url) => {
  const u = String(url);
  if (u.startsWith(TOKEN_URL)) {
    tokenFetches.push(u);
    if (fetchMode === "reject") return Promise.reject(new Error("network down"));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, tok: nextTok, path: "x" })
    });
  }
  if (typeof realFetch === "function") return realFetch(url);
  return Promise.reject(new Error("no network in test"));
};

// (a) Video with a media-route src → src gains ?dsh_tok=; exactly one mint.
const tokFence = makeCodeBlock("video", '```video\n{"path":"/tmp/media/tok.mp4"}\n```');
body.appendChild(tokFence);
mutate();
await flush(); // token gate: mint + src swap + load all settle in microtasks
const tokVideo = [...body.querySelectorAll("video")].find((v) => v.src.includes("tok.mp4"));
if (!tokVideo) throw new Error("token test: video not mounted");
if (!tokVideo.src.includes("dsh_tok=TOK-A")) {
  throw new Error(`video src must carry the token, got: ${tokVideo.src}`);
}
if (!tokenFetches.some((u) => u.includes("path="))) {
  throw new Error("token mint must hit the /token route");
}
if (tokenFetches.length !== 1) {
  throw new Error(`one mint per file expected, got ${tokenFetches.length}`);
}
console.log("✓ video src gains dsh_tok (single mint):", tokVideo.src);

// (b) A second mount of the SAME file reuses the cached token — no new fetch.
const tokFence2 = makeCodeBlock("video", '```video\n{"path":"/tmp/media/tok.mp4"}\n```');
body.appendChild(tokFence2);
mutate();
await flush();
if (tokenFetches.length !== 1) {
  throw new Error(`cached token must not refetch, got ${tokenFetches.length} mints`);
}
console.log("✓ second mount of the same file reuses the cached token");

// (c) Audio is never tokenized (its fetch runs in the page stack w/ cookie).
const tokAudioFence = makeCodeBlock("audio", '```audio\n{"path":"/tmp/media/tok-audio.mp3"}\n```');
body.appendChild(tokAudioFence);
mutate();
await flush();
const tokAudio = [...body.querySelectorAll("audio")].find((a) => a.src.includes("tok-audio.mp3"));
if (!tokAudio) throw new Error("token test: audio not mounted");
if (tokAudio.src.includes("dsh_tok")) {
  throw new Error(`audio src must NOT carry a token, got: ${tokAudio.src}`);
}
if (tokenFetches.length !== 1) {
  throw new Error(`audio must not mint a token, got ${tokenFetches.length} mints`);
}
console.log("✓ audio mounts are not tokenized");

// (d) A tc retry keeps the token (container the browser cannot decode).
nextTok = "TOK-A"; // stable for this file
const tokMkvFence = makeCodeBlock("video", '```video\n{"path":"/tmp/media/tok-demo.mkv"}\n```');
body.appendChild(tokMkvFence);
mutate();
await flush();
const tokMkv = [...body.querySelectorAll("video")].find((v) => v.src.includes("tok-demo.mkv"));
if (!tokMkv) throw new Error("token test: mkv video not mounted");
if (!tokMkv.src.includes("dsh_tok=TOK-A")) throw new Error(`mkv src must carry the token: ${tokMkv.src}`);
tokMkv.dispatchEvent("error"); // transcodable → immediate tc retry (synchronous)
if (!tokMkv.src.includes("tc=1")) throw new Error(`tc retry must fire: ${tokMkv.src}`);
if (!tokMkv.src.includes("dsh_tok=TOK-A")) throw new Error(`tc retry must KEEP the token: ${tokMkv.src}`);
console.log("✓ tc retry keeps dsh_tok:", tokMkv.src);

// (e) Mint failure → degrade to the bare URL (older host / network down).
fetchMode = "reject";
const tokFailFence = makeCodeBlock("video", '```video\n{"path":"/tmp/media/tok-fail.mp4"}\n```');
body.appendChild(tokFailFence);
mutate();
await flush();
const tokFail = [...body.querySelectorAll("video")].find((v) => v.src.includes("tok-fail.mp4"));
if (!tokFail) throw new Error("token test: fail-case video not mounted");
if (tokFail.src.includes("dsh_tok")) {
  throw new Error(`mint failure must degrade to the bare src, got: ${tokFail.src}`);
}
console.log("✓ mint failure degrades to the bare URL (no token)");

// (f) Secret rotation self-heals: a non-transcodable retry forces a re-mint and
// swaps in the fresh token.
fetchMode = "ok";
nextTok = "TOK-B";
const rotFence = makeCodeBlock("video", '```video\n{"path":"/tmp/media/tok-rot.mp4"}\n```');
body.appendChild(rotFence);
mutate();
await flush();
const rotV = [...body.querySelectorAll("video")].find((v) => v.src.includes("tok-rot.mp4"));
if (!rotV) throw new Error("token test: rotation video not mounted");
if (!rotV.src.includes("dsh_tok=TOK-B")) throw new Error(`rotation: initial token missing: ${rotV.src}`);
nextTok = "TOK-C"; // the host rotated the secret; the cached TOK-B is now stale
rotV.dispatchEvent("error"); // non-transcodable → schedules the 800ms re-mint retry
await new Promise((r) => setImmediate(r)); // let failOnce schedule the timer
const retryTimer = windowStub.__timers.at(-1);
if (typeof retryTimer !== "function") throw new Error("rotation: retry timer was not scheduled");
retryTimer(); // fire the 800ms retry → forced re-mint
await flush(); // the re-mint fetch + src swap settle in microtasks
if (!rotV.src.includes("dsh_tok=TOK-C")) {
  throw new Error(`rotated secret must self-heal via re-mint, got: ${rotV.src}`);
}
if (rotV.src.includes("TOK-B")) {
  throw new Error(`stale token must be replaced, got: ${rotV.src}`);
}
console.log("✓ secret rotation self-heals via forced re-mint:", rotV.src);

globalThis.fetch = realFetch; // restore the real (absent) fetch for dispose

// ---------------------------------------------------------------------------
// Scenario 25: settle re-render inserts the replacement wrapper AFTER the
// surviving figure (the REAL React ordering — the settle parse keys markdown
// blocks by array index while the streaming parse keys them by absolute text
// offset, so on settle React deletes every block after the first and re-inserts
// the new wrapper before its next *known* sibling, which sits AFTER our
// figure). The figure ends up stranded BEFORE the new wrapper, the
// adjacent-sibling adoption cannot see it, and a naive second mount would
// double the media. The stranded duplicate must be evicted: one fence ⇒ one
// mount, mounted after the settled wrapper.
// ---------------------------------------------------------------------------

// (a) img fence with trailing content: early mount, then the settle swap.
const staleMsg = new FakeElement("div");
body.appendChild(staleMsg);
const settleLead = new FakeElement("p");
settleLead.textContent = "lead";
const settleFence1 = makeCodeBlock("img", '```img\n{"path":"/tmp/media/settle_dup.png"}\n```', { withInfostring: "" });
const settleTail = new FakeElement("p");
settleTail.textContent = "after fence";
staleMsg.appendChild(settleLead);
staleMsg.appendChild(settleFence1);
staleMsg.appendChild(settleTail);
mutate(); // fence has a following sibling → early mount
if (staleMsg.querySelectorAll(".img-preview-grid").length !== 1) {
  throw new Error("settle-dup: early streaming fence must mount exactly once");
}
const earlyGrid = staleMsg.children[staleMsg.children.indexOf(settleFence1) + 1];
if (!earlyGrid || earlyGrid.className !== "img-preview-grid") throw new Error("settle-dup: early img mount missing");
// Settle: React deletes the old wrapper and inserts the new one AFTER the
// surviving figure (its next known fiber sibling is the trailing paragraph).
staleMsg.children.splice(staleMsg.children.indexOf(settleFence1), 1);
settleFence1.parentElement = null;
const settleFence2 = makeCodeBlock("img", '```img\n{"path":"/tmp/media/settle_dup.png"}\n```'); // settled: infostring = "img"
const afterGridIdx = staleMsg.children.indexOf(earlyGrid) + 1;
staleMsg.children.splice(afterGridIdx, 0, settleFence2);
settleFence2.parentElement = staleMsg;
mutate([{ type: "childList", addedNodes: [settleFence2] }]); // observer sees the new wrapper
const gridsAfter = staleMsg.querySelectorAll(".img-preview-grid");
if (gridsAfter.length !== 1) {
  throw new Error(`settle-dup: one fence must show ONE image, got ${gridsAfter.length} grids`);
}
if (gridsAfter[0] === earlyGrid) throw new Error("settle-dup: the stranded figure must be evicted");
const newGrid = settleFence2.nextElementSibling;
if (!newGrid || newGrid.className !== "img-preview-grid") {
  throw new Error("settle-dup: the mount must sit directly after the settled wrapper");
}
if (settleFence2.style.display !== "none") throw new Error("settle-dup: settled wrapper must be hidden");
mutate([]); // a later full scan (3s fallback) must not resurrect a duplicate
if (staleMsg.querySelectorAll(".img-preview-grid").length !== 1) {
  throw new Error("settle-dup: a later full scan must not duplicate the mount");
}
console.log("✓ settle re-render behind the figure: stale duplicate evicted, single image");

// (b) same ordering on a video fence — the stranded player is torn down and a
// single fresh player sits after the settled wrapper.
const staleVMsg = new FakeElement("div");
body.appendChild(staleVMsg);
const settleVLead = new FakeElement("p");
settleVLead.textContent = "vlead";
const vFence1 = makeCodeBlock("video", '```video\n{"path":"/tmp/media/settle_vid.mp4"}\n```', { withInfostring: "" });
const vTail = new FakeElement("p");
vTail.textContent = "vtail";
staleVMsg.appendChild(settleVLead);
staleVMsg.appendChild(vFence1);
staleVMsg.appendChild(vTail);
mutate();
await flush(); // token gate settles; the early player arms its load
const vEarlyFig = staleVMsg.children[staleVMsg.children.indexOf(vFence1) + 1];
if (!vEarlyFig || vEarlyFig.querySelectorAll("video").length !== 1) {
  throw new Error("settle-dup video: early player mount missing");
}
staleVMsg.children.splice(staleVMsg.children.indexOf(vFence1), 1);
vFence1.parentElement = null;
const vFence2 = makeCodeBlock("video", '```video\n{"path":"/tmp/media/settle_vid.mp4"}\n```');
const vAfterIdx = staleVMsg.children.indexOf(vEarlyFig) + 1;
staleVMsg.children.splice(vAfterIdx, 0, vFence2);
vFence2.parentElement = staleVMsg;
mutate([{ type: "childList", addedNodes: [vFence2] }]);
await flush();
const vFigs = staleVMsg.querySelectorAll(".dsh-media-player");
if (vFigs.length !== 1) {
  throw new Error(`settle-dup video: one fence must show ONE player, got ${vFigs.length}`);
}
if (vFigs[0] === vEarlyFig) throw new Error("settle-dup video: the stranded player must be evicted");
const newFig = vFence2.nextElementSibling;
if (!newFig || newFig.className !== "dsh-media-player") {
  throw new Error("settle-dup video: the player must sit after the settled wrapper");
}
console.log("✓ settle re-render behind the figure: stale duplicate evicted, single player");

// (c) deliberate duplicates: two IDENTICAL fences in one settled message are
// two real mounts — a mount owned by a live wrapper must never be evicted.
const dupMsg = new FakeElement("div");
body.appendChild(dupMsg);
const dupA = makeCodeBlock("img", '```img\n{"path":"/tmp/media/twice.png"}\n```');
const dupB = makeCodeBlock("img", '```img\n{"path":"/tmp/media/twice.png"}\n```');
dupMsg.appendChild(dupA);
dupMsg.appendChild(dupB);
mutate();
if (dupMsg.querySelectorAll(".img-preview-grid").length !== 2) {
  throw new Error("two identical img fences in one message must BOTH keep their mounts");
}
console.log("✓ deliberate duplicate fences keep their own mounts (owner alive)");

// ---------------------------------------------------------------------------
// Scenario 12: dispose stops everything
// ---------------------------------------------------------------------------

mod.dispose();
console.log("✓ dispose OK");

console.log("\nALL CLIENT SMOKE TESTS PASSED");
