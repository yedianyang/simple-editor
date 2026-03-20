# Clip Group Spec

> **SUPERSEDED — 2026-03-17**
>
> This spec is no longer valid. The `groupId` / `subChannel` design has been replaced by the
> Clip Container Model described in `round5-interview-decisions.md` (§1) and reflected in the
> updated `multichannel-tracks.md`.
>
> **Summary of what changed:**
> - `Clip.groupId` and `Clip.subChannel` have been removed from the data model.
> - A multi-channel file (stereo / quad / 5.1) now creates **one** `Clip` object with
>   `bufferIds: string[]` (one buffer ID per channel), not N separate clips linked by a group ID.
> - All operations (move, trim, fade, split, delete, undo) operate on the single clip object.
>   There is no group synchronization layer needed.
> - Cross-track split/merge operates by slicing or concatenating the `bufferIds` array.
>
> **Do not implement anything from the section below.** It is preserved for historical reference only.

---

## [ARCHIVED] Original Spec

### Overview
同一文件导入到多声道轨道时，各 sub-channel clip 绑定为一组（clip group），所有操作自动同步。

### 数据模型
- Clip 接口新增 `groupId?: string`
- 导入多声道文件时，所有 sub-channel clips 共享同一 groupId
- groupId 格式: `"g-{nanoid}"` 或类似唯一 ID

### 同步操作
以下操作作用于 group 内所有 clips：
- Move（位置）
- Trim Start / End
- Fade In / Out
- Split (S key)
- Delete
- Select（点击任一 → 选中整组）

**独立操作**（不同步）：
- Clip Gain — 各声道独立调节

### 跨轨道拆分
| 源 | 目标 | 行为 |
|---|---|---|
| Stereo (2ch) | 2x Mono | L→Mono1, R→Mono2, 解除 group |
| Quad (4ch) | 2x Stereo | ch0+ch1→Stereo1, ch2+ch3→Stereo2, 各对形成新 group |
| Quad (4ch) | 4x Mono | 各 ch→各 Mono, 解除 group |

### 跨轨道合并
- 2个 Mono clip 拖入 Stereo 轨道 → 合并为新 group
- 合并后保留各自原有 Clip Gain

### 不兼容拖拽
- Mono → Stereo 轨道：拒绝（前端视觉提示，不弹对话框）
- 提示方式：ghost clip 变红或不显示

### 覆盖规则
- 目标轨道已有 clip 时：叠加覆盖，被盖部分自动 trim（Pro Tools 行为）

### 拆分后原轨道
- 保留为空轨道（不自动删除）

### Undo
- 拆分/合并操作完整支持 undo
- Undo 恢复原 groupId、原轨道、原位置

### Filename 自动填充（独立于 clip group）
- UCS 字段变化 → 自动更新 filename
- 用户手动编辑 → 锁定
- 用户再次修改 UCS → 解锁，重新填充
