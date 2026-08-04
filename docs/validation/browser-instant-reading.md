# 浏览器即时朗读 MVP 验证记录

> 验证日期：2026-08-04
> 开发分支：`codex/browser-instant-reading`

## 实现范围

- EPUB：读取当前位置所属的已渲染章节，通过 Web Speech API 分段朗读。
- 文字型 PDF：分页模式读取当前单页或双页跨页，连续模式读取当前可见页。
- 共用朗读侧栏：枚举浏览器可用音色，支持系统默认音色、0.5–2 倍速、开始、重新朗读、暂停、继续和停止。
- 音色和语速只保存在当前浏览器的 `localStorage`；正文不发送给 PEUFMReader 后端，也不产生 NAS 音频缓存。
- 切换 PDF 页面、EPUB 章节、书籍或退出阅读器时取消当前语音队列；更换音色或语速时停止当前朗读，避免旧配置继续播放。
- 长文本按标点拆分为短语音队列，降低浏览器朗读长章节时中途停顿的概率。
- PDF 页面画布与文字层独立渲染：Safari 文字层异常时仍保留已完成的页面画布，仅将文字选择与高亮降级，并显示非阻断提示。
- PDF 文字层改用 PDF.js 官方阅读器采用的 `streamTextContent` 流式输入，减少 Safari 处理完整文字内容对象时的兼容风险。

## 安全与边界

- 没有新增后端接口、数据库迁移、后台任务或音频文件。
- 扫描版 PDF 没有文本层时显示明确提示，不自动触发 OCR。
- Web Speech API 的音色由浏览器和操作系统提供；`localService` 音色会在界面标记为“本地”，其他音色是否联网由设备环境决定。
- 当前版本不包含章节自动连续播放、文字进度同步、定时关闭或后台生成音频，这些仍属于后续听书阶段。

## 自动化验证

在 `web/` 目录执行：

```bash
pnpm test
pnpm build
E2E_BROWSER_CHANNEL=chrome E2E_DISABLE_VIDEO=1 pnpm test:e2e layout-and-interactions.spec.ts --grep "book detail and reader controls"
```

结果：

- Vitest：8 个测试文件、48 项测试全部通过。
- TypeScript 与 Vite 生产构建通过，离线资源清单成功生成。
- Playwright：桌面 Chromium 1440×900 与 Pixel 7 移动视口各 1 项通过；覆盖朗读入口、设备音色枚举、1.25× 语速、开始、暂停、继续和停止。
- 本地部署后使用真实 PDF“牵伸解剖指南”完成 Chrome 冒烟检查：页面画布进入 `rendered` 状态，页面错误和文字层降级提示均未出现。
- Safari 26.5.2 的原始问题来自 PDF.js 文字层兼容路径；当前自动化环境不能驱动 Safari，修复后的 Safari 实机结果需要手动复核。

本机部署执行：

```bash
docker compose up -d --build
docker compose ps
```

结果：应用镜像构建完成，`app` 与 `db` 容器均为 `healthy`。
