# 白场 Whiteframe

面向导演的 Web 3D 白模预演工作台。人工和外部 AI 共用场景、角色、动作、摄影机与剪辑状态，最终导出白模 MP4 视频。产品流程到视频导出为止。

当前本机交付实例、四部完整影片、项目包和对应验收来源见 [交付入口](docs/delivery-runtime.md)。用户已明确 [产品范围](docs/scope-decisions.md)：暂不要求专业 DCC 扩展、内置聊天或外部生成式 3D 集成，所有 Web 能力需要通过 MCP 使用。[验收矩阵](docs/full-delivery-matrix.md) 记录对应完成状态。

## 运行

需要 Node.js 24+、npm，以及已加入 `PATH` 的 FFmpeg / ffprobe。

```sh
npm install
npx playwright install chromium
npm run dev
```

编辑器：`http://127.0.0.1:5173`。API 与 MCP：`http://127.0.0.1:4173`。

首次启动创建“未接来电”示例：客厅、两名骨架白模、手机、走位、停顿反应及三个连续镜头。后续启动恢复 SQLite 中上次打开的项目。

生产运行：

```sh
npm run build
npm start
```

生产模式由同一服务提供编辑器、API 和 MCP，地址为 `http://127.0.0.1:4173`。

自定义本地端口：

```sh
PORT=4273 WEB_PORT=5273 APP_URL=http://127.0.0.1:5273 npm run dev
```

## 功能

- 基础几何体、室内组件、GLB/glTF 导入、场景层级、多选、分组、移动旋转缩放、吸附、锁定。
- 骨架人形、行走与简单表演、头部注视、姿态关键帧、手部道具附着。
- 自由视角、拍摄视角、俯视调度；多摄影机、景别预设、推拉摇移升降、环绕和跟随。
- 表演源时间与剪辑时间分离，镜头裁切重排、方案副本、剧情节拍、对白与修改意见。
- 基础布光、画幅安全区、切点前后帧对照、实际 PNG 预览。
- SQLite 自动保存、多项目切换、项目 JSON 导入导出、撤销重做、版本冲突校验与请求幂等。
- 异步 MP4 导出、进度、取消、重试、下载；支持单镜头或完整序列、横竖屏和方形、720p/1080p、可选音轨与审片时间码。
- MCP Streamable HTTP 和 stdio，包含真实工具发现、场景读取与编辑、图片预览、视频任务控制。
- 多场景与独立表演版本、并排镜头方案比较、带时间和几何依据的连续性审查。
- 网格编辑、挤出、连续布尔、曲线路面和地形；跨项目对象组合及场景模板库。
- 可编辑的镜像、阵列和细分修改器栈，保留源几何并支持禁用、排序和烘焙。
- 动作片段混合、关节动画、手脚 IK、接触约束、车辆与飞行路径、Rapier 物理烘焙。
- 连续速度曲线、慢动作、独立摄影机时钟、对白与动作事件同步关联、光学景深与移焦、横竖屏独立构图。
- 已导出 MP4 的应用内播放、暂停、进度跳转、音量、全屏和下载；包含资产、历史及可选视频的项目包恢复。
- Fountain/JSON 剧本拆解、场次与人物审阅、对白和覆盖镜头导入；动作文本保留为可编辑剧情节拍。
- 真实画面叠化与淡入淡出、音频源裁剪和音量包络；预览与导出共用时间采样。
- 白模表情、嘴形轨道、导入模型形变映射和 Rhubarb 语音口型分析；中文初步分析需要人工校正。
- 本地临时对白合成，使用已安装的 macOS Say 或 eSpeak NG 语音，生成实际 WAV 并编排对白、音轨与同步关系。
- 固定成片版本的团队审片、时间点意见与回复、处理状态及审片或只读访问权限。
- 可保存、复制和编辑的布光方案，支持场景默认与独立镜头覆盖，预览和导出使用同一套光照解析。
- MCP 工作区控制：读取和设置实际选择、观察视角、预览播放、工具、面板、方案比较与已导出视频播放器，支持明确标签页、版本校验及执行回执。
- MCP 分块上传与断点续传：资产最高 100 MiB、项目包最高 512 MiB，包含 SHA-256 校验和原子入库；无浏览器时也能渲染任意观察视角并检查全部接触约束。

桌面浏览器提供完整编辑界面。手机适合播放、查看镜头和基础参数调整；精细 3D 操作建议使用鼠标键盘。

## MCP

在编辑器右上角打开 **MCP**，可复制包含本机路径及访问令牌的配置。

HTTP 配置示例，令牌从本机界面获取：

