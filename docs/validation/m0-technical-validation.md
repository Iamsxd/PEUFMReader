# M0 技术验证记录

> 日期：2026-07-19
> 结论：技术基线可运行；完整 M0 退出条件尚未全部满足。

## 已实现

- Docker Compose：Go 应用、PostgreSQL 18、持久化书库与 staging 挂载。
- admin/reader 本地账号、Argon2id 密码、HttpOnly 会话、CSRF 防护。
- PDF/EPUB 上传、魔数校验、SHA-256 去重、托管书库复制。
- 支持 staging 与 library 位于不同挂载点的安全跨卷落盘。
- 鉴权文件流和 HTTP Range。
- React 书库界面、PDF.js 阅读器、隔离的 EPUB 阅读器适配层。
- 按用户隔离的阅读位置、整体进度、状态和有效阅读时长。

## 自动验证结果

| 项目 | 结果 |
|---|---|
| Go `gofmt`、`go vet ./...`、`go test ./...` | 通过 |
| TypeScript 类型检查、Vitest | 通过；当前持续套件为 42 项，见浏览器系统测试文档 |
| React 生产构建 | 通过；PDF/EPUB 阅读器按需拆包 |
| `docker compose config` | 通过 |
| PostgreSQL 迁移与容器健康检查 | 通过 |
| 管理员创建 reader 用户 | 通过 |
| 跨挂载点上传、SHA-256 重复导入 | 通过 |
| 已登录 Range 请求 | 返回 206，内容正确 |
| 未登录文件请求 | 返回 401 |
| 两用户阅读进度隔离 | 通过（验证值 25% 与 50%） |
| 阅读时长心跳 | 通过（验证累计 2 秒） |
| 生产前端入口 | 返回 200 |

## 后续环境验证

- 真实书籍的首页/中间页/末页渲染、阅读位置保存与重新进入恢复已纳入可重复的桌面和移动浏览器回归；固定语料及循环次数由部署者通过环境变量控制。
- 仍需在实际 Unraid 主机完成一次副本环境的全量备份恢复演练，并持续观察缓存盘/阵列上的大文件读取。

真实 PDF/EPUB 语料回归及桌面/移动 Chromium 交互矩阵已经补齐；执行方法见 `reader-corpus-regression.md` 和 `browser-system-test.md`。Unraid 可先运行 `sh scripts/preflight.sh` 验证实际 PUID/PGID 和卷权限，再用 `sh scripts/verify-backup.sh 快照名` 做非破坏性备份校验，但仍需在副本环境完成一次完整恢复演练。

备份恢复演练完成前，应把当前版本视为可部署的开发基线；公网访问还必须经过受信任的 HTTPS 反向代理或私有网络。
