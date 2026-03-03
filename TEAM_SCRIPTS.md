# Claude Code Team Scripts

FieldCorder 项目的 Claude Code 团队启动脚本（单 session 模式）。

## 工作模式

**单 session + tmux 监控：**
- 启动一个 Lead session
- Lead 通过 Claude Code 内置工具调动 teammates
- 你在 tmux 中监控所有 agent 交互
- 不需要多个独立 session

---

## `start-team.sh` — 启动 Lead Agent

```bash
./start-team.sh            # 同步 worktrees + 启动
./start-team.sh --no-sync  # 跳过同步，直接启动
```

**Lead 启动后自动执行：**
1. 读取 CLAUDE.md（团队规则）
2. TaskList（检查任务状态）
3. 汇报就绪，等待指令

**Lead 的职责：**
- 拆分任务 → TaskCreate
- 分配给 teammates → TaskUpdate(owner=teammate)
- 协调进度 → TaskList + SendMessage
- 审批跨模块 Plan

**Lead 不做：**
- ❌ 不直接写代码
- ❌ 不运行测试（teammates 负责）

---

## Lead 如何调动团队

### 启动 Teammate

**通过 Claude Code 内置功能：**
```
启动 generator teammate，负责 Rust 后端和音频引擎。
第一条指令：First run the tests (npm test && cd src-tauri && cargo test)
```

Lead 会：
1. 调用 Claude Code 的 agent spawn 功能
2. 分配角色和文件 ownership
3. 下达第一条指令：`First run the tests`

### 分配任务

**通过 TaskCreate：**
```
TaskCreate {
  title: "实现 Wiener Filter 插件",
  owner: "generator",
  priority: "high"
}
```

### 沟通协作

**通过 SendMessage：**
```
SendMessage(to=frontend, message="AppAPI.loadAudio 接口已更新...")
SendMessage(type=broadcast, message="准备开始集成测试")
```

---

## Teammate 角色定义

| Agent | Files | 用途 |
|-------|-------|------|
| **generator** | `src-tauri/`, `src/core/`, `src/utils/` | Rust 后端 + 音频引擎 |
| **frontend** | `src/editor/`, `src/mixer/`, `src/ui/`, `src/plugins/` | TypeScript UI |
| **quality** | `**/*.test.ts`, test blocks, `docs/test-report.md` | 测试 + 审查 |
| **docs** | `readme.md`, `docs/` | 文档 + 调研 |

---

## 开发规则（三层）

1. **AGENTIC_RULES.md** — 通用最佳实践
   - Session 启动：First run the tests
   - Red/Green TDD
   - 代码复用：Hoard and Recombine
   
2. **CLAUDE.md** — FieldCorder 团队规范
   - 角色定义、任务流程、Plan approval
   
3. **.clinerules** — TDD 细节
   - Red → Green → Refactor

---

## First Run the Tests 规则

**为什么重要：**
- 确认测试环境正常
- 了解当前代码状态
- 获取项目规模感
- 进入测试心态

**Lead 如何执行：**
1. Lead 启动 teammate 时，第一条指令：`First run the tests`
2. Teammate 执行并汇报结果
3. 失败的测试 → 询问是否先修复

**命令：**
```bash
# TypeScript + Vitest
npm test -- --run

# Rust
cd src-tauri && cargo test
```

---

## Tmux 监控

**你在 tmux 中看到的：**
```
[Lead] Starting generator teammate...
[generator] Running tests...
[generator] Tests: 84/84 passed (TS), 12/12 passed (Rust)
[generator] Ready for tasks
[Lead] Assigning task: Implement Wiener Filter
[generator] Starting work on task...
```

**Tmux 快捷键：**
- 分离：`Ctrl+B` → `D`
- 滚动查看历史：`Ctrl+B` → `[` → 方向键 → `Q` 退出
- 从外部 attach：`tmux attach -t fieldcorder-team`

---

## Worktree 配置

每个 teammate 在独立 worktree 工作（避免文件冲突）：

| Agent | Worktree |
|-------|----------|
| Lead (main) | `/Volumes/Metro-External/simple-editor` |
| generator | `/Volumes/Metro-External/simple-editor` |
| frontend | `/Volumes/Metro-External/fieldcorder-frontend` |
| quality | `/Volumes/Metro-External/fieldcorder-quality` |
| docs | `/Volumes/Metro-External/fieldcorder-docs` |

**同步 worktrees：**
```bash
./sync-worktrees.sh
```

---

## 常见场景

### 场景 1：开始新功能开发

```bash
./start-team.sh
# 在 tmux 中：

"启动 generator 和 frontend teammates。
Generator 负责实现 Rust WAV 解析器，
Frontend 负责实现波形渲染器。
两人并行工作。"
```

### 场景 2：修复测试失败

```bash
./start-team.sh
# Lead 启动后：

"启动 quality teammate。
First run the tests 检查失败的测试，
然后修复它们。"
```

### 场景 3：文档更新

```bash
./start-team.sh
# Lead 启动后：

"启动 docs teammate。
根据最近的代码变更更新 user-manual.md。"
```

---

## 任务流程

```
[You] 给 Lead 下达任务
  ↓
[Lead] TaskCreate → 拆分任务
  ↓
[Lead] 启动 teammates（First run tests）
  ↓
[Teammates] 完成任务 → 运行测试 → commit
  ↓
[Lead] TaskList 检查进度
  ↓
[Lead] 汇报完成
```

---

## 故障排查

### 问题：Teammate 没有运行测试

**解决：**
Lead 下达第一条指令时明确说明：
```
"First run the tests: npm test && cd src-tauri && cargo test"
```

### 问题：Worktree 不同步

**解决：**
```bash
./sync-worktrees.sh
```

### 问题：Session 卡住

**解决：**
```bash
tmux kill-session -t fieldcorder-team
./start-team.sh
```

---

## 最佳实践

1. **Lead 只协调，不写代码** — 保持 delegate mode
2. **First run tests 是第一条指令** — 建立测试心态
3. **遵循 Red/Green TDD** — 测试先行
4. **完成任务立即 commit** — 不要积攒变更
5. **用 tmux 监控所有交互** — 便于调试和干预

---

## 相关文档

- `AGENTIC_RULES.md` — 通用开发规则
- `CLAUDE.md` — 项目团队规范
- `.clinerules` — TDD 规则
- `docs/dev-workflow.md` — 开发工作流

---

**工作模式**：单 session + Lead 协调 + tmux 监控  
**最后更新**：2026-03-03  
**维护者**：根据实践持续更新
