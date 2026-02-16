#!/bin/bash
# FieldCorder Team Lead 启动脚本
# 用法: ./start-team.sh

set -e

SESSION="fieldcorder-team"
PROJECT_DIR="/Volumes/Metro-External/simple-editor"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 如果 session 已存在，询问是否 kill
if tmux has-session -t $SESSION 2>/dev/null; then
    echo -e "${YELLOW}⚠️  Session '$SESSION' already exists.${NC}"
    read -p "Kill and restart? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        tmux kill-session -t $SESSION
        echo "Killed existing session."
    else
        echo "Attaching to existing session..."
        tmux attach -t $SESSION
        exit 0
    fi
fi

# 启动新 session
tmux new-session -d -s $SESSION -c $PROJECT_DIR

# 启动 claude code
tmux send-keys -t $SESSION 'claude --dangerously-skip-permissions' Enter

# 等待 claude 启动
sleep 5

# 发送启动指令
tmux send-keys -t $SESSION '你是 FieldCorder DAW 的 Team Lead。读取 CLAUDE.md、TEAM.md、TODO.md，了解项目现状。你不写代码，任务分配给 @generator @designer @template 等 teammates。报告就绪后等待指令。' Enter

echo -e "${GREEN}✅ FieldCorder Team Lead started in tmux session: $SESSION${NC}"
echo ""
echo "Commands:"
echo "  tmux attach -t $SESSION        # 进入 session"
echo "  tmux kill-session -t $SESSION  # 停止"
echo ""
echo -e "${YELLOW}Tip: Press Ctrl+B then D to detach (keep running)${NC}"
