# PEUFMReader 跨机器 Codex 交接包

此文档用于把本项目交给**另一台机器、另一个账号**上的 Codex 继续开发。Codex 对话上下文、个人设置、已登录的 Git 凭据和本机文件不会随 Git 仓库自动迁移；因此以版本化的代码、本文档和启动提示作为交接边界。

## 快照信息

- 交接包生成时间：2026-08-03（Asia/Shanghai）。
- 仓库：`https://github.com/Iamsxd/PEUFMReader.git`
- 分支：`master`
- 交接盘点时的代码提交：`79ada4364874fbd96a0eeb451b4f2257556f3197`（`fix: open offline epubs as binary`）。
- 盘点时 `master` 与 `origin/master` 一致且没有未提交改动。生成本交接包后，请以再次执行 `git status --short --branch` 的结果为准。
- 本交接包本身包含 `AGENTS.md`、本文档和 `docs/handoff/NEW_MACHINE_PROMPT.md`；应提交并推送，或随离线 Git bundle 一并转移。

## 项目是什么

PEUFMReader 是面向 NAS 的多用户电子书管理与 Web 阅读应用。它使用 React/TypeScript/Vite 前端、Go 单体 API 与后台 worker、PostgreSQL，以及 Docker Compose 部署。支持 PDF、EPUB、MOBI、AZW3 的导入、管理、权限、阅读进度、离线阅读、阅读统计和运维视图。

系统的关键边界：

- 电子书默认导入为应用管理的副本；不能静默覆盖、重命名、移动或删除用户原文件。
- 阅读进度、笔记、高亮、权限和统计属于用户私有状态；书籍、元数据与分类为共享领域数据。
- 应用服务通过鉴权 HTTP 接口提供文件和 HTTP Range，不暴露 NAS 路径。
- PostgreSQL、托管书库与派生缓存分开存储；缓存可再生，但数据库和托管书库必须备份。

## 新 Codex 的阅读顺序

1. 仓库根目录的 `AGENTS.md`。
2. 本文档和 `docs/handoff/NEW_MACHINE_PROMPT.md`。
3. `README.md`：启动、配置、NAS 部署、备份与恢复的完整用户说明。
4. `docs/product/development-roadmap.md`：已完成范围、P2 待办和发布门槛。
5. `docs/adr/0002-library-storage.md`、`0003-explainable-classification.md`、`0004-nas-multi-user-web.md`：不可违反的架构决策。
6. `docs/validation/`：已验证范围、真实阅读器语料回归和 NAS 验收记录。

`docs/README.md` 是全部设计与验证文档的索引。

## 当前开发状态与建议切入点

已完成并有记录的内容包括：P1 移动离线阅读/PWA/前端加载优化；P1.5 目录查询优化；P2.1 运维监控增强（磁盘、任务分类耗时、健康阈值和受保护的 Prometheus 导出）；P2.4 第一版独立阅读统计页面；阅读器控制栏与首页导航细节优化。

后续路线在 `docs/product/development-roadmap.md`，但不要自行假定优先级。P2 的公开候选方向是：外部告警通知、跨书库全文检索与 AI、听书、阅读目标/导出/隐私等统计增强。开始新功能前先向项目负责人确认本次目标。

## 代码地图

| 路径 | 内容 |
| --- | --- |
| `server/cmd/peufmreader/main.go` | 服务入口、依赖装配。 |
| `server/internal/httpapi/` | REST API、认证、权限、阅读和管理接口及集成测试。 |
| `server/internal/store/` | PostgreSQL 查询、领域持久化和后台任务状态。 |
| `server/internal/database/migrations/` | 顺序 SQL 迁移；已有 001–027。 |
| `server/internal/importing/`、`importinbox/`、`watchlibrary/`、`calibre/` | 书籍导入与外部书库接入。 |
| `web/src/components/` | React 页面与组件；阅读器在 `components/readers/`。 |
| `web/src/api/`、`web/src/types/` | 前端 API 客户端与领域类型。 |
| `web/e2e/` | Playwright 浏览器测试。 |
| `scripts/` | 备份、恢复、预检、性能与阅读器回归脚本。 |
| `compose.yaml`、`Dockerfile`、`.env.example` | 容器部署与配置模板。 |

## 目标 Mac 上的最小开发环境

目标机器是 macOS。仅继续开发时，不需要复制 `node_modules`、`data/`、`backups/` 或 `tmp/`。安装 Git、Docker Desktop（自带 Docker Compose v2）；若要直接在宿主机运行测试，再安装 Go 1.26、Node.js 24.18 和 pnpm 11.9。

若已安装 Homebrew，可用以下命令安装命令行依赖；Docker Desktop 请从 Docker 官方应用安装并首次启动：

```sh
brew install git go node
npm install --global pnpm@11.9.0
```

在 macOS 终端执行：

```sh
git clone https://github.com/Iamsxd/PEUFMReader.git
cd PEUFMReader
git status --short --branch
cp .env.example .env
```

`.env` 至少要为本地 Docker 环境设置新的 `POSTGRES_PASSWORD` 和 `ADMIN_PASSWORD`。不要把源机器的 `.env` 提交到 Git、聊天记录或交接提示中。

使用容器验证最小启动：

```sh
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs --tail 100 app
```

在 Apple Silicon（M 系列）Mac 上，必须保留 `--build` 以本地构建 arm64 镜像；不要把 `docker compose pull app` 当作默认路径，因为仓库当前发布工作流只发布 `linux/amd64` 镜像。Intel Mac 也可使用本地构建路径。

本机开发/测试命令：

