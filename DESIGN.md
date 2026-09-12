# dsh-media-inline-preview 设计方案

> 自研 DSH 一体化插件：让模型回复中的 `img` / `video` / `audio` 围栏在聊天消息里
> 内联渲染——图片卡片（lightbox/网格/TGA 转码）、原生 `<video>` / `<audio>` 播放器。
> 与 dsh-mermaid（mermaid 围栏）、pbr-render（pbr3d 围栏）同一套 house pattern。
> **合并并取代**原 img-preview（img 围栏）与独立的 video/audio 围栏插件。

## 0. 合并决策（2026-08-27）

用户要求把 img-preview 的功能并入同一个"全能型"插件。决策要点：

- **一个插件、三种围栏、一个扫描循环**。client 单 observer/单 interval/单 `handled` Map，
  检测一次分派渲染（img 卡片 vs 播放器 figure）。
- **两个工具**：`mip_img`（图片）+ `mip_media`（视频/音频）——各自参数/返回形状最小。
  v1.4.0 起工具名带命名空间：**工具名是全局注册的**，`img_serve`/`media_serve` 这类通用名与
  第三方 img-preview 插件**完全同名**（硬冲突，比围栏标签更严重），故与围栏标签一并改名。
- **保留两条路由**（各自独立，互不影响）：
  - `/plugins/dsh-media-inline-preview/files`（图片：整读 128 MiB、TGA→PNG、ACAO *）
  - `/plugins/dsh-media-inline-preview/media`（媒体：流式 Range 2 GiB、`?tc=1` 转码）
  两条路由前缀不同，webServer 前缀路由天然隔离；URL 编码方案也各自沿用（files 整串
  decode、media 按段 decode），把移植 bug 面降到最小。
