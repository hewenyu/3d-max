# 高级建模 MCP 使用说明

本接口供 AI 或脚本操作同一个白模导演编辑器。Web 与 MCP 使用共享命令、几何计算、版本校验和 SQLite 历史；工作流程结束于可编辑项目、GLB、PNG 和白模 MP4 导出。完整输入 JSON Schema 以连接后的 `listTools()` 为准，本文对应 `server/modeling-mcp.ts`、共享命令定义和本次高级建模版本。

## 连接与结果

使用 MCP SDK 的 Streamable HTTP 传输。先向本地服务的 `/api/connection` 请求连接信息，不把 token 写进日志或项目文件。以下 JavaScript 示例在项目根目录的 Node.js 环境运行，依赖已经列入 `package.json`。`WHITEFRAME_API_URL` 指向当前服务；运行后面的建模示例会新建并切换到一个独立项目。

```js
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const apiUrl = process.env.WHITEFRAME_API_URL ?? 'http://127.0.0.1:4224';
const response = await fetch(new URL('/api/connection', apiUrl));
if (!response.ok) throw new Error(`Connection discovery: HTTP ${response.status}`);
const connection = await response.json();
const client = new Client({ name: 'whiteframe-modeling-client', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
  }),
);
const catalog = await client.listTools();

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 150000 });
  const text = result.content.find((item) => item.type === 'text')?.text;
  if (result.isError) throw new Error(`${name}: ${text ?? 'MCP error'}`);
  if (text === undefined) throw new Error(`${name} returned no JSON text`);
  return JSON.parse(text);
}
let project = await call('project_get');
const guard = () => ({
  projectId: project.id,
  expectedRevision: project.revision,
  expectedContext: {
    sceneId: project.production?.activeSceneId ?? null,
    performanceId: project.production?.activePerformanceId ?? null,
  },
});
async function waitJob(job) {
  const deadline = Date.now() + 180000;
  while (job.status === 'queued' || job.status === 'running') {
    if (Date.now() > deadline) {
      await call('modeling_job_cancel', { id: job.id });
      throw new Error(`Modeling wait exceeded deadline: ${job.id}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    job = await call('modeling_job_status', { id: job.id });
  }
  if (job.status !== 'completed') throw new Error(JSON.stringify(job.error ?? job.status));
  return job.result;
}
async function commands(values) {
  const result = await waitJob(
    await call('modeling_job_start', {
      ...guard(),
      requestId: randomUUID(),
      kind: 'commands',
      commands: values,
    }),
  );
  project = result.project;
  return result;
}
```

普通工具返回 MCP `text` 内容块中的 JSON；先检查 `isError`。PNG 捕获返回 `image` 内容块，不能用上面的 JSON-only `call` 帮助函数读取。结构化错误为 `{error:{code,message,details?}}`；异步失败保存在任务的 `error` 中。

## 版本、上下文与任务

编辑命令使用 `projectId`、`expectedRevision`、`expectedContext:{sceneId,performanceId}` 和 `requestId`。`project_get` 返回当前项目，编辑成功返回 `{project,results}`；后续请求使用返回的新 revision。读取组件也需要项目、版本、上下文，但 `mesh_inspect` 和 `mesh_selection_query` 没有 `requestId`。

| MCP 工具                 | 关键输入                                                                                              | 结果与 Web 对应                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `modeling_job_start`     | 编辑 guards，`kind:"commands"`，`commands:[{type,payload}]`，1 至 200 条                              | 原子命令批次；Web 建模操作使用同一任务接口                        |
| `modeling_inspect_start` | 编辑 guards，必须带 `kind:"inspect"`，`objectId`，`stage`，`componentKind`，分页                      | 源或求值网格诊断任务                                              |
| `model_conversion_start` | 编辑 guards，必须带 `kind:"conversion"`，`objectId`                                                   | 静态 GLB/glTF 转换方案；Web 导入模型转换                          |
| `model_export_start`     | 编辑 guards，必须带 `kind:"export"`，`scope`，可选 `objectIds`、`sourceTime`、`includeHidden`、`name` | 实际 GLB 文件；Web 模型导出                                       |
| `modeling_job_status`    | `id`                                                                                                  | 持久化任务及完成结果                                              |
| `modeling_job_list`      | 可选 `projectId`                                                                                      | 最近 200 个任务的摘要，结果正文通过 status 读取                   |
| `modeling_job_cancel`    | `id`                                                                                                  | 取消排队任务或终止活动 Worker；终态任务保持原状态                 |
| `mesh_inspect`           | 读取 guards，`objectId`，`stage`，`kind`，分页                                                        | 等待 Worker 后返回组件页；注意这里是 `kind`，不是 `componentKind` |
| `mesh_selection_query`   | 读取 guards，`objectId`，`selection`                                                                  | 解析、连通、环、扩展、收缩或反选组件                              |
| `model_conversion_plan`  | 读取 guards，`objectId`                                                                               | 等待同一 Worker 服务后返回方案                                    |
| `model_export`           | 读取 guards及导出参数                                                                                 | 等待同一 Worker 服务后返回 GLB 资产                               |

HTTP 对应为 `POST /api/modeling/jobs`、`GET /api/modeling/jobs`、`GET /api/modeling/jobs/:id` 和 `POST /api/modeling/jobs/:id/cancel`。直接等待结果的旧入口为 `/api/modeling/inspect`、`/selection`、`/conversion`、`/export`，均为 POST。

任务状态为 `queued`、`running`、`completed`、`failed`、`cancelled`。`progress.phase` 为 `queued/starting/computing/committing/finished`；命令进度报告实际 `completedCommands/totalCommands`。资产任务另外报告 `progress.asset:{stage,completed,total}`，stage 为 `reading/geometry/encoding/storing`。GLB 编码期间进度不会伪造连续百分比。

开始任务时 SQLite 保留不可变项目快照、请求、哈希及资产清单；命令、转换方案和 GLB 发布前重新检查版本与上下文。检查任务返回其捕获版本的只读诊断，即使当前项目后来改变；使用该选择编辑前必须确认 revision。冲突时读取最新项目并重新检查组件，不把旧结果强行写回。

同一个项目内，完全相同的 `requestId` 和输入返回同一任务；更换输入而复用 ID 报 `IDEMPOTENCY_CONFLICT`。失败或取消后的新尝试使用新 ID。服务重启把未完成任务标为 `MODELING_INTERRUPTED`，已完成结果仍可读取和重放。单服务最多 8 个未完成任务、一个计算 Worker，快照 64 MiB、请求 32 MiB、结果 128 MiB、合计预留 256 MiB，执行超时 120 秒，Worker 老生代堆上限 512 MiB。

## 组件建模

`mesh_inspect` 支持 `stage:"source"|"evaluated"`，`kind:"vertex"|"edge"|"face"`，`offset` 和 `limit`（1 至 2000，默认 200）。结果包含 `namespace`、`editable`、稳定 ID、位置、法向、邻接、`bounds`、`diagnostics` 和 `nextOffset`；连续读取直到 `nextOffset:null`。坐标为对象局部米，Y 向上，旋转为 XYZ 度。

可编辑选择形如 `{namespace,kind,ids}`。源必须是 mesh，也可以是修改器栈内的 mesh base；求值阶段 ID 只用于观察。拓扑变化后读取返回的组件映射或重新 inspect，不能继续按旧数组下标选面。`mesh_selection_query` 的 selection 另带 `operation:"replace"|"connected"|"loop"|"ring"|"grow"|"shrink"|"invert"`，可选 `steps`。

下表的编辑输入还需要目标 `id` 和编辑 guards。批次内命令名使用点，例如 `topology.extrude`；单独 MCP 工具名只把点替换为下划线，连字符保持原样。

| MCP 工具             | 操作参数与边界                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topology_transform` | `selection`；`translation/rotation/scale` 或 16 元素 `matrix`；`space:local/world/normal`，`pivotMode:median/bounds/origin/active/custom`，可选 `pivot`、`snap`、`proportional:{radius,falloff,connected?}`；world 使用基础姿态 |
| `topology_extrude`   | 面 selection，`distance`，`mode:region/individual`，可选局部 `direction`                                                                                                                                                        |
| `topology_inset`     | 面 selection，正 `thickness`，可选 `depth`、`mode`；保留孔洞，拒绝交叉偏移                                                                                                                                                      |
| `topology_bevel`     | 可选边 selection，`width`、`segments:1..16`、`shape:0..1`；支持一致朝向的闭合凸壳                                                                                                                                               |
| `topology_split`     | 面 selection，`mode:boundary/individual`                                                                                                                                                                                        |
| `topology_delete`    | selection；点或边需明确 `incidentFaces:reject/delete`；可选 `removeLooseVertices`                                                                                                                                               |
| `topology_merge`     | 点 selection，`target:first/center/cursor`；cursor 配 `position`；`collapseFaces:remove/reject`                                                                                                                                 |
| `topology_fill`      | 完整共面边界环 selection；可选 `triangulate`，嵌套环保留孔洞                                                                                                                                                                    |
| `topology_bridge`    | 两个边数相等且不相交的完整边界环；`segments:1..64`、整数 `twist`                                                                                                                                                                |
| `topology_weld`      | selection，正 `tolerance`，`position:first/center`                                                                                                                                                                              |
| `topology_dissolve`  | 共面内部边或共线二价点 selection                                                                                                                                                                                                |
| `topology_loop-cut`  | 恰好一个种子边 ID，`cuts:1..32`，`-1 < slide < 1`；沿四边形条带切分                                                                                                                                                             |
| `topology_slide`     | 内部边链或其顶点 selection，`-1 < amount < 1`                                                                                                                                                                                   |
| `topology_bisect`    | 局部平面 `normal`、`offset`，`keep:both/positive/negative`，`fill`、可选 `tolerance`                                                                                                                                            |
| `topology_repair`    | 可选 selection；`removeDegenerateFaces`、`removeDuplicateFaces`、`removeLooseVertices`、`orientFaces:consistent/outward`                                                                                                        |

