# 高级建模实际作品

本文件记录新增建模作品的结构、正式制作入口和证据来源。作品由通用 MCP 命令创建，图片、GLB、MP4 和项目包均经产品服务生成。作品脚本只提供具体设计参数和验证编排，不调用内部命令执行器、演示专用造型分支或独立渲染器。

车辆与建筑已在 `output-runtime-02` 完成最终统一版本导出和视觉检查；下列早期文件保留为制作记录，最终文件在各作品的“最终产物”中单列。四作品的集中项目包恢复与服务重启验证由统一验收步骤补充。

## 车辆车体

- 项目：`project-f0a4516b-a67b-45b9-9ed7-f44de8fd39eb`，`GT-01 / 可编辑白模车体`。
- 正式生产脚本：[vehicle.ts](../scripts/modeling-assets/vehicle.ts)；传输与产物验证：[client.ts](../scripts/modeling-assets/client.ts)。
- 生产服务：`http://127.0.0.1:4220`，SQLite 数据目录 `.data/advanced-vehicle`。该项目使用普通建模对象，未使用车辆演示 rig。
- 已完成源版本：r21。生产数据库重启、统一运行版本的最终产物和视觉检查已通过；集中项目包恢复仍待统一验收。

### 造型清单

| 结构 | 保留的可编辑源及真实操作 | 检查对象 |
| --- | --- | --- |
| 车身轮廓与厚度 | 八截面放样，闭合截面、封口和 0.025m 壳厚；车头与车尾各截面宽高独立保存 | `car-body` |
| 轮拱与进气口 | 两个横穿车身的圆柱操作数形成真实轮拱；进气操作数同时切开前部进气壳与车身，保留 3 个车身活布尔引用 | `wheel-cut-front`、`wheel-cut-rear`、`intake-cutter` |
| 车顶控制网格 | 半侧控制笼、实际环切、支撑边滑移和局部面内插；镜像接缝以 `1e-5m` 焊接，Catmull-Clark 两级细分后实体化 0.035m | `roof-panel` |
| 开放车窗 | 跟随车顶的多边形凸棱柱框及匹配贯穿操作数；独立 B 柱，保留车窗倒角与布尔顺序 | `window-frame-1`、`window-frame--1` 及其 cutter |
| 轮胎与轮圈 | 四组旋转成型轮胎/轮圈；独立轮轴与七根辐条，轮胎与轮圈截面继续可编辑 | `wheel-*` |
| 外部与内部细节 | 门缝管状曲线、后视镜及支臂、灯组、底盘、后扩散器、座椅占位；倒角宽度和段数保留 | `door-seam-*`、`mirror-*`、`lamp-*`、`chassis`、`seat-*` |
| 前格栅 | 十一片线性阵列及独立贯穿进气壳；已修正被车身端面遮挡的位置 | `grille-fin`、`front-intake` |
| 风挡 | 使用实际 `mesh.set` 建立贴合车顶的薄棱柱；保留 0.003m 两段倒角 | `screen-front`、`screen-rear` |

### 镜头覆盖

四个独立相机、四个各 6 秒镜头和一个 24 秒剪辑序列均可继续修改。每个镜头有起止相机关键帧和持续运镜，没有重复片段或静帧延时。

| 视频时间 | 镜头 | 实际检查内容 |
| --- | --- | --- |
| 0-6 秒 | `shot-overall` | 整车轮廓、侧窗、门缝、轮拱和轮毂 |
| 6-12 秒 | `shot-nose` | 前灯倒角、真实进气孔、格栅阵列、轮拱侧壁 |
| 12-18 秒 | `shot-roof` | 细分车顶、车窗开口和车顶厚度 |
| 18-24 秒 | `shot-rear` | 后灯、扩散器、轮胎宽度和车尾轮廓 |

### 制作记录

所有下列目录位于 `.data/advanced-modeling/works/vehicle/`；`mcp-operations.jsonl` 记录工具、参数、结果字节数/哈希和错误标记，异步建模任务另存 `job-*.json`。后续修正持续打开同一个项目，没有重新导入成品替换失败过程。

