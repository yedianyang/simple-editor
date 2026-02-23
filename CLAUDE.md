# CLAUDE.md — FieldCorder DAW

## ⚠️ 废弃文件说明

**已废弃（2026-02-22）：**
- ❌ `TEAM.md` — 改用 **SendMessage** 工具通讯
- ❌ `TODO.md` — 改用 **TaskList** 工具管理任务

---

## 项目概述

FieldCorder 是一个轻量级 DAW，专为多通道环境录音编辑设计。目标平台 macOS，计划上架 Mac App Store。

## 技术栈

- **前端**: TypeScript + Vite + Web Audio API
- **桌面**: Tauri 2.x (Rust 后端)
- **音频**: Web Audio API (效果器) + Rust WAV 解析器
- **构建**: Vite + Cargo (Tauri CLI)

## 项目结构

```
src/                    # 前端 (TypeScript)
├── core/               # 音频引擎、类型（@generator）
├── editor/             # 波形编辑器（@frontend）
├── mixer/              # 混音台（@frontend）
├── plugins/            # 效果器（@generator）
├── ui/                 # UI 组件（@frontend）
├── utils/              # 工具层（@generator）
├── styles/             # CSS（@frontend）
└── main.ts             # 入口（@frontend）
src-tauri/              # Rust 后端（@generator）
docs/                   # 文档（@docs）
```

完整结构见 README。

## 开发命令

```bash
npm run dev            # Vite 开发服务器（仅前端）
npm run tauri:dev      # Tauri + Vite 完整开发模式
npm run tauri:build    # Tauri 生产构建（DMG）
npm run build:frontend # 仅构建前端
```

## 代码规范

- TypeScript strict mode，无 `any`
- Rust：snake_case 函数，PascalCase 类型，clippy 零警告
- 深色主题，遵循 macOS HIG
- 完整架构详见各 agent 文件

---

## 验证标准（Commit 前必须通过）

```bash
# TypeScript — 类型检查
npx tsc --noEmit

# Rust — 编译 + 测试 + lint
cd src-tauri && cargo check && cargo test && cargo clippy -- -D warnings

# 完整构建（重大变更时）
npm run build:frontend
```

**什么算"通过"：**
- `tsc --noEmit` — 零类型错误
- `cargo check` — 零编译错误
- `cargo test` — 全绿
- `cargo clippy -- -D warnings` — 零警告

**不通过不准 commit。没有例外。**

### TDD 规则（Red/Green）

所有新功能和 bug 修复使用 **red/green TDD**：

1. **Red** — 先写测试，跑一遍，**必须失败**（证明测试有效）
2. **Green** — 再写/修改实现，跑测试，**必须通过**

```
quality: 写测试 → cargo test / npx tsc → 确认红 ❌
generator/frontend: 实现功能 → 跑测试 → 确认绿 ✅
commit
```

**为什么：**
- 防止写了不工作的代码
- 防止写了从不被调用的代码
- 防止以后改动悄悄破坏现有功能（regression）

**跳过 red 阶段是禁止的。** 如果测试一开始就通过 → 测试写错了，重写。

### 音频/UI 变更 — 需要人工验证

以下变更 commit 后标记 🔍：
- 播放/暂停/停止逻辑
- 波形渲染（缩放、颜色、精度）
- 频谱图渲染
- 混音台 UI（推子、电平表）
- 键盘快捷键
- 文件加载（WAV/非WAV 路径）

**Agent 职责：** commit message 加 🔍，SendMessage 说明验证方式。
**Jingxi 职责：** `npm run tauri:dev` 启动后实际操作确认。

---

## Agent Team 协作规范

### 核心机制

- **TaskCreate/TaskList/TaskUpdate** — 共享任务列表
- **SendMessage** — agent 间通讯
- **delegate mode** (Shift+Tab) — Lead 只协调不写码
- **plan approval** — 跨模块/架构变更需 Lead 审批

### 角色定义 & 文件 Ownership（5 agents）

| Agent | Model | 文件 ownership | 用途 |
|---|---|---|---|
| **lead** | opus | 不碰源码 | 拆任务、分配、审批 Plan |
| **generator** | sonnet | `src-tauri/src/*`, `Cargo.toml`, `src/core/*`, `src/utils/*` | Rust 后端 + 音频引擎核心 |
| **frontend** | sonnet | `src/editor/*`, `src/mixer/*`, `src/ui/*`, `src/plugins/*`, `src/styles/*`, `src/main.ts`, `index.html` | 前端 UI + 渲染 |
| **quality** | sonnet | `**/*.test.ts`, `#[cfg(test)]` blocks, `docs/test-report.md` | 测试 + 代码审查 |
| **docs** | sonnet | `readme.md`, `docs/*.md`, `docs/research/*.md` | 文档 + 技术调研 |

