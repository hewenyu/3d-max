# 高级建模验收证据

本文件记录高级建模的实际验收。完整目标见 `advanced-modeling-goal.md`，行为矩阵见 `advanced-modeling-matrix.md`，本机入口及四作品文件见 [交付入口](advanced-modeling-delivery.md)。既有四部两分钟影片的历史验收保持有效；新增建模作品单独交付。

## 已执行检查

2026-09-08 集成工作区 `npm test` 完成 **501/501**，耗时 19.467 秒。包含全部正式编辑工具逐个独立 MCP 调用及精确撤销、HTTP/SQLite 等价、拓扑内核、曲面和修改器、模型转换/GLB、后台任务取消/重启/冲突/失败回滚，以及原影片相关导演、动作、镜头、剪辑和资产测试。后续仅补充测试与文档，组件 Worker 失败重试 2/2、吸附终点等组件领域检查 10/10 另有通过记录。

`output-runtime-02` 的构建、TypeScript 和结构检查通过：455 个源码文件，每个不超过 1000 行。生产输出包含实际 GeometryWorker、ComponentSourceWorker、ComponentPreviewWorker 和 OpenSubdiv WASM。源哈希为 `d53e60212f1435b3acccb651f9f1aa53f7a3ee3ec96f5fb78aa2b7e3ad208cf0`；278 个产品代码/配置/资源文件与最终工作区逐一哈希相同，见 `.data/advanced-modeling/delivery/production-source-comparison.json`。构建保留大 chunk 与 Node 专用 fs 分支外部化提示，浏览器路径不读取 Node 文件系统。

生产浏览器整套检查首轮 9 项通过、5 项失败，修正测试后仅重跑失败项 5/5 通过。首轮文件、错误及 trace 保留在 `.data/advanced-modeling/final-ui`；修正结果在 `final-ui-corrected`。失败原因是哈希 WASM 文件名和 Worker 网络观测、异步受控 checkbox 的等待、轮询内过早抛断言，以及源重新安装后已清空旧诊断的界面状态。持久化、几何、真实像素和下载断言均保留，未修改冻结产品代码。

| 范围 | 可定位证据 | 实际行为 |
| --- | --- | --- |
| 拓扑身份、邻接、选择及十五类编辑 | `tests/topology*.test.ts`、`tests/fixtures/topology-command-cases.ts` | 稳定身份与变化映射，退化/非流形负例，复杂边界与孔洞，原子失败，SQLite 历史和独立 MCP 命令 |
| 实际组件视口与拖拽 | `.data/advanced-modeling/final-ui/`、`tests/component-workspace.spec.ts`、[性能报告](advanced-modeling-performance.md) | 真实点/边/面拾取、框选/套索/穿透、Shift 增选/Control 减选、MCP 挤出、GPU 拖拽预览、Escape/pointercancel/capture-release 取消、精确撤销；冷源准备取消及 Worker 失败后重试；桌面/手机非空图像 |
| 拓扑数值界面 | `final-ui` 与 `final-ui-corrected`、`tests/topology-ui.spec.ts` | 十五类操作各自通过真实 UI 执行并撤销；诊断选择边界、填洞后实际边界为零并与独立 MCP 检查一致 |
| 新修改器与源编辑 | `.data/advanced-modeling/modifier-ui/`、`tests/advanced-modifiers.test.ts` | 实体化、弯曲、扭转、曲线阵列、Catmull-Clark、焊接镜像及栈复制/排序/启停/烘焙；原失败与修正轮均保留 |
| 活布尔与倒角 | `.data/advanced-modeling/boolean-bevel-ui/verification.json`、`tests/modifier-dependencies.test.ts` | 三类布尔体积，隐藏/锁定/父变换操作数、依赖变化后的视口重算和实际 GLB；倒角实际多段闭合几何 |
| 曲面与切线 | `tests/surfaces.test.ts`、`tests/surfaces.spec.ts`、`shared/surfaces/README.md` | Bezier 源、带孔截面、扫掠/旋转/放样、开闭路径、厚度/封口、转换、超限与自交诊断；25 个内核用例 |
| 模型文件和源保留 | `tests/modeling-assets.test.ts`、`tests/model-assets-ui.spec.ts`、`tests/modeling-job-access.test.ts` | 真 GLB 读取/下载、节点与父变换、显式静态转换、属性/rig/动画边界、sourceAssetUrl 包与重启保存 |
| 真实计算隔离 | `tests/modeling-jobs.test.ts`、`tests/model-asset-jobs.test.ts` | 不可变快照、命令/检查/转换/导出 CPU Worker、真实阶段和对象数量、运行中取消、SQL 触发器失败回滚、重启与幂等 |
| 公开服务等价 | `tests/modeling-services.test.ts`、`tests/fixtures/modeling-service-cases.ts` | 11 个独立 MCP 服务均实际调用，HTTP 返回与几何/GLB 哈希比较，冲突/锁/状态码与结构化错误一致 |
| 模型依赖及旧格式 | `tests/modeling-dependencies-integration.test.ts` | 模板依赖闭包/重映射、锁定依赖、项目包、GLB、历史回退和求值一致性 |

