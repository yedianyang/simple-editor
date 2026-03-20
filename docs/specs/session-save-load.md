# Spec: Session Save/Load

> Date: 2026-03-19
> Status: Approved

---

## Overview

实现 FieldCorder session 的保存和加载功能。Session 文件 (`.fcs`) 存储轨道布局、clip 位置、效果器参数等状态，音频文件以路径引用方式存储（不嵌入音频数据）。

## 文件格式

- 扩展名: `.fcs` (FieldCorder Session)
- 内部格式: JSON
- 编码: UTF-8

## 音频文件引用

- 存储**相对路径**（相对于 .fcs 文件位置）+ **绝对路径** fallback
- 打开时优先用相对路径解析，失败则尝试绝对路径，都失败则弹提示让用户重新定位

## 保存内容

| 数据 | 保存 |
|------|------|
| 轨道列表（名称、颜色、通道数） | Yes |
| Clip 位置、trim、fade、crossfade | Yes |
| Clip gain | Yes |
| 轨道 volume / pan / mute / solo | Yes |
| 效果器插件链 + 参数 | Yes |
| Playhead 位置 | Yes |
| 会话采样率 | Yes |
| 会话元数据 (BWF/iXML/UCS) | Yes |
| 文件浏览器当前路径 | Yes |
| Undo 历史 | No |
| 缩放级别 / 滚动位置 / 轨道高度 | No（未开发，后续加） |

## 快捷键

| 操作 | 快捷键 |
|------|--------|
| 保存 session | Cmd+S |
| 另存为 | Cmd+Shift+S |
| 新建 session | Cmd+N |
| 打开 session | 仅菜单（File → Open Session）+ 文件浏览器双击 .fcs |
| 导入音频 | Cmd+Shift+I（原 Cmd+O） |

## 保存行为

- **首次保存 (Cmd+S)**: 弹系统"另存为"对话框让用户选位置和文件名
- **后续保存 (Cmd+S)**: 直接覆盖保存，不弹对话框
- **另存为 (Cmd+Shift+S)**: 始终弹对话框
- **自动保存**: 暂不实现，未来在设置窗口中配置

## 未保存修改提示

以下操作触发 "是否保存当前 session？" 对话框（Save / Don't Save / Cancel）：
- 新建 session (Cmd+N)
- 打开另一个 session
- 关闭 app

## 打开 session

- **菜单**: File → Open Session → 弹系统文件选择器（过滤 `.fcs`）
- **文件浏览器**: 双击 `.fcs` 文件
- 打开时加载 JSON → 解析 → 重建 timeline → 加载音频文件 → 重建效果器链

### 音频文件加载失败处理

1. 尝试相对路径
2. 失败 → 尝试绝对路径
3. 都失败 → 弹提示 "找不到文件 X，是否重新定位？" → 用户选新位置 → 更新引用

## MAS 沙盒

- 使用 Tauri security scope 持久化之前用户授权过的文件路径
- session 打开时自动恢复 scope，确保引用的音频文件可访问

## Session 文件结构（JSON Schema 草案）

```json
{
  "version": 1,
  "appVersion": "1.0.0",
  "sampleRate": 48000,
  "playheadSample": 0,
  "fileBrowserPath": "/Users/xxx/recordings",
  "metadata": {
    "project": "...",
    "scene": "...",
    "take": "...",
    "...": "..."
  },
  "audioFiles": [
    {
      "id": "af-1",
      "relativePath": "../recordings/interview.wav",
      "absolutePath": "/Users/xxx/recordings/interview.wav",
      "sampleRate": 48000,
      "channels": 2,
      "numSamples": 480000
    }
  ],
  "tracks": [
    {
      "id": "t-1",
      "name": "Interview",
      "color": "#4A90D9",
      "channels": 2,
      "volume": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "clips": [
        {
          "id": "c-1",
          "audioFileId": "af-1",
          "bufferChannelIndices": [0, 1],
          "timelineOffset": 0,
          "sourceStart": 0,
          "sourceEnd": 480000,
          "duration": 480000,
          "gainDb": 0,
          "fadeInSamples": 0,
          "fadeOutSamples": 0,
          "fadeInCurve": 0,
          "fadeOutCurve": 0,
          "crossfadeInSamples": 0,
          "crossfadeOutSamples": 0,
          "crossfadeType": "equalPower",
          "muted": false,
          "reversed": false
        }
      ],
      "inserts": [
        {
          "pluginId": "eq7",
          "bypassed": false,
          "params": { "band1Freq": 200, "band1Gain": 3.5, "..." : "..." }
        }
      ]
    }
  ]
}
```

**注意**: `audioFiles` 数组存储去重的音频文件列表。Clip 通过 `audioFileId` + `bufferChannelIndices` 引用具体声道。这样同一个音频文件被多个 clip 引用时只存一份路径。
