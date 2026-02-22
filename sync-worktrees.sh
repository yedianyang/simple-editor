#!/bin/bash
# 同步所有 worktree 到当前 branch 最新状态
set -e

CURRENT_BRANCH=$(git -C /Volumes/Metro-External/simple-editor branch --show-current)
echo "📦 Syncing all worktrees to $CURRENT_BRANCH..."

for wt in fieldcorder-frontend fieldcorder-quality fieldcorder-docs; do
  dir=/Volumes/Metro-External/$wt
  if [ -d "$dir" ]; then
    echo "→ Syncing $wt..."
    cd "$dir" && git merge $CURRENT_BRANCH --no-edit 2>/dev/null \
      && echo "  ✅ $wt synced" \
      || echo "  ⚠️  $wt has conflicts — resolve manually"
  fi
done

echo ""
echo "Worktree status:"
cd /Volumes/Metro-External/simple-editor && git worktree list