- **冲突分析（合并的核心风险）**：原 img-preview client 的宽松兜底——"body 能解析成
  带 `path` 的 JSON 就当图片"——会**把 video/audio 围栏误认成图片**（`{"path":"x.mp4"}`
  是合法 img spec 形状）。因此合并版的检测改为**三级防冲突**：
  1. infostring 文本恰为 `mip-img`/`mip-video`/`mip-audio`（真实 DOM 主检测，流式期间 infostring 为空）；
  2. 文本以 ```` ```mip-img ```` / ```` ```mip-video ```` / ```` ```mip-audio ```` 开头（字面标签兜底）；
  3. JSON spec 按 `path` 扩展名在**互斥扩展名集合**里推断种类（裸 JSON 体也不会跨类误触发；
     `.webm` 归 video——`<video>` 元素可播纯音频 webm）。
  代价：img-preview 对"裸 ```json 围栏里的 img spec"的宽松识别被收窄为"扩展名可推断才认"，
  与 video/audio 行为一致，且 systemPrompt 教学始终用显式 ```mip-img 围栏，无实际损失。
- **标签命名空间（v1.4.0，破坏性）**：围栏标签改名为 `mip-img` / `mip-video` / `mip-audio`，旧的
  裸标签 `img` / `video` / `audio` **不再识别**。原因是实测发现第三方 `img-preview` 插件发的就是
  ```` ```img ````（本插件正是从它移植而来），而 DSH 核心**没有围栏注册表**、也没有客户端插件的
  标签仲裁——每个插件各自扫 DOM，两个认领者会**双双挂载**，一个围栏显示两份媒体。命名空间是
  生态里的既有做法（如 `@bhzhangsun/dsh-media` 用 ```` ```dsh-media ````）。附带实现要点：正文里
  fence 标记的剥离正则必须是 `[a-z][a-z0-9-]*`，`[a-z]+` 会把 `mip-img` 吃成 `mip` 而静默失效。
- **移植而非重写**：TGA 解码器（uncompressed/RLE、8/15/16/24/32 位、调色板、上下/左右翻转）、
  纯 JS PNG 编码器（zlib deflate、CRC32、filter 0）、lightbox（滚轮缩放/拖拽平移/双击切换/
  顶部工具条/底部提示）、卡片+网格渲染，全部**逐行移植自本地 img-preview 副本**（含用户
  定制：单击打开、工具条置顶、无"原图"按钮、提示文字底部居中）——已在线上验证过的代码不重写。
- **img-preview 兼容性**：本插件取代原 img-preview（img 围栏）与独立的 video/audio 围栏插件；不建议与它们并存（并存时 img 围栏会双渲染）。

## 1. 调研结论（借鉴来源）

| 来源 | 借鉴点 |
|---|---|
| **img-preview**（本地参考实现） | 完整骨架：`systemPrompt.section` 注入围栏教学 + `tools.register` 校验工具 + `webServer.register({kind:"prefix"})` 文件路由 + client `__ModuleLoader__.load` + MutationObserver 扫描 + `[data-streaming]` 跳过 + `block.after(container); block.style.display="none"` 挂载；**TGA→PNG 即时转码**；lightbox/网格交互 |
| **pbr-render**（官方） | 同上模式验证；asset 路由（`/plugins/<id>/assets`）；`renderFence` 导出约定（核心并不调用，纯约定） |
| **dsh-mermaid**（官方） | **infostring 检测法**：`block.querySelector("[class*='infostring']")?.textContent?.trim()` 是最可靠的围栏识别；**流式期间 infostring 为空**（lang 被抑制），settle 后才出现——检测天然防流式半截 JSON |
| **better-sidebar trust-fence**（官方插件） | 服务器信任围栏：Host 头必须是 loopback（localhost/127.0.0.0/8/::1）或 `ctx.webRuntime.trustedHosts`（绑定 0.0.0.0 时采样的 LAN IP + `--trusted-host`）；`sec-fetch-site: cross-site` 拒绝；Origin 存在时必须与 Host 一致。**支持 LAN/手机访问**（loopback + trusted-hosts 白名单，img-preview 没有这层，合并版补上） |
| **yichengup/dsh-media-player**（GitHub，v0.2.0） | Range 流式路由参考实现：`bytes=start-end` → 206 + `Content-Range` + `createReadStream({start,end}).pipe(res)`；非法 range → 416 + `bytes */size` |
| **2332239652/dsh-inline-audio**（GitHub） | 音频路径→播放器的 DOM 替换思路；安静降级（不存在的路径静默跳过） |
| **Wisdoverse/dsh-inline-media-viewer**（GitHub） | 自动扫描消息里媒体路径的想法——**不采用**：自动扫描会误伤消息里随口提的路径；显式围栏 + 工具校验更符合本插件的设计哲学 |

不采用的机制及原因：
- dsh-media-player 的 `media_add` 工具事件节点：需要 DSH 认识 `plugin/media-add` 事件类型，官方 DSH 重开旧会话有 `SessionFormatUnsupportedError` 风险（README 自述需改 DSH 源码才能修）——违反"不改 DSH 源码"铁律。**围栏方案没有这个问题**：围栏就是消息 markdown 文本本身，天然持久化、重开即重渲染。
- dsh-media-player 的 `req.socket.remoteAddress` loopback 硬检查：会**切断 LAN/手机访问**，改用 webRuntime.trustedHosts 围栏。

## 2. 围栏语法

```mip-img
{"path":"绝对路径或工作区相对路径","label":"可选标题"}
```
```mip-video
{"path":"...","label":"..."}
```
```mip-audio
{"path":"...","label":"..."}
```

- 与 img 围栏同款 JSON spec；`path` 必填（图片另支持顶层 `url` 与 `{"images":[{path|url,label},...]}` 网格），`label` 可选（渲染为 figcaption/卡片标题）。
- 客户端容忍 Windows 反斜杠路径（先按原样 JSON.parse，失败则把游离反斜杠归一化为正斜杠重试——img-preview 同款容错）。
- 每个围栏一个媒体（图片网格除外）。

## 3. 格式策略（"兼容的格式多" 的落地）

浏览器原生能播的直出，播不了的走 **ffmpeg 转码兜底**（要求宿主环境装有 ffmpeg ≥ 5）：

| 类别 | 扩展名 | 行为 |
|---|---|---|
| 图片 | png jpg jpeg webp gif avif bmp svg ico tga | files 路由整读直出；`.tga` 先解码再即时编码为 PNG 返回（`image/png`） |
| 视频·原生直出 | mp4 webm mov m4v ogv ts 3gp | 直接 Range 流式服务 |
| 视频·转码兜底 | mkv avi flv wmv mpg mpeg | 先按原样直出；`<video>` 触发 error 后客户端自动重试 `?tc=1`，host 用 ffmpeg 转 H.264/AAC mp4 流式返回，成品按 `sha256(path\|size\|mtime)` 缓存到 `~/.dsh/media-cache/` |
| 音频·原生直出 | mp3 wav m4a aac ogg oga flac opus weba | 直接 Range 流式服务 |
| 音频·转码兜底 | wma mid midi m4b | 同上转 AAC m4a |
| 白名单外 | 其他 | 工具报错 / 路由 415 拒绝 |

转码参数：`ffmpeg -nostdin -i in -map 0:v:0 -map 0:a? -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 160k -movflags +faststart -f mp4 out`（音频 `-vn -c:a aac -b:a 192k -f mp4`）。并发控制：同路径在途任务共享同一 Promise（Map 在首个 await 之前同步置入，无双重转码竞态）；10 分钟 SIGKILL 超时；7 天 TTL 每日清理。2 GiB 上限。

## 4. 架构

### host 半（lib/index.js，ESM，零第三方依赖）
- `inject = ["systemPrompt"]`；`apply(ctx)`：
  1. `ctx.systemPrompt.section({name:"dsh-media-inline-preview:fence", order:115, text})` —— 三围栏教学 + **主动触发**规则（下载/生成/转换/用户提到的媒体文件 → 先 `mip_img`/`mip_media` 校验再发围栏，不要问"要不要看"）+ 去重规则。
  2. `tools.register(mip_img)` / `tools.register(mip_media)`：参数 `{path}`；返回 `{ok, [kind], path, url, error}`。校验：路径解析（绝对/相对，multi-root 遍历，**文件缺失回退也过包含检查**，逃逸一律 null）→ 会话 cwd（`exec.agent.session.header.cwd`）优先 + 已注册 workspace 根 + `DSH_WORKSPACE` + cwd → 扩展名白名单 → 文件存在。
  3. `webServer.register({kind:"prefix", path: FILES_ROUTE, handler})`（图片）+ `webServer.register({kind:"prefix", path: MEDIA_ROUTE, handler})`（媒体）：
      - **每个请求先过 trust-fence**（better-sidebar 同款：Host loopback/trustedHosts + sec-fetch-site + Origin 匹配；实现逐行对齐官方 `@deepseek-ai/dsh-client-connection` 的 `isTrustedApiRequest`/`isTrustedAuthority`）；`webRuntime` 服务拿 `trustedHosts`，反射拿不到就退化为纯 loopback 检查（安全侧失败）。
      - 图片路由：`GET/HEAD /<绝对路径>`（整串 decode），200 全量 / 404/403/415/413；TGA→PNG；`ACAO *`（img-preview 兼容）。
      - 媒体路由：`GET/HEAD /<每段 encodeURIComponent 的绝对路径>`：200 全量流 / 206 Range 流（`createReadStream` 切片，内存恒定）；416 处理非法 range。
      - `?tc=1` 查询参数：转码兜底（缓存目录、并发锁、ffmpeg 缺失 → 501 明确文案；原生可播的扩展名带 `?tc=1` → 400）。
      - 响应头：`accept-ranges: bytes`、`cache-control: no-cache`（本地文件会变）。

### client 半（lib/client.js，CJS factory）
- `window.__ModuleLoader__.load({id:"dsh-media-inline-preview", factory})`；factory 返回 `{apply, inject:["sessions"], dispose}`（house 约定）。
- 检测（每帧 rAF 合并 + 1500ms 兜底 interval）：
  - 候选：`.md-code-block, .code-block, .code-block-small, pre`
  - 三级判定（§0 冲突分析）：infostring 精确匹配 → 字面 ```` ```lang ```` 开头 → JSON spec 扩展名推断
  - 跳过 `[data-streaming]` 内的块；跳过嵌套于 wrapper 内的候选（wrapper 才是挂载目标，防双重挂载——img-preview 原版的潜在 bug，合并版已修）；`handled` Map 去重
