# 高级建模逐项验收矩阵

创建日期：2026-09-08。目标来源：[advanced-modeling-goal.md](advanced-modeling-goal.md)。基线代码版本：`6ff0ec25ffbb7bf1dc7ca895ae6bd200389a8e11`。

本矩阵仅跟踪新增高级建模目标；不替换或修改 `full-goal.md`、`full-delivery-matrix.md`、历史四片验收及既有范围决定。流程终点仍是可编辑白模、模型文件、参考图片与白模视频，不接入下游 AI 视频生成。雕刻、材质节点、布料、毛发、流体、额外复杂动力学、内置聊天和外部生成式 3D 服务不在本目标内。

状态规则：`待实现` 表示尚无新增交付证据；`实施中` 表示已有部分代码但验收未齐；`待验证` 表示实现待指定检查；`通过` 必须链接实际产物、测试或人工检查证据；`失败` 必须保留失败输入、日志和复现方法。每个子行为均必须验证，不能用一项成功覆盖整行。下列入口中明确写为“拟”的名称是接口规划，不表示当前存在可调用工具。

## 既有基线，不计新增完成

| 基线 | 当前实现与边界 | 本目标新增差异 |
| --- | --- | --- |
| 索引多边形网格 | `shared/modeling.ts`：`vertices` 坐标数组、`faces` 索引数组，检验索引和非零面积；无稳定顶点/边/面 ID、显式边或邻接模型 | AM-01 至 AM-04 的拓扑身份、邻接、迁移及引用语义 |
| 基础顶点和面编辑 | `shared/modeling-operations.ts`：顶点增改删、面增删、单面法线挤出；`ModelingPanel.tsx` 用局部索引输入选择 | 完整组件选择、变换和高级拓扑操作；已有单面挤出不能重复计数 |
| 破坏式布尔 | `mesh.boolean` 使用 `three-bvh-csg`，要求闭合实体；成功即替换网格，操作数可保留或隐藏 | 可继续编辑的布尔栈、依赖追踪和同一求值语义 |
| 基础修改器 | `modifier-schema.ts`、`modifier-evaluation.ts`：不焊接镜像、直线阵列、Loop 细分；已有新增/参数/排序/启停/删除/整体烘焙 | 倒角、实体化、焊接镜像、曲线阵列、弯曲/扭转、多边形细分、复制和依赖支持 |
| 基础曲线与地形 | Catmull-Rom 道路/圆管；可编辑点、闭合及分段；显式高度网格与地形刷 | 可编辑切线、自定义截面扫掠、旋转成型、多截面放样和诊断 |
| 对象视口操作 | `SceneEngine.ts`：对象级射线拾取、单对象 TransformControls、固定步长吸附 | 顶点/边/面真实拾取、区域选择、编辑笼与组件变换 |
| 导入与流转 | glTF/GLB 资产、静态/骨架/动画目录；项目包保存历史和资产；现有 `mesh.convert` 明确拒绝导入模型 | 静态导入网格显式转换、新拓扑和依赖的包兼容、实际 GLB 导出 |
| 共享操作与历史 | `commandDefinitions` → `applyCommands` → SQLite `Store.commands`；Web 与 MCP 使用同一命令，批量原子、请求幂等、版本冲突已有 | 全部新增命令和组件状态进入相同校验/权限/历史路径，重计算进度、取消和无浏览器工作流 |

## 功能矩阵

所有修改均以真实项目为输入，以更新后的源拓扑、求值几何、结构化结果和历史为验收对象。失败必须保持操作前项目、引用和历史不变。Web 数值表单或 MCP 注册本身不算通过。

