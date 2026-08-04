# 运维监控增强验证

## 范围

本次在既有管理员运维页和进程内请求指标之上增加：

- 书库、暂存区和缓存目录的文件系统总量、可用空间与已用百分比；API 只返回用途标签，不返回真实路径。
- 按后台任务类型统计近 24 小时完成数、失败数、端到端平均耗时和 P95。端到端耗时从任务入队算到完成或最终失败，包含排队与重试，更接近管理员实际等待时间。
- 统一健康状态与可配置的预警/严重阈值。阈值覆盖磁盘已用比例、最长排队时间和近 24 小时失败任务数。
- 默认关闭的 `GET /metrics` Prometheus 文本导出。启用时必须使用独立 Bearer Token；标签只使用固定用途、任务类型和归一化路由，不包含用户、书名、正文或文件路径。

`GET /healthz` 仍只检查应用和数据库是否可用。健康阈值不会改变容器存活检查状态，避免容量预警触发自动重启循环。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HEALTH_DISK_WARNING_PERCENT` | `85` | 磁盘已用预警百分比 |
| `HEALTH_DISK_CRITICAL_PERCENT` | `95` | 磁盘已用严重百分比 |
| `HEALTH_QUEUE_WARNING` | `5m` | 最长排队预警阈值 |
| `HEALTH_QUEUE_CRITICAL` | `30m` | 最长排队严重阈值 |
| `HEALTH_FAILED_JOBS_WARNING` | `1` | 24 小时失败任务预警数 |
| `HEALTH_FAILED_JOBS_CRITICAL` | `5` | 24 小时失败任务严重数 |
| `PROMETHEUS_ENABLED` | `false` | 是否开放指标端点 |
| `PROMETHEUS_BEARER_TOKEN` | 空 | 启用时必须至少 24 字符 |

所有预警阈值必须严格小于对应严重阈值。Token 只能保存在本机 `.env` 或部署系统的密钥管理中。

Prometheus 抓取示例：

```yaml
scrape_configs:
  - job_name: peufmreader
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: ${PEUFMREADER_METRICS_TOKEN}
    static_configs:
      - targets: [reader.example.internal:8080]
```

## 验证清单

- `cd server && go test ./...`
- `cd web && pnpm test && pnpm build`
- `docker compose config --quiet`
- `docker compose up -d --build`
- 管理员打开“任务与运维”，确认健康摘要、三个磁盘用途、任务分类耗时和请求指标可见。
- 未启用 Prometheus 时 `/metrics` 返回 404；启用后无 Token 或错误 Token 返回 401，正确 Token 返回 Prometheus 文本。
- `/healthz` 在数据库正常时继续返回 200。

不得把测试 Token、`.env`、书籍、`data/`、`backups/` 或 `tmp/` 纳入提交。