`topology_loop_cut` 不是注册工具。实际名称是 **`topology_loop-cut`**，批次名称为 **`topology.loop-cut`**。

以下示例接续前面的 SDK 初始化，创建可编辑盒子，读取朝上的源面并挤出。示例每次写入使用最新 revision。

```js
project = await call('project_new', { name: 'MCP modeling example', template: 'empty' });
await commands([
  {
    type: 'object.create',
    payload: {
      id: 'example-body',
      name: 'Editable body',
      type: 'box',
      dimensions: [2, 1, 2],
    },
  },
  { type: 'mesh.convert', payload: { id: 'example-body' } },
]);
const page = await call('mesh_inspect', {
  ...guard(),
  objectId: 'example-body',
  stage: 'source',
  kind: 'face',
  offset: 0,
  limit: 200,
});
const top = page.elements.find((face) => face.normal?.[1] > 0.9);
if (!top) throw new Error('No upward-facing source polygon');
await commands([
  {
    type: 'topology.extrude',
    payload: {
      id: 'example-body',
      selection: { namespace: page.namespace, kind: 'face', ids: [top.id] },
      distance: 0.6,
      mode: 'region',
    },
  },
]);
```

## 曲面与修改器

`surface_set({id,surface,...guards})` 建立保留曲线源的 `sweep`、`revolve` 或 `loft`。公共字段为 `kind:"surface"`、`segments`（1 至 256）、`profileSegments`（1 至 64）、`caps`、`thickness`、`smooth`。Bezier 控制点为 `{position,inTangent?,outTangent?}`，切线是相对于控制点的局部向量。

