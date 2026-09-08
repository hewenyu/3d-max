# 高级建模交付入口

本机编辑器：<http://127.0.0.1:4224>。项目菜单中可切换四个新工程；右上角导出记录可在线播放和下载已生成的 MP4。全部新增 Web 能力均有正式 MCP 入口，配置与调用示例见 [高级建模 MCP](advanced-modeling-mcp.md)。

目标：[advanced-modeling-goal.md](advanced-modeling-goal.md)。功能状态：[验收矩阵](advanced-modeling-matrix.md)。作品结构与制作过程：[四个建模作品](advanced-modeling-works.md)。工程限制与许可：[工程约定](advanced-modeling-engineering.md)。

## 运行版本

- 固定代码和前端：`.data/advanced-modeling/output-runtime-02`。
- 运行清单：该目录的 `runtime-manifest.json`，源哈希 `d53e60212f1435b3acccb651f9f1aa53f7a3ee3ec96f5fb78aa2b7e3ad208cf0`。
- 集中 SQLite 与文件库：`.data/advanced-modeling/delivery`。
- MCP：`http://127.0.0.1:4224/mcp`，令牌从编辑器 MCP 配置窗口读取，不写入文档或版本库。
- 真实停服重启记录：数据目录的 `lifecycle-before.json` / `lifecycle-after.json`，PID 从 6289 变为 7029。

默认运行命令（停掉该端口上自己的实例后使用）：

```sh
PORT=4224 APP_URL=http://127.0.0.1:4224 \
WHITEFRAME_DATA_DIR="$PWD/.data/advanced-modeling/delivery" \
WHITEFRAME_DIST_DIR="$PWD/.data/advanced-modeling/output-runtime-02/dist" \
WHITEFRAME_REVIEW_PORT=4324 WHITEFRAME_REVIEW_URL=http://127.0.0.1:4324 \
node --import tsx .data/advanced-modeling/output-runtime-02/server/index.ts
```

Node.js 24、FFmpeg/ffprobe、Playwright Chromium 为本机依赖。固定版本用于复验，日常开发使用仓库根目录的 `npm run dev`。请保留整个数据目录或使用包含媒体与历史的项目包迁移，单独复制 SQLite 文件不能带走模型和视频。

## 作品文件

四件作品都使用公开 MCP 从空项目制作，文件来自正式预览、GLB 和视频导出服务。展示片各 24 秒、1280x720、24 fps、576 帧；上一目标的四部至少两分钟影片单独保留，未重复计入本目标。

| 作品 | 集中工程 ID | 最终文件目录 |
| --- | --- | --- |
| GT-01 车体 | `25ce7569-0b85-4466-8166-6ddad8567d58` | [vehicle](../.data/advanced-modeling/works/vehicle/2026-09-08T06-15-41-938Z-ce0dfa73/) |
| 双发机械飞行器 | `6b3a4b38-d45d-46ab-b7c1-fc725898fb28` | [mechanical](../.data/advanced-modeling/works/mechanical/2026-09-08T06-14-32-194Z-f4300b14/) |
| 三拱观测馆 | `155f32a2-9ccd-4b0f-8ee0-3951842adbd1` | [architecture](../.data/advanced-modeling/works/architecture/2026-09-08T06-17-51-621Z-f861bb97/) |
| 曲面工艺壶 | `d96d0695-cc4e-4fea-89bb-8c8af01a7231` | [curved-prop](../.data/advanced-modeling/works/curved-prop/2026-09-08T06-14-32-191Z-11745ae2/) |

每个目录有同名 `.whiteframe`、`.glb`、`.mp4`，四张实际 PNG、ffprobe、完整播放和下载报告、每秒联系表、桌面/手机截图及人工视觉审查。`mcp-operations.jsonl` 和作品文档连接到从空项目开始的操作记录及保留的失败输入。

## 验证来源

集中恢复证据位于 `.data/advanced-modeling/restoration-final`：`suite-report.json` 为四件全部通过的总报告，`imports.json` 保存四包导入结果，`restarts.json` 保存服务实际重启后的验证；各运行目录包含项目、历史、资产哈希、GLB 和 PNG 精确对照，以及真实修改/undo/redo 和再导出视频。`video-hashes.json` 证明四个完整 MP4 再导出也字节一致。

全量 Node 回归 501/501；生产 Web 首轮 9 项通过、5 项测试观测/异步等待失败，保留原结果，修正测试后仅重跑失败项 5/5 通过。两轮均使用上述固定产品版本，证据在 `.data/advanced-modeling/final-ui` 和 `final-ui-corrected`。后续补充的行为检查与最终状态见 [验收证据](advanced-modeling-evidence.md)。

已验证的交互性能和明确限制见 [性能报告](advanced-modeling-performance.md)，包括 512、10000、40000 顶点真实网格和 90000 顶点/45000 四边形的近上限检查。90k 网格变换达到当前 512 MiB Worker 堆限制，创建、检查、选择、保存和 PNG 可用，失败不改变源与版本。大型 JSON/历史处理仍有主线程长任务，不能把帧时间 p95 当作持续 60 fps 承诺。

旧四片实例 <http://127.0.0.1:4219> 及原文件未改动。[兼容报告](advanced-modeling-compatibility.md) 包含四个旧工程和历史恢复、实际重启、四代表镜头 42 秒/1008 帧重导出、桌面/手机 8 项播放验证和原文件哈希对照。

二进制作品和运行数据保存在本机 `.data`，不进入 Git；源代码、制作与复验脚本、文档及许可证已提交为 `a9464d1` 并推送至 `origin/master`。本次文档收尾提交记录全部验收关闭。四作品独立视觉报告为 `restoration-final/manual-visual-review.json`，真实孔洞射线检查为 `independent-glb-hole-review.json`；机械最终目录另有正式 MCP 捕获的 `hydraulic-detail.png` 补足套筒近景。
