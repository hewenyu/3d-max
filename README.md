# 白场 Whiteframe

面向导演的 Web 3D 白模预演工作台。人工和外部 AI 共用场景、角色、动作、摄影机与剪辑状态，最终导出白模 MP4 视频。产品流程到视频导出为止。

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

具体配置字段以所使用的 MCP 客户端为准。服务默认监听本机回环地址，HTTP MCP 使用 Bearer 令牌；当前版本没有公网协作和远程账户系统。

推荐调用顺序：

1. `capabilities_list`、`project_get` 读取能力与项目 ID、revision。
2. `edit_batch` 或实体工具创建物体、角色、摄影机和镜头。编辑传 `projectId`、`expectedRevision` 与稳定的 `requestId`。
3. `camera_motion` 生成可编辑运镜关键帧，`preview_capture` 返回真实 PNG 图片。
4. 根据预览局部修正；锁定的对象或镜头必须显式解锁后才能编辑。
5. `render_start` 创建任务，使用 `render_status` 查询并下载，或 `render_cancel` 取消。

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

导出以提交时的项目快照逐帧采样，FFmpeg 编码 H.264 / yuv420p MP4。编辑器继续修改不会改变正在导出的快照。单次导出上限为 18000 帧；队列最多等待 8 项。关闭浏览器不会停止服务端导出；服务重启后未完成任务标记失败，可重新提交。

临时对白支持“表演源时间”和“成片时间”两种基准。源时间音轨跟随片段裁切及重排；成片音轨独立连续播放。单镜头导出仅使用有确定时间映射的源时间音轨。

## 验证与规范

```sh
npm run check:structure
npm run format:check
npm run typecheck
npm test
npm run build
npm run test:e2e
```

`test:e2e` 自动启动隔离测试服务（4180 / 5180）和 `.data/e2e` 数据库，覆盖网页编辑、保存恢复、MCP 从空项目完成双人三镜头场景，以及真实 10 秒 MP4 导出。

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

首版使用组件组合建模和简单骨架表演。精细拓扑、雕刻、面部动画、复杂接触 IK、物理模拟及自动剪辑判断仍属于后续能力；GLTF 动画保留原模型骨架，不自动重定向到内置人形。
