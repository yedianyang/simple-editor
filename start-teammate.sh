#!/bin/bash
# FieldCorder Claude Code Teammate 启动脚本
# 用法: ./start-teammate.sh [generator|frontend|quality|docs]

set -e

if [ $# -eq 0 ]; then
    echo "Usage: ./start-teammate.sh [generator|frontend|quality|docs]"
    exit 1
fi

ROLE=$1
SESSION="fieldcorder-$ROLE"

case $ROLE in
    generator)
        WORKTREE="/Volumes/Metro-External/simple-editor"
        FILES="src-tauri/src/*, Cargo.toml, src/core/*, src/utils/*"
        ;;
    frontend)
        WORKTREE="/Volumes/Metro-External/fieldcorder-frontend"
        FILES="src/editor/*, src/mixer/*, src/ui/*, src/plugins/*, src/styles/*, src/main.ts"
        ;;
    quality)
        WORKTREE="/Volumes/Metro-External/fieldcorder-quality"
        FILES="**/*.test.ts, #[cfg(test)] blocks, docs/test-report.md"
        ;;
    docs)
        WORKTREE="/Volumes/Metro-External/fieldcorder-docs"
        FILES="readme.md, docs/*.md, docs/research/*.md"
        ;;
    *)
        echo "Unknown role: $ROLE"
        echo "Valid roles: generator, frontend, quality, docs"
        exit 1
        ;;
esac

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Teammate 启动提示词（严格执行 First run the tests）
INITIAL_PROMPT="I am the **$ROLE** teammate agent.

Session startup protocol (MANDATORY per AGENTIC_RULES.md):

1. **First run the tests** (REQUIRED):
   \`\`\`bash
   npm test -- --run
   cd src-tauri && cargo test
   \`\`\`
   Report: X/Y tests passed

2. Read CLAUDE.md (already loaded) - Confirm my role and file ownership

3. TaskList - Check for assigned tasks

4. Report ready status or continue incomplete work

My file ownership: $FILES
Working directory: $WORKTREE"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  FieldCorder Teammate: $ROLE${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# 检查已有 session
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

# 启动新 session
tmux new-session -d -s $SESSION -c $WORKTREE
tmux send-keys -t $SESSION "claude --dangerously-skip-permissions \"$INITIAL_PROMPT\"" Enter

echo -e "${GREEN}✅ $ROLE agent started: tmux session '$SESSION'${NC}"
echo ""
echo -e "${BLUE}── Role: $ROLE ───────────────────────────────────${NC}"
echo "  Working directory: $WORKTREE"
echo "  File ownership: $FILES"
echo ""
echo -e "${BLUE}── Startup Protocol ──────────────────────────────${NC}"
echo "  ✓ First run the tests (auto-executing)"
echo "  ✓ Read CLAUDE.md"
echo "  ✓ Check TaskList"
echo ""
echo -e "${BLUE}── Operations ────────────────────────────────────${NC}"
echo "  Attach:  tmux attach -t $SESSION"
echo "  Detach:  Ctrl+B → D"
echo "  Kill:    tmux kill-session -t $SESSION"
echo ""

read -p "Attach now? [Y/n] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    tmux attach -t $SESSION
fi