```sh
cd server
go test ./...

cd ../web
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

停止本地环境用 `docker compose down`。除非已验证备份，禁止使用 `docker compose down -v`。

## 应该拷走什么

| 目标 | 必须带走的内容 | 推荐方式 | 不要带走/不要提交 |
| --- | --- | --- | --- |
| 仅继续开发 | 所有已提交的 Git 历史、源码、测试、`AGENTS.md`、`docs/` | Git clone（首选）或 Git bundle | `node_modules/`、`web/dist/`、`tmp/`、测试产物。 |
| 继续未提交工作 | 未提交文件和未推送提交 | 先提交并推送（首选）；否则提交 Git bundle，另附二进制 patch | 不要只复制工作树而丢失 Git 历史。 |
| 在新机器运行独立开发环境 | `.env.example` 和新机器自行生成的 `.env` | 从模板创建；秘密通过受控的密码管理器单独交付 | 不要通过 Git、截图或普通聊天发送 `.env`。 |
| 迁移同一套应用/书库状态 | 新鲜的逻辑备份目录，以及需要时的私有 `.env` | `scripts/backup.sh` + `scripts/verify-backup.sh`，目标端用 `scripts/restore.sh` | **绝不**复制正在运行的 `data/postgres/`。 |
| 保留外部书库接入 | 实际的 Calibre 根目录、只读监控书库，或在目标端关闭这些配置 | 在有授权的存储之间单独迁移并按只读方式挂载 | 这些目录不在应用备份里，可能含版权书籍。 |

当前工作区本地存在被忽略的运行目录：`data/`、`backups/`、`tmp/`。它们不是代码交接的必需品。`data/` 中包含数据库、托管书库和缓存；在本次盘点中约为 147 MB，但它的大小和内容会随运行变化。

## 两种代码交接方式

### 方案 A：GitHub/Git 远程仓库（首选）

1. 先确认全部待交接改动已提交；不要用 `git add -A` 把密钥或运行数据意外加入。
2. 只暂存本交接包时可使用：

   ```sh
   git add AGENTS.md docs/README.md docs/handoff
   git commit -m "docs: add cross-machine Codex handoff"
   git push origin master
   ```

3. 让另一台机器使用其**自己的 GitHub 账号**访问仓库：公开仓库可直接克隆；私有仓库需要仓库管理员把该账号加入协作者，或提供只读/写入所需的独立凭据。
4. 新机器克隆后执行 `git status --short --branch` 和 `git log -1 --oneline`，确认提交一致。

### 方案 B：离线 Git bundle

当另一台机器无法访问远程仓库时，先把待交接内容提交，再在源机器执行：

```sh
git bundle create ../PEUFMReader-20260803.bundle --all
```

把 `.bundle` 文件通过受控存储介质复制到新机器，然后执行：

```sh
git clone ../PEUFMReader-20260803.bundle PEUFMReader
cd PEUFMReader
git log -1 --oneline
```

若源工作区仍有未提交改动，优先先提交；确实不能提交时才额外创建 patch：

```sh
git diff --binary > ../PEUFMReader-local.patch
```

目标端在确认基础提交正确后应用：

```sh
git apply --index ../PEUFMReader-local.patch
```

## 迁移同一套运行数据（仅在确有需要时）

仅为另一台 Codex 继续写代码时跳过本节。此节适用于新机器还要接管当前用户、书籍、进度、权限和缓存。

1. 确认后台导入、OCR、转换任务已空闲或已知晓中断影响；备份不包含 `staging` 临时目录。
2. 在源实例所在目录创建命名快照。Linux/Unraid/Git Bash/WSL 可直接运行：

   ```sh
   sh scripts/backup.sh codex-handoff-20260803
   sh scripts/verify-backup.sh codex-handoff-20260803
   ```

   快照在 `${PEUFM_BACKUP_ROOT}/codex-handoff-20260803`，包含 `database.dump`、`library.tar.gz`、`cache.tar.gz`、`import.tar.gz`、`MANIFEST.txt` 和 `SHA256SUMS`。
3. 将整个快照目录复制到目标机器的 `PEUFM_BACKUP_ROOT` 下。源和目标应使用受控方式单独交付相应 `.env`；其中的数据库密码和外部服务凭据属于机密。
4. 目标端先准备 Compose、`.env` 和空的数据根目录，然后：

   ```sh
   docker compose up -d db
   sh scripts/restore.sh codex-handoff-20260803 --yes
   docker compose up -d --build
   ```

5. 检查 `docker compose ps`、`/healthz`、管理员登录、书籍数量、封面、用户阅读进度和权限。恢复会替换目标数据库、托管书库、缓存和导入目录，先在副本环境演练。

Calibre 根目录和只读监控目录是外部挂载，不包含在上述快照中。若不需要它们，在目标 `.env` 中保持 `WATCH_LIBRARY_ENABLED=false` 并设置/清空相应路径；若需要，必须在具备内容授权的前提下独立复制或挂载，并保持只读。

## 交接完成的验收清单

- [ ] 新机器的 `git rev-parse HEAD` 与约定提交一致，或能解释其后续提交。
- [ ] `AGENTS.md`、本文档、路线图和验证文档都存在且已阅读。
- [ ] `git status --short --branch` 的未提交改动已被解释，不覆盖他人的工作。
- [ ] `.env` 仅存在于本机，且密钥未进入 Git 或交接提示。
- [ ] `go test ./...`、`pnpm test`、`pnpm build` 按改动范围通过；Docker 方案至少能 `docker compose config`。
- [ ] 若迁移了运行数据，备份已校验并完成恢复演练；没有直接复制 PostgreSQL 原始数据目录。
- [ ] 已把 `NEW_MACHINE_PROMPT.md` 中的提示粘贴给新 Codex，并告知本次具体目标。
