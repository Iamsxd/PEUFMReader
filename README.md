# PEUFMReader

PEUFMReader 是一个面向 NAS 的多用户电子书管理与 Web 阅读应用。它将书籍导入、元数据整理、分类、检索、阅读和进度记录集中在一个自托管服务中，适合家庭或小团队在局域网使用。

项目当前以约 10 个用户、3000 本书为设计基线，使用 Docker Compose 部署，支持 PDF、EPUB、MOBI 和 AZW3。

> 当前仓库仍处于持续开发阶段。局域网部署已经可用；公网访问必须放在受信任的 HTTPS 反向代理或私有网络之后。

## 功能概览

### 书库管理

- 浏览器批量上传 PDF、EPUB、MOBI、AZW3。
- SHA-256 文件去重和真实格式签名校验。
- 原文件复制到应用托管书库，不依赖原始上传位置。
- Calibre 书库只读扫描、预览和可恢复批量迁移。
- 监控导入目录，自动排队处理稳定写入的电子书。
- 首页提供继续阅读、热门书籍、最近加入、题材分类和个人统计。
- 独立书籍详情页、收藏书架和个性化推荐。
- 服务端全文条件搜索、分页、排序和分类筛选。

### 阅读器

| 格式 | 浏览器阅读方式 | 主要能力 |
| --- | --- | --- |
| PDF | PDF.js | 单页/双页、连续滚动、缩放、目录、页码跳转、键盘操作 |
| EPUB | epub.js | 分页/连续滚动、字号、主题、目录、搜索、键盘操作 |
| MOBI/AZW3 | 导入时生成 EPUB 阅读缓存 | 复用 EPUB 阅读能力，原文件仍被保留 |

- 每位用户独立保存阅读位置、整体进度、阅读状态和有效阅读时长。
- 阅读缓存可以删除和重新生成，不修改原始电子书。
- 不支持受 DRM 保护的 MOBI/AZW3，也不提供 DRM 移除功能。

### 元数据与分类

- 提取 EPUB OPF、PDF Info 和 Calibre `metadata.opf`。
- PDF 首页封面、原生文本提取和可选中英文 OCR。
- 按作者、出版年份和管理员维护的固定题材体系分类。
- 保存元数据证据、来源、置信度和管理员审核结果。
- 可选 Ollama 或 OpenAI-compatible AI 分类建议。
- 支持 Open Library、Google Books 和独立 `douban-api-rs` 豆瓣服务。
- 外部来源可配置启用状态、地址、优先级、超时、候选数和导入后自动查询。
- 外部查询只生成建议，不会自动覆盖管理员确认的数据。

### 多用户与运维

- `admin`/`reader` 角色、本地账号和 Argon2id 密码哈希。
- 管理员可查看登录记录、活跃会话、最近访问、阅读统计并下线设备。
- HttpOnly 会话 Cookie、CSRF 防护、登录限流和操作审计。
- PostgreSQL 持久后台任务、任务租约、失败重试和重启恢复。
- 书库一致性检查、数据库导出、文件快照和校验恢复。

## 技术架构

```mermaid
flowchart LR
    B["浏览器"] -->|HTTP| A["Go API + React Web"]
    A --> P[(PostgreSQL)]
    A --> L["托管书库"]
    A --> C["封面 / OCR / 转换缓存"]
    A --> W["持久后台任务"]
    W --> O["OCR / MOBI 转换"]
    W --> E["外部书目服务"]
    A -.可选.-> AI["Ollama / 云端 AI"]
```

- 后端：Go、`net/http`、pgx。
- 前端：React、TypeScript、Vite、PDF.js、epub.js。
- 数据库：PostgreSQL 18。
- 文档处理：Poppler、Tesseract OCR、libmobi。
- 部署：Docker Compose，应用容器以非 root 用户运行。

## 快速启动

### 运行要求

- Docker Engine 或 Docker Desktop。
- Docker Compose v2。
- 至少 2 GB 可用内存；运行大量 PDF OCR 时建议 4 GB 以上。
- 当前已验证镜像平台为 `linux/amd64`。

克隆仓库：

```sh
git clone https://github.com/Iamsxd/PEUFMReader.git
cd PEUFMReader
```

复制配置：

```sh
cp .env.example .env
```

至少修改以下两项，且不要复用同一个密码：

