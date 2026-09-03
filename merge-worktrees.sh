#!/bin/zsh
# Take every worktree into main, one after another: commit what is
# there, rebase it onto main, fast-forward main to it, and on to the
# next, which rebases onto the main the last one just made. Then the
# check runs once on what main has become, main is pushed, and every
# worktree is caught up so all of them sit on the new main.
#
# Run from your own terminal, from anywhere:
#
#   <repo>/merge-worktrees.sh
#
# Never from the Claude session inside a worktree: that session is
# sandboxed to its own folder and cannot reach the root where main
# lives. In Claude Code, type the line with a ! in front and it runs in
# your shell.
#
# The repo is the folder this script lives in, so the same file works
# in any repo it is copied to. Per-repo settings come from
# worktree-flow.conf beside it: `check` must pass before anything is
# pushed, and `autoresolve` names the conflicts the script may settle
# on its own (an append-only log, a literal every branch bumps).
#
# Conflicts. One the rules cover is settled on the spot and the rebase
# carries on. One they do not cover stops the script at that worktree,
# with the rebase put back as it was and the exact lines to run. What
# was merged before it is kept in local main, unpushed. Resolve it,
# then rerun: worktrees already taken in have nothing left to merge and
# are passed over, and the script picks up where it stopped.
#
# Where else it stops, and why:
#   - the root has uncommitted edits to tracked files: merging
#     underneath them is how work gets tangled. Commit or stash there.
#   - a worktree is in the middle of a rebase already: finish or abort
#     that one by hand first.
#   - the check fails on the merged main: nothing is pushed. Local
#     main holds every merge; fix it there, run the check, push.
# Nothing after a stop has happened; the script is safe to rerun.

set -u

root=${0:A:h}
trees="$root/.claude/worktrees"
cd "$root" || exit 1

check=''; lockfile=''; install=''; autoresolve=()
[ -f "$root/worktree-flow.conf" ] && source "$root/worktree-flow.conf"

# Settle a rebase that has stopped on a conflict, using the autoresolve rules
# from worktree-flow.conf, and carry it through to the end. Returns 0 when the
# rebase finished; 1 when something the rules do not cover stopped it, in
# which case the rebase is left stopped and the caller aborts it as before.
settle_rebase() {
  local wt=$1 label=$2 f r rule how pat
  while [ -d "$(git -C "$wt" rev-parse --git-path rebase-merge)" ] \
     || [ -d "$(git -C "$wt" rev-parse --git-path rebase-apply)" ]; do
    local files=$(git -C "$wt" diff --name-only --diff-filter=U)
    [ -z "$files" ] && return 1            # stopped, but nothing unmerged: not ours to guess at
    for f in ${(f)files}; do
      rule=''
      for r in "${autoresolve[@]}"; do [ "${r%% *}" = "$f" ] && rule=$r; done
      [ -z "$rule" ] && { echo "  $label  conflict in $f, and no rule covers it"; return 1; }
      how=$(echo "$rule" | awk '{print $2}')
      pat=$(echo "$rule" | cut -d' ' -f3-)
      case "$how" in
        union)
          awk '/^<<<<<<< /{next} /^=======$/{next} /^>>>>>>> /{next} {print}' \
            "$wt/$f" > "$wt/$f.settle" && mv "$wt/$f.settle" "$wt/$f" ;;
        theirs)
          if ! awk -v pat="$pat" \
               '/^<<<<<<< /{inb=1;next} /^>>>>>>> /{inb=0;next} /^=======$/{next}
                inb && $0 !~ pat {bad=1} END{exit bad}' "$wt/$f"; then
            echo "  $label  conflict in $f goes beyond '$pat'"; return 1
          fi
          awk '/^<<<<<<< /{side="ours";next} /^=======$/{side="theirs";next}
               /^>>>>>>> /{side="";next} side=="ours"{next} {print}' \
            "$wt/$f" > "$wt/$f.settle" && mv "$wt/$f.settle" "$wt/$f" ;;
        *) echo "  $label  rule for $f says '$how', which is not a thing"; return 1 ;;
      esac
      git -C "$wt" add "$f"
      echo "  $label  settled $f ($how)"
    done
    GIT_EDITOR=true git -C "$wt" rebase --continue >/dev/null 2>&1 || true
  done
  return 0
}