- sweep：三维 `path:{points,closed}` 和二维 `profile:{outer,holes}`；outer 和每个 hole 都是闭合曲线。
- revolve：二维 `profile:{points,closed}`，x 为半径、y 为高度；绕 Y 轴，`angle` 默认 360，`startAngle` 默认 0。
- loft：2 至 64 个 `sections:[{profile,position,rotation}]`，`interpolation:linear/centripetal`，可选 `closed`。

曲面厚度是向内的法向/miter 壳，保留外表面。非法轮廓、尖点、自交、截面不兼容或容量溢出会原子失败。`mesh_convert` 显式烘焙为可编辑网格；导入 GLB 使用下面的转换任务。

修改器入口为 `modifier_add({id,modifier,index?})`、`modifier_set({id,modifier})`、`modifier_remove({id,modifierId})`、`modifier_reorder({id,modifierId,index})`、`modifier_bake({id})`，均加编辑 guards。`modifier_set` 按稳定 modifier ID 替换完整参数；`enabled:false` 保留配置但跳过求值。栈按顺序执行，最多 16 项，bake 可撤销。

| modifier.type   | 关键参数                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `boolean`       | `operandId`、`operation:union/subtract/intersect`；引用操作数的求值几何及基础层级变换，支持隐藏操作数；每个操作数最多 30000 三角形，拒绝循环依赖 |
| `bevel`         | `width`、`segments:1..16`、`shape:0..1`；闭合凸壳，超宽、凹壳和开边界报诊断                                                                      |
| `mirror`        | `axis`、`offset`、`keepOriginal`、可选 `weldThreshold`                                                                                           |
| `array`         | `count:2..32`、三维 `offset`                                                                                                                     |
| `curve-array`   | 三维 `points`、`closed`、`count:2..32`、`axis`、`orient`                                                                                         |
| `subdivision`   | Loop 三角细分，`iterations:1..3`、`preserveEdges`、`flatOnly`                                                                                    |
| `catmull-clark` | `iterations:1..3`、`boundary:smooth/corners`                                                                                                     |
| `solidify`      | 正 `thickness`、`offset:-1..1`                                                                                                                   |
| `bend`          | `axis`、不同的 `direction`、`angle:-180..180`、`from`、`to`                                                                                      |
| `twist`         | `axis`、`angle:-720..720`、`from`、`to`                                                                                                          |

