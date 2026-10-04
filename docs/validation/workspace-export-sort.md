# 跨书笔记导出与书架握柄排序

日期：2026-10-04。分支：`codex/reading-workspace-export-sort`，基于 `ce8423c`。

版本：部署记录 `163572b`；排序后端 `7ac47c1`；导出后端 `65001fb`；前端流程与隔离回归 `3a77ed0`；布局拦截稳定性 `f41fd3f`。按边界分开提交，均未推送或合并。

## 部署与数据边界

用户本轮要求先部署最新版再继续开发。已将完成的 `ce8423c` 部署至本机 8080；升级前通过项目脚本创建并校验 `before-polish-20261004-ce8423c`，保留旧镜像 `peufmreader:before-polish-ce8423c`。仅重建并替换应用，不替换数据库。登录／退出、健康、目录、首页、书架、笔记接口和前端资源均正常；书籍／账号／阅读进度／批注／书架前后数量一致（4／1／3／0／0）。

随后在新分支开发以下功能，新代码没有推送、合并或再次替换 8080。本轮没有新增数据库迁移，也没有读取／复制真实电子书。真实实例烟测不创建书架、批注或测试账号；写入验证仅使用独立 PostgreSQL 18 tmpfs 和原创合成 PDF。

## 完成范围

- 书架 ⠿ 握柄使用 PointerEvent 与 pointer capture，兼容鼠标／触摸；5px 移动阈值，卡片上下半区对应之前／之后，显示插入线与屏幕阅读器状态。
- 仅握柄使用 `touch-action:none`，普通卡片文字仍可触摸滚动；Esc、pointercancel、失去 capture、切换范围与卸载取消手势。无效、邻接无变化、卡片外落点不提交。
- 请求期间锁定冲突操作并同步防重复提交；成功后重新查询，不做误导性的本地乐观重排。失败原顺序保持，可显式重试。
- 拖拽仅面向当前页有效落点；原 ↑↓ 保留键盘操作与跨页逐本移动。不支持拖拽跨页或拖动期间自动滚屏。
- 笔记按当前已提交筛选导出全部匹配记录，而非只下载当前页；未提交搜索文字与未保存草稿不纳入文件，下载不清空它们。
- JSON 使用 `version:1`、`generatedAt`、`filters`、`items`，记录含书名／格式、摘录／批注、时间和完整定位数据；Markdown 将不可信内容作为转义文本，不生成外部图片／链接／HTML。
- 固定 `notebook.json`／`notebook.md` 文件名；返回 `private,no-store`／`nosniff`，导出文件不留在服务器缓存。前端下载检查 MIME、按块限制 16 MiB，并延迟释放临时 Object URL；不写浏览器持久存储。
- 最多 5000 条或 16 MiB（原始文本与最终序列化分别限制）。超限返回 413，不返回部分附件或静默截断。导出需要联网，文件含私人笔记需自行保管；没有实现导入／第三方笔记同步。

## 接口与正确性

- `PATCH /api/v1/shelves/{id}/order`，请求 `{bookId,targetBookId,placement:"before"|"after"}`，成功 204。原有 CSRF／账号认证不变；非法输入 400，无权／不存在／非成员 404，零写入。
- 排序锁定所属书架父行，与批量追加和原箭头排序串行化；单条 CTE 按全部成员排序，兼容稀疏 position，保留隐藏／其他页记录与其余书相对顺序；重复相对移动幂等。
- `GET /api/v1/notebook/export?format=markdown|json`，复用列表的 q／kind／color／bookId 校验与 SQL，拒绝 page／pageSize。单 SQL 快照同时过滤记录所有者与当前可访问书籍，无逐页拼接竞态，不暴露其他账号或权限撤销后的批注。

## 验证

