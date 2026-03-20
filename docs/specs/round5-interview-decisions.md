# Spec: Round 5 — Interview Decisions (2026-03-17)

> Status: Approved
> Scope: Clip container model revision, crossfade visual, sample rate handling, export format, file browser marking

---

## 1. Clip 容器模型修订

**覆盖 `clip-group.md` 和 `multichannel-tracks.md` 中的部分设计。**

### 核心规则

- 立体声轨道上的立体声 clip 是**一个对象**（不是 2 个独立 clip）
- 显示为 L/R 两条波形（视觉上分开），但所有操作作为整体
- **通道数严格匹配**：单声道 clip 不允许放到立体声轨道，反之亦然
- 4ch/6ch 同理——clip 通道数必须等于轨道通道数

### 拆分规则（立体声 → 单声道）

将立体声 clip 拖到单声道轨道时：
- 有 2 个单声道轨道 → L/R 分别放入
- 只有 1 个单声道轨道 → 自动在底部创建第二个空白单声道轨道，分别放入

### 合并规则（单声道 → 立体声）

- 选中 2 个单声道 clip → 右键 "Merge to stereo track" → 合并为一个立体声 clip

### 不允许的操作

- 单声道 clip 拖入立体声轨道 → 拒绝（视觉提示，clip ghost 变红）
- 立体声 clip 拖入单声道轨道 → 触发拆分流程（见上）
- 通道数不匹配且无法拆分的情况 → 拒绝

### 与现有 spec 的冲突

| 现有 spec 描述 | 新决策 |
|---------------|--------|
| `multichannel-tracks.md` 2.1: Mono file → stereo track 按 Y 位置分配 subChannel | **删除** — 不允许通道数不匹配 |
| `multichannel-tracks.md` 2.3: clip 在多声道轨道内可通过 Y 改变 subChannel | **删除** — clip 是整体，无 subChannel 概念 |
| `clip-group.md`: groupId 绑定多个独立 clip | **替换** — 不再是多个 clip + groupId，而是一个多声道 clip 对象 |

### 数据模型变更

```typescript
// 旧模型：多个 clip + groupId
interface Clip {
  groupId?: string;
  subChannel?: number;
  // ...
}

// 新模型：一个 clip 包含多声道数据
interface Clip {
  id: string;
  bufferIds: string[];        // 每个声道一个 buffer, length = track.channels
  name: string;
  timelineOffset: number;
  sourceStart: number;
  sourceEnd: number;
  duration: number;
  gainDb: number;
  fadeInSamples: number;
  fadeOutSamples: number;
  muted: boolean;
  reversed?: boolean;
  // 移除: groupId, subChannel
}
```

---

## 2. Crossfade 视觉

- Crossfade 区域内，两个 clip 的波形**重叠显示**（半透明叠加）
- 前一个 clip 延伸进来，后一个 clip 也延伸进来（Pro Tools 风格）
- 不是两个独立的 fade out + fade in 的视觉

---

## 3. 采样率处理

### 导入流程

1. 导入文件采样率 ≠ session 采样率 → 弹出确认对话框
2. 对话框内容：明确提示"文件为 XkHz，session 为 YkHz，将转换采样率"
3. 点确定 → 在导入时执行重采样，结果写入**临时缓存文件**
4. 点取消 → **不导入**（修复当前 bug：cancel 仍导入）

### 缓存策略

- 缓存位置：session 文件旁的隐藏目录 `.fieldcorder-cache/`
- 缓存清除时机：
  - 导出完成后
  - Session 标记为已完成
  - 音频文件标记为已完成（Finished）

---

## 4. 导出格式

### 通道配置

- 默认：**Stereo** (L R)
- 可选：
  - **4.0**: L R LS RS
  - **5.1**: L C R LS RS LFE
- 导出界面提供格式选择下拉

### Channel Names

- BWF 标签页显示 channel name 输入框
- 输入框数量 = 所选导出格式的通道数
- 编辑后写入 iXML trackList

### Pan/Routing

- 暂未设计（pin pot + 通道出口待后续）
- 当前所有轨道默认 downmix 到 stereo 导出

---

## 5. 文件浏览器标记系统

### 标记状态（固定三种）

- **Unprocessed** — 未处理
- **Processing** — 处理中
- **Finished** — 已完成

### 交互

- **单击**标记圈圈 → 切换标记状态
- **右键菜单**中也有标记选项
- 标记圈圈区域**不触发双击创建新工程**（修复当前 bug）

### 持久化

- 主方案：源文件旁写 sidecar 文件 `.fieldcorder-meta`
- Fallback（只读位置写不了 sidecar 时）：存入 session 文件

### 标记对象

- 标记在文件浏览器的**源文件**上，不是 session 内的 clip

---

## 6. 搁置项

- **Inspector File Info 显示逻辑** — 低优先级，未来处理

---

## Bug 修复清单（Round 4 测试发现）

| Bug | 描述 | 关联 |
|-----|------|------|
| B1 | 采样率 Cancel 仍导入文件 | §3 |
| B2 | 播放中改变 Solo 不生效 | 独立 bug |
| B3 | Crossfade 不把立体声当整体 | §1 (容器模型) |
| B4 | Undo 逐声道恢复 | §1 (容器模型) |
| B5 | Fade 曲线垂直拖动无变化 | 独立 bug |
| B6 | Crossfade 视觉不像真正 cross | §2 |
| B7 | Channel Names 无输入框 | §4 |
| B8 | 文件浏览器标记圈误触发双击 | §5 |
