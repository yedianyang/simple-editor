# Claude Code Team Scripts

FieldCorder 项目的 Claude Code 团队启动脚本。

## 脚本说明

### `start-team.sh` — 启动完整团队（推荐）

启动 Lead agent，并准备好多 agent 协作环境。

```bash
./start-team.sh            # 同步 worktrees + 启动
./start-team.sh --no-sync  # 跳过同步，直接启动
```

**自动执行流程：**
1. 读取规则（CLAUDE.md + AGENTIC_RULES.md）
2. **First run the tests**（验证环境）
3. TaskList（检查任务状态）
4. 汇报就绪

**适用场景：**
- 开始新的开发 session
- Lead 协调多个 teammates
- 完整的项目工作流

---

### `start-teammate.sh` — 启动单个 Teammate

启动特定角色的 agent，严格执行启动协议。

```bash
./start-teammate.sh generator  # Rust + 音频引擎
./start-teammate.sh frontend   # TypeScript + UI
./start-teammate.sh quality    # 测试 + 审查
./start-teammate.sh docs       # 文档 + 调研
```

**启动协议（强制）：**
1. **First run the tests** (MANDATORY)
   - `npm test -- --run`
   - `cd src-tauri && cargo test`
   - 汇报测试结果
2. 确认角色和文件 ownership
3. TaskList 检查任务
4. 汇报就绪或继续工作

**适用场景：**
- 单独启动某个 agent 处理特定任务
- 调试某个模块
- 并行开发（多个终端窗口）

---

## Worktree 配置

每个 teammate 在独立的 worktree 中工作，避免文件冲突：

| Agent | Worktree | Files |
|-------|----------|-------|
| **Lead** (main) | `/Volumes/Metro-External/simple-editor` | 协调，不碰源码 |
| **generator** | `/Volumes/Metro-External/simple-editor` | `src-tauri/`, `src/core/`, `src/utils/` |
| **frontend** | `/Volumes/Metro-External/fieldcorder-frontend` | `src/editor/`, `src/mixer/`, `src/ui/`, `src/plugins/` |
| **quality** | `/Volumes/Metro-External/fieldcorder-quality` | `**/*.test.ts`, test blocks, `docs/test-report.md` |
| **docs** | `/Volumes/Metro-External/fieldcorder-docs` | `readme.md`, `docs/` |

**同步 worktrees：**
```bash
./sync-worktrees.sh
```

---

## Tmux 快捷键

| 操作 | 快捷键 |
|------|--------|
| 分离（Detach） | `Ctrl+B` → `D` |
| 查看历史（Scroll） | `Ctrl+B` → `[` → 方向键滚动 → `Q` 退出 |
| 切换窗口 | `Ctrl+B` → `0-9` |
| 创建新窗口 | `Ctrl+B` → `C` |

**从外部 attach：**
```bash
tmux attach -t fieldcorder-team        # Lead
tmux attach -t fieldcorder-generator   # Generator
tmux attach -t fieldcorder-frontend    # Frontend
tmux attach -t fieldcorder-quality     # Quality
tmux attach -t fieldcorder-docs        # Docs
```

**停止 session：**
```bash
tmux kill-session -t fieldcorder-team
tmux kill-session -t fieldcorder-generator
# ... 其他 session
```

---

## 启动流程详解

### Lead Agent（`start-team.sh`）

**职责：**
- 拆分任务（TaskCreate）
- 分配给 teammates（TaskUpdate）
- 审批跨模块 Plan
- 协调进度（TaskList + SendMessage）

**不做：**
- ❌ 不直接修改源码
- ❌ 不运行测试（可以跳过 "First run tests"）

**启动后自动执行：**
```
1. CLAUDE.md 加载 ✓
2. (Lead 可跳过测试)
3. TaskList 检查任务状态
4. 汇报就绪，等待指令
```

---

### Teammate Agents（`start-teammate.sh`）

**严格启动协议（不可跳过）：**

```bash
# 1. First run the tests (MANDATORY)
npm test -- --run
cd src-tauri && cargo test

# 报告格式：
# "Tests: 84/84 passed (TypeScript), 12/12 passed (Rust)"
# 或
# "Tests: 82/84 passed (TypeScript - 2 failures), 12/12 passed (Rust)"
```

**为什么强制执行：**
- ✅ 确认开发环境正常
- ✅ 了解当前代码状态（哪些测试在失败）
- ✅ 获取项目规模感（测试数量）
- ✅ 进入测试心态（Red/Green TDD）

**如果测试失败：**
1. 报告失败的测试
2. 检查是否是自己负责的模块
3. 询问是否先修复测试还是继续任务

---

## 开发规则（三层）

FieldCorder 遵循三层规则体系：

1. **AGENTIC_RULES.md** — 通用 Agentic Engineering 最佳实践
   - Session 启动：First run the tests
   - Red/Green TDD
   - 代码复用：Hoard and Recombine
   - 代码理解：Linear Walkthrough + Interactive Explanation
   
2. **CLAUDE.md** — FieldCorder 项目协作规范
   - Team 角色定义
   - 文件 ownership
   - 任务流程
   - Plan approval 规则
   
3. **.clinerules** — TDD 细节规则
   - Red → Green → Refactor 完整流程
   - Bug fix / Feature development 协议
   - 测试组织结构

**优先级：** 3 > 2 > 1（项目特定规则优先于通用规则）

---

## 常见场景

### 场景 1：开始新的开发 session

```bash
./start-team.sh
# 等待 Lead 启动完成
# 在 tmux 中给 Lead 下达任务
```

### 场景 2：单独处理某个模块

```bash
./start-teammate.sh frontend
# 进入 tmux session
# 直接开始工作，测试会自动运行
```

### 场景 3：并行开发

```bash
# 终端 1
./start-teammate.sh generator

# 终端 2
./start-teammate.sh frontend

# 终端 3
./start-team.sh
# Lead 协调两个 teammates
```

### 场景 4：测试失败时启动

```bash
./start-teammate.sh quality
# 自动运行测试发现失败
# Agent 会报告失败的测试
# 询问："Should I fix these failing tests first?"
```

---

## 故障排查

### 问题：Agent 没有运行测试

**原因：** 可能 INITIAL_PROMPT 没有生效

**解决：**
```bash
# 在 tmux session 中手动输入：
First run the tests
```

### 问题：Worktree 不同步

**解决：**
```bash
./sync-worktrees.sh
# 或
./start-team.sh  # 会自动同步
```

### 问题：Session 已存在

**解决：**
脚本会提示是否 attach 或 kill，选择 kill 后重新启动。

### 问题：测试一直失败

**步骤：**
1. 手动运行测试确认环境
2. 检查是否有未提交的变更
3. 查看 git status
4. 必要时 `git stash` 后重试

---

## 最佳实践

1. **每次 session 开始运行脚本**，不要手动启动 claude
2. **观察测试结果**，失败的测试可能指向需要修复的问题
3. **Lead + 多个 Teammates 并行**效率最高
4. **遵循 Red/Green TDD**，测试先行
5. **完成任务立即 commit**，不要积攒变更

---

## 参考文档

- `AGENTIC_RULES.md` — 通用开发规则
- `CLAUDE.md` — 项目团队规范
- `.clinerules` — TDD 规则
- `docs/dev-workflow.md` — 开发工作流
- `docs/TDD-GUIDE.md` — 测试驱动开发指南

---

**最后更新**: 2026-03-03  
**维护者**: 根据项目实践持续更新
