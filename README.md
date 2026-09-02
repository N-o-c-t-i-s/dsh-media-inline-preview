# dsh-media-inline-preview

[![CI](https://github.com/seeingrain/dsh-media-inline-preview/actions/workflows/ci.yml/badge.svg)](https://github.com/seeingrain/dsh-media-inline-preview/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 🇬🇧 English: [README.en.md](README.en.md)

**DeepSeek Harness（DSH）聊天的全能媒体展示器**——一个插件、三种围栏（`` ```img `` / `` ```video `` / `` ```audio ``）、覆盖 **36 种本地媒体格式**。图片渲染成卡片 + 全屏 Lightbox 查看器，视频/音频渲染成原生播放器，全部**内联在聊天消息里**：不走侧边栏、不弹新标签页、流式输出过程中即可挂载播放。合并并取代了原先独立的 img-preview（图片围栏）与 video/audio 围栏插件。

## 📱 效果预览

| 图片卡片（JPG / PNG / SVG / TGA…） | 动图 GIF + 矢量 SVG 内联 | MP4 / MP3 原生播放器 |
| :---: | :---: | :---: |
| ![图片卡片 + Lightbox](https://raw.githubusercontent.com/seeingrain/dsh-media-inline-preview/main/assets/preview-1-images.jpg) | ![GIF 动图与 SVG 矢量](https://raw.githubusercontent.com/seeingrain/dsh-media-inline-preview/main/assets/preview-2-gif-svg.jpg) | ![MP4 与 MP3 播放器](https://raw.githubusercontent.com/seeingrain/dsh-media-inline-preview/main/assets/preview-3-video-audio.jpg) |

## 支持格式（36 种）

| 类别 | 格式 | 说明 |
|------|------|------|
| 图片（10） | `.png .jpg .jpeg .webp .gif .avif .bmp .svg .ico .tga` | 卡片 + Lightbox；`.tga` 宿主侧即时转 PNG（纯 JS 解码器，支持 uncompressed/RLE、8/15/16/24/32 位、调色板）；GIF 原样内联播放 |
| 视频 · 原生（7） | `.mp4 .webm .mov .m4v .ogv .ts .3gp` | 浏览器可直播，HTTP Range 流式 |
| 音频 · 原生（9） | `.mp3 .wav .m4a .aac .ogg .oga .flac .opus .weba` | 原生 `<audio>` 播放器 |
| 视频 · 转码（6） | `.mkv .avi .flv .wmv .mpg .mpeg` | 播放失败自动 `?tc=1` 触发 ffmpeg 转 H.264/AAC mp4 |
| 音频 · 转码（4） | `.wma .mid .midi .m4b` | 同上，转码结果按内容寻址缓存 7 天 |

## 特性

- **图片（`img`）**——缩略卡片（标题**只显示文件名**），单击打开全屏 Lightbox：桌面滚轮缩放 / 拖拽平移 / 双击切换 100%↔2.5x / ESC 关闭；**手机双指捏合缩放（围绕中点）+ 双指拖动平移**，单指也可拖；顶部工具条 −/＋/适应/100%/✕；`{"images":[...]}` 宫格；外部 `url` 直通。
- **视频 / 音频（`video` / `audio`）**——原生 `<video>` / `<audio>` 播放器直接渲染在消息内（进度拖动、全屏、移动端 `playsinline`），文件名标题，无需侧边栏。
- **HTTP Range 流式**（media 路由）——`createReadStream` 管道 + 完整 206/416 处理，大文件拖动进度条平滑、内存恒定；上限 2 GiB。
- **转码回退**——浏览器放不了的容器（mkv/avi/flv/wmv/wma…）播放失败时客户端自动带 `?tc=1` 重试，宿主 ffmpeg 转码并缓存到 `~/.dsh/media-cache/`（内容寻址，7 天 TTL）。
- **带宽友好**——两条路由均支持 ETag / `If-None-Match` 条件请求（未变更文件 304 零传输）；TGA→PNG 与 ffmpeg 转码结果磁盘缓存；播放器 IntersectionObserver 懒加载，滚到视口才开始。
- **围栏即 Markdown**——会话历史原生保留围栏，刷新页面媒体永不丢失。
- **流式提前挂载**——消息还在流式输出时，已闭合的媒体围栏即刻挂载播放，不用等整条消息结束。
- **零配置**——装完即用：会话中出现或产出的媒体文件，agent 先调 `img_serve` / `media_serve` 校验再发围栏，卡片/播放器自动出现在消息里；也可以手写围栏（见下）。

## 围栏语法

```img
{"path":"/绝对路径/图片.png","label":"可选标题"}
```
```video
{"path":"/绝对路径/视频.mp4","label":"可选标题"}
```
```audio
{"path":"/绝对路径/音乐.mp3","label":"可选标题"}
```

`label` 字段仍会解析（兼容手写围栏），但 UI 标题**固定只显示文件名**。多图宫格：`{"images":[{"path":"..."},{"path":"..."}]}`。

## 架构（house pattern）

- **host（`lib/index.js`）**——`systemPrompt.section` 注入统一围栏教学（三围栏 + 主动触发 + 去重）；`img_serve` / `media_serve` 工具校验路径并返回 `{ok, ..., path, url}`；两条前缀路由：
  - `/plugins/dsh-media-inline-preview/files`——图片路由（整读、128 MiB 上限、TGA→PNG 即时转码 + 磁盘缓存、`ACAO *`）
  - `/plugins/dsh-media-inline-preview/media`——媒体路由（Range 流式、2 GiB 上限、`?tc=1` 转码回退）
  - `/plugins/dsh-media-inline-preview/token` + `__media_auth`——**文件级 HMAC 令牌**（`?dsh_tok=`）：按文件 realpath 绑定的凭据，供 nginx `auth_request` 校验，让无 cookie 的系统媒体管线（如 Android stagefright，独立进程取流、不带浏览器 cookie）也能穿过 cookie 门控的反向代理；secret 部署时自动生成（0600，工作区外），支持热轮换（失败重试时强制重签自愈）。
- **client（`lib/client.js`）**——`window.__ModuleLoader__` 注册；增量 MutationObserver 扫描（rAF 合并 + 3s 全量兜底），**三级防冲突检测**：
  1. `div.infostring` 文本精确等于 `img`/`video`/`audio`（主判定；流式期间为空，半截围栏永不匹配）
  2. 文本以 `` ```img `` / `` ```video `` / `` ```audio `` 开头（表面兜底）
  3. JSON spec 按 `path` 扩展名推断种类（互斥扩展名集合——裸 JSON 体不会跨类误触发）
  
  wrapper 内嵌套的 `pre` 跳过（单一挂载目标，不重复挂载）；播放失败自动 `?tc=1` 重试，二次失败换错误卡片。
- **安全**（详见 DESIGN.md）：
  - 两条路由**每请求**过浏览器信任围栏：Host 必须为回环或 `webRuntime.trustedHosts`（启动时采样的 LAN IP + `--trusted-host` 条目），`sec-fetch-site: cross-site` 拒绝，带 Origin 时必须与 Host 一致——**LAN/手机 GUI 访问照常工作，跨站抓取被挡**（比原 img-preview 更严）。
  - 工作区包含检查每请求复检，`realpath` 堵死符号链接逃逸（含文件缺失回退路径），扩展名白名单，128 MiB / 2 GiB 上限。

## 使用

安装后零配置：会话中出现或产出图片/视频/音频时，agent 自动先调 `img_serve` / `media_serve` 再发围栏，卡片/播放器直接出现在消息里。也可以手写上面的围栏。

## 测试

```sh
npm test                  # host + cache + client smoke（全部套件）
node test/host.mjs        # 宿主单测：信任围栏 / 路径逃逸 / TGA→PNG / 类型映射
node test/cache.mjs       # 缓存：ETag/304 条件请求 + TGA 磁盘缓存
node test/client-smoke.mjs  # 桩 DOM 冒烟：检测 / 跨类冲突 / 挂载 / 懒加载 / 令牌
```

## 安装

```sh
dsh plugin --profile web add github:seeingrain/dsh-media-inline-preview
# host 半边需要重启 web；client 半边下次刷新页面即加载
```

## License

MIT — 见 [LICENSE](LICENSE)。
