# 桌面与移动浏览器系统测试

测试使用同一组 Playwright 场景分别运行在 1440×900 桌面 Chromium 和 Pixel 7 移动视口。

## 覆盖范围

- 登录、主导航固定顺序以及横向溢出检查。
- 首页、推荐、收藏、全部书籍和分类页面切换。
- 推荐原因、推荐反馈以及反馈后的即时刷新。
- 管理后台四个工作区切换，避免所有管理功能堆叠在一个长页面。
- 用户与权限工作区中的书库组、用户组和权限矩阵在桌面及移动视口可达且不产生页面横向溢出。
- 书籍详情进入 PDF/EPUB 阅读器，确认阅读工具和书签/高亮入口可达。
- 在移动浏览器保存测试 PDF，切断网络并刷新，确认应用外壳、离线书架和 PDF 页面仍可渲染。
- 每个场景保存桌面与移动截图；失败时保留截图、视频和 Playwright trace。

## 执行

```powershell
docker compose up -d
cd web
pnpm exec playwright install chromium
$env:E2E_BASE_URL = "http://127.0.0.1:8085"
$env:E2E_ADMIN_USERNAME = "admin"
$env:E2E_ADMIN_PASSWORD = "你的管理员密码"
pnpm test:e2e
```

测试产物位于 `web/test-results`，HTML 报告位于 `web/playwright-report`，两者均已忽略，不会提交到 Git。

## 当前验证状态

- `pnpm test:e2e:list` 已发现桌面与移动端共 18 个场景，包括布局交互、站点外壳、离线阅读和真实书籍语料回归。
- 前端类型检查、36 个组件/逻辑测试及生产 Docker 构建已通过。
- 2026-08-01 已在 Pixel 7 移动视口完成导航、管理后台、详情页、阅读器和离线 PDF 回归；离线用例实际切断浏览器网络、刷新页面并验证 PDF.js 完成页面渲染。
- 登录助手会等待“登录表单或已登录导航”稳定出现，避免应用初始化阶段误判导致的并发/时序波动。
