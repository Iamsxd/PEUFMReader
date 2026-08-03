# 给另一台机器上 Codex 的启动提示

将下面的内容复制到新 Codex 的首条消息中；最后一行替换为本次实际任务。

```text
你正在 macOS（可能是 Apple Silicon）上接手 PEUFMReader 仓库。不要依赖任何旧对话、旧账号记忆或未传输的本机文件。容器启动使用 docker compose up -d --build；不要默认拉取当前仅发布 amd64 的 app 镜像。

请先阅读以下文件，然后只报告你确认到的项目状态和建议的下一步；在我确认本次目标前不要修改代码：
1. AGENTS.md
2. docs/handoff/CODEX_HANDOFF.md
3. README.md
4. docs/product/development-roadmap.md
5. docs/adr/0002-library-storage.md
6. docs/adr/0003-explainable-classification.md
7. docs/adr/0004-nas-multi-user-web.md

先执行并汇报：
- git status --short --branch
- git log -1 --oneline
- git diff --stat

约束：不要提交 .env、data/、backups/、tmp/、电子书或任何密钥；不要直接复制、删除或修改 data/postgres；保留与本任务无关的现有改动。后端改动运行 go test ./...；前端改动运行 pnpm test 和 pnpm build，并按需要补充阅读器或浏览器回归。

本次要处理的具体任务是：<在这里填写>
```

若新机器只负责开发，请不要复制生产书籍和运行数据。若它还要接管同一套应用状态，严格按 `CODEX_HANDOFF.md` 的“迁移同一套运行数据”执行。
