# 阅读器与知识工作台第一批验证

> 日期：2026-10-05；分支 `codex/reader-knowledge-enhancements`，从 `master@fc398bb` 创建；实现与测试提交 `c087b19`。
>
> 本机 8080 未替换，继续运行 `fe9ee53`；没有操作生产数据库、原书、Calibre 目录或备份。没有合并、推送 GitHub 或触发远端自动构建。

## 实现与迁移

范围见[实施计划](../product/reader-knowledge-enhancements.md)。新增：

- `031_reading_mark_sync.sql`：幂等回执、书籍级联与删除批注时清除回执正文。
- `032_smart_shelves.sql`：手动／智能书架及集合式可见成员函数；旧书架保持手动及原顺序。
- `033_full_text_search.sql`：正文索引元信息与片段、trigram 索引。

只在临时 PostgreSQL 的隔离 schema 验证 001–033；生产数据库仍为 001–030。上线会新增表／字段，应重新按部署约定准备迁移，不把此前一次“无需备份”当作永久许可。

## 验证结果

| 检查 | 当前结果 |
| --- | --- |
| `go test ./...` | 通过（Go 1.26.6 构建容器） |
| `go test -tags integration ./...` | 通过；含全部迁移重复执行、账号／权限、同步回执与冲突、删除隐私、索引原子替换及智能规则 |
| `pnpm test` | 20 文件／139 项通过 |
| `pnpm build` | Node 24 生产构建通过；已有 PDF 分包超过 500 kB 提示保留 |
| 新增能力与阅读器浏览器矩阵 | 58 项通过（24 项新增能力、34 项阅读器回归） |
| 工作台浏览器矩阵 | 71 项通过、1 项桌面移动溢出检查按设计跳过 |
| `pnpm audit --prod --audit-level=high` | 0 个已知漏洞 |
| `go vet`／`govulncheck v1.6.0` | 通过；0 个可达漏洞，4 个仅模块级非调用项（不等于依赖模块完全无漏洞） |
| Docker 应用构建 | 最终源码构建通过，`peufmreader:knowledge-development`；未部署 |
| `git diff --check` | 通过，含最终暂存差异复核 |

Playwright 使用 `http://127.0.0.1:5196` 的独立生产资源预览，阻断 Service Worker 并模拟 API。书籍全部为程序生成的原创 PDF／EPUB fixture；没有登录生产服务或读取真实电子书。桌面 Chromium 与 Pixel 7 视口验证，不代表真实手机或 Safari。

最终同批执行 130 项，129 项通过、1 项按设计跳过（2.4 分钟，无自动重试）；产物位于被忽略的 `web/test-results/knowledge-refinements/final-verified/`。临时 PostgreSQL 容器只有 tmpfs 测试数据，无生产挂载，验证后已删除，不保留该合成数据库；5196 预览服务也已停止。

新增关键场景：离线笔记联网一次回放、大 PDF Range、跨页选区一条高亮、暂停中的睡眠截止、EPUB 可见段落跟随、点击已有高亮编辑、JSON 书籍归属预览／重复重试、裁边保持原坐标、取消放弃草稿、正文出处导航、智能规则与手动操作隔离、保存中规则锁定与连续更换草稿后仍可拒绝离开。

最终开发镜像 ID：`sha256:de942a692e5e4802fdec9168b1d3ea65af7f5bddd1cede1bab09bb72f2040bcf`；这是本地测试构建，不是已发布版本，也没有覆盖本地 `edge` 镜像别名。

## 边界与待验收

- 后台音频生成、引用 AI 问答、第三方同步、EPUB 跨 iframe 选区尚未实现，不能把第一批称为四个方向全部完成。
- 尚未执行 iPhone／Android 真机、iOS 主屏幕、Safari、锁屏／蓝牙听书或授权真实语料验收。
- 尚未执行 NAS 3000 本真实全文索引容量与性能测试、OCR 部分页语料检查、索引服务运行中权限撤回压力测试或容器系统包扫描。
- API／浏览器权限测试与本地构建通过不等于正式上线。隔离索引单测也不等于测试了全部复杂 EPUB 结构、加密文件或多栏 PDF。
- 开发过程曾出现跨页 DOM 选区夹带整页容器、工具栏切换点击坐标变化、裁边侧栏误显示搜索及保存后的草稿守卫误阻导航；均已修复并补回归。手动书架多请求分类导致的严格夹具失败通过按需加载修复，没有放宽请求校验。笔记返回 PDF 的一轮超时发生在工具栏自动收起时，测试改为在页码恢复后通过正常 Tab 操作唤起工具，再点击批注，没有强制点击或提高重试数。另曾用错误宿主 Node 构建命令，已使用 Node 24 重新构建；失败批次不计入最终通过数。

## 可复现命令

```sh
cd server
go test ./...
TEST_DATABASE_URL='postgres://测试账号:测试密码@127.0.0.1:5432/测试库?sslmode=disable' go test -tags integration ./...
go vet ./...
go run golang.org/x/vuln/cmd/govulncheck@v1.6.0 ./...

cd ../web
pnpm test
pnpm audit --prod --audit-level=high
pnpm build
E2E_BASE_URL=http://127.0.0.1:5196 E2E_BROWSER_CHANNEL= E2E_DISABLE_GPU=1 E2E_DISABLE_VIDEO=1 \
  pnpm test:e2e e2e/reader-knowledge.spec.ts e2e/reader-refinements.spec.ts \
    e2e/notebook-polish.spec.ts e2e/notebook-export.spec.ts e2e/shelf-drag-sort.spec.ts \
    e2e/personal-workspace.spec.ts e2e/site-shell.spec.ts --workers=2 --global-timeout=360000
```

Node 路径应使用项目要求的现代运行时；宿主系统旧 Node 的错误退出码可能误报成功，必须核对 Vite 实际构建成功输出。