# A commit message for edits a worktree was left with. The name says
# where it came from; the date says when it was swept up.
sweep_message() { echo "$1: uncommitted work taken in on $(date +%Y-%m-%d)"; }

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "The root checkout has uncommitted edits to tracked files:"
  git status --short --untracked-files=no | sed 's/^/  /'
  echo "Commit or stash them there, then rerun. Nothing merged."
  exit 1
fi

echo "fetching origin"
git fetch origin --quiet || exit 1
git pull --ff-only --quiet origin main || {
  echo "Could not fast-forward local main to GitHub's: the two have"
  echo "diverged. Sort that out in the root first. Nothing merged."
  exit 1
}
echo "main: $(git log --oneline -1 main)"
echo

merged=0; skipped=0
for wt in "$trees"/*(/N); do
  name=${wt:t}
  branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD)
  echo "== $name ($branch)"

  if [ -d "$(git -C "$wt" rev-parse --git-path rebase-merge)" ] \
     || [ -d "$(git -C "$wt" rev-parse --git-path rebase-apply)" ]; then
    echo "  in the middle of a rebase already. Finish or abort it by hand:"
    echo "    cd $wt"
    echo "    git status"
    echo "  then rerun. Stopping; what was merged so far is in local main, unpushed."
    exit 1
  fi

  # 1. Commit whatever was left there.
  if [ -n "$(git -C "$wt" status --porcelain)" ]; then
    git -C "$wt" add -A
    git -C "$wt" commit --quiet -m "$(sweep_message "$name")" || exit 1
    echo "  committed: $(sweep_message "$name")"
  fi

  # 2. Nothing beyond main? Nothing to take in.
  if [ "$(git -C "$wt" rev-list --count main..HEAD)" = "0" ]; then
    echo "  nothing beyond main"
    skipped=$((skipped+1))
    continue
  fi

  # 3. Rebase onto main as it stands now -- including what the last
  #    worktree just put there.
  behind=$(git -C "$wt" rev-list --count HEAD..main)
  [ "$behind" != "0" ] && echo "  rebasing onto main ($behind behind)"
  if ! git -C "$wt" rebase --quiet main >/dev/null 2>&1 && ! settle_rebase "$wt" "$name"; then
    git -C "$wt" rebase --abort
    echo
    echo "CONFLICT rebasing $name onto main, and no rule covers it."
    echo "The worktree is back as it was. Resolve it by hand:"
    echo "  cd $wt"
    echo "  git rebase main"
    echo "  (fix the files it names, git add them, git rebase --continue)"
    echo "then rerun this script; it picks up here."
    echo "Merged before the stop and kept in local main, unpushed: $merged worktree(s)."
    exit 1
  fi

  # 4. Fast-forward main to it.
  git merge --ff-only --quiet "$branch" || {
    echo "  could not fast-forward main to $branch after a clean rebase. Stopping."
    exit 1
  }
  echo "  merged: $(git log --oneline -1 main)"
  merged=$((merged+1))
done

echo
if [ "$merged" = "0" ]; then
  echo "nothing to merge: every worktree was already on main ($skipped looked at)"
  exit 0
fi

# 5. The check, once, on exactly what main has become.
if [ -n "$check" ]; then
  echo "check on main: $check"
  eval "$check" || {
    echo
    echo "The check failed on the merged main. Nothing pushed."
    echo "Local main holds all $merged merge(s); fix it in the root, run the"
    echo "check again, then: git push origin main && ./catchup-worktrees.sh"
    exit 1
  }
fi

# 6. Push, and bring every worktree onto the new main.
git push --quiet origin main || exit 1
echo "pushed: $(git log --oneline -1 main)"
echo "$merged merged, $skipped had nothing"
echo
"$root/catchup-worktrees.sh"
