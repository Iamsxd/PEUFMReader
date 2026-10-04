# 阅读器排版、跳转历史与 PDF 页内定位

日期：2026-10-04。分支：`codex/reader-experience-refinements`，从双主题及调研版本 `90e7063` 接续；不从旧 `master` 覆盖主题改动。

实现与隔离回归提交：`3df25f7`（`feat: refine reader typography navigation and PDF anchors`）。本文与路线图／交接补记另作文档提交，均仅保存在本地分支。

## 已实现范围

- EPUB 独立排版面板：设备已有宋体／黑体／系统字体、行距、段距、左右留白与最大行宽；尊重原书、重置、作用范围说明。使用独立 `peufmreader.epub.typography.v1` 保存当前浏览器全局默认，旧 `peufmreader.epub.preferences.v1` 不迁移、不改字段。
- EPUB 调排版、字号、单双页或阅读方式时捕获并恢复当前可见 CFI（不依赖连续滚动的延迟位置事件），合并连续滑块更新，抑制重排期间的瞬时进度；不创建新 book、不再次下载正文。只替换应用注入的排版样式，不覆盖 epub.js 的 body 分栏几何；尊重原书会撤回先前注入的排版覆盖。调整排版会停止当前朗读。
- EPUB 当前目录章 `aria-current="location"` 与打开时定位；百分比拖动仅预览，确认后跳转。排版及进度面板可在窄横屏内滚动。关闭侧栏／Esc 恢复触发控件焦点。
- PDF／EPUB 会话内显式跳转历史：目录、搜索、批注（EPUB 另有百分比，PDF 另有页码）支持返回／前进，普通翻页及自动连续朗读不记录；最多 50 条，书籍卸载后清除，不写服务端或浏览器持久化存储。
- PDF 保存页面索引和归一化页内 yRatio；打开、缩放、阅读方式／单双页切换与方向变化保留该点，旧仅页码记录 yRatio 降级为 0。高亮跳转使用首个有效矩形的 y，页内书签保留当前比例。锚点对齐到阅读视口顶端下方 24px，超出可滚范围时由视口自然限制。
- PDF 初始恢复及单纯改变尺寸不主动写进度；用户滚动、翻页和显式跳转沿用原防抖保存及退出 flush。几何就绪绑定当前页面 DOM，避免重访异形尺寸页误用旧状态；去除页面宽高过渡，保留画布淡入；无变化的设置点击不会遗留恢复状态。放大的双页目标会按需横向揭示，目标页可见且真实尺寸就绪后才提交历史／进度；不新增横向位置存储。

## 验证

- `cd web && pnpm test`：17 个文件、127 项测试通过；覆盖旧 EPUB／PDF 偏好、排版解析与样式边界、页内／横向几何、高亮定位、旧页码降级、共用跳转历史等。
- `cd web && pnpm build`：通过；PDF／EPUB／后台继续独立拆包。保留既有 PDF 分包超过 500 kB 提示，没有新增依赖。
- `e2e/reader-refinements.spec.ts`：最终生产构建上的 34 项全部通过（约 2.1 分钟），覆盖桌面 Chromium 与 Pixel 7 模拟。
- 同一最终构建上，`e2e/themes.spec.ts` 的 30 项全部通过；`e2e/site-shell.spec.ts` 的 3 项通过、1 项按设计跳过（仅手机适用的场景在桌面不执行）。这两套联合执行约 52.5 秒，验证双主题、正文隔离、原导航／基础阅读操作、断点与 PWA 元数据。
- 桌面／手机排版面板、高亮定位的合成截图已人工检查；排版面板可内部滚动，收起工具栏后 PDF 高亮位于可视阅读区。截图、trace 和构建产物只保留在被忽略的目录，不提交。
- `git diff --check`：通过。

阅读器用例覆盖：PDF 分页／连续模式页内恢复与保存后重开、旧页码记录、缩放／旋转／阅读方式保锚点且不主动写进度、批注矩形、双向多点历史、普通翻页不入栈、异形尺寸页重访、无变化设置、200% 双页右侧页横向揭示；EPUB 排版及原书样式撤回、旧偏好与拒绝存储、CFI／章节保持且无重新下载、目录当前章、搜索／批注／百分比跳转及前进分叉、快速调回原值、连续滚动后立即重排、短横屏确认按钮、Esc 焦点；另验证 PDF 自动跨页和 EPUB 自动跨章朗读不入历史、EPUB 快速翻页串行化。

所有新增阅读器浏览器用例拦截身份、正文、批注、会话及进度 API；PDF／EPUB 为内存生成的原创样本，不写真实数据库、账号或书库。朗读回归用模拟 Web Speech 回调和原创英文短句，不播放真实音频、不验证设备音色。未运行会读写真实账户的旧 `layout-and-interactions`／真实语料套件。

回归过程中实际修正了 PDF 尺寸动画导致锚点漂移、异形页旧几何误判、无变化设置残留恢复状态、双页放大后目标横向离屏，以及 EPUB 异步位置事件导致历史漏记、翻页与跳转并行、快速排版回原值锁住操作、连续滚动捕获旧 CFI、侧栏 Esc 与外层隐藏工具冲突。PDF 目录 ID 另改为完整层级路径，避免同名子目录同时标为当前项。

复现（先启动独立生产预览，不替换 8080）：

```sh
cd web
pnpm test
pnpm build
pnpm exec vite preview --host 127.0.0.1 --port 5196 --strictPort
```

另一个终端分批执行，避免覆盖其他套件截图：

```sh
cd web
E2E_BASE_URL=http://127.0.0.1:5196 E2E_BROWSER_CHANNEL= E2E_DISABLE_GPU=1 E2E_DISABLE_VIDEO=1 \
  pnpm test:e2e e2e/reader-refinements.spec.ts --workers=1 --output=test-results/reader-refinements/final --global-timeout=300000
E2E_BASE_URL=http://127.0.0.1:5196 E2E_BROWSER_CHANNEL= E2E_DISABLE_GPU=1 E2E_DISABLE_VIDEO=1 \
  pnpm test:e2e e2e/themes.spec.ts e2e/site-shell.spec.ts --workers=1 --output=test-results/reader-refinements/themes --global-timeout=240000
```

## 尚未承诺的范围

- EPUB 本书单独覆盖／跨设备配置同步、目录层级折叠、脚注跳转历史、固定版式专项排版；原书复杂 CSS／RTL／竖排仍需授权语料验收。
- EPUB 损坏／缺失章节的引擎错误恢复需要单独语料回归；现有加载超时不等于所有后续章节导航都有可取消的恢复流程。
- PDF 搜索当前仍定位到匹配页，不是每个命中词的精确坐标。没有实现在线 Range／边下载边打开、PDF 裁边或文本重排。
- 新增强测试为 Chromium 桌面和 Pixel 7 模拟，不是真机；真实 NAS 语料、Safari／iPhone、PWA 安装与锁屏朗读等未完成本轮验收。
- 初次调研中的渐进搜索、移动跨页选区、离线批注写入、段落级朗读等仍为后续候选，见 [调研记录](../discovery/reader-experience-gap-analysis.md)。

本轮不增加依赖、不更换引擎、不发送正文给第三方、不复制／提交真实书籍、不触碰 `.env`、数据库、备份或运行数据。无后端改动，因此无需 Go 回归。本轮未合并、推送或部署；8080 仍为 `ce8423c`。