| ID / 目标条款 | 固定验收行为 | Web 入口 | MCP / 共享入口 | 边界与失败行为 | 必需证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| AM-01 / 2 | 顶点、边、多边形面有稳定 ID；未改变元素在编辑/保存/恢复后保持身份；新元素分配新 ID | 建模检查与组件信息 | `mesh_inspect；topology_*` | 拒绝重复/悬空 ID；不得把数组移位后的元素误当旧选择 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 身份保持、删除重建、SQLite 往返测试 | 通过 |
| AM-02 / 2 | 可查询点边面邻接、边界环、面朝向；凹多边形正确三角化，源多边形保留 | 编辑笼、法线/边界显示 | `mesh_inspect；mesh_selection_query` | 明确孔洞表示；不把有孔区域错误扇形填满；不兼容多边形报定位错误 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 凹面、开放边界、带孔区域、朝向与三角化几何断言 | 通过 |
| AM-03 / 2 | 旧网格、SQLite 项目、历史快照、模板、项目包可读取或显式迁移 | 打开/导入/历史/模板 | `project_open；project_package_export/import；transfer_*；模板命令` | 迁移确定、可备份；失败不部分写入；原历史不能被静默丢弃 | [旧四片兼容与历史恢复](advanced-modeling-compatibility.md)、[新四包真实重启恢复](../.data/advanced-modeling/restoration-final/suite-report.json)、模型依赖/模板与坏包原子回滚集成测试均通过 | 通过 |
| AM-04 / 2 | 拓扑变化返回元素身份映射/删除集合；选择及元素引用更新或明确失效 | 选择反馈与错误定位 | `topology_* 返回 changes；workspace_apply components` | 不静默指向另一元素；版本过期拒绝；依赖缺失明确报错 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 删除/合并/拆分/撤销前后引用测试 | 通过 |
| AM-05 / 3 | 顶点/边/面模式下真实视口拾取，屏幕反馈与读取的 ID 一致 | 视口模式、单击拾取 | `workspace_get/apply components；mesh_inspect` | 始终拾取源编辑笼；首次拓扑与三角化在 source Worker 准备，MCP 等待安装；切换对象取消旧请求，失败不发布假确认 | [生产浏览器用例](../tests/component-workspace.spec.ts) 2/2、[实际结果](../.data/advanced-modeling/component-production-tests/.last-run.json)；真实面/点/边点击与 MCP 稳定 ID 一致；[拾取与覆盖层断言](../tests/component-overlay.test.ts)、[源 Worker 取消/重试](../tests/component-source.test.ts)、[桌面图](../.data/advanced-modeling/component-production-tests/component-workspace-compon-3f0ac-CP-edits-share-stable-state/components-desktop.png) | 通过 |
| AM-06 / 3 | 框选、套索、可见/穿透选择、增选/减选/反选 | 视口选择工具 | `workspace_apply components；mesh_selection_query` | 投影/遮挡使用当前视口和源编辑笼；框/套索路径、xray、Shift 增选、Control 减选以及手机布局均有实际操作断言 | [冻结 02 生产浏览器用例](../tests/component-workspace.spec.ts) 2/2，验证框选/套索全选 8 点、非 xray 仅可见点、真实增/减选的精确有序顶点 ID；[反选集合断言](../tests/topology.test.ts)、[手机图](../.data/advanced-modeling/component-production-tests/component-workspace-compon-3f0ac-CP-edits-share-stable-state/components-mobile.png)、[像素与无溢出记录](advanced-modeling-performance.md) | 通过 |
| AM-07 / 3 | 关联选择、边环/边带、扩展/收缩返回真实拓扑集合 | 组件选择菜单 | `mesh_selection_query；workspace_apply components` | 开边界、极点、三角面、非流形的停止或拒绝规则明确；不跳到无关部分 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 确定元素集合、边界/极点负例 | 通过 |
| AM-08 / 3 | 选中组件支持数值和工具变换；世界/局部/法线空间及合适枢轴 | 视口变换、组件参数 | `topology_transform；workspace_apply components` | 世界 gizmo 增量转换为源局部仿射矩阵，保留旋转和非均匀父缩放；法线空间使用选中面法线；奇异/投影/非有限矩阵与混合空间参数原子拒绝 | [父变换/法线空间与非法矩阵断言](../tests/topology-commands.test.ts)、[枢轴/方向及组件坐标断言](../tests/topology.test.ts)；[生产浏览器用例](../tests/component-workspace.spec.ts) 实际拖拽只改变所选面顶点，MCP 回读并精确撤销；[提交后图](../.data/advanced-modeling/component-production-tests/component-workspace-compon-3f0ac-CP-edits-share-stable-state/component-drag-committed.png) | 通过 |
| AM-09 / 3 | 组件吸附和比例编辑；影响半径及衰减可调且可检查 | 吸附/比例编辑设置 | `topology_transform 参数；workspace_apply components` | 比例半径为源局部米制距离，连通距离沿边传播；增量吸附分别量化米制位移、角度和相对 1 的缩放增量；取消无残留提交 | [比例权重/连通与非连通断言](../tests/topology.test.ts)、[仿射比例及三类吸附精确终点](../tests/topology-commands.test.ts) 10/10；位移 0.26→0.3、旋转 23→30 度、缩放 1.26→1.3，并验证未选顶点不动；[生产浏览器用例](../tests/component-workspace.spec.ts) 验证真实 preview Worker、Escape/pointercancel/实际释放 pointer capture 无提交及精确撤销 | 通过 |
| AM-10 / 4 | 区域挤出保留共同边界；独立面挤出彼此独立；距离/方向可编辑 | 拓扑工具 | `topology_extrude` | 混合朝向、开放面、凹区及不兼容非流形输入明确；零距离不产退化面 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 面邻接/体积/边界断言及两类实物细节 | 通过 |
| AM-11 / 4 | 内插与可调段数倒角生成真实支撑拓扑和圆滑边缘 | 内插/倒角参数 | `topology_inset；topology_bevel` | 宽度越界、相交、尖角和不兼容拓扑拒绝或明确限幅；不静默丢面 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 多段截面、厚度/距离断言、边界负例 | 通过 |
| AM-12 / 4 | 环切后可滑移，保持连接与方向，支持数值定位 | 环切/滑移工具 | `topology_loop-cut；topology_slide` | 环到边界/极点终止规则明确；过界导致翻面时拒绝 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 环轨迹、面数/邻接、滑移后法线检查 | 通过 |
| AM-13 / 4 | 切割与平面剖切真实拆分相交面；保留侧及封口按明确参数 | 切割/剖切工具 | `topology_bisect` | 共面、穿顶点/边、多个闭环与开放输入定义；不能用仅显示裁剪代替网格编辑 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 剖切边界/截面、导出几何、退化负例 | 通过 |
| AM-14 / 4 | 桥接边环与补洞；方向和端点对应可检查 | 桥接/补洞工具 | `topology_bridge；topology_fill` | 不兼容边数、扭曲、非简单环、非流形明确拒绝；不得封住应保留的孔 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 闭环邻接、面朝向、真实孔洞截图 | 通过 |
| AM-15 / 4 | 合并与按距离焊接，拆分、溶解、删除按组件语义工作 | 拓扑编辑菜单 | `topology_merge/weld/split/dissolve/delete` | 明确删除连带面、溶解保留表面、焊接阈值/代表点；不产悬空引用 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 各操作正反例、身份映射、原子失败 | 通过 |
| AM-16 / 4 | 修复法线；诊断开放、孔洞、非流形、退化输入，定位元素 | 法线/诊断面板 | `mesh_inspect；topology_repair` | 不可定向或相矛盾邻接不猜测外侧；保留诊断并拒绝不适用修复 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 反向面、非流形、零面积、退化输入集 | 通过 |
| AM-17 / 5 | 活布尔保存操作数引用；修改操作数后目标重算；支持并/差/交 | 修改器栈、操作数定位 | `modifier_*；依赖统一求值` | 缺失、循环依赖、锁定、跨上下文引用明确处理；重算失败保留合法源 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 依赖求值、GLB 体积及 Web/MCP 操作数变化检查已通过；四作品统一冻结输出及重启恢复均已通过 | 通过 |
| AM-18 / 5 | 倒角、实体化、带焊接镜像保持源可编辑 | 修改器参数 | `modifier_*；topology_bevel` | 厚度/偏移/焊接阈值单位明确；退化、翻面、自相交边界可诊断 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 厚度/边段/接缝邻接、栈次序对比；见进度记录 2026-09-08 | 通过 |
| AM-19 / 5 | 曲线阵列、弯曲、扭转产生可重复几何，参数持续可改 | 修改器参数与曲线点 | `modifier_*` | 曲线方向/闭合接缝、变形轴/区间、零长路径/区间明确 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 参数前后几何、轨迹方向、负例；见进度记录 2026-09-08 | 通过 |
| AM-20 / 5 | 面向多边形控制网格的细分保留控制笼，可持续编辑 | 细分修改器与编辑笼 | `modifier_* catmull-clark` | 与既有 Loop 区分；开放边界、非流形、凹面输入规则明确 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 四边控制网格、边界位置、收敛与法线检查；见进度记录 2026-09-08 | 通过 |
| AM-21 / 5 | 全部新增修改器可改参、排序、启停、复制、显式烘焙；依赖影响可读 | 修改器栈 | `modifier_add/set/reorder/remove/bake` | 复制 ID 唯一；烘焙与撤销恢复源和依赖；失败不部分改栈 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 每种修改器生命周期及历史测试；见进度记录 2026-09-08 | 通过 |
| AM-22 / 5 | 编辑笼、求值结果、预览、碰撞辅助、GLB 和视频统一求值语义 | 视口/预览/导出 | `evaluateModelObject；正式预览/GLB/视频` | 缓存包含源、参数、依赖与版本；不得各入口实现不同几何 | 四作品使用同一冻结求值器，原/恢复 GLB 与 PNG 哈希完全一致，四片 MP4 重导出亦字节一致；[恢复总报告](../.data/advanced-modeling/restoration-final/suite-report.json)、[视频对照](../.data/advanced-modeling/restoration-final/video-hashes.json)、碰撞辅助/依赖集成测试 | 通过 |
| AM-23 / 6 | 曲线控制点和切线可编辑；开闭状态可切换并保持源 | 曲线编辑模式/参数 | `surface_set` | 路径方向、尖角、重复点、零切线的规则明确 | [最终生产界面审查](advanced-modeling-ui-review.md)、surfaces.spec.ts 两项真实Web/MCP源、切线、开闭状态、撤销及重开；四作品实际曲面源保留 | 通过 |
| AM-24 / 6 | 自定义截面扫掠、旋转成型、多截面放样均生成实际曲面 | 曲面生成与截面编辑 | `surface_set` | 截面方向/对应、旋转轴穿越、路径拐点、自交及不兼容截面有诊断 | [曲面内核约定](../shared/surfaces/README.md)、surfaces.test.ts 几何与退化输入；[工艺壶及飞行器实际源和GLB](advanced-modeling-works.md)、最终Web/MCP双向回归 | 通过 |
| AM-25 / 6 | 分段精度、封口和厚度可调；显式转为稳定拓扑网格 | 曲面参数、转换命令 | `surface_set；mesh_convert` | 精度超限明确拒绝；转换前保留源，转换后历史可恢复；不要求完整 CAD/NURBS | [最终界面证据](advanced-modeling-ui-review.md)、曲面封口/厚度/采样/转换测试，以及四作品精确包恢复和再导出 | 通过 |
| AM-26 / 7 | 线框/实体、法线/边界显示；读取元素数量、尺寸和合法性 | 建模显示/检查面板 | `workspace_apply components；mesh_inspect` | source Worker 预计算源线框/边界/法线；辅助层仅属于交互 Controller，不写入源网格或正式对象工厂；检查显式区分源与求值数据 | [覆盖层及可见性恢复断言](../tests/component-overlay.test.ts)、[传输后的静态反馈/边界尺寸断言](../tests/component-source.test.ts)、[实际法线/边界显示与画布像素](../tests/component-workspace.spec.ts)；[11 服务真实 MCP/HTTP 检查与 GLB](../tests/modeling-services.test.ts)、[正式工厂导出几何](../tests/modeling-assets.test.ts) | 通过 |
| AM-27 / 7 | 定位重复元素、退化面和非流形并执行对应修复 | 诊断结果列表、定位/修复 | `mesh_inspect；topology_repair/weld` | 修复不能静默删掉合法特征；不可修项有原因；修复可撤销 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 含多类缺陷夹具、定位 ID、修复前后检查 | 通过 |
| AM-28 / 7 | 兼容静态 GLB/glTF 显式转为可编辑网格 | 导入对象转换 | `model_conversion_plan/start；mesh_set` | 原资产保留；骨架/动画/morph/不支持属性逐项报告；节点变换正确 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 静态多节点/索引/非索引用例、拒绝夹具与原资产哈希；见模型流转进度 | 通过 |
| AM-29 / 7 | 导出所选对象或场景的实际 GLB；重新读取结果 | 模型导出 | `model_export/start` | 范围、对象层级/变换、求值时刻明确；不把 JSON 或原资产拷贝当新 GLB | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 GLB 解析、几何比较、真实文件下载；见模型流转进度 | 通过 |
| AM-30 / 7 | 项目包保留源拓扑、修改器、依赖资产和历史，重新打开可编辑 | 包导出/导入 | `project_package_export/import；transfer_*；项目包入口` | 依赖闭包完整；模板实例化重映射；缺失/坏资产回滚 | [四包恢复与重启总报告](../.data/advanced-modeling/restoration-final/suite-report.json)、[模型依赖/模板/包集成](../tests/modeling-dependencies-integration.test.ts)、sourceAssetUrl 保留及坏资产回滚测试 | 通过 |
| AM-31 / 8 | 全部新增 Web 能力有正式 MCP 等价入口，组件可读/可选/可改 | 全部新增界面 | `正式 topology_*、surface_set、modifier_*、workspace_* 与11服务` | 无浏览器仍可选组件并建模，不依赖 live workspace 才能修改源 | [完整新增MCP使用映射](advanced-modeling-mcp.md)、真实SDK/HTTP共用11服务等价、独立拓扑命令与撤销测试、[最终双向浏览器验证](advanced-modeling-ui-review.md)、四作品无浏览器公开MCP制作 | 通过 |
| AM-32 / 8 | 新增操作共用校验、权限、锁定、历史；原子批量、幂等与版本冲突 | 所有编辑入口 | `共享领域命令；SQLite Store；modeling_job_start` | 批内中途失败回滚；同 requestId 异参拒绝；锁定对象/操作数一致 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 HTTP/MCP/SQLite 集成、冲突重试、撤销/重做 | 通过 |
| AM-33 / 8 | 耗时操作有实际阶段/进度与取消；无浏览器可预览并取得图片/模型 | 任务进度与取消、产物列表 | `modeling_*_start/status/cancel；model_export_start；model_conversion_start` | 进度来自实际工作量；取消不提交半成品；重启状态明确 | 见 [当前证据](advanced-modeling-evidence.md)；原行为验收要求保持 中途取消、结束竞争、重启恢复、无浏览器全链路 | 通过 |
| AM-34 / 9 | 复杂计算隔离主线程；缓存/内存有明确上限和释放策略 | 交互持续响应、可理解错误 | `GeometryWorker；ComponentSourceWorker；ComponentPreviewWorker；ModelingJobService` | 几何/首次组件源/预览权重在 Worker；组件缓存只留当前源版本，源变化取消旧 Worker，失败缓存可重试；90k 顶点变换达到固定 512 MiB 堆限额并原子失败；JSON、克隆和安装仍有长任务，不承诺全程无阻塞 | [资源边界](advanced-modeling-engineering.md)、[队列预算/释放](../tests/geometry-queue.test.ts)、[服务取消/超限](../tests/modeling-jobs.test.ts)、[源缓存/重试](../tests/component-source.test.ts)、[生产拖拽取消](../tests/component-workspace.spec.ts)、[40k 成功回归](../tests/topology-memory.test.ts)、[90k 资源失败后源/版本不变且仍可读取、选择、保存](../.data/advanced-modeling/performance-near-limit/node-server/2026-09-08T06-29-15-245Z-98cd6f09/report.json) | 通过 |
| AM-35 / 9 | 多复杂度真实网格测量选取、编辑、重算、撤销、保存和预览 | 实际工作区 | `scripts/modeling-assets/benchmark.ts；benchmark-browser.ts；summarize-performance.ts` | 512/10000/40000 顶点独立成功运行各一次；另测 90000 顶点/45000 连通四边形/90000 三角形近限输入，记录资源拒绝；四作品分别提取正式导出记录，延迟不冒充孤立 CPU 时长 | [性能报告](advanced-modeling-performance.md)、[三档原始报告](../.data/advanced-modeling/performance/node-server/2026-09-08T06-07-11-195Z-219e707f/report.json)、[90k 完整测量及明确失败边界](../.data/advanced-modeling/performance-near-limit/node-server/2026-09-08T06-29-15-245Z-98cd6f09/report.json)、[四作品复杂修改器/曲面输入及实际耗时](../.data/advanced-modeling/performance/works-performance.json)；均保留来源、负载/次数、rAF/长任务/内存、像素和历史结果，90k 失败不计为编辑成功 | 通过 |

