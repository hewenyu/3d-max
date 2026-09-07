# 画面转场

镜头序列支持淡入、淡出和交叉溶解。时间线选中片段后打开“画面转场”，可编辑转场秒数、查看相邻素材余量。UI 和 MCP 执行同一个 `clip.transition` 命令，保留工程历史、撤销和版本检查。

## 时间契约

- `SequenceClip.fadeIn`、`fadeOut`：成片秒数，在片段自己的头部或尾部线性从黑场淡入、淡出至黑场。
- `transitionIn: { type: "dissolve", duration }`：连接前镜头与本镜头，以原切点为中心，前后各占 `duration / 2` 秒。
- 转场不改变序列总时长、片段源入出点或速度曲线；单镜头导出和指定源时间预览不包含序列转场。
- 溶解期间两个镜头都按各自源时间继续运动。越过片段裁剪边界后，源时间按速度曲线端点的速度延伸；独立相机时钟保持其设置的速度。
- 延伸区域必须位于相应 `Shot.sourceIn..sourceOut` 内。缺少素材余量、独立相机时间越界、转场窗口重叠时，命令原子拒绝，不使用冻结尾帧填充。
- 首片段不能设置前镜头溶解。同一边界不能同时使用黑场淡化和交叉溶解。分割片段仅将原有头部转场保留给左片段、尾部淡出保留给右片段。
- 音轨淡化独立设置，画面转场不会自动修改声音时钟或音轨包络。

例如两个镜头的源范围均为 `0..6` 秒，剪辑片段均取 `1..5` 秒，序列总长为 8 秒。在第二片段设置 1 秒溶解后，切点仍为第 4 秒，溶解范围为 `3.5..4.5` 秒；前镜头采样 `4.5..5.5` 秒，后镜头采样 `0.5..1.5` 秒。

## MCP

```json
{
  "name": "clip_transition",
  "arguments": {
    "projectId": "project-id",
    "expectedRevision": 12,
    "sequenceId": "sequence-id",
    "clipId": "incoming-clip-id",
    "fadeIn": null,
    "transitionIn": { "type": "dissolve", "duration": 1 }
  }
}
```

省略字段保留原值；传入 `null` 删除该设置。黑场淡入、淡出分别通过 `fadeIn`、`fadeOut` 设置。镜头或剪辑方案锁定时拒绝编辑；修改溶解同时检查前镜头锁定状态。

## 渲染与验证

`shared/transitions.ts` 负责源时间和混合权重。`SceneEngine` 在实时镜头预览及确定性导出中共同使用该采样。`TransitionRenderer` 将各镜头实际完成景深、色调映射后的画面复制到 GPU 纹理，再以显示像素线性混合，黑场淡化使用同一合成过程。没有 DOM 或 CSS 画面覆盖。

`tests/transitions.test.ts` 覆盖真实素材余量、变速端点、独立相机时钟、跨场景绑定、原子拒绝和分割规则。`tests/transitions.spec.ts` 检查实际 WebGL 像素、景深、重复采样一致性、实时预览与导出 PNG 一致性、桌面及移动端编辑、正式 MCP 修改/撤销，以及实际 8 秒、720p、24 fps MP4 的解码、画面对比和完整播放。
