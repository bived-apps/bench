# The coordinator's routine, as commands

What `.bive/prompts/COORDINATOR.md` steps 5, 7 and 9 mean at the shell, for a coordinator that wants the exact
commands. `<n>` is the issue, `<slug>` a short name, `<base>` the integration branch, `<model>` the delegate's
`provider/model`.

## Session start

The label the owner applies to authorize a merge must exist that day (owner, 2026-11-10). Create it, never rename an
older one: renaming moves the label onto every pull request that carries it and would re-date the owner's past
authorizations. The coordinator never applies it.

```bash
label="bive-merge-authorized-until-$(date -u +%F)"
gh label list --search "$label" --json name --jq '.[].name' | grep -qx "$label" \
  || gh label create "$label" --color B60205 --description "Owner only: authorizes one merge through $(date -u +%F) UTC"
```

## Start a delegate (step 5)

```bash
git worktree add .worktrees/issue-<n> -b issue/<n>-<slug> <base>
git config extensions.worktreeConfig true                     # once per clone
git -C .worktrees/issue-<n> config --worktree user.name "delegate <model>"
git -C .worktrees/issue-<n> config --worktree user.email delegate@bive.invalid
mkdir -p .worktrees/issue-<n>/.bive/state
echo delegate > .worktrees/issue-<n>/.bive/state/role          # the guard's sign
# the brief: .bive/templates/brief.md filled into .bive/state/briefs/<n>.md
gh issue comment <n> --body "Started: branch issue/<n>-<slug>, delegate <model>"
brief="$(cat .bive/state/briefs/<n>.md)"                        # read here: outside the delegate's worktree
(cd .worktrees/issue-<n> && BIVE_ROLE=delegate opencode run --agent delegate --model <model> "$brief") &
echo $!                                                         # record the PID (AGENTS.md › Never)
```

The `delegate` agent of `opencode.jsonc` gives the session `.bive/prompts/DELEGATE.md` as its system prompt.
`opencode debug agents` lists the agents OpenCode resolved (OpenCode 2.2.5 has no `opencode agent` subcommand).

A project whose checks need a local environment links it into the worktree (for example
`ln -s "$PWD/.venv" .worktrees/issue-<n>/.venv`).

## Open and review a pull request (step 7)

The delegate pushes its branch and returns the filled report; it never opens a pull request. The coordinator creates
the PR from the pushed branch and uses the report as the PR body. For a multi-part issue, open/update it according to
the brief's timing. If the delegate's final response is not accessible from the coordinator's machine, recover the
report from the final pushed commit body (do not expect the delegate's ignored `.bive/state/` file to travel):

```bash
git fetch origin issue/<n>-<slug>
git show -s --format=%H FETCH_HEAD
git log -1 --format=%b FETCH_HEAD
```

The report's Log section should name the commit SHA; the coordinator fills it in if the report was carried in that
commit body. Save the report on the coordinator's machine in `.bive/state/briefs/<n>-report.md`, then run:

```bash
gh pr create --base <base> --head issue/<n>-<slug> --title "#<n>: <title>" --body-file .bive/state/briefs/<n>-report.md
```

The report body starts with `Closes #<n>` when complete, or `Part of #<n>` and what remains.

```bash
gh pr view <pr> --json body,baseRefName,files,commits \
  --jq '.body, .baseRefName, (.files[].path), (.commits[].authors[] | "\(.name) <\(.email)>")'
```

Read it against the checklist: first line `Closes #N` / `Part of #N`; the sections State, Changed, Checks, Left, Log
filled and no `<!--` left; the base; no path matching the inviolable list (`AGENTS.md` › Inviolable prompts, the same
list as `bive-inviolable`); every author `delegate <provider/model> <delegate@bive.invalid>`. Then the brief's checks
in the worktree if the head changed since the report, and the diff. Then wait for CI and hand over:

```bash
gh pr checks <pr> --watch                      # returns when the checks finish; every one but bive-merge-gate green
gh pr review <pr> --approve --body "Ready to merge: <the checks you ran>"
```

The supervisor merges (`gh pr merge <pr> --merge --match-head-commit <sha>`, after the label); its queue is
`gh pr list --base <base> --search "review:approved"`. The coordinator never merges, closes or pushes
to `<base>`. To be told when a pull request is merged without a watcher plugin: `gh pr checks` for the checks, then
`until [ "$(gh pr view <pr> --json state --jq .state)" != OPEN ]; do sleep 60; done` in the shell, when a session
really needs to wait; most of the time the next session reads `gh pr list` instead.
Once merged, if the issue is still open (GitHub closes on the default branch only):

```bash
gh issue close <n> --comment "Done in <base> (PR #<pr>)"
```

`bive-merge-gate / merge-gate` stays red on every pull request until the owner applies the dated label
`bive-merge-authorized-until-YYYY-MM-DD` (`docs/REQUIRED-CHECKS.md`): read that red as "waiting for the owner's label",
not as a failure to brief again. The coordinator never applies the label.

## After the batch (step 9)

The core checks once, after the last merge, then `HANDOFF.md` and `ROADMAP.md` in one commit on a coordinator branch,
opened as a pull request labelled `coordinator` and merged by the supervisor like any other. Clean up:
`git worktree list`, then `git worktree remove .worktrees/issue-<n>` for each merged issue (never forced).

## Two coordinators at once

The supervisor may run one coordinator per milestone, at most two at once (`AGENTS.md` › Roles). Each works in its own
clone, because `.worktrees/`, `.bive/state/` and the guard belong to one checkout:

```bash
git clone <repository> <dir> && cd <dir> && git switch milestone/<name>
gh pr list --base milestone/<name>                    # the pull requests this coordinator reviews, and no others
gh pr list --label coordinator --state open           # before opening a coordinator PR on an inviolable file: empty
```

At gate 1 each milestone lists the files it will touch; where the two lists overlap, the supervisor names one writer
or the order, and the brief says so. Each coordinator writes only its milestone's section of `HANDOFF.md` and
`ROADMAP.md`.

## GitHub pull-request merge methods

The repository allows `merge` only (`AGENTS.md` › Project rules): a merge commit keeps every delegate's commit under
its author; squash would attribute the result to the account that pressed the button. The owner keeps **Settings →
General → Pull Requests** aligned.

## Scripting it

A project may script this routine in its own repository (start, review, status, clean): one Python / ImGui project
did, in about 400 lines with tests, and used it for a whole batch. Bive ships no such script (HANDOFF › Decisions,
*No machinery*): the prompt and this page are enough for any coordinator, and a script stays the project's own,
outside Bive's files.