- 渲染：`block.after(container); block.style.display="none"`
  - **img**：网格容器 `.img-preview-grid` > 卡片（`<img>` 缩略图，单击 → lightbox：全屏 overlay、滚轮缩放（围绕光标）、拖拽平移、双击 100%↔250%、顶部工具条、底部提示"滚轮缩放 · 拖拽平移 · 双击切换 · ESC 关闭"）；加载失败显示 ⚠️ + 路径。
  - **video/audio**：`<figure>` > `<video controls preload="metadata" playsinline>`（`width:100%;max-width:640px;max-height:480px;`）或 `<audio controls preload="metadata">`（`width:100%;max-width:640px;`）+ `<figcaption>`（label 或文件名）。
  - **错误降级**：`<video>/<audio>` `onerror` / 15s 无 `canplay` → 若属可转码扩展名，自动把 src 换成 `?tc=1` 重试一次（转码窗口 180s）；再失败 → 替换为错误卡片（⚠️ + 路径 + 原因），不阻塞聊天。`canplay/playing/loadedmetadata` 任一先到即锁定成功，忽略迟到的 error。
  - src 构造：图片 `/plugins/dsh-media-inline-preview/files/<按段编码的绝对路径>`；媒体 `/plugins/dsh-media-inline-preview/media/<按段编码的绝对路径>`；spec 里已带 url 时直接用。

