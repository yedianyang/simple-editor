# FieldCorder 开发完整流程

## 每次开工

```bash
# 1. 同步所有 worktree
cd /Volumes/Metro-External/simple-editor
./sync-worktrees.sh

# 2. 启动 Lead session（主目录）
claude
```

---

## 场景 A：简单任务（单 agent）

直接告诉 Lead：

```
修复播放时波形光标跳动的问题
```

Lead 判断是 frontend 的事，直接 SendMessage 分配，你不用开其他 terminal。

---

## 场景 B：中型任务（2-3 个 agent 并行）

> 例：新增 BWF 格式支持（Rust 解析 + TS 加载路径 + 文档）

### Step 1: Interview

Lead 会先问你：
- BWF 和 WAV 的差异处理？broadcast extension chunk 要不要解析？
- MAS 沙盒里读 BWF 有无权限问题？
- 文件名超过 BWF 规范限制（64字符）怎么处理？

回答完 → Lead 写 spec 到 `docs/specs/` → 拆任务

### Step 2: 开 worktree sessions

```bash
# Terminal 1: Lead + Generator（主目录）
cd /Volumes/Metro-External/simple-editor && claude

# Terminal 2: Frontend（等 generator 定义好 AppAPI 后）
cd /Volumes/Metro-External/fieldcorder-frontend && claude

# Terminal 3: Docs（调研可以并行）
cd /Volumes/Metro-External/fieldcorder-docs && claude
```

### Step 3: 监控进度

在 Lead session：
```
TaskList
```

### Step 4: 合并

```bash
cd /Volumes/Metro-External/simple-editor
git merge wt/frontend
git merge wt/docs
./sync-worktrees.sh
```

### Step 5: 验证

```bash
# 自动验证
npx tsc --noEmit
cd src-tauri && cargo check && cargo test && cargo clippy -- -D warnings

# 人工验证（有 🔍 标记的 commit 必须）
npm run tauri:dev
# 实际加载 BWF 文件，听一遍，看波形
```

---

## 场景 C：大型任务（全员）

```bash
# Terminal 1: Lead + Generator
cd /Volumes/Metro-External/simple-editor && claude

# Terminal 2: Frontend
cd /Volumes/Metro-External/fieldcorder-frontend && claude

# Terminal 3: Quality
cd /Volumes/Metro-External/fieldcorder-quality && claude

# Terminal 4: Docs
cd /Volumes/Metro-External/fieldcorder-docs && claude
```

---

## TaskList 速查

| 你说 | Lead 做 |
|------|---------|
| "看看现在有什么任务" | `TaskList` |
| "加个任务：支持 FLAC 格式" | `TaskCreate(...)` |
| "任务 3 完成了" | `TaskUpdate(status=completed)` |
| "任务 2 要等任务 1 完成" | `TaskUpdate(addBlockedBy=[1])` |

---

## Worktree 日常操作

```bash
# 每天开工
./sync-worktrees.sh

# 合并某个 worktree 成果回主分支
cd /Volumes/Metro-External/simple-editor
git merge wt/frontend

# 开始新任务前重置 worktree
cd /Volumes/Metro-External/fieldcorder-frontend
git reset --hard <current-branch>

# 查看状态
git worktree list
```

---

## Worktree 目录

```
/Volumes/Metro-External/simple-editor/         main — Lead + Generator
/Volumes/Metro-External/fieldcorder-frontend/  wt/frontend — Frontend
/Volumes/Metro-External/fieldcorder-quality/   wt/quality — Quality
/Volumes/Metro-External/fieldcorder-docs/      wt/docs — Docs
```

---

## 注意事项

1. **Lead 不写代码** — 只协调
2. **合并前 commit** — 未提交的改动不能 merge
3. **🔍 标记必须验证** — 音频类问题必须实际听，不只看代码
4. **AppAPI 接口变更** — generator 完成后 SendMessage 通知 frontend
5. **外置硬盘要挂载** — 确认 `/Volumes/Metro-External/` 可用再开工