后端全量 `go test ./...`、`go vet ./...` 与独立 PostgreSQL 18 的 `go test -tags integration ./...` 全部通过；排序专项另连续运行 5 次。覆盖稀疏位置、隐藏记录、幂等、权限与账号隔离、CSRF、与批量／箭头并发，以及导出跨页完整性、过滤、恶意文本、5000／5001 项、原始与转义大小边界。

前端 `pnpm test` 93 项通过，`pnpm build` 通过；保留原 PDF 分包超过 500 kB 的构建提示。`pnpm audit --prod` 未发现已知漏洞。新代码 Docker 镜像构建通过，独立标签 `peufmreader:workspace-export-sort-check`，不覆盖运行中的 edge 镜像。

`govulncheck@v1.6.0 ./...` 退出 0：当前代码可达漏洞 0、已导入包漏洞 0；另有 4 条 require 模块层级漏洞提示，当前代码不调用对应漏洞。不能把这个结果描述为所有依赖模块都无漏洞。本轮没有改变依赖版本。

浏览器按唯一场景计 **109 项通过、3 项条件跳过**：个人工作台 30、笔记流程 12、拖拽 16、导出 10、双主题 24、站点外壳 3、布局交互 10、原私人工作台真实往返 2、新排序／导出真实往返 2。跳过为桌面专属移动断言和两个无推荐候选的反馈写入场景，不算通过。

测试区分全 API 拦截的状态化原创夹具与必须显式开启、限制到 `http://127.0.0.1:5189` 的真实接口往返。真实往返分别使用桌面鼠标和移动 CDP touch，将首项拖到第三项之后，刷新与 API 再查询确认持久化；3 本原创 PDF 的书籍／批注保持不变，再通过笔记 UI 下载 JSON／Markdown，核对跨书内容、完整定位、时间、MIME、禁止缓存和固定文件名。手机视口和 CDP 触摸不等于 iPhone／Android 真机或 PWA 安装验收。

首次拖拽测试有两个夹具问题：折叠区内 textbox 不能用默认可见角色定位，触摸落点处于固定手机底栏背后。修正为检查已挂载输入框，以及在手势前将两卡居中到未遮挡区域，并用 `elementFromPoint` 验证实际命中；保留严格落点断言，38 项相关场景复测全通过。旧布局首页的一次请求计数断言未捕获请求，独立重跑通过；API 拦截套件禁用 Service Worker 后桌面／移动全套通过，未更改应用缓存行为。

组合套件另发生 Chromium 原生 CVDisplayLink／SIGSEGV 上下文启动失败；对应 EPUB 场景独立重跑通过。失败批次不计作通过，以上是各唯一场景最终复测结果。额外尝试单独对 E2E 运行 tsc 时项目缺少 Node 类型定义，未能启动该静态检查，不计通过；标准前端 tsc／生产构建、E2E 清单解析与实际运行均通过。

独立测试应用／PostgreSQL 的挂载经核实仅 tmpfs、无真实 bind／volume，验证结束后清理其精确容器与网络，仅删除合成账号／书籍／批注。保留测试镜像，8080 原实例继续健康。真实 iPhone／Android PWA 安装、真实 NAS 大书库性能和副本恢复演练仍待独立验收。

## 复现命令

```sh
cd server
go test ./...
go vet ./...
# TEST_DATABASE_URL 仅能指向独立测试数据库。
go test -tags integration ./...
cd ../web
pnpm test
pnpm build
pnpm audit --prod
export E2E_BASE_URL=http://127.0.0.1:5189
export E2E_DISABLE_GPU=1
export E2E_DISABLE_VIDEO=1
pnpm test:e2e e2e/shelf-drag-sort.spec.ts e2e/notebook-export.spec.ts e2e/notebook-polish.spec.ts --workers=1 --reporter=list
# 下面的写入测试仅在一次性 tmpfs 数据库/书库实例执行，
# 需要显式提供该实例合成 E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD。
E2E_WORKSPACE_SCRATCH=1 pnpm test:e2e e2e/workspace-export-sort-live.spec.ts --workers=1 --reporter=list
```
