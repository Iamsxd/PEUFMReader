# PEUFMReader 设计文档索引

产品方向已确认为 NAS 上的多用户 Web 应用。当前已完成 M0～M2 技术闭环及 P1 用户体验优化；P2 增强仍按路线图推进，不代表已经达到无需运维验证的公网发布状态。

跨机器、跨账号将项目交给另一台 Codex 时，先阅读 [Codex 交接包](./handoff/CODEX_HANDOFF.md) 和 [新机器启动提示](./handoff/NEW_MACHINE_PROMPT.md)。

- [后续开发计划与当前完成状态](./product/development-roadmap.md)
- [GitHub 同类项目调研](./discovery/github-project-comparison.md)
- [NAS 多用户 Web 实现方案](./product/nas-web-implementation-proposal.md)
- [M0 技术验证记录](./validation/m0-technical-validation.md)
- [M1 导入分类验证记录](./validation/m1-import-classification-validation.md)
- [M2 阅读、导入与运维闭环验证](./validation/m2-reader-import-operations-validation.md)
- [运维监控增强验证](./validation/operations-monitoring-enhancements.md)
- [阅读器真实语料与自动化回归](./validation/reader-corpus-regression.md)
- [桌面与移动浏览器系统测试](./validation/browser-system-test.md)
- [依赖安全与发布加固验证](./validation/security-release-hardening.md)
- [早期桌面方案（已废弃）](./product/implementation-proposal.md)
- [领域术语表](./domain/glossary.md)
- [ADR-0001：local-first 桌面模块化单体](./adr/0001-local-first-desktop.md) — Rejected
- [ADR-0002：原文件不可变与托管书库](./adr/0002-library-storage.md) — Accepted
- [ADR-0003：可解释自动分类管线](./adr/0003-explainable-classification.md) — Accepted
- [ADR-0004：NAS 多用户 Web 模块化单体](./adr/0004-nas-multi-user-web.md) — Accepted

已确认环境：Unraid Docker Compose、约 10 个用户和 3000 本书；首期局域网访问，未来可能公网访问；AI 同时考虑本地 Ollama 与云端提供者；Calibre 导入是可选迁移路径。
