#!/bin/bash
# FieldCorder Claude Code Team 启动脚本
# 用法: ./start-team.sh [--no-sync]

set -e

SESSION="fieldcorder-team"
PROJECT_DIR="/Volumes/Metro-External/simple-editor"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

INITIAL_PROMPT="执行启动流程：读取 CLAUDE.md，调用 TaskList 查看任务状态，汇报就绪或继续未完成任务。"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  FieldCorder Claude Code Team${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── 同步 worktrees ──────────────────────────────────────
if [[ "$1" != "--no-sync" ]]; then
    echo "→ Syncing worktrees..."
    cd $PROJECT_DIR && ./sync-worktrees.sh
    echo ""
fi

# ── 启动 / 恢复 session ────────────────────────────────
if tmux has-session -t $SESSION 2>/dev/null; then
    echo -e "${YELLOW}⚠️  Session '$SESSION' already exists.${NC}"
    read -p "Attach to existing? [Y/n] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        tmux attach -t $SESSION
        exit 0
    else
        tmux kill-session -t $SESSION
        echo "Killed existing session."
    fi
fi

tmux new-session -d -s $SESSION -c $PROJECT_DIR

# 带初始 prompt 启动 claude（自动触发启动流程）
tmux send-keys -t $SESSION "claude --dangerously-skip-permissions \"$INITIAL_PROMPT\"" Enter

echo -e "${GREEN}✅ Claude Code started: tmux session '$SESSION'${NC}"
echo ""
echo -e "${BLUE}── 工作模式 ──────────────────────────────────────${NC}"
echo "  模型：Lead = claude-opus-4-6 / Teammates = claude-sonnet-4-6"
echo "  团队：main / generator / frontend / quality / docs"
echo "  任务管理：TaskCreate / TaskList / TaskUpdate（内建工具）"
echo "  通讯：SendMessage（内建工具）"
echo ""
echo -e "${BLUE}── Worktrees ──────────────────────────────────────${NC}"
echo "  主目录（Lead）:   $PROJECT_DIR"
echo "  Frontend:         /Volumes/Metro-External/fieldcorder-frontend"
echo "  Quality:          /Volumes/Metro-External/fieldcorder-quality"
echo "  Docs:             /Volumes/Metro-External/fieldcorder-docs"
echo ""
echo -e "${BLUE}── 操作 ───────────────────────────────────────────${NC}"
echo "  进入 session:   tmux attach -t $SESSION"
echo "  后台分离:       Ctrl+B → D"
echo "  查看历史:       Ctrl+B → [ (方向键滚动, Q 退出)"
echo "  停止 session:   tmux kill-session -t $SESSION"
echo ""
echo -e "${YELLOW}Tip: 进入后 Lead 已自动开始启动流程${NC}"
echo ""

read -p "立即 attach 进入？[Y/n] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    tmux attach -t $SESSION
fi
