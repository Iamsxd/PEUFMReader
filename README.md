# PEUFMReader

面向 NAS 的多用户电子书管理与阅读服务。当前已完成 M0 技术基线与 M1 导入分类闭环，覆盖：

- Docker Compose + PostgreSQL 部署。
- admin/reader 本地账号、Argon2id 密码、HttpOnly 会话和 CSRF 防护。
- EPUB/PDF 托管上传、SHA-256 去重和格式签名校验。
- 鉴权 HTTP Range 文件流，不向浏览器暴露 NAS 路径。
- 浏览器 EPUB/PDF 阅读，以及按用户隔离的进度和有效阅读时长。
- EPUB OPF 与 PDF Info 元数据提取、EPUB 封面缓存、作者/年份/题材分组和搜索。
- 19 个固定题材分类、双语确定性规则、证据/置信度、管理员待整理与可撤销决策。
- 可选 Ollama 或 OpenAI-compatible AI 分类建议；AI 不能自动覆盖人工选择。
- Open Library 与可选 Google Books 外部书目候选；管理员确认前不会覆盖本地元数据。
- 每次成功、重复或失败导入都保留任务审计记录。
- Calibre `metadata.opf` 只读预检与批量迁移，来源文件不会被修改或删除。
- PostgreSQL 持久后台任务、租约、自动重试和服务重启恢复。
- PDF 首页封面、原生文本提取，以及扫描件的可选中英文 OCR。

目标环境是 Unraid Docker Compose，按约 10 个用户、3000 本书（典型 PDF 约 20 MB）设计。Calibre 不是运行依赖，也可以继续使用浏览器上传。

## 本地启动

1. 复制 `.env.example` 为 `.env`，修改两个密码。
2. 确保数据目录对 `.env` 中的 PUID/PGID 可写。
3. 启动服务：

   ```sh
   docker compose up --build -d
   ```

4. 打开 `http://NAS-IP:8080`，使用 `.env` 中的管理员账号登录。

查看状态：

```sh
docker compose ps
docker compose logs -f app
```

停止服务：

```sh
docker compose down
```

`docker compose down` 不会删除数据目录。不要使用 `down -v` 或手工删除 `PEUFM_DATA_ROOT`，除非已经确认备份。

## Unraid 配置

建议在 `.env` 中设置：

```dotenv
PUID=99
PGID=100
PEUFM_DATA_ROOT=/mnt/user/appdata/peufmreader
CALIBRE_LIBRARY_PATH=/mnt/user/ebooks/Calibre Library
```

PostgreSQL 数据应位于 Unraid 本机持久卷，不要把数据库目录放到另一台机器的 SMB/CIFS 共享。书库文件保存在 `${PEUFM_DATA_ROOT}/library`，可再生封面保存在 `${PEUFM_DATA_ROOT}/cache`。

`CALIBRE_LIBRARY_PATH` 会以只读方式挂载到容器的 `/import/calibre`。管理员先点击“扫描 Calibre”查看预检结果，再点击“迁移全部”；每个 PDF/EPUB 都是独立可恢复任务，迁移只复制文件，不改写 Calibre 目录。

## AI 分类（可选）

AI 默认关闭；不配置时导入、规则分类和人工整理均可正常工作。启用方式见 `.env.example`：

- `AI_PROVIDER=ollama`：调用局域网 Ollama。
- `AI_PROVIDER=openai-compatible`：调用兼容 Chat Completions 的云端服务。

AI 只在管理员点击“请求 AI 建议”时发送书名、作者、年份、语言、题材和简介，并且只能返回固定分类 ID。使用云端提供者意味着这些元数据会离开局域网，请在配置前确认服务条款和隐私边界。

## 外部书目候选

默认启用 Open Library。管理员在整理表单点击“查询外部书目”后，服务才会发送 ISBN，或书名与作者；匹配结果只填充候选表单，必须人工保存才能成为正式元数据。完全禁用可设置：

```dotenv
BIBLIOGRAPHY_PROVIDERS=
```

若要同时查询 Google Books，启用 Books API、创建受限 API Key 后设置：

```dotenv
BIBLIOGRAPHY_PROVIDERS=openlibrary,google-books
GOOGLE_BOOKS_API_KEY=your-restricted-api-key
```

外部查询会把上述书目信息发送到对应服务，请根据书库隐私要求决定是否启用。

## PDF 封面与 OCR

PDF 导入后会在后台生成首页封面，并先尝试提取原生文本。默认 `PDF_OCR_MODE=auto`，仅当文本过少、疑似扫描件时逐页运行 Tesseract `chi_sim+eng`；每次只渲染一页，避免大型 PDF 填满临时目录。可在 `.env` 调整：

```dotenv
PDF_OCR_MODE=auto
PDF_OCR_LANGUAGES=chi_sim+eng
PDF_OCR_MAX_PAGES=500
PDF_OCR_DPI=180
```

OCR、封面和文本都属于可再生缓存，原始 PDF 不会被修改。处理失败会自动重试三次，也可以在管理员“处理队列”中人工重试。

## 公网访问边界

当前版本适合局域网 M0 验证。若通过公网访问，至少需要：

- 使用受信任的 HTTPS 反向代理，并设置 `COOKIE_SECURE=true`。
- 增加登录限流、账号锁定、反向代理可信 IP 配置和安全审计。
- 不直接暴露 PostgreSQL，也不公开 `/data` 路径。

在这些工作完成前，不应将当前版本直接暴露到公网。

## 开发验证

前端：

```sh
cd web
pnpm install
pnpm test
pnpm build
```

后端（本机无 Go 时可使用容器）：

```sh
docker run --rm -v "$PWD/server:/src" -w /src golang:1.26.5-bookworm /usr/local/go/bin/go test ./...
```

完整架构与范围见 [实现方案](docs/product/nas-web-implementation-proposal.md)，验证结果见 [M0](docs/validation/m0-technical-validation.md) 与 [M1 技术验证记录](docs/validation/m1-import-classification-validation.md)。
