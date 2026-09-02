#!/bin/zsh
# Finish the worktree you are standing in: commit, rebase onto main,
# run the guards, merge into main, push, then rebase every other
# worktree so they all take in the work.
#
# Run from inside any worktree (anywhere under it):
#
#   ~/Developer/game-mastery/finish-worktree.sh "Sessions: what changed"
#
# The message is the commit message. Without one the script asks.
#
# Where it stops, and why:
#   - run from the root checkout: there is nothing to merge main into.
#   - the rebase hits a conflict: the worktree is put back as it was;
#     resolve it by hand (WORKTREES.md, "Keep one worktree current").
#   - a guard is red: nothing is done until they are green.
#   - the root has uncommitted edits to tracked files: merging
#     underneath them is how work gets tangled. Commit or stash there.
# Nothing after a stop has happened; the script is safe to rerun.

set -u

root=~/Developer/game-mastery
top=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "not inside a git checkout"; exit 1
}

if [ "$top" = "$root" ]; then
  echo "This is the root checkout (main). Run it from inside a worktree:"
  git worktree list | awk 'NR>1{print "  " $1}'
  exit 1
fi

branch=$(git rev-parse --abbrev-ref HEAD)
case "$branch" in
  worktree-*) ;;
  *) echo "On '$branch', not a worktree-* branch. Stopping."; exit 1 ;;
esac

message="${1:-}"
if [ -z "$message" ] && [ -n "$(git status --porcelain)" ]; then
  printf "Commit message: "
  read -r message
  [ -z "$message" ] && { echo "No message. Stopping."; exit 1; }
fi

echo "== $branch"

# 1. Commit whatever is here.
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit --quiet -m "$message" || exit 1
  echo "committed: $message"
else
  echo "nothing to commit"
fi

# 2. Rebase onto main as it is on GitHub.
git fetch origin --quiet || exit 1
behind=$(git rev-list --count HEAD..origin/main)
if [ "$behind" != "0" ]; then
  echo "rebasing onto origin/main ($behind commits)"
  if ! git rebase --quiet origin/main; then
    git rebase --abort
    echo
    echo "CONFLICT rebasing onto main. The worktree is back as it was."
    echo "Resolve it by hand, then rerun this script:"
    echo "  git fetch origin"
    echo "  git rebase origin/main"
    exit 1
  fi
else
  echo "already on top of origin/main"
fi

ahead=$(git rev-list --count origin/main..HEAD)
if [ "$ahead" = "0" ]; then
  echo "no commits beyond main; nothing to merge"
  exit 0
fi

# 3. Guards, on exactly what main is about to become.
echo "guards"
(cd "$top/dnd-app" && npm run guards) || {
  echo
  echo "A guard is red. Nothing merged. Fix it, then rerun."
  exit 1
}

# 4. Merge into main at the root, and push.
if [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then
  echo
  echo "The root checkout has uncommitted edits to tracked files:"
  git -C "$root" status --short --untracked-files=no | sed 's/^/  /'
  echo "Commit or stash them there, then rerun. Nothing merged."
  exit 1
fi

echo "merging into main"
git -C "$root" pull --ff-only --quiet origin main || exit 1
git -C "$root" merge --ff-only --quiet "$branch" || {
  echo "main moved between the rebase and the merge. Rerun."
  exit 1
}
git -C "$root" push --quiet origin main || exit 1
echo "pushed: $(git -C "$root" log --oneline -1 main)"

# 5. Every other worktree takes it in.
echo
"$root/catchup-worktrees.sh"