## 四个新作品清单

以下是每个作品必须可检查的结构与操作；具体造型可调整，但不得删除目标要求的建模类型或用成品导入替代。各作品的数量/尺寸随真实设计记录，不把尚未测量的多边形数量作为“复杂”证据。四个作品共用下节交付验收。

| ID / 作品 | 制作前检查清单 | 必须保留的建模证据 | 状态 |
| --- | --- | --- | --- |
| ART-01 车辆车体 | 可辨识车身轮廓；轮拱开口和厚度；车窗/进气开口；车身面板内插、支撑边和多段倒角；左右焊接镜像；控制网格细分；局部环切/滑移调整 | [车辆源与制作记录](advanced-modeling-works.md)、r21最终GLB/四图/24秒正式视频，真实顶点修改/undo/redo，原SQLite重启及集中恢复后GLB/PNG/MP4均字节一致 | 通过 |
| ART-02 飞行器或机械装置 | 主体和可辨识机械构件；孔洞、壳厚和连接关系；活动布尔操作数；阵列构件；桥接/补洞；弯曲或扭转构件；可编辑倒角 | [飞行器制作记录](advanced-modeling-works.md)：可改放样/翼面笼、活布尔吊架、扭转叶片阵列、内外环桥接套筒、襟翼剖切修复；r23最终全套产物、源编辑历史及重启恢复通过 | 通过 |
| ART-03 建筑地标 | 带拱洞的主体；真实台阶；沿路径栏杆；墙/楼板厚度；窗洞及开口；剖切/切割形成真实拓扑；重复构件依赖可查 | [三拱观测馆制作记录](advanced-modeling-works.md)：三拱、8级台阶、路径栏杆、阵列窗洞、厚度、塔冠剖切；前墙真实闭合，r15全套产物及原数据库/集中包重启恢复通过 | 通过 |
| ART-04 曲面道具 | 主要造型真实依靠自定义截面扫掠、旋转成型和多截面放样；曲线控制点/切线；封口和厚度；局部转换拓扑后编辑 | [工艺壶制作记录](advanced-modeling-works.md)：真实扫掠/旋转/带孔放样及切线源，拓扑转换/比例编辑/undo，r14全套产物及集中重启恢复通过 | 通过 |

