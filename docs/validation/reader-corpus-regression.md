# 阅读器真实语料稳定性与自动化回归

本套回归直接读取 NAS/本机已导入的真实 PDF 与 EPUB，不将书籍文件、封面或正文提交到 Git。它把“文件是否可服务”和“浏览器是否可稳定阅读”拆成两条可定位的验证链路。

## 使用测试账号

创建一个专用的普通阅读者账号，例如 `reader-regression`，只授予用于回归的书库组访问权。不要使用管理员或日常用户账号：浏览器阅读会建立会话、保存进度，并可能产生阅读时长。

如果回归书籍属于受限书库组，需要在“管理后台 → 用户与权限”中把该测试账号加入有“允许”权限的用户组。

## 语料选择

默认每种格式选择书名排序后的前两本 PDF、EPUB。可配置以下环境变量：

| 变量 | 用途 |
| --- | --- |
| `E2E_READER_CORPUS_IDS=12,18,23` | 精确选择书籍 ID，适合固定基线语料。 |
| `E2E_READER_MAX_PER_FORMAT=3` | 未指定 ID 时，每种格式最多抽样数量。 |
| `READER_INCLUDE_KINDLE=true` | 内容烟测额外检查 MOBI/AZW3 转换出的 EPUB；浏览器交互仍由 EPUB 阅读器覆盖。 |

建议固定至少 6 份脱敏或具有测试授权的样本：多页文本 PDF、扫描 PDF、图片密集 PDF、普通 EPUB、长章节 EPUB、复杂 CSS/目录 EPUB。每次导入新类型或修复阅读器后，可把对应书籍 ID 写入 `E2E_READER_CORPUS_IDS`。

## 1. 真实内容烟测

该脚本不修改阅读进度，检查书籍详情、内容接口、文件签名、MIME、进度读取，以及存在时的 PDF 提取文本。

```powershell
$env:BASE_URL = "http://127.0.0.1:8085"
$env:READER_REGRESSION_USERNAME = "reader-regression"
$env:READER_REGRESSION_PASSWORD = "专用测试账号密码"
$env:E2E_READER_CORPUS_IDS = "12,18,23" # 可选
node scripts/reader-regression-smoke.mjs
```

PDF 必须返回 `%PDF-` 与 `application/pdf`；EPUB 及已转换的 Kindle 书必须返回 ZIP 头与 `application/epub+zip`。失败时可先定位为导入/文件服务/转换问题，而非页面渲染问题。

## 2. 桌面与移动浏览器回归

此测试在桌面 Chromium 和 Pixel 7 视口运行，对选中的真实书籍验证：

- PDF 首页、中间页、末页可渲染，连续滚动与分页切换正常。
- PDF Ctrl/Command + 滚轮改变书页缩放，而非浏览器页面缩放。
- EPUB iframe 内容完成加载；分页、连续滚动、双页（桌面）、字号、主题和翻页可操作。
- 阅读位置可被服务端保存，阅读器中不出现加载/渲染错误。

```powershell
docker compose up -d
cd web
pnpm exec playwright install chromium
$env:E2E_BASE_URL = "http://127.0.0.1:8085"
$env:E2E_READER_USERNAME = "reader-regression"
$env:E2E_READER_PASSWORD = "专用测试账号密码"
$env:E2E_READER_CORPUS_IDS = "12,18,23" # 可选
pnpm test:reader-regression
```

失败会保留截图、视频、trace 和实际选中的 `reader-corpus.json`；这些产物位于 `web/test-results`，已被 Git 忽略。

## 判定与维护

- 任何“PDF 页面渲染失败”“正在加载 EPUB…”长期不消失、末页空白、浏览器缩放改变、进度未保存，均视为回归失败。
- 新增阅读器功能、升级 PDF.js/epub.js、调整 OCR/MOBI 转换、修改权限或内容响应头后，都应运行两条命令。
- 若样本含版权内容，只保留其 ID、格式和故障现象；不要将电子书文件、正文或截图上传到公开仓库。