| 运行目录 | 结果与作用 |
| --- | --- |
| `2026-09-08T05-03-38-013Z-56b22334` | `project_new(template=empty)` 起点、车身与轮拱创建；脚本误把工具写成 `topology_loop_cut`，真实名称为 `topology_loop-cut`，调用拒绝并保留失败 |
| `2026-09-08T05-05-46-914Z-84ed41f6` | 完成车顶拓扑、车窗、车轮与细节；镜头脚本误用 `subjectId`，领域校验要求 `subjectIds`，镜头批次原子失败 |
| `2026-09-08T05-07-00-366Z-41429fe3` | 真实车顶顶点修改与撤销执行；生产客户端没有同步 `history_undo` 返回的直接 Project，产生本地断言误报，修复客户端后继续验证 |
| `2026-09-08T05-08-08-125Z-b14e6929` | 首套完整 GLB、图片、24 秒 MP4 和项目包；`revision-evidence.json` 证明稳定顶点上移 0.03m 后源发生变化，undo/redo 精确重现源与修改器 |
| `2026-09-08T05-11-19-227Z-1afb6f37` | r19，矩形侧窗改为贴合车顶的多边形窗框和实际布尔 cutter，补座椅；保留前后产物 |
| `2026-09-08T05-20-23-815Z-14a2abd1` | r19 使用当时已构建版本重新导出；首次跑通完整应用内 1x 播放、全文件 decode、变化像素和浏览器下载哈希验证 |
| `2026-09-08T05-25-51-975Z-71562c17` | r20，修正灯组、进气壳和格栅遮挡，车身增加进气贯穿布尔；图像复查发现风挡旋转摆位仍需修正 |
| `2026-09-08T05-32-03-875Z-026708fb` | 拟合风挡薄棱柱时，原 0.008m 倒角过宽，产品返回 `BEVEL_OVERLAP`，整个建模任务原子失败 |
| `2026-09-08T05-32-24-144Z-ab1fca73` | r21，将风挡改为实际薄棱柱并降低其倒角到 0.003m；四张多角度图、每秒接触表、桌面/手机播放器已人工检查，记录在 `visual-review.json` |

r21 的旧运行版本产物为 14,384 个三角形、648,564 字节 GLB，以及 H.264 1280x720、24 fps、576 帧、24.000 秒 MP4。完整播放、每秒变化像素、全文件 decode、下载哈希分别保存在 `vehicle-playback-review.json`、`vehicle-ffprobe.json` 和 `vehicle-review/`。这些记录与下列最终同版输出分别保留。

### 最终产物

目录：`.data/advanced-modeling/works/vehicle/2026-09-08T06-15-41-938Z-ce0dfa73/`。正式服务已重启到 `output-runtime-02`，源哈希 `d53e60212f1435b3acccb651f9f1aa53f7a3ee3ec96f5fb78aa2b7e3ad208cf0`；前后端使用同版几何求值，车身活布尔保留源的平滑着色。

| 产物 | 实测结果 |
| --- | --- |
| `vehicle.glb` | 64 个可见对象，13,614 顶点、14,384 三角形、570,516 字节；5 个隐藏操作数保留在源项目 |
| `vehicle.mp4` | H.264、1280x720、24 fps、576 帧、24.000 秒、2,048,565 字节；任务 `73034e8e-9593-46f1-871a-66ec1f34e471` |
| `vehicle.whiteframe` | 11,821,858 字节，保留源、18 个历史快照及 6 个已完成版本的视频；本作品没有外部依赖资产 |
| 四角度图片 | `overall.png`、`nose.png`、`roof.png`、`rear.png`，各自镜头局部第 3 秒 |
| 播放与视觉检查 | `visual-review.json`，全文件 decode、应用内 1x 播放 24.265 秒、25 个变化像素样本、无黑冻帧；1440px 桌面和 390px 手机截图已看，浏览器下载与 MP4 哈希一致 |

完整文件 SHA-256 在 `artifacts.jsonl` 及各 `*-glb.json`、`*-ffprobe.json`、`*-package.json` 中。源生产数据库的实际重启已通过，集中恢复与重新导出的结果由统一验收补充。

## 建筑地标