```json
{
  "mcpServers": {
    "whiteframe": {
      "url": "http://127.0.0.1:4173/mcp",
      "headers": { "Authorization": "Bearer YOUR_LOCAL_TOKEN" }
    }
  }
}
```

stdio 配置指向当前项目；API 服务需先启动：

```json
{
  "mcpServers": {
    "whiteframe": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/3d-max/server/stdio.ts"],
      "env": { "WHITEFRAME_API_URL": "http://127.0.0.1:4173" }
    }
  }
}
```

具体配置字段以所使用的 MCP 客户端为准。编辑器与完整 HTTP MCP 默认监听本机回环地址，MCP 使用 Bearer 令牌。团队审片使用独立服务及限定到单个成片版本的邀请凭据，配置见下文。

推荐调用顺序：

1. `capabilities_list`、`project_get` 读取能力与项目 ID、revision。
2. `edit_batch` 或实体工具创建物体、角色、摄影机和镜头。编辑传 `projectId`、`expectedRevision` 与稳定的 `requestId`。
3. `camera_motion` 生成可编辑运镜关键帧，`preview_capture` 返回真实 PNG 图片。
4. 根据预览局部修正；锁定的对象或镜头必须显式解锁后才能编辑。
5. `render_start` 创建任务，使用 `render_status` 查询并下载，或 `render_cancel` 取消。

需要与当前浏览器协作时，使用 `workspace_list` 找到目标标签页，再用 `workspace_get` 读取选择、视角和播放状态，使用 `workspace_apply` 控制实际界面。`viewport_capture` 返回当前视口的真实 PNG；`scene_view_capture` 与 `contact_constraints_inspect` 不要求打开编辑器。大文件通过 `transfer_begin/chunk/status/commit/cancel` 传入。完整能力映射、参数和重试语义见 [Web 与 MCP 等价说明](docs/web-mcp-parity.md)。

例如生成推进镜头：

```json
{
  "id": "camera-reaction",
  "motion": "dolly_in",
  "start": 3.5,
  "end": 7,
  "distance": 0.5,
  "easing": "smooth"
}
```

## 数据与导出

业务数据保存在 `.data/whiteframe.sqlite`，使用 WAL 和事务。项目、历史、请求记录、资产元数据和导出任务均进入数据库。模型、音频及视频二进制文件存放于 `.data/assets/` 和 `.data/renders/`，通过数据库引用。

`WHITEFRAME_DATA_DIR` 可以修改数据目录。备份时停止服务并备份整个数据目录，或使用 SQLite 在线备份并同步二进制文件。项目 JSON 用于同一资产库内导入和恢复；跨机器迁移包含导入资源的项目时需要一并迁移资产库。

项目窗口中的“导出项目包”生成 `.whiteframe` 文件，包含项目与必需资产，并可包含编辑历史和成片。使用“恢复项目包”可在干净数据库中恢复成新项目。项目包保留独立场景、表演、镜头和历史，导入时校验 SHA256、引用与媒体。新格式按记录处理完整历史：压缩包上限 512 MiB、解压流上限 8 GiB、单条记录上限 256 MiB；超过限制会明确报错。MCP 对应 `project_package_export` / `project_package_import`，超过 MCP 输入大小限制的包使用浏览器或正式 multipart 接口上传。格式兼容和一致性说明见 [项目包](docs/project-packages.md)。

场景资源面板的“模板”页保存对象组合或当前场景与表演，模板库在 SQLite 中跨项目复用。对象组合自动包含层级、持物及约束依赖；场景模板还包含镜头、剪辑与同步关联。置入后创建独立对象 ID，后续修改不改变模板或其他实例。MCP 对应 `template_list` / `template_save` / `template_get` / `template_instantiate` / `template_update` / `template_delete`。

项目名称菜单中的“团队审片”可发布已导出的固定视频版本，创建实名审片或只读邀请，管理时间点评论、回复、解决状态和访问撤销。独立审片服务默认使用 API 端口加 100（通常为 `http://127.0.0.1:4273`）；通过 `WHITEFRAME_REVIEW_PORT`、`WHITEFRAME_REVIEW_HOST` 和 `WHITEFRAME_REVIEW_URL` 配置端口与访问地址。审片 MCP 仅开放邀请授权的成片和评论。详见 [团队审片说明](docs/team-review.md)。

导出以提交时的项目快照逐帧采样，FFmpeg 编码 H.264 / yuv420p MP4。编辑器继续修改不会改变正在导出的快照。单次导出上限为 18000 帧；队列最多等待 8 项。关闭浏览器不会停止服务端导出；服务重启后未完成任务标记失败，可重新提交。

临时对白支持“表演源时间”和“成片时间”两种基准。源时间音轨跟随片段裁切及重排；成片音轨独立连续播放。单镜头导出仅使用有确定时间映射的源时间音轨。

