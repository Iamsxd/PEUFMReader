# GitHub 同类项目调研

> 调研快照：2026-07-19。功能、活跃度与依赖版本会继续变化，链接均指向项目的一手资料。

## 结论先行

PEUFMReader 不适合直接复刻某一个项目，更合理的组合是：

- 借鉴 **BookLore** 的导入收件箱、元数据候选、智能书架和多格式进度模型。
- 借鉴 **Kavita** 的扫描容错、响应式 Web 阅读器和按用户隔离的阅读状态。
- 借鉴 **Readest** 的跨平台阅读体验、`foliate-js`/PDF 阅读器组合和离线优先思路。
- 保留 **Calibre-Web** 对 Calibre/OPDS 生态的兼容意识，但不继承其对 Calibre 数据库的强耦合。
- 借鉴 **Paperless-ngx** 的“收件箱—规则匹配—低置信度复核—从人工修正学习”流程；它是分类设计参照，不是电子书竞品。

市场上的共同问题是：元数据抓取经常被称作“自动分类”，但它只解决了书名、作者、封面和外部分类字段，并没有解决分类体系归一化、置信度、冲突处理和错误回滚。PEUFMReader 应把这四件事作为一等能力。

## 对比矩阵

| 项目 | 产品定位 | 管理与自动整理 | 阅读与记录 | 架构与技术栈 | 主要优点 | 主要缺点/风险 |
|---|---|---|---|---|---|---|
| [BookLore](https://github.com/booklore-app/booklore) | 自托管、多用户数字书库 | BookDrop 监控导入；Google Books/Open Library/Amazon 元数据；规则式 Magic Shelves；导入前复核 | 浏览器内 EPUB、PDF、漫画阅读；高亮、批注、进度；Kobo/KOReader 同步 | 单仓库前后端分离；Java 25、Spring Boot 4、JPA、Flyway、MariaDB；Angular 21、PrimeNG；PDF 使用 `ngx-extended-pdf-viewer`，EPUB 侧包含 Foliate 代码 | 与目标最接近；导入链路完整；领域对象丰富；多用户和设备同步已经成型 | 项目较新；后端和部署偏重；AGPL-3.0；网络存储模式会禁用文件重组等写操作；功能面很大，照搬会拖慢 MVP |
| [Kavita](https://github.com/Kareadita/Kavita) | 漫画、书籍一体的跨平台阅读服务器 | 扫描已有目录；丰富元数据、过滤器、收藏和阅读列表；外部元数据的部分能力属于 Kavita+ | EPUB/PDF/漫画响应式阅读；EPUB 高亮批注；阅读进度、阅读次数和 KOReader 同步 | .NET 10 / C# 分层单体，Entity Framework；Angular 21；SQLite 为常见部署选择；PDF 使用 `ngx-extended-pdf-viewer` | 大型书库扫描经验成熟；读者和权限模型完整；部署与社区成熟度较高 | 仍标注 beta；产品模型明显偏系列/漫画；自动分类更多依赖文件结构与已有元数据；部分外部元数据能力付费；GPL-3.0 |
| [Calibre-Web](https://github.com/janeczku/calibre-web) | Calibre 数据库的 Web 前端 | 高级检索、书架、元数据编辑/下载、格式转换；依赖有效的 Calibre `metadata.db` | 浏览器阅读多种格式；Kobo 同步、OPDS、发送到设备 | Python/Flask/SQLAlchemy；服务端模板与 Bootstrap 3；可调用 Calibre、ImageMagick、Ghostscript 等外部二进制 | Calibre 生态兼容性强；格式转换和设备工作流成熟；部署简单 | 不是独立书库内核；对 Calibre 模型和数据库强耦合；前端架构偏旧；自动分类和细粒度阅读统计不是强项；GPL-3.0 |
| [Readest](https://github.com/readest/readest) | 本地与云同步的跨平台深度阅读器 | 本地书库、分组/标签、OPDS/Calibre 接入；自动分类较弱 | EPUB、MOBI、AZW3、FB2、CBZ、TXT、PDF；高亮、笔记、TTS、翻译、双书并读、跨端同步 | pnpm 单仓库；Next.js 16、React 19、Tauri v2/Rust；`foliate-js`；Turso 类本地数据库与 Supabase 服务 | 阅读体验和跨平台覆盖最强；可访问性好；本地应用与 Web 共用 UI 的范例 | README 仍把高级阅读统计和全书库全文检索列为建设中/计划项；同步与多平台矩阵显著增加复杂度；管理/分类不是核心；AGPL-3.0 |

### 自动分类参照：Paperless-ngx

[Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx) 的目标是文档归档，不适合作为阅读器基础，但它的分类流程值得借鉴：

- 先保留不变的原始文件，再生成索引和派生数据。
- 新内容先进入可人工处理的 inbox，而不是静默改变文件。
- 同时支持 Exact、Any、All、正则、模糊匹配和 Auto 学习匹配。
- Auto 模式从用户已确认的数据学习，并明确要求足够的正例和负例。
- 对批量重新分类提供 dry-run/限定范围/是否覆盖等安全边界。

PEUFMReader 的差异是：书籍通常已经有 EPUB OPF、PDF Info、ISBN、目录和封面等结构化信号，所以应先利用确定性信号，再用正文分类；不应从第一版就依赖 LLM。

## 功能拆解

| 能力 | BookLore | Kavita | Calibre-Web | Readest | PEUFMReader 建议 |
|---|---:|---:|---:|---:|---|
| 文件夹监控/自动导入 | 强 | 强 | 弱 | 中 | MVP |
| 去重与导入复核 | 强 | 中 | 中 | 中 | MVP，必须可恢复 |
| 内嵌元数据提取 | 强 | 强 | 强 | 强 | MVP |
| 外部元数据候选 | 强 | 部分能力付费 | 强 | 有 | MVP，提供者可插拔 |
| 可解释自动分类 | 规则书架为主 | 智能过滤为主 | 弱 | 弱 | 核心差异化 |
| EPUB 阅读 | 强 | 强 | 有 | 很强 | MVP |
| PDF 阅读 | 强 | 强 | 有 | 强 | MVP |
| 高亮/笔记 | 强 | EPUB 强 | 弱 | 很强 | 第二阶段；先预留数据模型 |
| 活跃阅读时长 | 有会话模型 | 新版本增强 | 弱 | 正在增强 | MVP 记录会话，统计 UI 可后置 |
| 多端同步 | Kobo/KOReader | KOReader/OPDS | Kobo/OPDS | 原生跨平台 | 第三阶段，不进入首版关键路径 |
| 全书库全文检索 | 有 | 元数据为主 | 有限 | README 列为计划 | 第二阶段，SQLite FTS5 |

## 架构观察

### 1. 不要把格式处理塞进一个“万能 Reader”

PDF 是固定版式，进度天然以页为主；EPUB 是可重排文档，进度需要 CFI、章节 href 和整体比例的组合。BookLore 的后端和数据模型分别处理 PDF、EPUB、CBX 进度，Readest 也有大量格式相关进度测试。统一 UI 可以有，但持久化锚点必须按格式建模。

### 2. 文件扫描必须是持久化任务，不是一个长函数

大型书库会遇到文件未写完、损坏压缩包、重复文件、移动/重命名、程序中断和再次扫描。导入阶段应幂等，并把状态、错误和重试次数落库。Kavita 的扫描演进和 BookLore 的 BookDrop/任务表都说明这一点。

### 3. 自动分类必须保留来源和置信度

外部服务的 subjects/categories 并不一致，中文书名的同名匹配也容易误判。每个候选字段应保存来源、原值、归一化值、分数和采用状态。不能只在 `book.category_id` 上写最终结果，否则无法解释和回滚。

### 4. NAS 多用户已经成为主路径，但不同时做原生多端同步

目标已确认为 NAS 上的多用户 Web 应用，因此身份认证、权限、HTTP Range 文件流和按用户隔离的进度必须进入 MVP。浏览器访问天然共享服务端进度，但离线阅读、原生手机应用和第三方设备双向同步仍后置，避免同时引入冲突合并与多套客户端。

## 一手资料

- BookLore：[README](https://github.com/booklore-app/booklore#readme)、[后端构建配置](https://github.com/booklore-app/booklore/blob/develop/booklore-api/build.gradle)、[前端依赖](https://github.com/booklore-app/booklore/blob/develop/booklore-ui/package.json)
- Kavita：[README](https://github.com/Kareadita/Kavita#readme)、[.NET SDK 配置](https://github.com/Kareadita/Kavita/blob/develop/global.json)、[前端依赖](https://github.com/Kareadita/Kavita/blob/develop/UI/Web/package.json)
- Calibre-Web：[README](https://github.com/janeczku/calibre-web#readme)、[Python 项目配置](https://github.com/janeczku/calibre-web/blob/master/pyproject.toml)
- Readest：[README](https://github.com/readest/readest#readme)、[应用依赖](https://github.com/readest/readest/blob/main/apps/readest-app/package.json)
- Paperless-ngx：[自动匹配说明](https://docs.paperless-ngx.com/advanced_usage/#matching-tags-correspondents-document-types-and-storage-paths)、[导入流程](https://docs.paperless-ngx.com/usage/#adding-documents-to-paperless-ngx)