| ID / 目标条款 | 四个作品共用验收行为 | 必需证据 | 状态 |
| --- | --- | --- | --- |
| ART-05 / 作品 1、2 | 全部通过正式 Web/MCP 通用操作制作，记录命令及版本；至少一个由外部 Agent 经公开 MCP 从空项目完成建模、检查、修正和导出 | 四份生产脚本通过MCP SDK通用工具从空工程制作；[作品记录](advanced-modeling-works.md)逐项链接empty-project、命令/修正日志、真实几何检查，root与协作Agent均直接使用公开MCP | 通过 |
| ART-06 / 作品 3 | 每个作品交付可再编辑项目包、实际 GLB、多角度图片和正式视频导出功能生成的展示片 | [四套实际下载文件](advanced-modeling-delivery.md)、各自ffprobe/完整1x在线播放/下载SHA/非黑冻帧/desktop-mobile人工看图；四片各24秒、1280x720、24fps、576帧，恢复后可继续编辑 | 通过 |
| ART-07 / 作品 3 | 展示能检查轮廓、曲面、倒角、孔洞和关键拓扑效果，镜头覆盖全部制作清单 | [四作品镜头/源清单](advanced-modeling-works.md)、四套人工视觉记录及每秒联系表；机械桥接内孔主视频像素较小，补正式 scene_view_capture 近景 hydraulic-detail.png，独立GLB射线证实套筒与壶嘴/出水孔真实开通；[最终文件](advanced-modeling-delivery.md) | 通过 |
| ART-08 / 作品 4 | 每件实际改参数或拓扑，撤销/重做，保存，重启服务，恢复项目，再导出 | [集中恢复总报告](../.data/advanced-modeling/restoration-final/suite-report.json)及两组原生产SQLite before/after；四个工程修改/undo/redo/保存/真实重启/包恢复，GLB、PNG和再次正式MP4均同哈希 | 通过 |
| REG-01 / 作品 5 | 旧武侠、赛车、太空战斗、旅游风景四片的有效验收保留，不重复计为新作品 | [原交付入口](delivery-runtime.md)、[历史四片](four-films.md)与[新增目标](advanced-modeling-goal.md)；原4219和28个历史文件未改动，新四作品不替代原四片 | 通过 |
| REG-02 / 作品 5 | 四个旧项目在新实现下兼容打开、播放，按几何/预览/导出实际变更补充回归 | [旧四片兼容报告](advanced-modeling-compatibility.md)：四工程/完整历史/重启，8个桌面手机播放检查、24次seek、8下载同hash、4PNG完全相同；42秒1008帧正式重导出 | 通过 |