- 项目：`project-8250b143-f7d7-4176-aa19-7242c0bf8ce0`，`三拱观测馆 / 可编辑建筑地标`。
- 正式生产脚本：[architecture.ts](../scripts/modeling-assets/architecture.ts)，与车辆共用公开 MCP 客户端和 4220 服务。
- 已完成源版本：r15。源保留了拱洞方向修正；布尔输出精度修复无需改变该版本的建模源。

### 造型清单

| 结构 | 保留的可编辑源及真实操作 | 检查对象 |
| --- | --- | --- |
| 大厅墙体与楼板 | 12m 宽、4.4m 高前墙，厚 0.36m；后墙/侧墙厚 0.32m；0.32m 屋面板；平台顶高 1.28m | `front-wall`、`rear-wall`、`side-wall-*`、`roof-deck`、`platform` |
| 三座贯穿拱洞 | 1.04m 半径、2m 直边上接 24 段半圆的闭合截面扫掠；三个独立隐藏操作数贯穿前墙，真实活布尔引用 | `arch-cutter--4`、`arch-cutter-0`、`arch-cutter-4` |
| 八级真实台阶 | 每级踏高 0.16m、踏深 0.32m；最后一级顶高 1.28m，与平台衔接，非贴图或视觉替身 | `stair-1` 至 `stair-8` |
| 台阶与屋面栏杆 | 管状路径扶手和真实 curve-array 立柱；斜台阶两侧各八柱，`orient:false` 保持立柱竖直；屋面四边各有可改路径和数量 | `stair-rail-*`、`stair-posts-*`、`roof-*-rail`、`roof-*-posts` |
| 后窗及窗台 | 一个矩形 cutter 加四实例线性阵列作为后墙布尔操作数；对应窗台独立保留阵列 | `rear-window-cutter`、`window-sill` |
| 观测塔身 | 三截面八边形放样、封口与 0.12m 厚度，截面尺寸和位置继续可编辑 | `tower-shaft` |
| 剖切塔冠 | 普通盒体显式转换为拓扑后，以斜平面实际 `topology_bisect` 并封口；切面后保留 0.06m 三段倒角 | `tower-crown` |
| 重复细节 | 七个通风构件线性阵列、馆内长凳，墙洞后可直接看见内部结构 | `roof-vent`、`interior-bench-*` |

### 镜头与修正记录

四个各 6 秒镜头依次检查整体轮廓、台阶及拱洞、屋面栏杆及剖切塔冠、背面窗洞和墙厚。四张图片为 `overall.png`、`arches.png`、`roof.png` 和 `rear.png`。

所有下列目录位于 `.data/advanced-modeling/works/architecture/`。

| 运行目录 | 结果与作用 |
| --- | --- |
| `2026-09-08T05-34-45-095Z-388c0e38` | 从 `project_new(template=empty)` 起步完成实际建模、图片/GLB/视频/项目包；`tower-before-bisect.json` 和 `tower-after-bisect.json` 保存剖切前后；`revision-evidence.json` 保存屋面前栏杆从 15 柱改为 17 柱后的真实顶点数变化，以及 undo/redo 的源哈希对照 |
| `2026-09-08T05-40-09-306Z-b91c0106` | 图像与 `mesh_inspect` 显示扫掠 Frenet 截面需绕 Z 轴旋转 90 度；通过正式 `object.update` 修正三个操作数，r15 图像显示正确直立贯穿拱洞，并完整播放正式导出视频 |

该 r15 运行同时暴露通用布尔输出精度问题：前墙有三组相距 `2.384185791015625e-7m` 的近重合点和 12 条索引边界，虽然 CSG 的几何子边配对检查认为表面闭合，拓扑检查仍应报告未焊接。失败输入/图像没有删除，也没有通过修改作品绕过问题。

