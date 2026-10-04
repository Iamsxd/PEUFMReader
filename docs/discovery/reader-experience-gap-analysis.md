# 阅读器体验对照与改进候选

日期：2026-10-04。基线：`master` 的 `f4f90a9`，主题实现分支为 `codex/bamboo-ocean-themes`。

本文是对公开一手资料与当前代码的对照，不代表以下功能已开发、已承诺上线或已在真机验收。只借鉴交互契约，不复制第三方源码、书籍、品牌或截图，不更换现有 PDF.js／epub.js 引擎。

后续实现补记：用户继续开发后，新建 `codex/reader-experience-refinements` 接续 `90e7063`，已实现下文前三项的首版（当前浏览器排版默认、目录当前章／显式跳转历史、PDF 页内比例与批注矩形定位）。本书覆盖、目录折叠、脚注历史等未纳入；以下“现状”为调研基线快照，当前实现、验证和限制以 [阅读器增强记录](../validation/reader-experience-refinements.md) 为准。

## 我们已具备的能力

- EPUB：字号、独立日间／护眼／夜间主题、分页／滚动、单页／双页、目录、书内搜索、CFI／章节位置恢复、书签、高亮、笔记。
- PDF：分页／滚动、单页／双页、适宽／适页／手动缩放、目录、文本层、高亮、按可见区域懒渲染与离屏画布释放。
- 共同能力：个人进度与有效时长、批注筛选与导出、离线正文及进度同步、设备音色与倍速、自动续读下一章／页、屏幕常亮。

章节连续朗读已经存在：`EPUBReader.tsx` 的 `loadNextSpeechSource`、`PDFReader.tsx` 的同名逻辑和 `hooks/useSpeechSynthesis.ts` 共同实现，`layout-and-interactions.spec.ts` 有对应回归。本轮同步纠正旧路线图把它列为待办的记录。

## 一手参考：哪些做法值得借鉴

