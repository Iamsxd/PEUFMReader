# 桌面与移动浏览器系统测试

测试使用同一组 Playwright 场景分别运行在 1440×900 桌面 Chromium 和 Pixel 7 移动视口。

## 覆盖范围

- 登录、主导航固定顺序以及横向溢出检查。
- 首页、推荐、收藏、全部书籍和分类页面切换。
- 推荐原因、推荐反馈以及反馈后的即时刷新。
- 管理后台四个工作区切换，避免所有管理功能堆叠在一个长页面。
- 书籍详情进入 PDF/EPUB 阅读器，确认阅读工具和书签/高亮入口可达。
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