新增展示片目标没有规定两分钟时长，本矩阵不借用旧四片的时长门槛，也不另设未授权时长要求；必须达到可完整检查作品且持续运动的实际展示标准。既有四片不因本目标强制重做。

建筑作品暴露的布尔精度回归：三次拱洞差集在 `geometryToMesh` 的量化哈希格边界留下 3 组相距 `2.384185791015625e-7m` 的重复点和 12 条索引边界。失败源与图片保存在 `.data/advanced-modeling/works/architecture/2026-09-08T05-40-09-306Z-b91c0106/`。`shared/modifiers/boolean.ts` 现复用 27 邻格距离查询，在既有 `1e-6m` 精度内焊接并保留全部面；超出该精度的传递链、塌面或翻面整次报错。`tests/boolean-output-weld.test.ts` 的两项真实建筑用例先复现失败，修复后闭合与独立开口体积断言通过；另覆盖容差外点、传递链与不可静默消除的微小面。`tests/boolean-output-mcp.test.ts` 通过真实 MCP 制作、检查、下载 GLB、操作数修改及撤销后相同 GLB 哈希验证。与已有修改器依赖/模型流转用例合计 23/23 通过；最终四作品已在包含该修复的 output-runtime-02 重新生成，并完成集中恢复与字节一致的再导出。