| 来源 | 已确认的体验 | 对 PEUFMReader 的借鉴 |
| --- | --- | --- |
| [Readest 阅读](https://readest.com/docs/reading) | 目录反馈当前章／位置，章节与整本进度，带章节和上下文的搜索，脚注弹窗 | 定位信息跟随阅读状态；临时查找不丢主阅读点 |
| [Readest 定制](https://readest.com/docs/customization) | 全局默认与本书覆盖；字体／布局／颜色分别覆盖，行高、段距、最大行宽与 CJK 字体 | 常用／高级设置分层，允许尊重原书样式和恢复默认 |
| [Foliate-js README](https://github.com/johnfactotum/foliate-js/blob/main/README.md) 与 [导航实现](https://github.com/johnfactotum/foliate-js/blob/main/view.js) | 分页／滚动，列宽；Range／CFI 锚点；逐步搜索；独立跳转历史 | 调版式保留段落位置；目录／搜索／批注跳转统一回退；搜索可取消 |
| [Kavita EPUB](https://wiki.kavitareader.com/guides/readers/epub/) 与 [阅读配置](https://wiki.kavitareader.com/guides/user-settings/reading-profiles/) | 当前章突出，内部链接回退，窄屏自动单栏，配置优先级 | 手机布局不能硬挤双栏；先做两级设置，不立即堆设备／系列／书库多层配置 |
| [Kavita PDF](https://wiki.kavitareader.com/guides/readers/pdf/) | 明确区分拖动工具与文字选择工具 | 减少拖页、触摸翻页与选区冲突；PDF 不强套 EPUB 排版设置 |
| [KOReader 快速浏览](https://koreader.rocks/user_guide/#L2-skimwidget)、[选区](https://koreader.rocks/user_guide/#L2-howtohighlight) 与 [文本外观](https://koreader.rocks/user_guide/#L1-customizingappearance) | 按页／章／百分比浏览并回到起点；两点选区；固定与重排版式分开 | 导航先预览再跳转，明确“回到刚才”；选区时抑制误翻页；PDF 优先缩放／适宽 |

Foliate-js 的 PDF 支持在 README 中仍标为 experimental，且有 CSS 多栏性能和原书样式限制。不能把“换引擎”当作这些体验问题的通用解法。Kavita 也明确跨设备 EPUB 页数可能变化；位置应使用稳定锚点，不只保存当前屏幕页码。

## 建议下一轮优先做的三项

### EPUB 排版设置（中等前端改动）

现状：`web/src/epub.ts` 偏好只有 flow、layout、fontSize、theme；`EPUBReader.tsx` 的初始样式固定 `Literata, Georgia, serif`、行高 1.7、左右 padding 4%、段落最大宽度 72ch。

建议：字体、行距、段距、留白／最大行宽；提供尊重原书样式、重置和明确作用范围。先用系统中文宋体／黑体回退，不默认下载大字体；全局默认＋本书覆盖需使用独立偏好存储，不能破坏已有浏览器偏好。

验收：调设置不重新打开文件、不丢当前 CFI；旧偏好能解析，长标题和复杂原书 CSS 不越界；手机旋转、单／双页切换后保持可见段落；不影响界面主题、PDF 或他人设置。

### 导航定位与跳转返回（小到中等）

现状：EPUB 目录被展开成扁平列表，没有当前章 `aria-current`；底部进度是文字。已有百分比到 CFI 的内部恢复能力，但没有用户进度跳转或跳转历史。`displayLocation`／PDF `goToPage` 都没有独立回退栈。

建议：当前章高亮／自动定位、目录层级折叠；百分比预览与确认跳转；搜索、目录、脚注及批注跳转后“返回刚才位置”。普通连续翻页不塞入跳转栈，跳回与退出阅读器清楚区分。

验收：A → 目录 B → 搜索 C 可依次返回 B、A；回退后再跳 D 不保留失效的 forward 分支；更新位置仍走原进度保存机制；键盘、手机、离线打开同样可用。

### PDF 页内阅读位置与批注定位（中等）

现状：恢复只读取 pageIndex；保存位置固定 `yRatio: 0`；连续滚动跳页总到页顶。`readingMarks.ts` 的 `getReadingMarkNavigationTarget` 只返回页码，没有使用高亮 rects。

建议：保存当前页内可见锚点的归一化 yRatio；跳高亮优先定位首个 rect；缩放或方向变化后恢复相同锚点。兼容已有仅页码的进度，双页／分页布局有独立降级行为。

验收：长页在中段关闭再打开、手机横竖屏与缩放、搜索／高亮跳转、旧记录及双页首尾页均稳定；不能因为容器高度变化反复写进度。

## 后续单独迭代

| 方向 | 实际缺口 | 范围与风险 |
| --- | --- | --- |
| 大 PDF 在线 Range 加载 | `PDFReader.tsx` 等全量 `fetchPDFBytes` 完成再 `getDocument({data})`；拼接时有额外全量副本 | 后端 `http.ServeContent` 已支持 Range。在线可评估 PDF.js 鉴权 URL，离线保持二进制输入；需验证 Cookie／权限／失败恢复、扫描 PDF 与内存峰值，不是主题附带小改 |
| 选区与单手工具 | 选中即打开较大的固定编辑层；已有高亮不能直接定位到该条编辑；PDF 只响应 pointerup 且要求同页选区 | 先做好同页移动选区、取消、复制／高亮／笔记／选区朗读与防误翻页；键盘选区与跨页两点选择需额外回归 |
| 渐进书内搜索 | EPUB 顺序遍历章节后才显示；PDF 每页只保留第一段匹配，跳页顶；没有取消、临时正文命中标记 | 分批结果、章节／页码分组、上下文、上／下一命中；临时标记不写入私有批注。文本缓存必须有容量上限及失效规则 |
| 更精细的朗读 | 已有自动续读，但 EPUB 章中启动仍从章首开始；无段落映射／跟随高亮／睡眠计时 | 先定时关闭及选区朗读，再建立文本块 → CFI／坐标映射。`onboundary` 不可靠时按块降级；不承诺锁屏后台稳定播放 |
| 离线批注 | 离线会清空高亮、关闭批注面板；现有离线同步只含进度／时长 | 可先缓存只读批注；可写模式需要账号隔离 outbox、UUID、幂等、重试／冲突和退出清理／权限撤销处理，必须单独立项 |

[Readest 分屏](https://readest.com/docs/parallel-read) 的每栏独立设置／进度与 [朗读文档](https://readest.com/docs/listen) 的段落启动／同步高亮／计时可作为中长期参考。分屏增加旧设备负担；云端朗读会把文本发送第三方，本项目私有书库不默认引入任何云端正文发送。

## 调研阶段边界

本轮只落地青竹书院／墨蓝星图界面主题并完成阅读器研究。未新增阅读器功能、数据库迁移、第三方正文发送、引擎依赖或本机 8080 部署。以上优先级是建议，实施前仍需确认下一轮的具体范围。
