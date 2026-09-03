#!/bin/zsh
# Finish a worktree: commit, rebase onto main, run the check, merge
# into main, push, then rebase every other worktree so they all take
# in the work.
#
# The repo is the folder this script lives in, so the same file works
# in any repo it is copied to. Per-repo settings come from
# worktree-flow.conf beside it: `check` is the command that must pass
# before anything is merged.
#
# From anywhere, naming the worktree (the folder under .claude/worktrees):
#
#   <repo>/finish-worktree.sh sessions "Sessions: what changed"
#
# From inside a worktree, the name can be left off:
#
#   <repo>/finish-worktree.sh "Sessions: what changed"
#
# With no name and not inside a worktree, it lists them and asks. The
# message is the commit message; without one the script asks for that
# too.
#
# Run it from YOUR terminal, not from the Claude session inside the
# worktree. That session is sandboxed to its own checkout and cannot
# reach the root where main lives, so asked to finish, it can only
# commit and rebase, and then has to hand the rest back to you. In
# Claude Code, type the line with a ! in front and it runs in your
# shell.
#
# Where it stops, and why:
#   - the root checkout is not reachable: see above. Nothing has been
#     touched; run the same line from a terminal.
#   - the rebase hits a conflict the conf's autoresolve rules do not
#     cover: the worktree is put back as it was; resolve it by hand (cd
#     there, git fetch origin, git rebase origin/main), then rerun. A
#     covered one (an append-only log, a literal every branch bumps) is
#     settled on the spot.
#   - the check fails: nothing is done until it passes.
#   - the root has uncommitted edits to tracked files: merging
#     underneath them is how work gets tangled. Commit or stash there.
# Nothing after a stop has happened; the script is safe to rerun.

set -u

root=${0:A:h}
trees="$root/.claude/worktrees"

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

# Which worktree? A name as the first argument wins. Otherwise the
# folder this was run from, if that is inside a worktree. Otherwise —
# a fresh terminal opens in ~ and knows nothing — list them and ask.
if [ -n "${1:-}" ] && [ -d "$trees/$1" ]; then
  cd "$trees/$1" || exit 1
  shift
else
  top=$(git rev-parse --show-toplevel 2>/dev/null || true)
  case "$top" in
    "$trees"/*) ;;
    *)
      if [ "$top" = "$root" ]; then
        echo "This is the root checkout (main); it has nothing to merge into itself."
      fi
      echo "Which worktree?"
      ls -1 "$trees" | sed 's/^/  /'
      printf "Name: "
      read -r name
      [ -d "$trees/$name" ] || { echo "No worktree called '$name'. Stopping."; exit 1; }
      cd "$trees/$name" || exit 1
      ;;
  esac
fi
top=$(git rev-parse --show-toplevel)
branch=$(git rev-parse --abbrev-ref HEAD)

# Before anything else: can this shell reach the root checkout? A
# Claude session inside a worktree cannot — its sandbox stops at the
# worktree's own folder — and finding that out AFTER committing and
# rebasing leaves the job half done with the merge still to do.
probe="$root/.finish-worktree-probe"
if ! ( git -C "$root" rev-parse --show-toplevel >/dev/null 2>&1 \
       && touch "$probe" 2>/dev/null && rm -f "$probe" ); then
  echo "Cannot reach the root checkout at $root from here."
  echo "This is what a Claude session inside a worktree sees: it is"
  echo "sandboxed to its own folder. Nothing has been changed."
  echo
  echo "Run the same line from your own terminal:"
  echo "  $root/finish-worktree.sh ${top:t} \"${1:-Tool: what changed}\""
  echo "In Claude Code, put a ! in front and it runs in your shell."
  exit 1
fi

message="${1:-}"
if [ -z "$message" ] && [ -n "$(git status --porcelain)" ]; then
  printf "Commit message: "
  read -r message
  [ -z "$message" ] && { echo "No message. Stopping."; exit 1; }
fi

echo "== ${top:t} ($branch)"

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
  if ! git rebase --quiet origin/main && ! settle_rebase "$top" "$branch"; then
    git rebase --abort
    echo
    echo "CONFLICT rebasing onto main. The worktree is back as it was."
    echo "Resolve it by hand, then rerun this script:"
    echo "  cd $top"
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

# 3. The check, on exactly what main is about to become.
if [ -n "$check" ]; then
  echo "check: $check"
  (cd "$top" && eval "$check") || {
    echo
    echo "The check failed. Nothing merged. Fix it, then rerun."
    exit 1
  }
fi

# 4. Merge into main at the root, and push.
if [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then
  echo
  echo "The root checkout has uncommitted edits to tracked files:"
  git -C "$root" status --short --untracked-files=no | sed 's/^/  /'
  echo "Commit or stash them there, then rerun. Nothing merged."
  exit 1
fi

# Say what main actually is, from Git, before moving it. The state of
# main is something to read, not something to remember: a session
# once corrected a correct command on the strength of a push it
# recalled making, which had already been taken in.
echo "main, local:  $(git -C "$root" log --oneline -1 main)"
echo "main, github: $(git log --oneline -1 origin/main)"
echo "merging into main"
git -C "$root" pull --ff-only --quiet origin main || {
  echo "Could not fast-forward local main to GitHub's. The root has"
  echo "commits GitHub does not; sort that out there first."
  exit 1
}
git -C "$root" merge --ff-only --quiet "$branch" || {
  echo "main moved between the rebase and the merge. Rerun."
  exit 1
}
git -C "$root" push --quiet origin main || exit 1
echo "pushed: $(git -C "$root" log --oneline -1 main)"

# 5. Every other worktree takes it in.
echo
"$root/catchup-worktrees.sh"