## 工程与交付门禁

| ID | 固定验收行为与边界 | 必需证据 | 状态 |
| --- | --- | --- | --- |
| ENG-01 | SQLite 保存项目/历史/任务/资产元数据；二进制引用、迁移、备份、导入、恢复一致且原子 | SQLite事务与失败注入测试、资源发布回滚、原制作库重启及[四包干净目录恢复](../.data/advanced-modeling/restoration-final/suite-report.json)；原资产/历史/任务跨重启保持 | 通过 |
| ENG-02 | 拓扑内核、建模命令、求值、渲染、交互、持久化、传输、编码按职责分离；无重复领域逻辑/新增循环依赖；源码每文件不超 1000 行 | [模块与资源约定](advanced-modeling-engineering.md)；456源码文件均≤1000、最大955行；250运行时模块765本地依赖边，0环/0未解析；结构、类型与冻结构建通过 | 通过 |
| ENG-03 | 统一格式、严格 TypeScript、边界校验和结构化错误；成熟几何库许可与数值行为核查，自定义算法说明数据约定 | 格式/严格TypeScript通过；[依赖许可与数值边界](advanced-modeling-engineering.md)、实际WASM LICENSE/NOTICE随构建发布，斜平面/近共面/布尔邻桶和退化输入回归 | 通过 |
| ENG-04 | 几何/拓扑/迁移/SQLite/Web/MCP/撤销恢复/导出按风险验证 | [501项完整回归及补充行为检查](advanced-modeling-evidence.md)、真实MCP/HTTP/SQLite/Worker/恢复/正式GLB和视频证据；失败原件保留 | 通过 |
| ENG-05 | 桌面/手机真实浏览器检查布局、非空 3D 像素、组件选中反馈、人工/MCP 双向操作、实际图像/模型/视频 | [最终生产UI审查](advanced-modeling-ui-review.md)、真实增减选/吸附补充、四作品与旧四片desktop/mobile在线播放/图像/下载/像素检查，恢复后再次导出视频字节相同 | 通过 |
| ENG-06 | 所有适用行和四作品、兼容回归均通过后，交付运行地址、MCP 文档、作品入口、报告和代码版本，commit 并推送 | [交付入口](advanced-modeling-delivery.md)、[MCP文档](advanced-modeling-mcp.md)、[完整证据](advanced-modeling-evidence.md)；实现提交 a9464d1 已推送 origin/master，全部适用行通过 | 通过 |

## 数值与复杂度记录

这里区分“代码当前允许的边界”和“经测量验证的能力”。任何新限制应在对应算法实施前明确参数含义、计数方式、预估中间量和错误，再通过边界用例及真实作品验证。提高或降低限制必须记录原因和影响，不能通过降低目标行为迁就实现。

