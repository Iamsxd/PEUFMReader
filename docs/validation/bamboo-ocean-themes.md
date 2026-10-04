# 青竹书院／墨蓝星图主题升级

日期：2026-10-04。

## 版本与范围

- 分支：`codex/bamboo-ocean-themes`；基线 `master`／`origin/master` 的 `f4f90a9`。
- 青竹书院（`edition`）：暖纸、松绿、衬线标题与安静留白；深松绿欢迎／继续阅读区，暖色阅读按钮。
- 墨蓝星图（`night`）：深海蓝、冰蓝、无衬线标题、封面画廊和局部星轨；不同深度的背景与面板。
- 保留原 `edition`／`night`、默认值和 `peufmreader.app-theme`；旧浏览器选择继续恢复、跨标签页同步，存储拒绝时本页仍能切换。
- 改动覆盖登录、应用导航、首页、书库、详情、统计、私人书架／笔记与管理工作区，不移除原有功能或隐藏操作。真实封面不调色／滤镜，缺失封面仍使用本地文字。
- PWA 默认启动背景／主题色改为日间色；运行时 `theme-color` 跟随当前界面主题。界面 token 仍限于 `.app-shell`／`.login-page`，阅读器控制栏维持中性，PDF／EPUB 正文、偏好、进度和批注逻辑不变。
- 只参考 Readest、BookLore／BookOrbit 和 Radix 的体验与色阶原则，不复制第三方源码、图标或书籍资产；没有额外网络字体／图片／依赖。

## 验证

- `cd web && pnpm test`：16 个文件、100 项测试通过。
- `cd web && pnpm build`：通过；PDF／EPUB／后台继续独立拆包。保留既有 PDF 分包超过 500 kB 提示，不把它当作新增问题。
- `e2e/themes.spec.ts`：最终构建上的 30 项测试全部通过（42.5 秒），覆盖桌面 Chromium 与 Pixel 7 移动模拟。使用拦截 API、合成身份和原创 PDF／EPUB，不写真实书库。
- `e2e/site-shell.spec.ts`：3 项通过、1 项按设计跳过（仅手机适用的场景在桌面不执行），验证站点图标、PWA 启动色／元数据与移动视口。
- 单测覆盖旧主题偏好兼容、阅读器偏好不变、theme-color、缺少 meta 容错、PWA 默认启动色一致性。浏览器回归覆盖两套实际页面背景和 16 项 token、320／390／720／721／820／1024／1440px 断点、原导航、键盘跳到正文、统计／后台、跨标签页同步、搜索值保留、存储拒绝、空库／错误／长标题／封面失败，以及 PDF／EPUB 主题隔离和 EPUB 字号／目录操作。
- 真实 CSS 对比度回归：特色面板文字、主按钮、搜索 placeholder、四套缺失封面的标题／作者均达到 4.5:1；特色面板实际 `:focus-visible` 的 2px 焦点环达到 3:1。复核后将 tone-3 封面背景加深为 `#825e4a`，并使用浅色特色 token 显示焦点环。
- 最终桌面／手机的两主题截图已人工检查；叶片装饰位于欢迎区右上角，不遮挡继续阅读操作，搜索占位文字在夜间保持可读。截图和 Playwright 产物只保留在被忽略的 `web/test-results/`，不提交。
- `git diff --check`：通过。

本轮没有后端改动，因此不运行 Go 测试；不触碰 `.env`、运行数据库、真实电子书或备份，不推送、不合并、不部署。8080 仍为此前 `ce8423c`，不能把该运行版本与本分支代码混淆。

## 复现

先构建，启动独立生产预览端口：

```sh
cd web
pnpm test
pnpm build
pnpm exec vite preview --host 127.0.0.1 --port 5196 --strictPort
```

另一个终端运行隔离主题回归：

```sh
cd web
E2E_BASE_URL=http://127.0.0.1:5196 E2E_BROWSER_CHANNEL= E2E_DISABLE_GPU=1 E2E_DISABLE_VIDEO=1 \
  pnpm test:e2e e2e/themes.spec.ts --workers=1 --global-timeout=240000
E2E_BASE_URL=http://127.0.0.1:5196 E2E_BROWSER_CHANNEL= E2E_DISABLE_GPU=1 E2E_DISABLE_VIDEO=1 \
  pnpm test:e2e e2e/site-shell.spec.ts --workers=1 --output=test-results/bamboo-ocean/site-shell
```

浏览器自动化不是 iPhone／Android 真机验收；实际 PWA 安装与手机阅读仍需真机测试。阅读器后续改进研究见 [体验对照](../discovery/reader-experience-gap-analysis.md)，不代表本轮新增那些功能。
