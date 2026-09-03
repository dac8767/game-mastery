# Worktrees — the commands

Everything here uses a worktree named `sessions` as the example. Swap
in the name of yours. `git worktree list` from the repo root shows what
exists.

Main lives in the root folder. A worktree is a branch in its own folder
under `.claude/worktrees/<name>`, on a branch called `worktree-<name>`.
Merging into main always happens from the root, never inside a
worktree — Git refuses to check out main in two places at once.

## Launch the app

```bash
cd ~/Developer/game-mastery/dnd-app && pwd
pkill -f "convex dev"
pkill -f "next dev"
lsof -ti tcp:3000 | xargs -I{} kill -9 {}
npm run dev
```

Then open http://localhost:3000. If the app looks wrong, check WHICH
checkout is on port 3000 — a worktree's dev server holds the port just
as well as main's does:

```bash
lsof -ti tcp:3000 -sTCP:LISTEN | xargs -I{} lsof -a -p {} -d cwd -Fn
```

## Create a worktree

Pull main first. A worktree is cut from LOCAL main, and a stale one
starts out behind before any work is done.

```bash
cd ~/Developer/game-mastery && pwd
git pull origin main
claude --worktree sessions
```

Then, in the chat that opens, a fresh worktree has no `node_modules`:

```bash
cd dnd-app && npm install
```

## Finish a worktree, in one command

From any terminal, naming the worktree:

```bash
~/Developer/game-mastery/finish-worktree.sh sessions "Sessions: what changed"
```

From inside the worktree the name can be left off, and with no name
from anywhere else it lists the worktrees and asks. A new terminal
opens in `~` and knows nothing about where you were working, which is
why the name is there.

It commits everything in the worktree with that message, rebases onto
origin/main, runs the guards, fast-forwards main to it at the root,
pushes, and then runs `catchup-worktrees.sh` so every other worktree
takes the work in. It stops, having changed nothing further, if the
rebase conflicts, a guard is red, or the root has uncommitted edits;
each stop says what to do. Run from the root it refuses, since main
has nothing to merge into itself.

**Run it from your terminal, not from the worktree's Claude session.**
That session is sandboxed to its own folder and cannot reach the root
where main lives. Asked to finish, the most it can do is commit and
rebase, and it then hands the merge back to you — and it may describe
main's state from memory rather than from Git, which is how one session
"corrected" a command that was already right. The script checks this
first and stops before touching anything if it cannot reach the root.
In Claude Code, type the line with a `!` in front and it runs in your
own shell instead.

## Finish a worktree, by hand

The same steps, one at a time. The rebase brings the branch up to
date first, so the merge into main is a plain fast-forward and the
guards run on exactly what main will become.

```bash
cd ~/Developer/game-mastery/.claude/worktrees/sessions/dnd-app && pwd
git add -A
git commit -m "Sessions: what changed"
git fetch origin
git rebase origin/main
npm run guards
cd ~/Developer/game-mastery && pwd
git pull origin main
git merge --ff-only worktree-sessions
git push origin main
```

If the rebase stops on a conflict: open the file it names, fix it, then

```bash
git add -A
git rebase --continue
```

and carry on from `npm run guards`. Rebasing replays your commits one
at a time, so each conflict is small and about one change. To abandon
a rebase that has gone wrong and get back to where you were:

```bash
git rebase --abort
```

## Catch up every worktree at once

The worktrees stay open, one per tool, and you go back to them. So
each one needs to take in main whenever main moves. One script does
all of them; run it from anywhere after any merge to main:

```bash
~/Developer/game-mastery/catchup-worktrees.sh
```

It fetches once, then rebases each worktree branch onto origin/main,
carrying uncommitted edits across, and runs `npm install` in a
worktree only if main changed the lockfile. A worktree whose rebase
hits a conflict is put back exactly as it was and named at the end,
so one stuck tool never blocks the rest; catch that one up by hand
with the block below. The root checkout is left alone.

## Keep one worktree current with main

The same thing for a single worktree, by hand. Run it in the worktree
before you start a session there, or when the script reported that
this one conflicted.

```bash
cd ~/Developer/game-mastery/.claude/worktrees/combat/dnd-app && pwd
git fetch origin
git rebase --autostash origin/main
npm install
```

What it does:

- `fetch` learns what main is now. It changes nothing on disk.
- `rebase` moves this worktree's commits on top of the new main. If
  the worktree has no commits of its own since the last merge, that
  is a plain fast-forward and it now IS main.
- `--autostash` parks any uncommitted edits, rebases, and puts them
  back. Without it Git refuses to rebase a dirty tree.
- `npm install` in case main brought a new dependency. It is a no-op
  otherwise.

The worktree you just merged does not need this. After `git merge
--ff-only worktree-sessions`, main and `worktree-sessions` are the
same commit, so that worktree is already current. Every OTHER
worktree is now behind by exactly that work.

The sooner you do this, the smaller the diff being reconciled. A
worktree that has not caught up in a month is the one that hits a
real conflict.

## Remove a worktree

Only if a tool is really finished. From the root, so `git worktree
list` only shows live work. A worktree that a Claude session still has
open is marked `locked` and will refuse; close that session first.

```bash
cd ~/Developer/game-mastery && pwd
git worktree remove .claude/worktrees/sessions
git branch -d worktree-sessions
```

`git branch -d` refuses if the branch has commits main does not. That
is the safety catch working: it means the worktree was not merged.
Merge it, or use `-D` only if you are sure the work is meant to be
thrown away.

## See where everything stands

```bash
cd ~/Developer/game-mastery && pwd
git fetch origin
git worktree list
git branch --no-merged main
git log --oneline -1 main
git log --oneline -1 origin/main
```

`--no-merged main` lists the branches with work main does not have.
The last two lines should name the same commit; if origin is ahead,
pull.

## The rhythm, with several worktrees open

1. Work in a worktree. Commit there as you go.
2. When a piece is done, run `finish-worktree.sh` there. It rebases,
   runs the guards, merges to main, pushes, and catches up every other
   worktree. That worktree is now identical to main, and the others
   have taken in its work.
3. Carry on in whichever worktree is next.

## Keeping conflicts rare

Conflicts are not caused by main moving. They are caused by two
branches editing the same lines.

- The file ownership in `dnd-app/TOOLS.md` is the real prevention. Two
  worktrees that never touch the same file cannot conflict.
- The shared files are where it bites: `dnd-app/app/globals.css`,
  `dnd-app/components/navItems.ts`, `dnd-app/convex/schema.ts`. Add a
  block in your own section rather than editing a neighbour's;
  additions at the end of a file merge cleaner than edits in the middle.
- Merge finished work as soon as it is finished, not in a batch. Five
  small merges are five small rebases for everyone else.
- Pull main in the root before creating a worktree.