## 真实作品暴露的问题

1. 40000 顶点的整体变换曾触发 512 MiB Worker 堆上限。`meshEditResult` 为产生组件 ID 映射建立了两份无用途的完整邻接图；改为线性 ID 集合后，在同一限制下成功。`tests/topology-memory.test.ts` 通过实际 Worker 验证所有坐标、稳定身份及精确撤销/重做。失败与修正报告位于 `.data/advanced-modeling/performance/node-server/`。
2. 飞行器翼面的实体化暴露斜平面正规方程的数值问题。对几乎秩一的矩阵直接 `Matrix3.invert()` 得到了反向偏移；`shared/normal-offset.ts` 改用 Cholesky 求解，保留原正则化和厚度定义，并供曲面厚度共用。具体斜面及近平行法线、直角 miter 的回归通过。
3. 曲面把手相邻三角形的法线差约 1e-7 弧度、平面距离约 3e-9 米时，落入了不稳定的非共面库分支。仍在既定 1e-7 米容差内，改用共面投影分离轴判断；真实重叠三角形仍拒绝。`tests/normal-offset.test.ts` 的具体顶点回归 3/3 通过。
4. 浏览器模块 Worker 在顶层 WASM 异步加载前会丢失首次消息，已通过 ready 握手修复。原布尔视口失败、隔离收发诊断和最终成功结果均保留。
5. 建筑三拱前墙暴露原布尔转换的量化邻桶近重合顶点。维持原 1e-6 米容差，按真实邻格距离焊接，保留全部面；真实墙体恢复闭合，超容差链和塌面/翻面仍原子拒绝。`boolean-output-weld.test.ts` 与真实 MCP GLB 测试覆盖依赖修改及撤销后同哈希导出。
6. 组件源 Worker 的失败 promise 曾留在当前版本缓存，导致同源无法重试；仅清理仍属于该任务的缓存，并验证旧失败不能清理新请求。生产浏览器实际阻断模块下载后重试成功。

## 四作品与恢复

四件作品的最终文件来自同一冻结代码和前端，均提供可编辑项目包、GLB、四张图及 24 秒/720p/24fps/576 帧正式展示视频。各片进行了完整 1x 应用内播放、变化像素、全文件解码、黑帧/冻帧检查、下载哈希及桌面/手机人工看图。具体清单和从空项目起步的命令历史见 [作品记录](advanced-modeling-works.md)。

`.data/advanced-modeling/restoration-final/suite-report.json` 记录四包在全新 SQLite 的导入、真实服务重启（PID 6289→7029）、项目内容和全部历史哈希、原媒体、GLB/PNG 精确比较，以及每件修改/撤销/重做/撤销、再次完整视频导出和播放。四个再次生成的视频 SHA-256 均与对应原片一致，见 `video-hashes.json`。

原制作数据库也实际重启并核对项目、历史、游标和 SQLite 完整性：`vehicle-architecture-restart/`、`mechanical-prop-restart/` 的 before/after 报告。四件模型完全从几何源创建，无导入成品资产；源资产转换与项目包保留另由模型流转测试验证。

旧四片兼容回归见 [兼容报告](advanced-modeling-compatibility.md)：四包全部历史、实际重启、四张官方 PNG 完全一致，42 秒/1008 帧代表镜头重导出，桌面/手机 8 项播放检查，28 个历史文件哈希不变。旧服务 4219 保留。

## 性能与边界

完整独立三档报告为 `.data/advanced-modeling/performance/node-server/2026-09-08T06-07-11-195Z-219e707f`。40000 顶点实际点选约 241ms、关联选择 302ms、首次组件准备 1027ms；首次准备与结果发布仍有长任务，报告列出最大值。90,000 顶点、45,000 连通四边面的近上限实测记录在 `performance-near-limit/`：可创建、检查、拾取、保存和生成 PNG，变换达到既定 512 MiB Worker 堆限制，失败原子保留源和版本。该结果标记 `completed-with-limit`，不宣称 90,000 顶点变换成功，也不以 100,000 顶点 schema 上限承诺每个操作的可用复杂度。

四件作品操作/检查/GLB 的耗时从正式日志提取，见 `.data/advanced-modeling/performance/works-performance.json`。全部实际边界、机器条件、失败原件及许可证见 [性能报告](advanced-modeling-performance.md) 和 [工程约定](advanced-modeling-engineering.md)。代码提交与推送是最后的交付门禁，目标状态只在所有适用验收关闭后更新。
