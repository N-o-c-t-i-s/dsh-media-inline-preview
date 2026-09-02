/**
 * DSH Media Inline Preview — all-in-one client half (browser).
 *
 * Detects ```img / ```video / ```audio fences in the session DOM and renders
 * them inline in the chat:
 *  - img   → image cards (thumbnails, single-click lightbox with zoom/pan,
 *            multi-image grids; ported from the local img-preview copy,
 *            including its UX customizations)
 *  - video → native <video> player (Range seeking, transcode fallback)
 *  - audio → native <audio> player (Range seeking, transcode fallback)
 *
 * Registration protocol: window.__ModuleLoader__.load({id, factory}).
 *
 * Fence discovery (collision-free, three tiers):
 *  1. infostring element text is exactly "img"/"video"/"audio" — the real
 *     chat DOM (div.md-code-block > div.infostring) carries the fence
 *     language once the block settles; while streaming the infostring is
 *     empty, so this tier never matches half-streamed fences.
 *  2. block text opens with ```img / ```video / ```audio (surfaces that keep
 *     the literal fence tag in the text).
 *  3. JSON-spec fallback: the body parses to a media spec and the kind is
 *     inferred from the path extension (disjoint extension sets), so a bare
 *     JSON body never cross-triggers another media kind.
 *  Streaming: blocks inside [data-streaming] mount EARLY only when the fence
 *  itself is settled — its JSON spec parses completely AND the block has a
 *  following element sibling (an unclosed fence swallows everything after
 *  it, so a following sibling proves the fence is closed and frozen by the
 *  frontend's incremental renderer, which reuses that element across
 *  re-renders — so the mount survives until the message settles). A fence
 *  that is the last block so far has no following sibling and waits for the
 *  next chunk or the message to settle, exactly as before. A
 *  `_dshMediaMounted` marker on injected figures prevents double-mounting
 *  across the streaming→settled re-render. Code elements nested inside a
 *  wrapper are skipped (the wrapper is the single mount target).
 *
 * Playback failure path (video/audio): on player error (or no metadata within
 * the grace window) the client retries once — ?tc=1 for containers the browser
 * cannot decode, the same source after a short pause otherwise (transient
 * network hiccups) — then swaps the player for an error card. The load is
 * deferred while the document is hidden (browsers throttle hidden-tab media
 * fetches), and a mount that survives a detach/reattach cycle re-arms its load
 * via _dshMediaResume (the virtualization zombie case).
 *
 * Media tokens (video, scheme B-prime-prime): the Android system media
 * pipeline (stagefright) fetches media with its own cookie-less HTTP stack,
 * so it can never pass a cookie gate — the URL query is the only credential
 * it can carry. For video mounts whose source is our media route, the client
 * mints a file-scoped token (GET /token?path=, one cached request per file)
 * and appends ?dsh_tok= to the src BEFORE the first real load (the lazy-load
 * start is gated on the mint). The failure retry forces a re-mint so a
 * rotated secret self-heals. Audio/img are untouched (their fetches run in
 * the page stack and keep the cookie). Any mint failure degrades to the bare
 * URL — identical to the pre-token behavior.
 */