```dotenv
POSTGRES_PASSWORD=replace-with-a-long-random-database-password
ADMIN_PASSWORD=replace-with-a-long-random-admin-password
```

启动：

```sh
docker compose up -d --build
docker compose ps
```

浏览器打开：

```text
http://服务器IP:8080
```

查看日志：

```sh
docker compose logs -f app
```

停止服务：

```sh
docker compose down
```

`docker compose down` 不会删除绑定挂载的数据。除非已经验证备份，否则不要执行 `docker compose down -v`，也不要删除 `PEUFM_DATA_ROOT`。

## Unraid / NAS 部署

建议把源码与运行数据分开：

```text
/mnt/user/appdata/peufmreader-stack   # Git 仓库与 compose.yaml
/mnt/user/appdata/peufmreader         # 数据库、托管书库和缓存
/mnt/user/ebooks/peufmreader-import   # 可选自动导入目录
/mnt/user/backups/peufmreader         # 备份快照
```

在 `.env` 中设置：

```dotenv
PUID=99
PGID=100
TZ=Asia/Shanghai
APP_PORT=8080

PEUFM_DATA_ROOT=/mnt/user/appdata/peufmreader
PEUFM_IMPORT_ROOT=/mnt/user/ebooks/peufmreader-import
PEUFM_BACKUP_ROOT=/mnt/user/backups/peufmreader
CALIBRE_LIBRARY_PATH="/mnt/user/ebooks/Calibre Library"
```

创建应用可写目录：

```sh
mkdir -p /mnt/user/appdata/peufmreader/{library,staging,cache}
mkdir -p /mnt/user/ebooks/peufmreader-import
mkdir -p /mnt/user/backups/peufmreader
chown -R 99:100 /mnt/user/appdata/peufmreader/library \
  /mnt/user/appdata/peufmreader/staging \
  /mnt/user/appdata/peufmreader/cache \
  /mnt/user/ebooks/peufmreader-import \
  /mnt/user/backups/peufmreader
```

检查并启动：

```sh
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs --tail 100 app
```

PostgreSQL 数据必须放在 NAS 本机持久存储，不应放在另一台设备的 SMB/CIFS 网络共享上。数据库端口没有映射到主机，也不应手动向局域网或公网开放。

## 从其他设备迁移现有实例

不要复制正在运行的 PostgreSQL 原始数据目录。使用项目提供的逻辑备份：

```sh
docker compose stop -t 30 app
docker compose --profile tools run --rm -e BACKUP_NAME=migration backup
docker compose start app
```

将 `${PEUFM_BACKUP_ROOT}/migration` 整个目录复制到新 NAS 的备份目录，然后在新设备运行：

```sh
docker compose up -d db
sh scripts/restore.sh migration --yes
docker compose up -d --build
```

恢复会替换目标实例的数据库、托管书库、缓存和导入目录。执行前请确认目标路径和快照名称。

## 主要配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_PORT` | `8080` | NAS 对外监听端口 |
| `PUID` / `PGID` | `99` / `100` | 应用容器读写文件使用的 UID/GID |
| `PEUFM_DATA_ROOT` | `./data` | PostgreSQL、书库、暂存和缓存根目录 |
| `PEUFM_IMPORT_ROOT` | `./data/import` | 自动导入、成功归档和失败隔离目录 |
| `CALIBRE_LIBRARY_PATH` | `./data/calibre` | Calibre 根目录，以只读方式挂载 |
| `MAX_UPLOAD_BYTES` | `524288000` | 单个上传文件最大字节数 |
| `SESSION_TTL` | `720h` | 登录会话有效期 |
| `COOKIE_SECURE` | `false` | 仅通过 HTTPS 访问时设置为 `true` |
| `PDF_OCR_MODE` | `auto` | `auto`、`always` 或 `disabled` |
| `BIBLIOGRAPHY_PROVIDERS` | `openlibrary` | 首次启动时初始化启用的外部来源 |

完整配置及 AI、OCR、Google Books、豆瓣服务示例见 [.env.example](.env.example)。

> PostgreSQL 初始化完成后，修改 `.env` 中的 `POSTGRES_PASSWORD` 不会自动修改数据库内已有角色密码。管理员账号已存在时，修改 `ADMIN_PASSWORD` 也不会重置该账号密码。请使用管理后台修改账号，数据库密码则应在计划维护窗口内同步修改。

## 外部书目信息源

进入“管理后台 → 外部书目信息源”即可配置：

