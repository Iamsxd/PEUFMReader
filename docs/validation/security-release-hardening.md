# 依赖安全与发布加固验证

> 日期：2026-08-04  
> 范围：依赖漏洞修复、真实 PostgreSQL 迁移验证与持续集成加固。

## 已修复问题

### Go 数据库驱动

初始 `govulncheck` 在 `github.com/jackc/pgx/v5 v5.7.6` 中发现可达的 `GO-2026-5004`，调用路径落到目录分类查询；扫描同时报告两个已导入但未确认调用的 pgx 包级漏洞。项目将 pgx 升级到 `v5.9.2` 后，符号级扫描结果为 0 个可达漏洞。

### Go 标准库

首次 GitHub Actions 扫描按 `go.mod` 中原有的 `go 1.26.0` 安装工具链，并发现 13 个可达的标准库漏洞；本地与生产 Dockerfile 已使用 1.26.5，因此本地扫描没有复现。项目随后把最低 Go 工具链明确固定到 `1.26.5`，使 CI、开发基线和生产构建使用同一已修复补丁版本。

### EPUB XML 依赖

初始 `pnpm audit --prod` 在 `epubjs 0.3.93` 间接依赖的 `@xmldom/xmldom 0.7.13` 中报告 5 个 high 漏洞，涉及 XML 序列化注入和不受控递归。由于 epubjs 当前仍把依赖范围限制在 0.7.x，工作区使用带注释的 pnpm override 固定到修复版本 `0.8.13`。重新审计后没有已知生产依赖漏洞。

## 持续集成改进

- Go job 启动 PostgreSQL 18 服务并设置 `TEST_DATABASE_URL`，使真实数据库集成测试不再因缺少连接而跳过。
- 新增迁移测试，在隔离 schema 中执行全部迁移两次，并核对 `schema_migrations` 数量，验证全新安装和重复执行。
- Go job 使用 1.26.5 工具链和官方 `govulncheck v1.6.0` 扫描可达漏洞。
- Web job 在单元测试后运行 `pnpm audit --prod --audit-level high`。
- Dependabot 每周检查 Go modules、pnpm、GitHub Actions 和 Docker 依赖。

## 本地验证结果

| 检查 | 结果 |
| --- | --- |
| `go vet ./...` | 通过 |
| `go test ./...`，连接临时 PostgreSQL 18 | 通过；包含 001–027 迁移重复执行和阅读标记集成测试 |
| `govulncheck ./...` | 0 个可达漏洞 |
| `pnpm audit --prod` | 0 个已知漏洞 |
| Node 24.18 / pnpm 11.9 前端生产构建 | 通过 |
| Vitest | 7 个测试文件、43 项测试通过 |

宿主机 Node 版本低于项目要求，因此前端测试和构建在项目指定的 `node:24.18.0-bookworm-slim` 构建环境中执行。该差异不影响容器生产构建，但宿主机直接开发前应按交接包升级 Node。

## 仍需目标环境验证

- 在副本环境执行一次完整备份恢复演练；禁止直接复制或修改运行中的 PostgreSQL 数据目录。
- 在真实 Unraid/NAS 上重跑优化后的 3000 本书、10 并发性能基线。
- 使用授权的 PDF/EPUB 固定语料和专用 reader 账号执行桌面、移动阅读器回归。
- 增加容器运行时系统包漏洞扫描，并确认告警更新策略。
- 调查先前撤回 `linux/arm64` 发布的具体原因；验证 OCR、Poppler、libmobi 和 Tesseract 后再恢复多架构镜像。
