# 高级建模：旧四影片兼容回归

验收日期：2026-09-08。高级建模实现已通过旧武打、赛车、太空战、旅游工程的兼容回归。测试绑定独立快照 `39faa587cabbbc1250bf180ea176e7bb19cb6366e44087726e9156b1f47bb0eb`，不改变 [candidate 10 原交付](delivery-runtime.md) 的验收归属。

原 `4219/4319` 服务、`.data/delivery-candidate-10` 数据和已验收影片均未被控制或修改。恢复、编辑、导出和重启使用独立 `4187/4287`、`4188/4288` 服务；这些临时服务已停止。源码快照和数据保留在 `.data/advanced-modeling/compatibility-runtime-03`、`compatibility-data`、`compatibility-final-data`。

## 工程与视频

[最终恢复及重启报告](../.data/advanced-modeling/compatibility-final/suite-report.json) 使用四个原 `.whiteframe` 包，通过 335 个 MCP 分块恢复工程。257 个原始历史快照、每部影片引用的素材和原 MP4 哈希全部匹配。摄影机修改产生不同像素，撤销后恢复完全相同的 PNG；重启后工程内容、撤销/重做、素材、原影片和新导出视频继续匹配。导入提交的幂等重放没有重复创建工程或改变当前选择。

最终快照正式重新导出四个代表镜头，共 **42 秒、1008 帧**，全部为 1280×720、24 fps。未重新生成四部完整影片，也未将旧影片计为高级建模的新作品。

| 影片   | 代表镜头                   | 时长 / 帧数 | 与原完整影片 SSIM | 验证结果                                            |
| ------ | -------------------------- | ----------- | ----------------- | --------------------------------------------------- |
| 旅游   | `travel-shot-3`，穿门步行  | 10 秒 / 240 | 0.998848          | 新 MP4 与已验证的 candidate 07 同镜头基线逐字节一致 |
| 武打   | `martial-shot-8`，持械攻防 | 8 秒 / 192  | 0.998245          | 新 MP4 与已验证的 candidate 07 同镜头基线逐字节一致 |
| 赛车   | `race-shot-4`，并行攻防    | 12 秒 / 288 | 0.999051          | 超过原完整影片 SSIM 0.999 门槛                      |
| 太空战 | `space-shot-6`，命中与碎片 | 12 秒 / 288 | 0.999245          | 超过原完整影片 SSIM 0.999 门槛                      |

旅游、武打的独立镜头编码与完整影片中的编码上下文不同；沿用已有、来源可验证的同镜头基线，逐帧解码和 MP4 字节都一致，没有降低原验收阈值。每片详细证据和新 `reexport.mp4` 位于 [最终回归目录](../.data/advanced-modeling/compatibility-final)。

## 浏览器与预览

[最终浏览器报告](../.data/advanced-modeling/compatibility/ui-03/film-ui-report.json) 在同一源码快照上完成 8/8 项桌面和手机检查：

- 四部影片的官方时间零 PNG 与原验收文件逐字节一致，RGBA 变化像素均为 0。
- 24 次真实时间轴定位、摄影机/自由视角/俯视切换与聚焦通过，保存的工程保持不变。
- 8 次浏览器 MP4 下载哈希与原影片一致；4 个完整 HTTP stream 和 Range 206 请求通过。
- 实际 1 倍速短时播放合计 23.728 秒，无浏览器或播放器错误。并行渲染负载下累计 5 个显示掉帧；这是功能回归，不是独立性能基准或完整影片重审。
- [8 张逐张人工检查的截图](../.data/advanced-modeling/compatibility/manual-visual-review-03.json) 显示非空场景、正常缩略图和播放器、没有页面溢出或文字遮挡。

[原文件保护报告](../.data/advanced-modeling/compatibility/legacy-ui-completion-03.json) 再次核对 28 个原工程、视频、工程包和预览证据文件，哈希未变。[派生测试数据来源](../.data/advanced-modeling/compatibility/ui-fixture-provenance-03.json) 只映射恢复后的工程/任务 ID、修订号和时间戳；工程内容和所有媒体基线保留原值。

## 回归中修复的问题

第一次浏览器运行在旅游远景发现海岸边缘 7/921600 个像素不同，其他三片完全一致。[原失败及定位记录](../.data/advanced-modeling/compatibility/order-regression.json) 保留完整来源。19 个旅游建模对象的新旧顶点、法线、索引逐元素一致，排除了几何变化。

原因是异步几何完成后才调用 `buildObject`，使地形材质晚于海面材质创建，改变了 Three.js 按材质 ID 排序时共享边缘的深度覆盖顺序。修复在 [ObjectFactory.ts](../src/engine/ObjectFactory.ts) 中按工程顺序分配对象与材质，再等待几何；[SceneResources.ts](../src/engine/SceneResources.ts) 同时固定对象映射顺序，并保留取消和失败释放行为。修复后四片官方预览均恢复原始字节。没有修改三角化实现或放宽像素门槛。

[资源测试](../tests/scene-resources.test.ts) 4/4 通过，覆盖延迟几何的材质顺序、场景对象顺序、取消与失败清理。[模型任务访问测试](../tests/modeling-job-access.test.ts) 4/4 通过，还验证转换后仅靠 `sourceAssetUrl` 引用的原 GLB 能进入不含历史的工程包，在干净数据库恢复和重启后字节不变。

## 复现与范围

独立快照通过构建、严格类型检查及 443 个源文件不超过 1000 行的结构检查。[运行时校验](../.data/advanced-modeling/compatibility-final/source-verification-2.json) 核对 456 个完整快照文件和 15 个实际提供服务的构建文件。`freeze-runtime.mjs` 已将新增 `public/` 纳入复制与哈希，避免遗漏运行时资源。

```sh
npx tsx scripts/production/verify-mcp-package-suite.ts --runtime .data/advanced-modeling/compatibility-runtime-03 --data <新数据目录> --output <新证据目录> --source .data/full-delivery/final-candidate-05/productions --port 4188 --review-port 4288 --render-baselines .data/full-delivery/final-candidate-09/mcp-package-checks/baseline-diagnostic/render-baselines.json
npx tsx scripts/modeling-assets/verify-legacy-ui.ts --evidence <已完成的恢复证据目录> --runtime .data/advanced-modeling/compatibility-runtime-03 --attempt <新的编号>
```

旧影片覆盖已有 mesh、curve、terrain、基本体、角色、车辆及特效。新高级曲面和修改器作品的完整验收另见高级建模矩阵。本报告不代替新功能测试或旧影片原始的完整观看验收。
