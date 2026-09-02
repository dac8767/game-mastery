#!/bin/zsh
# Bring every worktree up to date with origin/main.
#
# Run from anywhere:  ~/Developer/game-mastery/catchup-worktrees.sh
#
# For each worktree under .claude/worktrees it rebases the branch onto
# origin/main, carrying any uncommitted edits across (--autostash), and
# runs npm install only if main changed the lockfile. A worktree whose
# rebase hits a conflict is put back exactly as it was and named at
# the end, so one stuck tool never blocks the rest; catch that one up
# by hand with the block in WORKTREES.md.
#
# The root checkout (main) is left alone: it is where merges happen,
# and `git pull origin main` there is a different, deliberate act.

set -u

root=~/Developer/game-mastery
cd "$root" || exit 1

echo "fetching origin"
git fetch origin --quiet || exit 1

rm -f "$root/.catchup-result"

git worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r wt; do
  [ "$wt" = "$root" ] && continue
  branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD)
  behind=$(git -C "$wt" rev-list --count HEAD..origin/main)

  if [ "$behind" = "0" ]; then
    echo "  $branch  already current"
    echo "current $branch" >> "$root/.catchup-result"
    continue
  fi

  lock_before=$(git -C "$wt" rev-parse HEAD:dnd-app/package-lock.json 2>/dev/null)
  echo "  $branch  $behind behind, rebasing"
  if git -C "$wt" rebase --autostash --quiet origin/main; then
    lock_after=$(git -C "$wt" rev-parse HEAD:dnd-app/package-lock.json 2>/dev/null)
    if [ "$lock_before" != "$lock_after" ]; then
      echo "  $branch  lockfile changed, npm install"
      (cd "$wt/dnd-app" && npm install --no-audit --no-fund --silent)
    fi
    echo "updated $branch" >> "$root/.catchup-result"
  else
    git -C "$wt" rebase --abort
    echo "  $branch  CONFLICT, left as it was"
    echo "failed $branch" >> "$root/.catchup-result"
  fi
done

echo
if [ -f "$root/.catchup-result" ]; then
  n_up=$(grep -c '^updated' "$root/.catchup-result")
  n_cur=$(grep -c '^current' "$root/.catchup-result")
  n_fail=$(grep -c '^failed' "$root/.catchup-result")
  echo "$n_up updated, $n_cur already current, $n_fail conflicted"
  if [ "$n_fail" != "0" ]; then
    echo
    echo "Catch these up by hand (WORKTREES.md, 'Keep a worktree current'):"
    grep '^failed' "$root/.catchup-result" | cut -d' ' -f2 | sed 's/^/  /'
  fi
  rm -f "$root/.catchup-result"
fi
