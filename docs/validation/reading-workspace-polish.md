# 阅读工作台流程打磨

日期：2026-10-04。分支：`codex/reading-library-enhancements`，基于 `87418c3`。

后端批量接口独立提交：`6aa797c`（`feat: support atomic personal shelf batches`）；前端流程、回归与本文档随后单独提交，便于版本追踪。

## 运行与版本边界

第一版 `87418c3` 已部署到本机 8080；本次仅继续开发与隔离验证，不推送、合并或替换该运行实例。数据库、书库及已有账号保持不变。本轮没有新增迁移。

后续部署补记（2026-10-04）：按用户要求将本篇对应完成提交 `ce8423c` 部署到本机 8080。升级前创建并校验 `before-polish-20261004-ce8423c`，保留原镜像 `peufmreader:before-polish-ce8423c`。采用本机构建、`docker compose up -d --no-deps --no-build --pull never app`，仅替换应用。应用健康检查、登录／退出、目录／首页／书架／笔记接口和 JS／CSS 资源均通过；前后聚合数一致（书籍 4、账号 1、阅读进度 3、批注 0、书架 0）。没有写入真实书架／批注或删除源文件。本文其余“本轮未部署”描述保留为开发阶段的历史边界。

前一次本机部署使用 `scripts/backup.sh`／`scripts/verify-backup.sh` 创建并校验 `before-workspace-20261004-87418c3`；保留旧镜像 `peufmreader:before-workspace-20261004` 和第一版 `peufmreader:workspace-87418c3`。再次升级仍需创建新备份，不能把旧快照当成最新数据。

## 完成范围

- 书架添加候选使用服务端分页，每页 12 本；支持跨页勾选、勾选本页和清空勾选，一批最多 100 本。重新提交搜索会清空勾选，页面有明确说明。
- 已选清单可展开核对书名，并单独取消其他页的勾选，不必跳回原候选页。
- 长书架名在导航和标题处限制展示行数，保留完整 DOM 文本和标题提示，避免小屏被单个长名称撑高。
- 候选归属按当前账号在服务器批量查询，不再只用书架当前页推断，已有项不重复添加。
- 批量添加只发送书籍 ID，不上传或复制书籍文件；按输入去重顺序追加。与单本追加／排序共用父行锁；服务端一次事务完成，包含任何无权或不存在书籍时整批拒绝。
- 批量操作失败后保留勾选；加载重试与写入重试区分，不自动重发写入。成功项与原已存在项分别反馈。
- 书架移除、排序、保存和删除提供非阻塞结果提示；最近移除的一本可重新加入书架末尾，不能恢复原位置，也不撤销删除书架。原书、进度与笔记不受影响。
- 笔记首次空记录与筛选无结果分别引导；筛选可一键清空，保存／删除提供持久的 `aria-live` 反馈。
- 保存失败保留编辑草稿；保存时禁用冲突操作并同步锁定防重复提交；在当前笔记页切换筛选、分页、编辑另一条或返回原文等局部流程中，放弃未保存内容前确认。没有增加全站离开页面／关闭浏览器的草稿保护或离线自动保存。
- 异步列表响应在切换条件／卸载后忽略，刷新同一范围不会先清空编辑器或书籍勾选。

## API 与安全边界

- `GET /api/v1/shelves/{id}/memberships?ids=1,2,3`：返回 `{bookIds: []}`；仅当前账号书架及当前可访问书籍。
- `POST /api/v1/shelves/{id}/books`：请求 `{bookIds: []}`，成功返回 `{addedBookIds: [], alreadyPresentBookIds: []}`；保留 CSRF 校验。
- 原始输入限制 1–100 个正整数，去重保持顺序；空／非法／超限输入为 400，另一账号／不存在书架为 404，无权或不存在的书籍导致整批 404、零写入。

## 验证

Go 验证在 `golang:1.26.6-bookworm` 容器中执行；集成测试使用独立 PostgreSQL 18 tmpfs 实例，未连接本机运行数据库。覆盖账号隔离、权限撤销、原子失败、并发混合追加、顺序与去重、CSRF、输入边界及 100／101 项限制。

