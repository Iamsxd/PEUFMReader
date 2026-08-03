# PEUFMReader：Codex 工作约定

开始任何实现、评审或部署工作前，先阅读 [跨机器 Codex 交接包](docs/handoff/CODEX_HANDOFF.md)。它说明项目边界、当前开发状态、必要文档、验证命令，以及如何安全迁移运行数据。

工作约定：

- 不提交 `.env`、电子书、`data/`、`backups/`、`tmp/`、构建产物或任何密钥。
- 修改前先运行 `git status --short --branch`，保留工作区内不属于当前任务的改动。
- 后端改动至少运行 `cd server && go test ./...`；前端改动至少运行 `cd web && pnpm test && pnpm build`。按改动范围补充阅读器或浏览器回归。
- 不直接复制或删除正在运行的 PostgreSQL 数据目录；迁移运行数据只能使用 `scripts/backup.sh`、`scripts/verify-backup.sh` 与 `scripts/restore.sh`。
- 书籍源文件、Calibre 书库和只读监控目录可能包含私有或受版权保护的内容。除非任务明确要求且获得授权，不要复制、提交或上传这些文件。
