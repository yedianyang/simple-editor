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
tmux send-keys -t $SESSION 'claude' Enter

sleep 2

echo -e "${GREEN}✅ Claude Code started: tmux session '$SESSION'${NC}"
echo ""
echo -e "${BLUE}── 工作模式 ──────────────────────────────────────${NC}"
echo "  模型：Lead = claude-opus-4-6 / Teammates = claude-sonnet-4-6"
echo "  团队：main / generator / frontend / quality / docs"
echo "  任务管理：TaskCreate / TaskList / TaskUpdate（内建工具）"
echo "  通讯：SendMessage（内建工具）"
echo "  协作：Jingxi → Metro → Lead → Teammates"
echo ""
echo -e "${BLUE}── Worktrees ──────────────────────────────────────${NC}"
echo "  主目录（Lead+Generator）: $PROJECT_DIR"
echo "  Frontend:  /Volumes/Metro-External/fieldcorder-frontend"
echo "  Quality:   /Volumes/Metro-External/fieldcorder-quality"
echo "  Docs:      /Volumes/Metro-External/fieldcorder-docs"
echo ""
echo "  并行工作时，在新 Terminal 窗口 cd 到对应目录后运行 claude"
echo ""
echo -e "${BLUE}── 操作 ───────────────────────────────────────────${NC}"
echo "  进入 session:   tmux attach -t $SESSION"
echo "  后台分离:       Ctrl+B → D"
echo "  查看历史:       Ctrl+B → [ (方向键滚动, Q 退出)"
echo "  停止 session:   tmux kill-session -t $SESSION"
echo ""
echo -e "${YELLOW}Tip: 进入后直接说需求，Lead 会拆任务分配给 agents${NC}"
echo ""

read -p "立即 attach 进入？[Y/n] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    tmux attach -t $SESSION
fi