window.__ModuleLoader__.load({
  id: "dsh-media-inline-preview",
  factory: (require) => {
    "use strict";

    const FILES_BASE = "/plugins/dsh-media-inline-preview/files";
    const MEDIA_BASE = "/plugins/dsh-media-inline-preview/media";
    const TOKEN_BASE = "/plugins/dsh-media-inline-preview/token";
    const TOKEN_PARAM = "dsh_tok";
    const LANGS = ["img", "video", "audio"];

    /** Extensions the browser usually cannot decode; the tc-retry targets. */
    const TRANSCODE_EXTS = new Set([".mkv", ".avi", ".flv", ".wmv", ".mpg", ".mpeg", ".wma", ".mid", ".midi", ".m4b"]);

    /** Kind inference for the JSON-spec fallback tier (disjoint sets; .webm
     * resolves to video — a <video> element plays audio-only webm too). */
    const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|avif|bmp|svg|ico|tga)$/i;
    const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv|ts|3gp|mkv|avi|flv|wmv|mpg|mpeg)$/i;
    const AUDIO_EXT_RE = /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|weba|wma|mid|midi|m4b)$/i;

    // ---------------------------------------------------------------------
    // Spec parsing (shared shape: {path|url, label} or {images:[...]})
    // ---------------------------------------------------------------------

    /**
     * Parse the spec out of a fence body. Accepts a bare JSON body or a body
     * wrapped in ```lang ... ``` fence markers. Tolerates Windows backslash
     * paths (img-preview behavior).
     */
    function parseSpec(body) {
      if (typeof body !== "string") return null;
      let text = body.trim();
      text = text.replace(/^```[a-z]+\s*/i, "").replace(/\s*```\s*$/, "").trim();
      if (text === "") return null;
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        const tolerated = text.replace(/\\(?![\\"bfnrtu])/g, "/");
        try {
          value = JSON.parse(tolerated);
        } catch {
          return null;
        }
      }
      if (value === null || typeof value !== "object") return null;
      const hasPath = typeof value.path === "string" && value.path !== "";
      const hasUrl = typeof value.url === "string" && value.url !== "";
      const hasImages = Array.isArray(value.images) && value.images.length > 0;
      if (!hasPath && !hasUrl && !hasImages) return null;
      return value;
    }

    /** Extract a spec from a block element (banner-mode <pre> first, then full text). */
    function specOfBlock(block) {
      const pre = block.querySelector("pre");
      if (pre) {
        const parsed = parseSpec(pre.textContent ?? "");
        if (parsed !== null) return parsed;
      }
      return parseSpec(block.textContent ?? "");
    }

    /** Normalize one grid entry into {path, url, label} with a valid source. */
    function entryOf(item) {
      if (item === null || typeof item !== "object") return null;
      const path = typeof item.path === "string" ? item.path.trim() : "";
      const url = typeof item.url === "string" ? item.url.trim() : "";
      if (path === "" && url === "") return null;
      const label = typeof item.label === "string" && item.label !== "" ? item.label : undefined;
      return { path, url, label };
    }

    /**
     * Detect the fence language of a settled block, or null. Tier order:
     * infostring → literal ```tag → JSON-spec extension inference.
     */
    function detectLang(block) {
      // Tier 1: infostring (real chat DOM) — exact match on settled blocks.
      const info = block.querySelector("[class*='infostring']");
      if (info !== null) {
        const infoText = (info.textContent ?? "").trim();
        if (infoText !== "") return infoText === "img" || infoText === "video" || infoText === "audio" ? infoText : null;
      }
      // Tier 2: literal fence tag at the start of the text.
      const text = (block.textContent ?? "").trim();
      const tagMatch = /^```(img|video|audio)\b/i.exec(text);
      if (tagMatch !== null) return tagMatch[1].toLowerCase();
      // Tier 3: JSON spec with an inferrable media kind.
      const spec = specOfBlock(block);
      if (spec === null) return null;
      if (Array.isArray(spec.images) && spec.images.length > 0) return "img";
      const p = typeof spec.path === "string" ? spec.path : "";
      if (p === "" && typeof spec.url === "string") return "img"; // url-only specs are images
      if (IMG_EXT_RE.test(p)) return "img";
      if (VIDEO_EXT_RE.test(p)) return "video";
      if (AUDIO_EXT_RE.test(p)) return "audio";
      return null;
    }

    // ---------------------------------------------------------------------
    // URL builders
    // ---------------------------------------------------------------------

    /** Encode an absolute image path into a servable URL under the files route. */
    function imageUrlFor(raw) {
      if (raw.startsWith(FILES_BASE + "/")) return raw;
      const forward = raw.replace(/\\/g, "/");
      const enc = forward.split("/").map((seg) => encodeURIComponent(seg)).join("/");
      return `${FILES_BASE}/${enc}`;
    }

    /** Encode an absolute media path into a servable URL under the media route. */
    function mediaUrlFor(raw) {
      if (raw.startsWith(MEDIA_BASE + "/")) return raw;
      const forward = raw.replace(/\\/g, "/");
      const enc = forward.split("/").map((seg) => encodeURIComponent(seg)).join("/");
      return `${MEDIA_BASE}/${enc}`;
    }

    /** Append the transcode query param idempotently. */
    function withTranscode(url) {
      return url + (url.includes("?") ? "&" : "?") + "tc=1";
    }

    /** Append a file-scoped media token to a media URL (coexists with ?tc=1). */
    function withToken(url, tok) {
      return url + (url.includes("?") ? "&" : "?") + TOKEN_PARAM + "=" + encodeURIComponent(tok);
    }

    /**
     * File-scoped media tokens (scheme B″). The Android system media pipeline
     * (stagefright) fetches with its own cookie-less HTTP stack and cannot
     * pass a cookie gate; the URL query is the only credential it can carry.
     * The token is minted by the page stack (which IS authenticated) via the
     * /token route and cached per file — one request per file per page load.
     * Any failure (older host without the route, network) resolves to null and
     * the caller keeps the bare URL (degrades to pre-token behavior).
     */
    const tokenCache = new Map(); // abs path → { tok, pending }
    function fetchMediaToken(path, force) {
      if (typeof fetch !== "function" || typeof path !== "string" || path === "") {
        return Promise.resolve(null);
      }
      if (!force) {
        const hit = tokenCache.get(path);
        if (hit !== undefined) {
          return hit.pending !== null ? hit.pending : Promise.resolve(hit.tok);
        }
      }
      const pending = fetch(TOKEN_BASE + "?path=" + encodeURIComponent(path), { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          const tok = data !== null && typeof data === "object" && typeof data.tok === "string" ? data.tok : null;
          tokenCache.set(path, { tok, pending: null });
          return tok;
        })
        .catch(() => {
          tokenCache.set(path, { tok: null, pending: null });
          return null;
        });
      tokenCache.set(path, { tok: null, pending });
      return pending;
    }

    /** Extension of a spec path, lowercased ("" when none). */
    function extOfPath(path) {
      const i = path.lastIndexOf(".");
      if (i === -1) return "";
      return path.slice(i).toLowerCase();
    }

    /**
     * File name of a path or URL (query/fragment stripped, backslashes
     * normalized). User preference: captions/titles show ONLY the file name,
     * never the spec label.
     */
    function baseNameOf(raw) {
      if (typeof raw !== "string" || raw === "") return "";
      let s = raw.split("?")[0].split("#")[0].replace(/\\/g, "/");
      const i = s.lastIndexOf("/");
      return i === -1 ? s : s.slice(i + 1);
    }

    // ---------------------------------------------------------------------
    // Image rendering (ported from the local img-preview copy)
    // ---------------------------------------------------------------------

    /**
     * Standalone lightbox viewer: opens an image in a fullscreen overlay with
     * free zoom (wheel, around cursor) and pan (drag). Touch: two-finger
     * pinch zooms around the midpoint and a two-finger drag pans (single
     * finger pans too). Single tap on the thumbnail opens it; inside,
     * double-tap/click toggles between 100% and a zoomed view.
     * ESC / × / backdrop click closes. The title bar shows only the file name.
     */
    function openLightbox(src) {
      const overlay = document.createElement("div");
      overlay.className = "img-preview-lightbox";
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483000;background:rgba(8,10,14,0.94);" +
        "display:flex;flex-direction:column;align-items:stretch;";

      const stage = document.createElement("div");
      stage.style.cssText =
        "position:relative;flex:1;min-height:0;overflow:hidden;touch-action:none;cursor:grab;";

      const img = document.createElement("img");
      img.src = src;
      img.alt = baseNameOf(src) || "image";
      img.draggable = false;
      img.style.cssText =
        "position:absolute;left:50%;top:50%;max-width:none;max-height:none;" +
        "user-select:none;-webkit-user-drag:none;will-change:transform;";

      const hint = document.createElement("div");
      hint.style.cssText =
        "position:absolute;bottom:12px;left:50%;transform:translateX(-50%);padding:4px 12px;" +
        "border-radius:999px;background:rgba(0,0,0,0.55);color:#c9ced8;font:12px/1.6 system-ui,sans-serif;" +
        "pointer-events:none;white-space:nowrap;";
      let coarse = false;
      try {
        coarse = window.matchMedia("(pointer: coarse)").matches;
      } catch { /* non-standard env */ }
      hint.textContent = coarse
        ? "双指缩放 · 拖动平移 · 双击切换 · 点 ✕ 关闭"
        : "滚轮缩放 · 拖拽平移 · 双击切换 · ESC 关闭";
      stage.appendChild(img);
      stage.appendChild(hint);

      // ---- zoom / pan state ----
      let scale = 1;
      let tx = 0;
      let ty = 0;
      const MIN_SCALE = 0.05;
      const MAX_SCALE = 20;

      const apply = () => {
        img.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(${scale})`;
        zoomLabel.textContent = `${Math.round(scale * 100)}%`;
      };

      /** Zoom by `factor` keeping the stage-space point (px, py) fixed. */
      const zoomAt = (factor, px, py) => {
        const rect = stage.getBoundingClientRect();
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const sx = px === undefined ? cx : px - rect.left;
        const sy = py === undefined ? cy : py - rect.top;
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
        const r = next / scale;
        tx = (sx - cx) * (1 - r) + tx * r;
        ty = (sy - cy) * (1 - r) + ty * r;
        scale = next;
        apply();
      };

      /** Fit the image into the viewport (aspect-preserving), centered. */
      const fit = () => {
        const rect = stage.getBoundingClientRect();
        const nw = img.naturalWidth || rect.width;
        const nh = img.naturalHeight || rect.height;
        if (nw === 0 || nh === 0) return;
        scale = Math.min(rect.width / nw, rect.height / nh, 1);
        tx = 0;
        ty = 0;
        apply();
      };
      const reset = () => {
        scale = 1;
        tx = 0;
        ty = 0;
        apply();
      };

      // wheel: zoom around the cursor (prevent page scroll).
      stage.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
        },
        { passive: false }
      );

      // Pointer-driven pan + pinch (pointer events cover mouse and touch):
      //  - one pointer  → drag pans;
      //  - two pointers → distance ratio zooms around the midpoint AND the
      //    midpoint's movement pans, so two fingers down can move the image
      //    freely in all four directions (mobile requirement).
      const pointers = new Map();
      let dragging = false;
      let startX = 0;
      let startY = 0;
      let origTx = 0;
      let origTy = 0;
      let pinchDist = 0;
      let pinchMid = null;
      const twoPtr = () => {
        const vals = [...pointers.values()];
        const a = vals[0];
        const b = vals[1];
        return {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        };
      };
      stage.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        try {
          stage.setPointerCapture(e.pointerId);
        } catch { /* detached stage */ }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
          dragging = true;
          startX = e.clientX;
          startY = e.clientY;
          origTx = tx;
          origTy = ty;
          stage.style.cursor = "grabbing";
        } else if (pointers.size === 2) {
          dragging = false;
          const t = twoPtr();
          pinchDist = t.dist;
          pinchMid = t.mid;
        }
      });
      stage.addEventListener("pointermove", (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          const t = twoPtr();
          if (pinchDist > 0 && t.dist > 0) zoomAt(t.dist / pinchDist, t.mid.x, t.mid.y);
          if (pinchMid !== null) {
            tx += t.mid.x - pinchMid.x;
            ty += t.mid.y - pinchMid.y;
            apply();
          }
          pinchDist = t.dist;
          pinchMid = t.mid;
        } else if (dragging) {
          tx = origTx + (e.clientX - startX);
          ty = origTy + (e.clientY - startY);
          apply();
        }
      });
      const endPointer = (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.delete(e.pointerId);
        if (pointers.size < 2) {
          pinchDist = 0;
          pinchMid = null;
        }
        if (pointers.size === 1) {
          // hand off to single-finger pan from the remaining pointer.
          const [p] = [...pointers.values()];
          dragging = true;
          startX = p.x;
          startY = p.y;
          origTx = tx;
          origTy = ty;
        } else if (pointers.size === 0) {
          dragging = false;
          stage.style.cursor = "grab";
        }
      };
      stage.addEventListener("pointerup", endPointer);
      stage.addEventListener("pointercancel", endPointer);

      // double-click: toggle 100% <-> 2.5x.
      stage.addEventListener("dblclick", (e) => {
        e.preventDefault();
        if (Math.abs(scale - 1) < 0.01) {
          zoomAt(2.5, e.clientX, e.clientY);
        } else {
          reset();
        }
      });

      // ---- toolbar ----
      const bar = document.createElement("div");
      bar.style.cssText =
        "display:flex;align-items:center;gap:8px;padding:10px 14px;flex-wrap:wrap;" +
        "background:rgba(20,22,28,0.92);border-bottom:1px solid rgba(255,255,255,0.08);";

      const btnStyle =
        "border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);" +
        "color:#e6e9ee;border-radius:8px;padding:5px 12px;font:13px/1.4 system-ui,sans-serif;" +
        "cursor:pointer;";
      const makeBtn = (text, onClick, title) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.title = title ?? "";
        b.style.cssText = btnStyle;
        b.addEventListener("click", onClick);
        return b;
      };

      const zoomLabel = document.createElement("span");
      zoomLabel.style.cssText = "color:#c9ced8;font:12px/1.4 system-ui,monospace;min-width:44px;text-align:center;";

      const title = document.createElement("span");
      title.style.cssText = "color:#9aa1ad;font:12px/1.4 system-ui,sans-serif;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;";
      // File name only — never the spec label or the raw URL.
      title.textContent = baseNameOf(src) || "image";

      bar.appendChild(title);
      bar.appendChild(makeBtn("−", () => zoomAt(1 / 1.3), "缩小"));
      bar.appendChild(zoomLabel);
      bar.appendChild(makeBtn("＋", () => zoomAt(1.3), "放大"));
      bar.appendChild(makeBtn("适应", fit, "适应窗口"));
      bar.appendChild(makeBtn("100%", reset, "原始大小"));
      bar.appendChild(makeBtn("✕", close, "关闭 (ESC)"));

      overlay.appendChild(bar);
      overlay.appendChild(stage);
      document.body.appendChild(overlay);

      // ---- close ----
      let closed = false;
      function close() {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", onKey);
        overlay.remove();
      }
      function onKey(e) {
        if (e.key === "Escape") close();
      }
      document.addEventListener("keydown", onKey);

      // backdrop click closes (ignore clicks on the image/toolbar).
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close();
      });

      img.addEventListener("load", fit);
      // initial paint: wait for load (or immediate if cached).
      if (img.complete && img.naturalWidth > 0) fit();
      apply();
    }

    /**
     * Build one image card. On load error shows a message + the source path.
     * Single click opens the standalone lightbox viewer.
     */
    function buildCard(entry, index) {
      const card = document.createElement("figure");
      card.style.cssText =
        "margin:0;display:flex;flex-direction:column;gap:4px;min-width:0;" +
        (index === 0 ? "" : "max-width:360px;flex:1 1 240px;");
      card.className = "img-preview-card";

      const wrap = document.createElement("div");
      wrap.style.cssText =
        "position:relative;overflow:hidden;border-radius:10px;background:#101216;" +
        "display:flex;align-items:center;justify-content:center;min-height:120px;";

      const img = document.createElement("img");
      img.alt = baseNameOf(entry.path || entry.url) || "image";
      img.title = "单击查看大图（缩放 · 平移）";
      img.style.cssText =
        "display:block;width:100%;height:auto;max-height:560px;object-fit:contain;cursor:zoom-in;";
      if (index > 0) img.loading = "lazy";

      const fail = () => {
        wrap.innerHTML = "";
        const msg = document.createElement("div");
        msg.style.cssText =
          "padding:14px 16px;color:#f87171;font:12px/1.6 system-ui,monospace;word-break:break-all;";
        msg.textContent = `⚠️ img 加载失败：${entry.path || entry.url}`;
        wrap.appendChild(msg);
      };
      img.addEventListener("error", fail);
      img.addEventListener("click", () => {
        const target = img.currentSrc || img.src;
        if (target) openLightbox(target);
      });
      wrap.appendChild(img);

      card.appendChild(wrap);

      // Caption is always the file name (user preference: no label text).
      const name = baseNameOf(entry.path || entry.url);
      if (name !== "") {
        const caption = document.createElement("figcaption");
        caption.textContent = name;
        caption.style.cssText =
          "color:var(--dsw-alias-label-secondary,#9aa1ad);font:12px/1.5 system-ui,sans-serif;" +
          "padding:0 2px;word-break:break-word;";
        card.appendChild(caption);
      }
      return card;
    }

    /** Mount an img spec: grid container after the block, source hidden. */
    function mountImg(block, spec) {
      const container = document.createElement("div");
      container.className = "img-preview-grid";
      container.style.cssText =
        "display:flex;flex-wrap:wrap;gap:10px;margin:8px 0;align-items:flex-start;";
      container._dshMediaMounted = true; // dedup marker (see processBlock)

      const entries = [];
      if (typeof spec.path === "string" && spec.path !== "") {
        entries.push({ path: spec.path, url: typeof spec.url === "string" ? spec.url : "", label: spec.label });
      } else if (typeof spec.url === "string" && spec.url !== "") {
        entries.push({ path: "", url: spec.url, label: spec.label });
      } else {
        for (const item of spec.images ?? []) {
          const entry = entryOf(item);
          if (entry !== null) entries.push(entry);
        }
      }

      if (entries.length === 0) {
        const note = document.createElement("div");
        note.style.cssText = "padding:10px 14px;color:#e2a14b;font:12px/1.6 system-ui,monospace;";
        note.textContent = "img 栅栏缺少有效图片路径";
        container.appendChild(note);
        block.after(container);
        block.style.display = "none";
        return;
      }

      entries.forEach((entry, index) => {
        const card = buildCard(entry, index);
        container.appendChild(card);
        const src = entry.url !== "" ? entry.url : imageUrlFor(entry.path);
        const img = card.querySelector("img");
        if (img) img.src = src;
      });

      block.after(container);
      block.style.display = "none";
    }

    // ---------------------------------------------------------------------
    // Video / audio rendering
    // ---------------------------------------------------------------------

    /** Build the figure wrapper holding the player + caption. */
    function buildPlayerFigure(spec, lang) {
      const player = document.createElement(lang);
      const src = typeof spec.url === "string" && spec.url !== "" ? spec.url : mediaUrlFor(spec.path);
      player.src = src;
      player.controls = true;
      // Lazy-load: `preload="none"` until the figure scrolls into view (see
      // mountPlayer) — a long session with many media never opens one request
      // per player up front.
      player.preload = "none";
      if (lang === "video") {
        player.playsInline = true;
        player.style.cssText =
          "width:100%;max-width:640px;max-height:480px;min-height:0;display:block;" +
          "border-radius:8px;background:#000;";
      } else {
        player.style.cssText = "width:100%;max-width:640px;display:block;";
      }

      const figure = document.createElement("figure");
      figure.style.cssText =
        "margin:10px 0;padding:10px;border:0;display:flex;flex-direction:column;gap:6px;" +
        "border-radius:10px;background:rgba(128,128,128,0.07);";
      figure.appendChild(player);

      // Caption is always the file name (user preference: no label text).
      const name = baseNameOf(typeof spec.path === "string" ? spec.path : spec.url);
      if (name !== "") {
        const caption = document.createElement("figcaption");
        caption.textContent = name;
        caption.style.cssText =
          "font-size:12px;line-height:1.4;color:rgba(160,160,160,0.9);word-break:break-all;";
        figure.appendChild(caption);
      }
      return { figure, player, src };
    }

    /** Swap the player for a visible error card. */
    function showError(figure, player, spec, reason) {
      const card = document.createElement("div");
      card.style.cssText =
        "display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:8px;" +
        "background:rgba(220,80,60,0.10);border:1px solid rgba(220,80,60,0.35);" +
        "font-size:13px;line-height:1.45;color:inherit;max-width:640px;";
      const head = document.createElement("div");
      head.textContent = `⚠️ 无法播放：${reason}`;
      head.style.fontWeight = "600";
      const pathLine = document.createElement("code");
      pathLine.textContent = spec.path;
      pathLine.style.cssText = "font-size:11px;word-break:break-all;opacity:0.85;";
      card.appendChild(head);
      card.appendChild(pathLine);
      figure.replaceChild(card, player);
    }

    /** Mount a video/audio block: figure after the block, source hidden. */
    function mountPlayer(block, spec, lang) {
      const { figure, player, src } = buildPlayerFigure(spec, lang);
      figure._dshMediaMounted = true; // dedup marker (see processBlock)
      block.after(figure);
      block.style.display = "none";

      const transcodable = TRANSCODE_EXTS.has(extOfPath(spec.path));
      let attempt = 0; // 0 = first load, 1 = retry (tc if transcodable, else same src)
      let done = false; // canplay seen, or error card shown
      let started = false; // real network load kicked off (lazy-load gate)
      let needsResume = false; // load machinery torn down while not done
      let timer = null;
      let io = null;
      let visListener = null;

      // File-scoped media token (video only, scheme B″): the Android system
      // media pipeline (stagefright) fetches with its own cookie-less HTTP
      // stack and cannot carry the session cookie, so the credential rides in
      // the URL query. The page stack (authenticated) mints it; the real load
      // waits for the mint to settle so the first request already carries the
      // token. A missing issuer or a fetch failure keeps the bare src
      // (pre-token behavior — desktop cookie path is unaffected).
      const wantsToken =
        lang === "video" && typeof spec.path === "string" && spec.path !== "" && src.startsWith(MEDIA_BASE + "/");
      let currentSrc = src;
      let lastToken = null;
      const tokenGate = wantsToken
        ? fetchMediaToken(spec.path)
            .then((tok) => {
              if (tok !== null) {
                lastToken = tok;
                currentSrc = withToken(src, tok);
                player.src = currentSrc;
              }
            })
            .catch(() => {})
        : Promise.resolve();

      const clearTimer = () => {
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
      };

      const failOnce = (reason) => {
        if (done) return;
        if (attempt === 0) {
          attempt = 1;
          clearTimer();
          if (transcodable) {
            // Expected path: the browser cannot decode this container — ask
            // the host for a transcoded file; give ffmpeg a long window.
            // currentSrc may already carry ?dsh_tok= — withTranscode appends
            // &tc=1 idempotently on top.
            timer = window.setTimeout(() => {
              if (!done) {
                done = true;
                showError(figure, player, spec, "转码超时（ffmpeg 可能缺失或文件过大）");
              }
            }, 180000);
            player.src = withTranscode(currentSrc);
            player.load();
            return;
          }
          // Not transcodable: the failure is likely transient (connection
          // reset, background-tab throttle, brief stall) — wait a beat, then
          // retry the same source once before giving up. If a token is in
          // play, force a re-mint first: a fresh value (secret rotated)
          // self-heals, a missing/stale one falls through to the plain retry.
          timer = window.setTimeout(() => {
            if (done) return;
            const apply = (s) => {
              player.src = s;
              player.load();
              timer = window.setTimeout(() => failOnce(reason), 15000);
            };
            if (lastToken !== null) {
              fetchMediaToken(spec.path, true)
                .then((fresh) => {
                  if (done) return;
                  if (fresh !== null && fresh !== lastToken) {
                    lastToken = fresh;
                    currentSrc = withToken(src, fresh);
                  }
                  apply(currentSrc);
                })
                .catch(() => {
                  if (!done) apply(currentSrc);
                });
              return;
            }
            apply(currentSrc);
          }, 800);
          return;
        }
        done = true;
        clearTimer();
        showError(figure, player, spec, reason);
      };

      const onError = () => {
        // MediaError.code: 2 = decode error, 4 = source unsupported — but
        // browsers also report 4 for network failures, so treat anything but
        // 2 as a load (network/format) problem.
        const base = player.error?.code === 2
          ? "浏览器无法解码该格式"
          : "无法加载该媒体（网络错误、文件缺失或格式不支持）";
        failOnce(base + (attempt === 1 && transcodable ? "，且转码失败" : ""));
      };
      const onCanPlay = () => {
        if (done) return;
        done = true; // playback works — ignore any late error/timeout
        clearTimer();
      };

      const startLoad = () => {
        if (started || done) return;
        started = true;
        if (io !== null) {
          io.disconnect();
          io = null;
        }
        // Grace window starts NOW — lazy players below the fold must not
        // time out while never having loaded.
        player.preload = "metadata";
        player.load();
        player.addEventListener("error", onError);
        player.addEventListener("canplay", onCanPlay);
        player.addEventListener("playing", onCanPlay);
        player.addEventListener("loadedmetadata", onCanPlay);
        // Grace: metadata must arrive quickly; a hang means a network/file
        // problem (the error event covers hard 4xx too).
        timer = window.setTimeout(() => failOnce("加载超时（网络或文件问题）"), 15000);
      };

      const tryStartLoad = () => {
        // The real load must not start before the token mint settles, or the
        // first request would go out credential-less (stagefright → 302).
        // Non-video / no-token mounts resolve this immediately.
        tokenGate.then(() => {
          if (started || done) return;
          if (typeof document !== "undefined" && document.hidden) {
            // Browsers defer media fetches for hidden documents; starting now
            // would burn the grace window for no reason — wait for the tab to
            // become visible (the grace window then starts on the real load).
            const onVis = () => {
              if (document.hidden) return;
              document.removeEventListener("visibilitychange", onVis);
              visListener = null;
              startLoad();
            };
            document.addEventListener("visibilitychange", onVis);
            visListener = onVis;
            return;
          }
          startLoad();
        });
      };

      // Lazy-load: with many media in one session, players below the fold
      // should not each open a metadata request. IntersectionObserver starts
      // the load when the figure nears the viewport; without it (older
      // engines / stubbed tests) we fall straight back to eager loading.
      const armObserver = () => {
        if (typeof IntersectionObserver === "undefined") return null;
        try {
          const obs = new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                if (entry.isIntersecting) {
                  tryStartLoad();
                  break;
                }
              }
            },
            { rootMargin: "300px" }
          );
          obs.observe(figure);
          return obs;
        } catch {
          return null;
        }
      };
      io = armObserver();
      if (io === null) tryStartLoad();

      const cleanup = () => {
        if (io !== null) {
          try {
            io.disconnect();
          } catch { /* detached */ }
          io = null;
        }
        if (visListener !== null) {
          try {
            document.removeEventListener("visibilitychange", visListener);
          } catch { /* detached */ }
          visListener = null;
        }
        if (timer !== null) window.clearTimeout(timer);
        try {
          player.pause();
        } catch { /* detached */ }
        player.removeEventListener("error", onError);
        player.removeEventListener("canplay", onCanPlay);
        player.removeEventListener("playing", onCanPlay);
        player.removeEventListener("loadedmetadata", onCanPlay);
        if (!done) needsResume = true; // torn down while the load was unfinished
      };

      // Re-arm after a detach/reattach cycle (called from processBlock's
      // adoption branch): the figure survived but its load machinery was
      // torn down by cleanup, so rebuild it.
      const resume = () => {
        if (done || !needsResume) return;
        needsResume = false;
        started = false;
        io = armObserver();
        if (io === null) tryStartLoad();
      };
      figure._dshMediaCleanup = cleanup;
      figure._dshMediaResume = resume;
    }

    // ---------------------------------------------------------------------
    // DOM scanning (house pattern: rAF-coalesced incremental observer +
    // low-frequency full fallback)
    // ---------------------------------------------------------------------
    //
    // Real chat DOM (dsh-web-frontend CodeBlock):
    //   div.md-code-block
    //     div.bannerWrap > div.banner > div.infostring (text = fence lang)
    //     pre > code > #text (raw fence body)
    // The inner <pre> ALSO matches the bare `pre` selector, so candidates
    // nested inside a wrapper are skipped — the wrapper is the single mount
    // target.
    //
    // Incremental strategy (media-heavy sessions stay cheap): the
    // MutationObserver callback collects ONLY the inserted nodes (and the
    // block behind characterData changes, e.g. the infostring filling in)
    // into a `pending` set, and the rAF pass scans just those. A 3s fallback
    // interval still runs one full pass to catch anything the observer
    // missed (virtualized/streamed edge cases) and to reap stale handled
    // entries — far cheaper than the old scan-everything-per-mutation loop.

    const BLOCK_SELECTOR = ".md-code-block, .code-block, .code-block-small, pre";
    const WRAPPER_SELECTOR = ".md-code-block, .code-block, .code-block-small";
    const handled = new Map(); // block element -> cleanup fn

    let scheduled = false;
    let fullScanQueued = false;
    const pending = new Set(); // candidate blocks from recent mutations

    /** Normalize a candidate element to its wrapper (the single mount target). */
    function mountTargetOf(el) {
      try {
        const wrapper = el.closest(WRAPPER_SELECTOR);
        if (wrapper !== null) return wrapper;
      } catch { /* older engines: use the element itself */ }
      return el;
    }

    /** Collect inserted nodes (and characterData targets) into `pending`. */
    function collectCandidates(records) {
      for (const record of records) {
        if (record.type === "characterData" && record.target?.parentElement) {
          const block = mountTargetOf(record.target.parentElement);
          if (matchesSelector(block)) pending.add(block);
          continue;
        }
        const added = record.addedNodes;
        if (!added) continue;
        for (const node of added) {
          if (node.nodeType !== 1) continue; // elements only
          if (matchesSelector(node)) {
            pending.add(mountTargetOf(node));
            continue;
          }
          // The inserted node may CONTAIN blocks (chat app inserts whole
          // message divs); sweep only its descendants, not the whole doc.
          try {
            for (const sub of node.querySelectorAll(BLOCK_SELECTOR)) {
              pending.add(mountTargetOf(sub));
            }
          } catch { /* detached */ }
        }
      }
    }

    function matchesSelector(el) {
      try {
        return el.matches(BLOCK_SELECTOR);
      } catch {
        return false;
      }
    }

    function schedule(records) {
      if (records !== void 0 && records.length > 0) {
        collectCandidates(records);
      } else {
        // No records (stub env / interval fallback) → full pass.
        fullScanQueued = true;
      }
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (fullScanQueued) {
          fullScanQueued = false;
          scan();
        } else {
          scanPending();
        }
      });
    }

    /** Full pass over every block in the document. */
    function scan() {
      let blocks;
      try {
        blocks = document.querySelectorAll(BLOCK_SELECTOR);
      } catch {
        return;
      }
      reapHandled();
      for (const block of blocks) processBlock(block);
    }

    /** Incremental pass over only the blocks queued by recent mutations. */
    function scanPending() {
      reapHandled();
      const blocks = [...pending];
      pending.clear();
      for (const block of blocks) processBlock(block);
    }

    /** Remove handled entries whose element left the document (chat
     * virtualization) — cheap enough for the 3s fallback pass. */
    function reapHandled() {
      for (const [el, teardown] of handled) {
        if (el.isConnected === false || el.parentElement === null) {
          try {
            teardown(); // release the detached mount's timers / observers
          } catch { /* detached */ }
          handled.delete(el);
        }
      }
    }

    /** Try to mount one fence block; no-op when already handled/skipped. */
    function processBlock(block) {
      if (handled.has(block)) return;
      // Single mount target per fence: skip code elements nested inside a
      // wrapper — the wrapper carries the infostring and is what we mount.
      let wrapper = null;
      try {
        wrapper = block.closest(WRAPPER_SELECTOR);
      } catch { /* older engines: treat as standalone */ }
      if (wrapper !== null && wrapper !== block) return;
      // Dedup guard: a streaming→settled re-render can replace the wrapper
      // node while the figure we injected survives right after it — adopt the
      // existing mount instead of creating a second one.
      const existing = block.nextElementSibling;
      if (existing !== null && existing._dshMediaMounted === true) {
        block.style.display = "none"; // adopted mount shows the media, not the source
        if (typeof existing._dshMediaResume === "function") existing._dshMediaResume();
        handled.set(block, () => {
          try {
            if (existing._dshMediaCleanup) existing._dshMediaCleanup();
          } catch { /* detached */ }
        });
        return;
      }
      // Streaming gate (relaxed): while the message is still streaming, only
      // mount fences that are definitely settled. An unclosed fence swallows
      // everything after it, so a following element sibling proves this fence
      // is closed — and the frontend's incremental renderer freezes closed
      // blocks (same React element reused across re-renders), so the mount
      // survives until the message settles. A fence that is the last block so
      // far has no following sibling and waits for the next chunk or settle,
      // exactly as before.
      if (block.closest("[data-streaming]") !== null && block.nextElementSibling === null) return;
      const lang = detectLang(block);
      if (lang === null) return;
      const spec = specOfBlock(block);
      if (spec === null) return; // half-streamed or malformed; retry later
      if (lang === "img") {
        mountImg(block, spec);
      } else {
        mountPlayer(block, spec, lang);
      }
      handled.set(block, () => {
        try {
          const fig = block.nextElementSibling;
          if (fig && fig._dshMediaCleanup) fig._dshMediaCleanup();
        } catch { /* detached */ }
      });
    }

    let observer = null;
    let interval = null;

    const apply = () => {
      if (observer) return;
      observer = new MutationObserver((records) => schedule(records));
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
      interval = window.setInterval(() => schedule(void 0), 3000);
      scan();
    };
    const dispose = () => {
      if (observer) observer.disconnect();
      if (interval !== null) window.clearInterval(interval);
      observer = null;
      interval = null;
      pending.clear();
      fullScanQueued = false;
      for (const cleanup of handled.values()) {
        try {
          cleanup();
        } catch { /* detached */ }
      }
      handled.clear();
    };

    return {
      apply,
      inject: ["sessions"],
      dispose
    };
  }
});