### 安装面（house 约定）
- `package.json`：`dsh.bundle.patch: ./cordis.patch.yml`；`dsh.client.platform: "web"`；`exports["./client"]`
- `cordis.patch.yml`：`- insert: - id: dsh-media-inline-preview / name: dsh-media-inline-preview`
- 安装：通过插件管理器从源码目录/包安装（受保护安装流程，禁裸 `dsh plugin add`）；host 半（工具/路由/提示词）需重启 web 生效；client 半经 `/plugins/dsh-media-inline-preview/client.js` 自动发现，刷新页面加载。

## 5. 安全边界

1. trust-fence（Host + sec-fetch-site + Origin）——**两条路由都过**（img-preview 原版没有，合并版补上）；LAN/手机同源可用，跨站拒绝。
2. 路径必须落在已注册 workspace 根内（realpath 后前缀检查，**每请求重验**；文件缺失回退路径同样受包含约束，`../../etc/passwd` 类逃逸 → null）——不服务 workspace 外文件。
3. 扩展名白名单 + 128 MiB（图片）/ 2 GiB（媒体）上限——只出媒体，不出任意文件。
4. 转码缓存只写 `~/.dsh/media-cache/`，文件名纯哈希——不污染用户目录。
5. 图片路由保留 `ACAO *`（img-preview 兼容，lightbox/嵌入需要）；媒体路由不设 ACAO（同源即可，trust-fence 已限源）。

## 6. 验证计划（端到端）