每项修改器还需要唯一 `id`；距离为局部米。非破坏 Boolean 修改器保留操作数关系，与旧的破坏式 `mesh_boolean` 不同。Web 的曲面参数、修改器列表和组件建模面板调用同一共享命令。

## 转换、GLB 与视频

GLB/glTF 先经 `asset_import` 或分片 transfer 入库，再以 `object_create` 的 `type:"model"` 和返回的 `assetUrl` 建立对象。`model_conversion_start` 只产生方案，结果包括 `mesh`、`revision`、`context`、原始资产及 `diagnostics`；用方案的版本与上下文调用 `mesh_set` 才写入对象。原文件保留为 `sourceAssetUrl`，包括无历史项目包。静态转换明确报告材质、纹理、UV 等属性的省略，并拒绝动画、骨骼和不支持的扩展，不能把静态转换当作姿态烘焙。

模型导出参数 `scope:"selection"|"scene"`。selection 必须提供非空 `objectIds`，包括所选对象的后代；scene 不接受 objectIds。`sourceTime` 默认 0，`includeHidden` 默认 false。输出为该源时刻、世界坐标下的求值几何，含修改器结果；角色/车辆 rig、效果和骨骼附着不支持静态导出，会报告具体对象。导出不改变可编辑源。

```js
const glb = await waitJob(
  await call('model_export_start', {
    ...guard(),
    requestId: randomUUID(),
    kind: 'export',
    scope: 'selection',
    objectIds: ['example-body'],
    sourceTime: 0,
    name: 'example-body',
  }),
);
console.log({
  url: new URL(glb.url, apiUrl).href,
  sha256: glb.sha256,
  bytes: glb.bytes,
  vertices: glb.vertices,
  triangles: glb.triangles,
});

await commands([
  {
    type: 'camera.create',
    payload: {
      id: 'example-camera',
      name: 'Moving inspection',
      position: [5, 4, 6],
      target: [0, 1, 0],
      fov: 43,
      keyframes: [
        { id: 'camera-start', time: 0, position: [5, 4, 6], target: [0, 1, 0], fov: 43, easing: 'linear' },
        { id: 'camera-end', time: 6, position: [-5, 3, 6], target: [0, 1, 0], fov: 43, easing: 'linear' },
      ],
    },
  },
  {
    type: 'shot.create',
    payload: {
      id: 'example-shot',
      name: 'Inspection',
      cameraId: 'example-camera',
      sourceIn: 0,
      sourceOut: 6,
      subjectIds: ['example-body'],
    },
  },
]);
const preview = await client.callTool({
  name: 'preview_capture',
  arguments: {
    shotId: 'example-shot',
    time: 3,
    width: 1280,
    height: 720,
  },
});
if (preview.isError) throw new Error(JSON.stringify(preview.content));
const png = preview.content.find((item) => item.type === 'image');
if (!png) throw new Error('Preview returned no PNG');

let video = await call('render_start', {
  projectId: project.id,
  expectedRevision: project.revision,
  requestId: randomUUID(),
  shotId: 'example-shot',
  fps: 24,
  resolution: 720,
  aspect: '16:9',
  includeAudio: false,
  burnIn: false,
});
const deadline = Date.now() + 30 * 60 * 1000;
while (['queued', 'rendering', 'encoding'].includes(video.status)) {
  if (Date.now() > deadline) {
    await call('render_cancel', { id: video.id });
    throw new Error(`Video wait exceeded deadline: ${video.id}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  video = await call('render_status', { id: video.id });
}
if (video.status !== 'completed') throw new Error(JSON.stringify(video.error ?? video.status));
console.log({ downloadUrl: video.downloadUrl, playbackUrl: video.playbackUrl });
await client.close();
```

`render_start` 选择 `shotId` 或 `sequenceId`，两者不可同时传入；支持 720p/1080p、1 至 60 fps、16:9/9:16/1:1。`preview_capture` 的镜头 time 相对于 `sourceIn`；序列捕获使用剪辑时间。视频任务使用 `render_status({id})` 查询；不带 id 时返回最近 100 个任务，可按 `options.projectId` 筛选。**没有 `render_list` 工具。** 完成任务提供下载和原生播放器 URL。

`project_package_export({projectId,includeHistory:true,includeVideos:true})` 生成可下载项目包。恢复包使用 `project_package_import`，小文件 `dataBase64` 编码最大 32 MiB；大包使用 `transfer_begin({kind:"project-package",name,size,sha256,requestId})`、`transfer_chunk({id,index,dataBase64,sha256})`、`transfer_status({id})`、`transfer_commit({id})`。包上限 512 MiB，资产上限 100 MiB，分片会话可跨服务重启恢复。

## 操作已打开的 Web

无浏览器时可以建模、检查、捕获和渲染。要同步真实 Web 的组件选区，先 `workspace_list` 获取明确的 `workspaceId`，再调用 `workspace_get` 或 `workspace_apply`。后者需要 `workspaceId`、`projectId`、`expectedRevision`、`requestId`，可带 `expectedWorkspaceRevision`；command 示例：

```json
{
  "type": "components",
  "objectId": "example-body",
  "mode": "face",
  "tool": "box",
  "xray": false,
  "display": "solid-wire"
}
```

指定选区时加入 `selection:{namespace,kind:"face",ids,operation:"replace"}`，ID 来自最新的源检查结果。工作区状态控制 Web 模式、选区、观察视角和辅助层；实际几何修改仍通过 topology 命令提交。`viewport_capture` 返回真实 Web 视口；`scene_view_capture` 无需已打开的编辑器，按显式 source/shot/sequence 上下文返回 PNG、观察相机和渲染变换，完整参数见其 Schema。

## 已执行的端到端入口

`scripts/modeling-assets/client.ts` 封装真实 SDK 调用、版本 guards、任务等待、PNG/GLB/MP4 下载及哈希记录。四个 `vehicle.ts`、`mechanical.ts`、`architecture.ts`、`curved-prop.ts` 制作脚本使用这些正式工具，没有独立建模后门。`verify-restoration-suite.ts` 启动独立冻结服务，完成项目包导入、实际进程重启、修改/撤销/重做、GLB/PNG 比对、新 MP4、完整原生播放及下载核对；报告路径见 [验收证据](advanced-modeling-evidence.md) 和 [旧作品兼容性](advanced-modeling-compatibility.md)。
