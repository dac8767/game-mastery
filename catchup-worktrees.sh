#!/bin/zsh
# Bring every worktree of this repo up to date with origin/main.
#
# Run from anywhere:  <repo>/catchup-worktrees.sh
#
# The repo is the folder this script lives in, so the same file works
# in any repo it is copied to. Per-repo settings (the check command,
# the lockfile, the install command) come from worktree-flow.conf
# beside it.
#
# For each worktree under .claude/worktrees it rebases the branch onto
# origin/main, carrying any uncommitted edits across (--autostash), and
# runs the install command only if main changed the lockfile. A
# worktree whose rebase hits a conflict is put back exactly as it was
# and named at the end, so one stuck tool never blocks the rest; catch
# that one up by hand:
#   cd <that worktree> && git fetch origin && git rebase origin/main
#
# The root checkout (main) is left alone: it is where merges happen,
# and `git pull origin main` there is a different, deliberate act.

set -u

root=${0:A:h}
cd "$root" || exit 1

check=''; lockfile=''; install=''
[ -f "$root/worktree-flow.conf" ] && source "$root/worktree-flow.conf"

echo "fetching origin"
git fetch origin --quiet || exit 1

result="$root/.catchup-result"
rm -f "$result"

git worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r wt; do
  [ "$wt" = "$root" ] && continue
  branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD)
  behind=$(git -C "$wt" rev-list --count HEAD..origin/main)

  if [ "$behind" = "0" ]; then
    echo "  $branch  already current"
    echo "current $branch" >> "$result"
    continue
  fi

  lock_before=''
  [ -n "$lockfile" ] && lock_before=$(git -C "$wt" rev-parse "HEAD:$lockfile" 2>/dev/null)
  echo "  $branch  $behind behind, rebasing"
  if git -C "$wt" rebase --autostash --quiet origin/main; then
    if [ -n "$lockfile" ]; then
      lock_after=$(git -C "$wt" rev-parse "HEAD:$lockfile" 2>/dev/null)
      if [ "$lock_before" != "$lock_after" ] && [ -n "$install" ]; then
        echo "  $branch  $lockfile changed, installing"
        (cd "$wt" && eval "$install")
      fi
    fi
    echo "updated $branch" >> "$result"
  else
    git -C "$wt" rebase --abort
    echo "  $branch  CONFLICT, left as it was"
    echo "failed $branch" >> "$result"
  fi
done

echo
if [ -f "$result" ]; then
  n_up=$(grep -c '^updated' "$result")
  n_cur=$(grep -c '^current' "$result")
  n_fail=$(grep -c '^failed' "$result")
  echo "$n_up updated, $n_cur already current, $n_fail conflicted"
  if [ "$n_fail" != "0" ]; then
    echo
    echo "Catch these up by hand (cd into it, git fetch origin, git rebase origin/main):"
    grep '^failed' "$result" | cut -d' ' -f2 | sed 's/^/  /'
  fi
  rm -f "$result"
else
  echo "no worktrees"
fi