### Interview Mode（新模块/新功能必须）

新功能开发前，Lead 用 plan mode 向用户提问——专攻**用户可能没想到的**：
- 边界情况、性能瓶颈、格式兼容性、MAS 限制
- 不问显而易见的，挑战需求直到覆盖完整
- 输出 spec 到 `docs/specs/`，再拆任务

```
"Interview me about this feature.
Ask hard questions I might not have considered — edge cases,
performance, format compatibility, MAS sandbox limits.
Keep interviewing until complete, then write a spec."
```

### 并行策略

**可并行：**
- frontend(UI 渲染) + generator(Rust/音频引擎) + docs(调研)

**必须串行：**
- generator → frontend（API 契约：generator 先定义 AppAPI 接口，frontend 再调用）
- quality 等功能完成后才测试/审查
- docs 等测试通过后才更新文档

### Rust ↔ TypeScript 协作（API 契约）

1. generator 在 `types.ts` 新增接口、在 `TauriAPI.ts` 实现、在 Rust 添加命令
2. 完成后 SendMessage 通知 frontend：
   > `window.appAPI.xxx({ param })` 返回 `{ field1, field2 }`
3. frontend 按契约实现 UI 调用

### Plan Approval（分层策略）

| 任务类型 | 需要 Plan Approval |
|----------|:---:|
| 单文件 bug fix | No |
| 单模块新功能 | No |
| 跨 2+ 模块 / AppAPI 接口变更 | **Yes** |
| 架构变更 / 新依赖引入 | **Yes** |
| WAV 解析格式扩展 | **Yes** |
| MAS 权限变更 | **Yes** |

### 任务流程

```
Lead: TaskCreate → TaskUpdate(owner=teammate)
  ↓
Teammate: TaskUpdate(status=in_progress) → [plan mode if required]
  ↓
Teammate: 编码 → tsc/cargo 验证 → git commit → TaskUpdate(status=completed)
  ↓
Lead: TaskList → 检查进度 → 分配下一个 / SendMessage 反馈
```

### 文档更新规则（强制）

功能完成后，Lead **必须判断**是否需要触发文档更新：

| 完成的工作 | Lead 必须做 |
|-----------|------------|
| 新增功能 | SendMessage → docs 更新 user-guide.md + api.md |
| Tauri 命令名变更 | SendMessage → docs 更新 api.md |
| 用户可见行为变化 | SendMessage → docs 更新 user-guide.md |
| Bug 修复（行为不变） | 无需更新文档（可在 lessons-learned.md 记录） |
| 代码重构（行为不变） | 无需更新文档 |

**docs 任务必须在 quality 测试通过后才能开始。**
不符合上表条件时，Lead 可跳过文档步骤，但须在 TaskList 注明"无需文档更新"。

### 通讯规范

- **SendMessage(type=message)** — 点对点
- **SendMessage(type=broadcast)** — 全员广播（仅紧急事项）

---

## 自我改进机制

### Past Mistakes to Avoid

> 记录已识别的错误模式，持续更新。

**最后更新：2026-02-22**

#### 技术规范
- Tauri 命令修改后必须同步更新 `TauriAPI.ts` 接口，否则前端类型错误
- `#[tauri::command]` 函数名用 snake_case，JS 调用时也用 snake_case（Tauri 自动转换）
- WAV 解析不能一次性读入内存——超过 10 分钟文件会 OOM

#### 协作规范
- 不要修改 TEAM.md/TODO.md — 使用 TaskList/SendMessage
- generator 修改 AppAPI 接口后必须 SendMessage 通知 frontend

### 手动触发 Review

```
"Review CLAUDE.md based on last week's work.
Update 'Past Mistakes to Avoid' with new lessons learned.
Remove outdated rules that are now obvious.
Commit with: 'docs: weekly CLAUDE.md review'"
```

---

## 工程流程

- 每个 task 完成 + 验证通过 → 立即 commit（不积攒）
- Git commit 格式：`feat: xxx` / `fix: xxx` / `docs: xxx`
- 踩坑记录到 `docs/lessons-learned.md`