- 启用或停用来源。
- 服务地址、查询优先级、超时时间和最大候选数。
- “保存并测试”以及最近成功时间、响应耗时和最近错误。
- 导入后自动查询建议。

豆瓣书目源需要单独运行兼容服务，并填写其根地址，例如：

```text
http://192.168.3.118:5890
```

启用公网服务意味着书名、作者、ISBN 和语言等信息可能发送给第三方，请根据书库隐私要求决定是否开启。

## AI 分类

AI 默认关闭，不影响导入、规则分类和人工整理。局域网 Ollama 示例：

```dotenv
AI_PROVIDER=ollama
AI_BASE_URL=http://192.168.1.10:11434
AI_MODEL=qwen3:8b
```

OpenAI-compatible 服务示例：

```dotenv
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.example.com
AI_MODEL=provider-model-name
AI_API_KEY=replace-with-provider-api-key
```

AI 只提供分类建议，不能直接覆盖人工确认结果。使用云端服务意味着相关书目元数据会离开局域网。

## Calibre 与自动导入

`CALIBRE_LIBRARY_PATH` 以只读方式挂载到 `/import/calibre`。管理员可以先扫描预览，再将选中的 PDF、EPUB、MOBI、AZW3 复制到应用书库；原 Calibre 文件不会被修改或删除。

也可以将文件放入 `${PEUFM_IMPORT_ROOT}/inbox`。文件大小和修改时间稳定后会自动排队：

- 成功文件归档到 `processed/年-月`。
- 连续失败文件隔离到 `failed/任务标识`，同时写入错误说明。
- 后台任务在服务重启后继续处理。

## 备份与恢复

创建备份：

```sh
sh scripts/backup.sh
# 或指定名称
sh scripts/backup.sh before-upgrade
```

恢复：

```sh
sh scripts/restore.sh before-upgrade --yes
```

备份包含 PostgreSQL 导出、托管书库、缓存和导入目录，并通过 SHA-256 校验。恢复是破坏性操作，会替换当前数据，请先额外保留一份现有目录副本。

## 公网访问

不要直接把应用 HTTP 端口暴露到公网。至少需要：

- 受信任的 HTTPS 反向代理。
- `COOKIE_SECURE=true`。
- 正确配置反向代理网络的 `TRUSTED_PROXY_CIDR`。
- 强随机数据库密码和管理员密码。
- 定期备份并验证恢复流程。
- 不发布 `.env`、数据库目录、书籍文件或备份快照。

如果只是个人远程阅读，优先通过私有网络访问 NAS。

## 开发与验证

前端：

```sh
cd web
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

后端：

```sh
cd server
go test ./...
```

本机没有 Go 时可以使用容器：

```sh
docker run --rm -v "$PWD/server:/src" -w /src \
  golang:1.26.5-bookworm /usr/local/go/bin/go test ./...
```

完整 Docker 验证：

```sh
docker compose build
docker compose up -d
docker compose ps
```

性能基线脚本位于 `scripts/performance-seed.sql` 和 `scripts/performance-smoke.mjs`。设计决策、同类项目比较和阶段验证记录位于 [docs](docs/README.md)。

## 项目结构

```text
.
├── server/                  Go API、任务处理和数据库迁移
├── web/                     React Web 应用及阅读器
├── scripts/                 备份、恢复和性能验证脚本
├── docs/                    产品方案、ADR 和验证记录
├── compose.yaml             NAS/本地 Docker Compose 配置
├── Dockerfile               前后端多阶段构建
└── .env.example             配置模板
```

## 已知限制

- 不支持带 DRM 的电子书。
- PDF 字号无法像 EPUB 一样重新排版，阅读器提供的是页面缩放。
- OCR 会消耗较多 CPU 和临时磁盘空间。
- 外部书目服务可能受到网络、频率限制或上游页面变更影响。
- 当前仓库尚未附带开源许可证；公开可见不等同于获得复制、修改或再分发授权。

## 文档

- [NAS Web 实现方案](docs/product/nas-web-implementation-proposal.md)
- [同类 GitHub 项目比较](docs/discovery/github-project-comparison.md)
- [M0 技术验证](docs/validation/m0-technical-validation.md)
- [M1 导入分类验证](docs/validation/m1-import-classification-validation.md)
- [M2 阅读与运维验证](docs/validation/m2-reader-import-operations-validation.md)