修复位于 [boolean.ts](../shared/modifiers/boolean.ts)：在已有 `1e-6m` 转换容差内做真实邻格距离焊接，保留所有面；超容差传递链、塌面或翻面返回 `MODELING_PRECISION`。真实建筑用例先在旧代码失败，修复后通过闭合、体积和依赖修改检查；正式 MCP 的 GLB 下载、几何检查与撤销后同哈希重导出也通过。证据见 `.data/advanced-modeling/boolean-output-weld/verification.json`，测试为 [boolean-output-weld.test.ts](../tests/boolean-output-weld.test.ts) 和 [boolean-output-mcp.test.ts](../tests/boolean-output-mcp.test.ts)。下列最终建筑产物已在包含修复的冻结环境重新生成。

### 最终产物

目录：`.data/advanced-modeling/works/architecture/2026-09-08T06-17-51-621Z-f861bb97/`，运行版本同上为 `output-runtime-02`，源项目仍为 r15。

| 产物 | 实测结果 |
| --- | --- |
| `architecture.glb` | 34 个可见对象，10,410 顶点、6,142 三角形、355,648 字节；4 个隐藏布尔操作数保留在源项目 |
| `architecture.mp4` | H.264、1280x720、24 fps、576 帧、24.000 秒、2,349,804 字节；任务 `3cbbd87c-73c3-44cd-bb68-b4f666ef1088` |
| `architecture.whiteframe` | 6,981,854 字节，保留源、14 个历史快照及 3 个已完成版本的视频；本作品没有外部依赖资产 |
| 四角度图片 | `overall.png`、`arches.png`、`roof.png`、`rear.png`，各自镜头局部第 3 秒 |
| 前墙真实诊断 | `front-wall-inspection.json`：614 顶点、1,224 三角形，原面数量不变；重复点、边界和非流形边均为 0，闭合且朝向一致 |
| 播放与视觉检查 | `visual-review.json`，全文件 decode、应用内 1x 播放 24.300 秒、25 个变化像素样本、无黑冻帧；四张细节图、接触表和桌面/手机播放器已看，浏览器下载哈希一致 |

### 生产数据库重启基线

`.data/advanced-modeling/vehicle-architecture-restart/before.json` 保存 4220 生产服务重启前的 SQLite 项目文档和完整历史哈希、历史游标及 `integrity_check=ok`。车辆有 18 个历史快照，建筑有 14 个。`after.json` 记录旧进程 96513 已退出、新进程 6146 从 `output-runtime-02` 启动，两个项目的文档、全部历史与游标哈希完全一致，数据库完整性检查通过。随后使用正式 MCP 重新打开两原项目并生成上述最终产物。

## 飞行器与机械构件

项目 `project-9466fb99-beaa-446e-a80d-6a459acbc793`，正式脚本 [mechanical.ts](../scripts/modeling-assets/mechanical.ts)，生产 SQLite 为 `.data/advanced-mechanical`。整个工程从公开 MCP 空项目开始，使用普通静态建模对象；最终 r23 产物目录为 `.data/advanced-modeling/works/mechanical/2026-09-08T06-14-32-194Z-f4300b14`。

| 结构 | 可编辑源与操作 |
| --- | --- |
| 机身 | 多截面放样，独立控制前后截面轮廓与位置 |
| 主翼 | 多边形半翼控制笼，稳定组件拓扑修改、焊接镜像、Catmull-Clark 和实体化；实际斜面厚度保持正向 |
| 双发动机 | 带内外轮廓的旋转壳、进气口、后喷口；吊架保留活布尔操作数 |
| 叶片 | 沿闭合圆路径阵列，叶片扭转源保留，可分别修改数量、路径和扭转 |
| 起落架 | 前轮与双主轮、轮毂及连接机身的支柱；初次图像中前支柱悬空，已按连接尺寸修正 |
| 液压套筒 | 两端含内外边界环；通过正式 `topology_bridge` 分别桥接外壁与内壁，形成真实中空构件 |
| 尾翼与襟翼 | 薄壳尾翼，保留倒角的后缘襟翼；一侧襟翼显式转换、斜切封口、朝外法线修复 |

四镜头依次检查完整机身、进气与叶片、翼面与控制笼效果、后喷口与机械连接，均为 6 秒持续运镜。真实建模清单位于 `.data/advanced-modeling/works/mechanical/2026-09-08T05-15-29-513Z-6e17fdab/`，包含 `empty-project.json`、`modeling-checklist.json`、`wing-topology-edit.json`、`panel-cut-repair.json`、`edit-undo-redo.json` 和公开 MCP 日志。更早两次失败记录保留在同作品目录，未用成品导入替代。