前端浏览器使用生产构建预览、原创合成书目和状态化 API 拦截；不使用真实账号／电子书。笔记新增慢保存、失败保草稿、重复提交、放弃确认、清空筛选及 320px 双主题场景；书架补分页、跨页选择、候选归属、原子失败重试、重新加入与双主题小屏。

验证结果：

- `pnpm test`：71 项通过；`pnpm build` 通过，保留既有 PDF 分包超过 500 kB 提示。
- `go test ./...`、`go vet ./...`、独立 PostgreSQL 18 上 `go test -tags integration ./...` 全部通过。
- `pnpm audit --prod` 未发现已知漏洞；`govulncheck@v1.6.0` 未发现可达漏洞，另有 4 个依赖模块层漏洞提示但应用未调用相关符号，不能将此描述为所有模块无漏洞。
- Docker 镜像构建成功，本地标签 `peufmreader:workspace-polish-check`；没有推送镜像仓库或替换 8080 应用。
- 浏览器场景按唯一用例计：个人工作台 30 项、笔记打磨 12 项、双主题 24 项、站点外壳 3 项、原布局交互 10 项、真实接口往返 2 项通过，共 **81 项通过、3 项跳过**。跳过项为桌面“仅移动视口”断言及两个未配置专用书籍的推荐反馈写入场景，不算作通过。
- 新真实往返在独立临时应用与 tmpfs 数据库中上传原创 PDF，验证候选查询、浏览器批量添加、刷新持久化、接口重复幂等，以及删书架后原书与批注保留。
- 候选查询失败时禁止添加并提供显式重试；延迟返回的旧搜索不会覆盖新搜索；跨页清单核对与取消、320px 双主题无横向溢出均通过。

组合套件首次运行时 Chromium 在创建上下文前发生原生崩溃（CVDisplayLink / SIGSEGV）；站点外壳独立复测通过，不把崩溃批次计作通过。旧布局阅读器测试另遇到 PDF 加载跨过 3.5 秒工具栏自动隐藏窗口；修正测试为先等待 PDF 渲染，再用正常指针交互重启活动窗口，桌面／手机复测通过，未修改阅读器行为。

临时 PostgreSQL、应用容器与网络在验证后清理，只包含合成账号／书籍／批注；8080 原服务保持健康。本轮没有读取真实电子书或迁移运行数据。真实 iPhone／Android、真实 NAS 大书库性能和恢复演练仍需独立验收；拖拽排序、跨书导出、智能书架与新工作台离线功能本轮未实现。

## 复现命令

```sh
cd server
go test ./...
go vet ./...
# TEST_DATABASE_URL 只能指向专用测试 PostgreSQL，不能指向现有运行库。
go test -tags integration ./...
cd ../web
pnpm test
pnpm build
pnpm audit --prod
export E2E_BASE_URL=http://127.0.0.1:5189
export E2E_DISABLE_GPU=1
export E2E_DISABLE_VIDEO=1
# 使用生产构建预览；以下场景拦截 API，不读真实账号／书籍。
pnpm test:e2e e2e/personal-workspace.spec.ts --grep-invert 'marked PDF|marked EPUB' --workers=1 --reporter=list
pnpm test:e2e e2e/personal-workspace.spec.ts --grep 'marked PDF' --workers=1 --reporter=list
pnpm test:e2e e2e/personal-workspace.spec.ts --grep 'marked EPUB' --workers=1 --reporter=list
pnpm test:e2e e2e/notebook-polish.spec.ts --workers=1 --reporter=list
pnpm test:e2e e2e/themes.spec.ts --workers=1 --reporter=list
pnpm test:e2e e2e/site-shell.spec.ts --workers=1 --reporter=list
# 下列两个套件需先用一次性数据库＋应用镜像替代上述预览（仍为5189），
# 并提供该临时实例的 E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD。
E2E_WORKSPACE_SCRATCH=1 pnpm test:e2e e2e/personal-workspace-live.spec.ts --workers=1 --reporter=list
pnpm test:e2e e2e/layout-and-interactions.spec.ts --workers=1 --reporter=list
```
