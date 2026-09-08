# 高级建模工程约定

目标与逐项状态见 [目标](advanced-modeling-goal.md) 和 [验收矩阵](advanced-modeling-matrix.md)。这里记录实现边界，性能测量见 [性能报告](advanced-modeling-performance.md)，数值上限不等同于交互延迟承诺。

## 模块与数据

`shared/topology/` 处理稳定组件 ID、邻接、选择、编辑结果映射和几何操作；`shared/surfaces/` 处理参数曲面；`shared/modifiers/` 处理非破坏几何及依赖。它们不访问数据库或浏览器。坐标为米，欧拉角为度，源网格保留多边形，渲染时三角化。

`shared/topology-commands.ts`、建模和修改器命令负责领域适配；Web 与 MCP 共用命令定义、校验及 `Store` 的版本、上下文、锁定、请求幂等和历史事务。`server/modeling-jobs*` 接收不可变快照，在 CPU Worker 中运行命令、诊断、转换和 GLB 求值；提交前重新检查上下文和版本。SQLite 保存项目、历史、任务、资产元数据；二进制文件由数据库引用。

`src/engine/GeometryEvaluation.ts` 将浏览器几何求值放入模块 Worker；`SceneResourceCache` 只持有正在使用或加载的租约，不保留无人使用的历史版本。新版本加载过程中旧版本仍可显示；最后一个租约释放时取消未完成计算并销毁资源。材质按项目顺序在异步几何返回前分配，保证镜头与旧项目的渲染顺序稳定。

项目包同时保留源拓扑、修改器、依赖对象、历史和二进制。导入网格显式转换后仍以 `sourceAssetUrl` 引用原文件，撤销与跨目录恢复不丢失原资产。模型导出共用正式对象工厂和几何求值，不包含编辑辅助层。

2026-09-08 使用 TypeScript 编译器解析 `src/shared/server` 的本地运行时 import/export 并计算强连通分量，最终检查 250 个模块、765 条本地运行时依赖，0 个循环、0 个未解析引用；类型专用依赖不进入运行时图。最后结构检查为 456 个源码文件，最长为 955 行的 SceneEngine，全部不超过 1000 行。

## 数值与容量

| 范围 | 实际限制与行为 |
| --- | --- |
| 拓扑网格 | 100000 顶点、100000 面、每面 256 顶点、150000 三角形；坐标绝对值不超过 100000 米 |
| 拓扑检查 | 邻接拒绝面积法向长度小于 1e-8、边长小于 1e-10 的退化输入；共面比较为 1e-6 米；重复点诊断默认 1e-6 米，焊接距离由用户显式传入 |
| 复杂搜索 | 重复点、近邻及凸性检查最多 5000000 次比较；超过即报 `TOPOLOGY_LIMIT`，不跳过检查 |
| 补洞与桥接 | 补洞边界最多 2048 顶点；桥接两环各最多 2048 顶点且边数相等，1 至 64 段，保留明确的对应扭转 |
| 环切与倒角 | 环切 1 至 32 条；倒角 1 至 16 段，总剖面平面最多 256；支持闭合凸壳，凹壳、开边界、相交或吃掉源面的宽度明确拒绝 |
| 布尔及依赖 | 每个操作数最多 30000 三角形；依赖深度 32、闭包 256 对象；缺失、循环或不兼容源原子失败 |
| 曲面源 | 每曲线最多 128 控制点，16 孔、64 放样截面；路径分段 1 至 256，截面分段 1 至 64，每截面总采样点最多 2048 |
| 曲面结果 | 最多 70000 顶点、150000 三角形；自交检查最多 3000000 个 BVH 候选对；距离容差 1e-7 米、面积阈值 1e-14；厚度超过稳定偏移范围会拒绝 |
| 服务计算 | 单 CPU Worker；未完成任务最多 8；快照 64 MiB、请求 32 MiB、结果 128 MiB、合计预留 256 MiB；120 秒超时；Worker 老生代堆 512 MiB、栈 16 MiB |
| 浏览器求值 | 单活动 GeometryWorker；单依赖快照估算 64 MiB、排队及活动合计 256 MiB、2048 请求；120 秒超时；取消终止活动 Worker 或移除排队项并释放预留 |

浏览器快照字节按 JSON UTF-16 长度估算，是输入容量保护，不是整个浏览器的精确堆限额。性能报告另外记录实测内存、响应时间、长任务和浏览器环境。运行时因超时、取消、容量、几何错误或版本冲突失败时，源项目及历史保持原子性。

自定义算法的约定及拒绝范围见 [拓扑内核](../shared/topology/README.md)、[修改器](../shared/modifiers/README.md) 和 [曲面内核](../shared/surfaces/README.md)。倾斜平面的厚度求解使用正则化 Cholesky，近共面三角形采用投影分离轴判断；均有真实作品输入和退化负例回归。

## 几何依赖许可

| 依赖 | 锁定版本 | 许可与使用 |
| --- | --- | --- |
| Three.js | 0.180.0 | MIT；渲染、Earcut 多边形三角化、曲线与坐标变换 |
| three-bvh-csg | 0.0.18 | MIT；布尔裁剪，不自建第二套 CSG 内核 |
| three-mesh-bvh | 0.9.14 | MIT；BVH 与三角形相交，许可证随静态资源发布 |
| @nasedkinpv/opensubdiv-wasm | 0.2.0 | Tomorrow Open Source Technology License 1.0；Catmull-Clark WASM，包含上游 LICENSE 与 NOTICE |
| @gltf-transform/core | 4.5.0 | MIT；GLB/glTF 结构化读取与写入 |

实际许可证来自已安装依赖，与 lockfile 版本核对。OpenSubdiv 许可证及署名说明在 `public/licenses/opensubdiv-LICENSE.txt` 和 `opensubdiv-NOTICE.txt`，原文件未经修改；生产冻结脚本复制并计算 `public/` 哈希。Three-mesh-bvh 许可证在同目录。MIT 依赖分发时保留其原始版权与许可文本，OpenSubdiv 的名称只用于依赖署名。

## 检查入口

`npm run check:structure` 自动拒绝超过 1000 行的源码；不得通过压缩排版规避。`npm run format:check`、`npm run typecheck`、`npm test`、`npm run build` 是工程门禁；浏览器组件、曲面、模型资产及作品恢复另外验证真实操作和导出文件。旧影片和失败原件保留在独立目录，验收结果必须指向其对应构建和数据目录。
