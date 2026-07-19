# PEUFMReader 设计文档索引

产品方向已确认为 NAS 上的多用户 Web 应用，用户已授权进入实现。当前已完成 M0 技术基线与 M1 导入分类闭环，不代表完整 MVP 已交付。

- [GitHub 同类项目调研](./discovery/github-project-comparison.md)
- [NAS 多用户 Web 实现方案](./product/nas-web-implementation-proposal.md)
- [M0 技术验证记录](./validation/m0-technical-validation.md)
- [M1 导入分类验证记录](./validation/m1-import-classification-validation.md)
- [M2 阅读、导入与运维闭环验证](./validation/m2-reader-import-operations-validation.md)
- [早期桌面方案（已废弃）](./product/implementation-proposal.md)
- [领域术语表](./domain/glossary.md)
- [ADR-0001：local-first 桌面模块化单体](./adr/0001-local-first-desktop.md) — Rejected
- [ADR-0002：原文件不可变与托管书库](./adr/0002-library-storage.md) — Accepted
- [ADR-0003：可解释自动分类管线](./adr/0003-explainable-classification.md) — Accepted
- [ADR-0004：NAS 多用户 Web 模块化单体](./adr/0004-nas-multi-user-web.md) — Accepted

已确认环境：Unraid Docker Compose、约 10 个用户和 3000 本书；首期局域网访问，未来可能公网访问；AI 同时考虑本地 Ollama 与云端提供者；Calibre 导入是可选迁移路径。