`2026-09-08T05-29-18-729Z-d76f50df` 记录后续叶片扭转、两侧液压环桥接和 r22 的候选产物。主翼作品暴露的斜平面实体化数值错误已修为正则化 Cholesky 求解；[normal-offset.test.ts](../tests/normal-offset.test.ts) 包含实际斜面顶点和退化法向回归。最终 r23 使用 `output-runtime-02` 正式导出，完整视频、每秒联系表、总体图、桌面/手机播放器均已查看，`visual-review.json` 为实际审查记录。

## 曲面工艺壶

项目 `project-025fdccf-c16d-47b5-ad80-65714cb18515`，正式脚本 [curved-prop.ts](../scripts/modeling-assets/curved-prop.ts)，生产 SQLite 为 `.data/advanced-prop`。最终 r14 产物目录为 `.data/advanced-modeling/works/curved-prop/2026-09-08T06-14-32-191Z-11745ae2`。

| 结构 | 可编辑源与操作 |
| --- | --- |
| 壶体 | 带内外侧和内底的旋转轮廓，Bezier 切线保留；出水位置由隐藏操作数做活布尔开孔 |
| 把手 | 八点自定义截面沿三维 Bezier 曲线扫掠，端点与切线、封口和采样精度可继续编辑 |
| 壶嘴 | 四个不同朝向与尺寸的带孔截面放样，真实内壁和出水口 |
| 底座、壶盖及盖钮 | 各自独立旋转源，阶梯、弧面与切线保持可改 |
| 支座 | 多段倒角块与独立轴销，与把手相接 |
| 拓扑检查件 | 复制盖钮后显式转换为 562 顶点、1120 面的拓扑源；连通比例编辑使选中局部产生真实几何变化 |

四镜头检查整体轮廓、壶嘴内孔与旋转曲面、扫掠把手及机械支座、底座与拓扑检查件。空项目与建模清单保存在 `.data/advanced-modeling/works/curved-prop/2026-09-08T05-24-58-334Z-07f0e499/`；`2026-09-08T05-27-14-240Z-bcf5008e/` 包含 `converted-topology-proof.json`、曲线修改前后及精确 undo/redo、相机清单和 MCP 日志。检查件诊断为闭合、朝向一致，无非流形、重复或退化元素。

真实把手曾暴露近共面相邻三角形的相交误判，保留失败输入后在曲面通用验证内修复。`2026-09-08T05-29-18-728Z-73bc5a85/` 是修复后的旧候选产物；图像复核提出壶盖接缝、检查件落地和隐藏出水 cutter 尺寸调整，最终 r14 已通过正式领域命令应用并重新导出。`visual-review.json` 记录总体图、联系表及桌面/手机播放器人工审查，出水口上方原意外孔已消除，扫掠/放样/旋转形态可辨认。

机械与曲面生产数据库的重启基线在 `.data/advanced-modeling/mechanical-prop-restart/`，before/after 比较证明原 21 与 12 条历史、项目文档、游标 SHA-256 不变，SQLite 完整性通过，实际 PID 变化见 `lifecycle.json`。随后在该冻结代码上完成最后的源修正与导出。

## 四作品集中恢复

集中编辑器为 <http://127.0.0.1:4224>，四个工程 ID 和下载目录见 [交付入口](advanced-modeling-delivery.md)。四个项目包均实际恢复至全新 SQLite，保留 18、22、14、13 条源历史。服务真实重启后，每件均完成项目内容、历史、依赖、原视频、GLB 和 PNG 对照，修改对象、撤销/重做/撤销及再次正式 MP4 导出与完整播放。

`.data/advanced-modeling/restoration-final/suite-report.json` 为四件全部通过的总记录，实际 PID 为 6289→7029。四个再次生成的 GLB、PNG 和完整 MP4 都与最终原产物字节一致，视频独立对照在 `video-hashes.json`。作品源均由产品通用几何能力创建，没有引用成品模型资产；模板/导入资产源保留另由集成测试验证。