1. 装后 `plugin_status` 确认行 active；日志无报错。
2. host 路由（curl，回环 Host）：媒体路由 200 全量 / `Range: bytes=0-99` → 206 + 正确 Content-Range / 非法 range → 416；图片路由 200 + 正确 Content-Type；trust-fence（非回环 Host / cross-site / Origin 不匹配 → 403）。
3. TGA 转码：host 单测已覆盖解码/编码往返（24-bit/RLE/调色板 + PNG 签名/IHDR/IDAT 校验）；e2e 造一个 .tga 走图片路由确认返回 `image/png`。
4. 真实会话：对工作区已下载的 `xhs_*.mp4` / `xhs_*.mp3` 调 `mip_media` + 发围栏，工作区任一 png 走 `mip_img` + ```mip-img 围栏 → 用户在聊天里看到播放器/图片卡片并实际播放/查看（人工确认，这是唯一能证明 client 渲染的路径）。
5. 转码路径：造一个小 mkv（ffmpeg 生成）验证 `?tc=1` 兜底（client 冒烟已覆盖状态机；host 端真转码在 e2e 验证）。
6. 重开会话（reload）后围栏仍渲染（文本持久化 + 确定性 URL）。

## 7. 发布前整改（2026-08-29，GitHub/Gitea 公开化）

### 7.1 缓存与流量（本次新增）

- **ETag / `If-None-Match` 协商缓存**（files + media 两条路由）：响应携带弱校验器 `W/"<size-hex>-<mtime-hex>"`，浏览器命中缓存时带 `If-None-Match` 重验证，文件未变 → 304 零字节（`cache-control: no-cache` 语义不变，文件改动自然失效）。之前是裸 `no-cache` 无校验器，浏览器只能全量重下——刷新/重开会话时大媒体重复传输，是本插件最大的流量浪费点。
- **TGA→PNG 结果磁盘缓存**：解码+编码结果按 `sha256(path|size|mtime)` 写入 `~/.dsh/media-cache/tga-<key>.png`（7 天 TTL 与转码缓存共用清理），同源并发经 `tgaPngJobs` Map 共享（复用转码并发模式）。之前每请求重新解码+deflate，重复消耗 CPU。
- **`DSH_MEDIA_CACHE_DIR` 环境变量**：覆盖缓存目录（测试注入用，也允许部署定制）。

### 7.2 性能（媒体多时的卡顿面）

- **client 扫描改增量**：MutationObserver 回调从 records 收集 inserted nodes / characterData 目标（`collectCandidates` → `pending` Set），rAF 只扫 pending；3s 兜底 interval 全量扫（原 1500ms 全量）。长会话（几百条消息）不再每次 DOM 变动全文档 `querySelectorAll`。
- **媒体视口懒加载**：`<video>/<audio>` 挂载时 `preload="none"`，IntersectionObserver（300px 边距）进入视口才 `preload="metadata"` + `load()`；超时计时器随 `startLoad()` 启动（视口外的播放器不会空等 15s 误报）。无 IO 的环境回退立即加载。几十个媒体的会话不再一次性并发 metadata 请求。
- 图片卡片沿用 `loading="lazy"`（首图 eager）+ 新 `nodeType` 语义的增量挂载。

### 7.3 一致性收口

- **systemPrompt 教学文案**：`label` 字段标注为"兼容手写围栏才需要，UI 一律显示文件名"——与 client 实际行为对齐（此前文案称 label 为 caption，误导 agent 依赖 UI 不用的字段）。
- **扩展名集合防漂移**：`test/host.mjs` 新增解析 `lib/client.js` 源码的 `TRANSCODE_EXTS` 并与 host 的 `VIDEO+AUDIO_TRANSCODE_EXTS` 并集断言一致——两侧各自维护的列表从此有测试守护。

### 7.4 工程化

- `npm test` 跑全量（host + cache + client-smoke，原只跑 client-smoke 漏掉 host 套件）；新增 `test/cache.mjs`。
- `package.json` 补 `repository`/`bugs`/`homepage`/`author`/`engines`/`sideEffects`；`files` 补测试与文档；去重 `license` 字段。
- 新增 `.gitignore`、`CHANGELOG.md`、`.github/workflows/ci.yml`（Node 18/20/22 矩阵）、`README.en.md`（README 措辞已中性化，适配公开发布）。
- 零第三方依赖保持不变（纯 Node 内置 + 浏览器 API）。
