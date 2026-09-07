# 剧本拆解

剧本拆解支持 Fountain 1.1 和结构化 JSON。解析生成可审阅草案；确认后通过 `script.apply` 创建场次、独立表演、白模人物、剧情节拍、覆盖镜头与剪辑序列。解析本身不会修改当前项目。

## Fountain

解析使用 `fountain-js` 1.2.4 的 token API，不把解析器生成的 HTML 插入界面。

```fountain
Title: 雨夜来客

.INT. 客厅 - 夜

门缓缓打开。

@林川
(低声)
你终于来了。

@苏雨
门外有人跟着我。

.EXT. 露台 - 黎明

晨光照亮屋顶。
```

标准 `INT.`、`EXT.` 等标题和以点开头的强制场景标题均可使用。中文人物通过 `@` 强制人物提示行表达。动作、人物、对白、括号表演说明和 `^` 同时对白来自解析器的结构化 token。场次地点和时段按标题的空格连字符分隔提取；可在审阅界面修正。

未识别场次、对白缺少人物、重复 ID、超出结构限制等情况产生明确诊断。转场等未自动编排元素作为诊断呈现。Fountain 注释、章节和提要不转换为表演动作。

## JSON

JSON 适合需要明确场次演员、持续时间和同时对白的输入：

```json
{
  "title": "夜间仓库",
  "characters": ["守卫", "访客"],
  "scenes": [
    {
      "id": "warehouse",
      "heading": "INT. 仓库 - 夜",
      "location": "仓库",
      "timeOfDay": "夜",
      "characters": ["守卫", "访客"],
      "items": [
        { "kind": "action", "text": "守卫在门边停下。", "durationSeconds": 4 },
        { "kind": "dialogue", "character": "守卫", "text": "谁在那里？", "durationSeconds": 3 },
        { "kind": "dialogue", "character": "访客", "text": "是我。", "durationSeconds": 2 }
      ]
    }
  ]
}
```

`characters` 在场次层声明出场人物；对白人物会自动加入该场的演员名单。条目可提供 `direction` 和 `parallelGroup`；连续条目使用相同 `parallelGroup` 时共享开始时间，整体持续时间取最长条目。未给出的持续时间按对白字数/词数或动作文字长度估计，并标记 `durationEstimated`。这些值是可调整的占位时间，不代表自动理解表演时长。

## 共享入口

- HTTP：`POST /api/script/parse`，输入 `{format:"fountain"|"json", source:string}`。
- MCP：`script_parse` 使用同一输入和解析服务，返回 `ScriptBreakdown`。
- 领域命令：`script.apply`，输入 `{breakdown, options:{sceneIds?,createCoverage?,prefix?}}`。
- MCP：`script_apply` 由同一命令注册器提供，支持版本、项目和活动场景上下文、幂等请求 ID。

`options.sceneIds` 允许选取部分场次分批应用。每次创建新的场景和表演版本，保留已有内容。`createCoverage:true` 创建全景摄影机、人物中近景摄影机及按动作/对白切换的镜头；同时对白使用同一个全景区间。关闭覆盖时每场只创建一个完整全景镜头。

默认人物站位只用于调度占位；对白生成可编辑的 `talk/idle` 时间关键帧。动作文本完整保留在剧情节拍和镜头意图中，未自动推断走位、道具、具体动作或镜头情绪。需要导演继续编排表演。

## 限制与事务

输入上限 200000 字符，结构最多 100 场、每场 500 条、单条 10000 字符，单条时长 0.1–600 秒。一次应用最多展开 500 条通用领域命令；超限返回 `SCRIPT_LIMIT` 并要求减少所选场次。解析错误会阻止相应场次应用。

整个应用经过现有命令、校验、锁定、SQLite 历史和版本机制，作为一个编辑版本与一次撤销步骤提交。失败时不会留下半个场次。所有生成对象、剧情节拍、摄影机、镜头和序列均可通过界面或 MCP 继续编辑。

## 验证

- `tests/script.test.ts`：真实 Fountain token、中文人物、同时对白、JSON 时长与诊断、场景/表演/覆盖镜头、分批应用和输入限制。
- `tests/script-service.test.ts`：HTTP/MCP 同源解析、实际协议能力发现、原子应用、幂等、SQLite 保存与一次撤销/重做。
- `tests/script.spec.ts`：实际界面审阅、时间修改、选择场次、手机布局、保存恢复和非空白 3D 画面。