可选本地语音依赖：对白合成使用 macOS 系统语音或 `espeak-ng`，口型分析使用 Rhubarb。生产部署通过 `WHITEFRAME_RHUBARB_PATH` 指定 Rhubarb 可执行文件绝对路径，并保留旁边的模型资源目录。依赖未安装时，界面和 MCP 返回实际可用状态及诊断。配置与兼容边界见 [对白合成](docs/speech-synthesis.md)、[面部动画](docs/face-animation.md) 和 [音频包络](docs/audio-envelopes.md)。

使用固定的前端构建目录执行长视频任务时，可以设置 `WHITEFRAME_DIST_DIR` 指向保留的构建副本并用 `npm start` 启动。导出期间保留该目录；`tsx watch` 的服务重启仍会中断任务。四类实片的正式 MCP 导出及媒体规格核验可通过以下命令执行，`--job` 可以继续观察已知任务而不重新提交：

```sh
npx tsx scripts/production/export-film.ts --api http://127.0.0.1:4210 --project PROJECT_ID --theme racing --wait
```

该脚本调用产品的 `render_start` / `render_status`，保存真实 MP4 与 ffprobe 报告。规格检查通过后仍需完整播放及逐镜头视觉审查；实片验收状态见 `docs/full-delivery-matrix.md`。

制作与复验脚本默认在 `.data/full-delivery/productions/<theme>` 读取项目、成片及项目包并写入证据。设置 `WHITEFRAME_PRODUCTIONS_DIR` 可使用独立的验收输入与输出目录，保留原始制作记录。四片的版本、文件哈希和镜头内容见 [四片验收记录](docs/four-films.md)。

## 验证与规范

```sh
npm run check:structure
npm run format:check
npm run typecheck
npm test
npm run build
npm run test:render
npm run test:e2e
npm run test:production
```

`test:e2e` 自动启动隔离测试服务（4180 / 5180）和 `.data/e2e` 数据库，覆盖网页编辑、保存恢复、MCP 从空项目完成双人三镜头场景，以及真实 10 秒 MP4 导出。

`test:render` 使用独立端口与数据目录验证真实 MCP 图片、带声音的 240 帧 MP4、导出幂等、导出期间编辑、排队取消和运行中取消。

`test:production` 在 `npm run build` 后使用已构建前端，自动启动独立 4185 编辑器及 4285 审片服务，验证在线播放、跨场景音轨、发布与邀请，以及 1080p 竖屏和方形 MP4 的帧率、声音、审片标注及源时间裁剪。口型相关完整浏览器验收需安装 Rhubarb，语音合成验收需有对应语种的本地语音。

完整发布验证还逐项调用每个编辑工具与服务工具，检查真实项目变化、撤销、媒体与不同审片身份。`scripts/verify-release.mjs` 在冻结源码目录运行，保存日志、截图和 SDK 调用覆盖记录；缺少成功调用的已声明 MCP 工具会使验收失败。详见 [MCP 覆盖](docs/mcp-coverage.md) 和 [布光方案](docs/lighting-plans.md)。

额外视觉与渲染检查：

```sh
node scripts/visual-smoke.mjs
node scripts/thumbnail-smoke.mjs
node scripts/render-smoke.mjs
```

前两项默认使用已运行的开发服务，可通过 `WHITEFRAME_QA_URL` 修改；渲染检查自行启动隔离服务。检查产生桌面/手机截图、canvas 像素报告及视频规格报告。

工程规则见 [AGENTS.md](AGENTS.md)：严格 TypeScript、统一 Prettier 格式、按职责分模块、每个源码文件不超过 1000 行。结构检查属于构建的一部分。

## 模块

| 路径                                                       | 职责                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| `shared/`                                                  | 项目类型、Zod 校验、编辑事务、时间采样、运镜生成及示例 |
| `src/engine/`                                              | Three.js 场景、骨架、导入模型、变换工具与缩略图        |
| `src/components/`                                          | 场景、属性、导演、时间线及项目/导出窗口                |
| `server/store.ts`                                          | SQLite 持久化、历史与项目版本                          |
| `server/mcp.ts`、`server/stdio.ts`                         | MCP 协议及本地桥接                                     |
| `server/render.ts`、`server/encoder.ts`、`server/audio.ts` | 确定性渲染、视频编码及声音映射                         |
| `tests/`、`scripts/`                                       | 领域、服务、MCP、浏览器和视频验收                      |

GLTF 动画保留原模型骨架，不自动重定向到内置人形。完整目标与历史功能范围审查见 `docs/full-goal.md` 和 `docs/full-delivery-matrix.md`；当前实现及模块测试不代表四类实片与完整产品目标已经验收。