| 项目 | 基线代码边界或拟定设计项 | 验证状态 |
| --- | --- | --- |
| 基础网格 schema | 至多 100000 顶点、100000 面、每面 256 索引、150000 三角形；坐标范围 -100000 至 100000 米 | 已只读核查 schema；本轮未验证该复杂度可用性 |
| 既有修改器 | 至多 16 项；阵列 2 至 32；Loop 1 至 3 次；中间容量检查顶点/三角形 100000 | 已只读核查；不是新拓扑/新修改器性能承诺 |
| 既有布尔 | 命令说明要求每操作数至多 30000 三角形、闭合实体 | 已只读核查；新活布尔须单独验证依赖链与中间量 |
| 既有曲线/地形 | 曲线 256 控制点、2048 分段，生成顶点限制 70000；地形每轴最多 200 分段 | 已只读核查；不是扫掠/放样/切线能力上限承诺 |
| 新拓扑容差 | 邻接拒绝面积法向长度小于 1e-8、边长小于 1e-10 的退化输入；共面/重复点诊断默认 1e-6 米；焊接距离显式传入；具体阈值不被描述为任意尺度下的精度保证 | 已实施；[工程边界](advanced-modeling-engineering.md)、[拓扑约定](../shared/topology/README.md)、[退化/朝向/孔洞回归](../tests/topology-robustness.test.ts)、[合并/焊接/桥接几何](../tests/topology-operations.test.ts) |
| 新操作复杂度 | 拓扑 100000 顶点/面、每面 256 顶点、150000 三角形；复杂搜索最多 5000000 次比较；补洞/桥接边环最多 2048 顶点；环切 1 至 32、倒角 1 至 16 段且最多 256 剖面平面；依赖深度 32/闭包 256；曲面分段、截面、输出和自交候选量分别受限 | 已实施输入/中间量拒绝，具体曲面与布尔边界见 [工程约定](advanced-modeling-engineering.md)；[拓扑操作](../tests/topology-operations.test.ts)、[倒角负例](../tests/topology-bevel.test.ts)、[依赖原子失败](../tests/modeling-dependencies-integration.test.ts)；结构上限不是整范围性能验收 |
| 新任务资源 | 服务单 CPU Worker、最多 8 未完成任务；快照 64 MiB、请求 32 MiB、结果 128 MiB、合计预留 256 MiB；120 秒超时、老生代 512 MiB/栈 16 MiB；浏览器 Geometry 单活动 Worker、快照估算 64 MiB、合计 256 MiB/2048 请求、120 秒超时；组件源仅缓存当前版本，拖拽仅持有当前预览 Worker，完成/取消/卸载终止；模块加载取消以共享标志处理，计算中可终止 Worker | [资源实现边界](advanced-modeling-engineering.md)、[服务阶段/取消/超限/重启](../tests/modeling-jobs.test.ts)、[队列释放与启动失败](../tests/geometry-queue.test.ts)、[源版本缓存和失败重试](../tests/component-source.test.ts)、[生产卸载/取消](../tests/component-workspace.spec.ts) 已验；浏览器 JSON 字节估算不是整个 JS 堆的精确限额 |
| 性能网格梯度 | 三档中空旋转曲面烘焙为 512/10000/40000 顶点；近上限输入为 90000 顶点、45000 连通四边形、90000 三角形，无未引用填充顶点；另提取车辆/机械/建筑/曲面道具的真实修改器、依赖栈、曲面源和正式产物耗时 | [三档独立运行](../.data/advanced-modeling/performance/node-server/2026-09-08T06-07-11-195Z-219e707f/report.json)；[90k 并发负载测量](../.data/advanced-modeling/performance-near-limit/node-server/2026-09-08T06-29-15-245Z-98cd6f09/report.json) 构建/检查/选择/保存/PNG 成功，变换触及 512 MiB 堆限额，源与版本不变、撤销标记无提交而跳过；[四作品一次正式导出观察](../.data/advanced-modeling/performance/works-performance.json)、[解释与复现](advanced-modeling-performance.md)；不作全规模延迟保证 |

## 接入位置与审查结论

- 领域命令入口为 `shared/command-definitions.ts`、`shared/commands.ts`，已有建模分派到 `shared/modeling-operations.ts`。新增拓扑和曲面命令应按职责拆出，通过同一 `applyCommands` 校验完整草稿；不能在 React 或 MCP handler 实现算法。
- `server/store.ts` 的 `Store.commands` 包含 SQLite 事务、版本/上下文检查、请求重放、历史及资产一致性。耗时计算应使用不可变快照在隔离环境求值，提交时再次校验版本和上下文；不能在事务中等待长任务，也不能绕过提交协议直接替换数据库。
- `src/useEditor.ts` 提供队列和上下文保护，组件编辑应使用同一 `editor.command/run`。`ModelingPanel.tsx` 目前的局部顶点/面索引不能承载稳定选择；组件状态需要共享 schema，并在 `shared/workspace.ts`、`src/workspace/useAppWorkspace.ts` 和无浏览器建模查询/选择中有一致定义。
- `src/engine/SceneEngine.ts` 当前接近文件上限，新增选择投影、组件覆盖层、拾取和变换应是独立模块。引擎只负责屏幕交互与显示；稳定 ID、邻接、选择规则和最终顶点变换属于共享领域模块。
- `shared/modeling-geometry.ts` 的 `modelingToMesh/buildModelGeometry` 是现有求值入口；`src/engine/ObjectFactory.ts`、`server/simulation.ts` 使用它。当前 `modifier-evaluation.ts` 与 `modeling-geometry.ts` 已互相导入，新增内核应拆出纯数据/转换/求值职责，避免继续扩大此环。
- `src/engine/SceneResources.ts` 当前缓存键只含对象自身几何字段，构造函数 `buildObject(object)` 也没有项目依赖上下文。活布尔/曲线依赖加入后，统一求值接口和缓存键必须包含依赖内容/变换/版本，否则操作数改动会返回旧几何。
- `shared/templates.ts` 负责对象依赖闭包与实例化 ID 重映射；`server/project-packages.ts`、`server/package-store.ts` 收集资产和历史快照。新增修改器/曲面引用必须同时进入闭包、重映射、校验和资产搜集，不能只让当前项目成功打开。
- `server/mcp.ts` 已由 `commandDefinitions` 自动注册正式工具并调用 `Store.commands`。只读诊断、实际模型文件、隔离任务及图片服务应使用独立服务模块，经 HTTP/MCP 两种传输共享，不把文件/任务逻辑塞进命令注册循环。

## 进度记录 2026-09-08

以下保留早期过程及失败修正历史，其中“待验收/实施中”等描述属于当时状态。当前状态以本文件上方矩阵、最终证据和作品恢复报告为准。

已完成目标分解和基线只读定位，随后接入五类新增修改器参数界面及镜像焊接：`solidify`、`bend`、`twist`、`catmull-clark`、`curve-array`。`ModifierPanel.tsx` 复用共享 `editor.run`，参数组件拆分在 `src/components/modeling/`；复制通过 `modifier.add` 分配新 ID 并插到原项之后。Catmull-Clark 提供边界模式；曲线阵列提供点坐标、增删、闭合、轴与切线方向；焊接关闭时删除可选字段，阈值和厚度输入不截断小数精度。

