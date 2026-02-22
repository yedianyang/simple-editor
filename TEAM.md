# TEAM.md — FieldCorder 团队状态

## 当前状态

✅ **功能升级完成** — 多 Track 时间线 + 声能图 + UI 布局重构（全部 14 个任务已完成）

## 团队分工（已完成）

| 角色 | 模型 | 完成任务 | 状态 |
|------|------|----------|------|
| **main** (Team Lead) | Opus 4.6 | 协调、分配、追踪、代码审查 | ✅ 完成 |
| **generator** | Opus 4.6 | #1 types, #2 BufferPool, #3 TimelineModel, #4 UndoManager, #5 AudioEngine, #11 Rust scan_folder, #12 Mixer | ✅ 7 任务完成 |
| **template** | Opus 4.6 | #7 STFT Worker, #8 SonogramRenderer, #6 TimelineRenderer, #13 App.ts 集成 | ✅ 4 任务完成 |
| **designer** | Opus 4.6 | #9 HTML 重构, #10 CSS 样式, 视觉一致性审查 | ✅ 3 任务完成 |
| **docs** | Sonnet 4.5 | UI 框图文档 (docs/ui-wireframe.md) | ✅ 完成 |

## 任务依赖图

```
                    ┌──────────┐
           ┌───────│ #1 types │───────┐
           │       └──────────┘       │
           ▼                          ▼
    ┌──────────────┐          ┌───────────────┐
    │ #2 BufferPool│          │ #3 TimelineModel│
    └──────┬───────┘          └───────┬────────┘
           │                          │
           │                          ▼
           │                  ┌────────────────────┐
           │                  │ #4 TimelineUndoMgr  │
           │                  └────────────────────┘
           │
           ▼
    ┌──────────────────────────┐     ┌──────────────┐     ┌──────────┐
    │ #5 AudioEngine (Fader/XF)│     │ #7 STFT Worker│     │ #9 HTML  │
    └──────┬───────────────────┘     └──────┬───────┘     └────┬─────┘
           │                                │                   │
           ├──────────┐                     ▼                   ▼
           │          │              ┌──────────────┐    ┌──────────┐
           │          │              │ #8 Sonogram  │    │ #10 CSS  │
           │          │              └──────────────┘    └──────────┘
           ▼          ▼
    ┌──────────┐ ┌──────────┐     ┌──────────┐
    │ #6 TLRend│ │#12 Mixer │     │ #11 Rust │
    └──────────┘ └──────────┘     └──────────┘
           │          │
           └────┬─────┘
                ▼
         ┌──────────────┐
         │ #13 App.ts   │
         └──────┬───────┘
                ▼
         ┌──────────────┐
         │ #14 TS Check │
         └──────────────┘
```

## 并行执行路线

```
generator:  #1 → #2 → #3 → #4 → #5 → #11 → #12
template:   ──────────────────────── #7 → #8 → #6 → #13
designer:   #9 → #10
tester:     ──────────────────────────────────────── #14
```

**独立可并行任务**（无依赖）：
- #1 (types), #7 (STFT Worker), #9 (HTML), #11 (Rust scan_folder)

## 新增功能说明

### Fader Law
- **Equal Power**: gain = cos(position * π/2) — 混音默认
- **Equal Gain**: gain = linear — 平行处理

### Crossfader
- 水平滑块控制两个 Track 之间的过渡
- 支持 EP/EG 两种曲线
- Mixer 底部 A/B Track 选择器 + 水平滑块

---

## 历史消息

### [2026-02-16] Soundly 架构调研完成

@researcher 完成了 Soundly 音效搜索/管理软件的全面技术调研。
报告: `docs/research/soundly-architecture.md`

核心结论：Tauri 2.x + Rust + TypeScript 完全可以实现类 Soundly 功能。
建议将音效浏览器作为 FieldCorder DAW 的内置模块。

---

## 架构调整建议（基于 UPGRADE_PROMPT.md 审查）

### 1. Delegate Mode — 建议采用 (P0)

FieldCorder 的功能规模已经足够大，Lead 应专注于协调：
- 14 个任务跨 4 个 agent 并行，协调开销远大于直接写代码
- Lead 直接修改文件会与 teammate 产生冲突风险
- **建议**: 下次组队时 Lead 使用 delegate mode，禁止直接编辑代码

### 2. TODO.md 状态化格式 — 建议采用 (P1)

当前 TODO.md 是简单列表，状态全部 "pending"（实际已全部完成但未更新）。
- **建议**: 采用 `id | title | status | owner | dependencies` 表格
- TaskCreate/TaskUpdate 已经在用，TODO.md 应与之同步
- 下方已更新为完成状态

### 3. 文件所有权边界 — 建议采用 (P0)

本次升级的实际目录所有权：

| 范围 | 所有者 |
|------|--------|
| `src/core/` (types, AudioEngine, BufferPool, TimelineModel) | generator |
| `src-tauri/src/` (Rust 后端) | generator |
| `src/utils/` (TauriAPI, UndoManager) | generator |
| `src/editor/` (TimelineRenderer, SonogramRenderer, sonogram-worker) | template |
| `src/ui/App.ts` (集成) | template |
| `src/mixer/Mixer.ts` | generator |
| `src/index.html`, `src/styles/main.css` | designer |
| `docs/` | docs |

**教训**: generator 和 designer 都改了 index.html/main.css，导致需要额外协调。
**建议**: 严格划分 HTML/CSS 归 designer，其他 agent 只读不写。

### 4. Plan Approval — 建议采用 (P1)

本项目受益于 plan 审批流程：
- 复杂功能（如 AudioEngine track routing）的设计决策应先审查
- 防止 teammate 走偏（如选错数据结构或 API 设计）
- **建议**: 对 Opus 4.6 级 agent 使用 `planModeRequired: true`

### 5. Quality Gates — 建议采用 (P2)

- **必须**: `tsc --noEmit` 在任务完成前通过
- **推荐**: `vite build` 成功
- **推荐**: 新文件必须有对应的 import/使用（避免死代码）
- **可选**: UI 变更附截图

---

*最后更新：2026-02-22*
