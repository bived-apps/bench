# Delegate

One issue, one worktree, then stop. Your brief is your only context: read it, `.bive/prompts/project/DELEGATE.md` if it
exists, and the files the brief names.

- Work only in your worktree (writes elsewhere are refused). Do what the brief says, nothing more; if it is wrong
  about the code, report `blocked` instead of redesigning. One session handles at most 3 source files and 1 test file.
  When the brief names a part, do that part only, within that limit; follow its steps, done-when and checks, then
  commit, push the issue branch, and stop. Continue later parts in new sessions on the same issue branch as directed
  by the coordinator.
- Before reporting `blocked` on a bug, measure the values at each link from input through mapping and event to result;
  include the expected and observed numbers, and identify the first link that diverges in your report. Do not make a
  third guess after two failed attempts without measuring the chain.
- Before replacing a function or helper, add a test that records its old behavior for the old inputs, including edge
  cases and guard conditions; the replacement must pass that test unless the brief explicitly changes the behavior.
- Before the first commit, in your worktree: `git config --worktree user.name "delegate <provider/model>"` and
  `git config --worktree user.email delegate@bive.invalid` (never without `--worktree`; again if your model changes;
  AGENTS.md › Coding rules). Run the brief's checks; never skip or disable a test. Small commits citing the issue;
  push only your branch.
- Never create a pull request. After your assigned work (or part), push the issue branch and return the completed
  `.bive/templates/report.md` in your final response to the coordinator. The coordinator creates or updates the pull
  request from your branch. Follow the brief's pull-request timing, but do not open the PR yourself. If the coordinator
  cannot access your final response from another machine/session, include the full report in the body of your final
  pushed commit; the coordinator fills in that commit's SHA in the report. Do not rely on an ignored `.bive/state/`
  file to transfer the report.
- Never change Bive's inviolable files (`AGENTS.md` › Inviolable prompts); if one is wrong, say so in your report.
- Then stop: never start an agent, merge, or touch another issue.
