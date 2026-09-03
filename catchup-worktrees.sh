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
# conflict the conf's autoresolve rules cover (an append-only log, a
# literal every branch bumps) is settled on the spot and the rebase
# carried on; any other conflict puts the worktree back exactly as it
# was and names it at the end, so one stuck tool never blocks the
# rest. Catch that one up by hand:
#   cd <that worktree> && git fetch origin && git rebase origin/main
#
# The root checkout (main) is left alone: it is where merges happen,
# and `git pull origin main` there is a different, deliberate act.

set -u

root=${0:A:h}
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
  if git -C "$wt" rebase --autostash --quiet origin/main \
     || settle_rebase "$wt" "$branch"; then
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
