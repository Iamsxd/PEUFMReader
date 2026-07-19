# ADR-0004：采用 NAS 多用户 Web 模块化单体

- 状态：Accepted
- 日期：2026-07-19
- 取代：ADR-0001

## 背景

用户确认产品部署在 NAS 上，由多个用户通过浏览器共享书库。每位用户需要独立的阅读进度和阅读时长，但首版不要求原生客户端、离线同步、高亮或笔记。

## 决策

- 产品采用响应式 Web UI + 服务端模块化单体，通过 Docker Compose 部署。
- 推荐基线为 React/TypeScript/Vite 前端、Go 服务端和 PostgreSQL；正式编码前可根据团队技术经验调整语言，但模块边界不变。
- 应用服务同时承载 REST API、鉴权文件流和进程内后台 worker；首版不引入 Redis、独立消息队列或微服务。
- 共享 Work/Edition/BookFile、元数据和分类；按 User 隔离 ReadingState 与 ReadingSession。
- MVP 角色为 admin/reader。管理员导入和整理，reader 浏览和阅读。
- EPUB/PDF 通过鉴权 HTTP Range 接口提供，不暴露 NAS 路径。
- PostgreSQL 数据卷与书库卷分离；原始电子书使用托管复制，派生缓存可再生。

## 理由

- 多用户并发、权限和跨浏览器进度天然属于服务端模型，桌面 local-first 不再合适。
- Go 单体适合 NAS 的资源约束、文件 I/O 和简单部署；PostgreSQL 比共享卷上的 SQLite 更适合并发与任务抢占。
- 同一二进制内的后台 worker 足够完成 MVP，持久化 jobs 表可以保证重试和崩溃恢复。
- 浏览器侧可以直接复用 PDF.js 与 foliate-js，避免首版维护多套原生客户端。

## 备选方案

### Java/Spring Boot + Angular

BookLore 已验证这条路线，企业生态完整，但对小型 NAS 的内存和部署成本更高。

### .NET + Angular

Kavita 已验证扫描和阅读服务器能力，性能与部署良好；如果团队更熟悉 C#，可替代 Go，不改变领域与 API 设计。

### Node.js 全栈

开发速度快、前后端语言统一，但大型文件流、后台扫描和资源控制需要更谨慎的工程约束。

## 后果

- 认证、权限、会话安全、HTTP Range 和多用户隔离成为 MVP 必测项。
- 用户在任意浏览器登录后可以共享服务端进度，但首版不承诺离线阅读。
- NAS 类型、容器能力、卷文件系统和是否公网暴露必须在 M0 前确认。
- 若未来拆分 worker，可复用同一数据库任务协议，不需要改变领域模型。