有界浏览器验收文件为 `tests/advanced-modifiers.spec.ts`，独立数据库及证据位于 `.data/advanced-modeling/modifier-ui/`。首次三项结果是 1 通过、2 失败；显式按 option value 选择曲线点，并等待异步受控 checkbox 的真实确认后，仅重跑两失败项，结果 2/2 通过。原 `results.json`、截图和 trace 保留，修正结果单独存放于 `corrected-results.json`。启动阶段配置目录错误另保留在 `startup-failure.json`。类型检查通过。

成功检查覆盖五类参数编辑与实际画布变化、MCP 禁用回写、浏览器真实 OpenSubdiv WASM 加载、曲线点/闭合/方向、复制/排序/启停/烘焙/撤销/刷新，以及 390px 手机布局。镜像半壳烘焙为 12 顶点、10 面且每边恰有两个邻面；MCP 写入的 `0.000001m` 焊接阈值在 Web 精确显示。六张修正轮桌面图和首轮手机图已实际查看。

以上为低复杂度功能检查，未生成四个新作品，也未完成性能、迁移、全部退化输入和所有高级能力验收；因此对应行仍为实施中，不能据此标记目标 complete。

模型流转进度：新增 `server/modeling-assets.ts`，只读 `planModelConversion` 返回静态模型源资产标识/哈希、可编辑网格及属性舍弃诊断；`exportModelAsset` 从正式 `ObjectFactory` 读取求值几何，按选中对象及后代或当前场景导出真实 GLB，并通过既有资产导入服务存文件及 SQLite 元数据。导出使用显式项目/版本/场景/表演上下文和 source time，最终提交前重新检查；源拓扑和修改器仍保留在项目中。当前 actor/vehicle/effect/bone attachment、嵌入动画、skin/morph、未注册 glTF 扩展及非三角 primitive 整次拒绝并给结构化诊断，不能静默省略对象。

`tests/modeling-assets.test.ts` 本轮 9/9 通过：GLB/glTF 转换与真实 GLTFLoader 的节点层级/归一化坐标对照、负节点缩放面朝向、原资产与撤销恢复、五类不兼容输入、Sphere 正式工厂分段及多边形细分结果导出、采样父级世界变换、导入模型与家具导出、选择/隐藏范围、版本/上下文/锁/取消、保存阶段并发冲突后文件与元数据回滚，以及本地资源和合计字节限制。初版曾缺少 NodeIO 初始化，测试亦曾给出项目 schema 不允许的负对象 scale；分别补初始化和改为合法对象输入后通过，glTF 节点负 scale 的独立覆盖保留。格式检查通过，最终传输、界面、跨服务重启和作品交付仍待集成验收。

活布尔与倒角进度：`shared/modifiers/dependencies.ts` 对每个不可变 objects 快照进行依赖闭包校验与缓存求值；禁用的布尔引用也检查缺失与循环，最大深度 32、单次闭包 256 个对象。`meshBoolean` 复用 `three-bvh-csg`，使用源对象与父级建模变换，隐藏及锁定操作数保持可读。倒角修改器调用共享凸闭壳倒角内核，宽度、段数及弧度比例均可编辑；凹面、开壳等内核边界仍为明确限制。说明见 `shared/modifiers/README.md`。

`tests/modifier-dependencies.test.ts` 8/8 通过，覆盖并/差/交体积 12/4/4、负变换、操作数编辑、父级和隐藏/锁定输入、源动画与建模变换分离、缺失与循环、缓存副本隔离及倒角实际面数/闭合性。GLB 服务已向正式工厂传入相同依赖求值结果；增加隐藏操作数父级移动与撤销后的实际 GLB 体积 4→2→4 检查后，`tests/modeling-assets.test.ts` 为 10/10 通过。

Boolean/bevel 新界面专项首轮记录在 `.data/advanced-modeling/boolean-bevel-ui/results.json`：倒角参数、MCP 禁用回写、画布变化和烘焙通过；布尔参数与操作数 ID 已保存，但视口未随操作数变化。接入视口依赖求值后，`corrected-results.json` 仍失败；独立 worker 收发试验证明含顶层异步初始化的模块会丢失首次消息，`worker-debug-results.json` 保留首次无结果、延迟重发后返回 20 面的记录。正式 Worker 添加 ready 握手；`handshake-results.json` 随后暴露测试在轮询内部过早断言栈存在的问题，改为安全读取并继续轮询。

最终只重跑布尔失败项，`.data/advanced-modeling/boolean-bevel-ui/confirmed-results.json` 为 1/1 通过：更换操作数、MCP 移动隐藏操作数后实际画布哈希变化，三种布尔运算、390px 手机布局、烘焙、撤销及刷新保持源栈全部通过。倒角首轮与布尔最终轮共两个独立用例有成功证据，不能称为完整套件同轮重跑通过。已实际查看倒角桌面、布尔修改前后桌面及手机四张成功截图，失败记录均保留。此前类型检查与源码结构检查通过，后者当时统计 413 个源码文件均不超过 1000 行。上述检查发生于协同集成工作区，不代表冻结交付版本。
