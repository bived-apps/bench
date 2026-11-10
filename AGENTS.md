# Instructions for agents

Read this file, then [`HANDOFF.md`](HANDOFF.md), before changing anything. Your role's prompt is in
[`.bive/prompts/`](.bive/prompts/).

## Roles

- **Supervisor**: the owner (with their Claude project), another person with theirs, or an agent the owner has
  qualified with the test of `.bive/templates/supervisor-test.md` (logged in `HANDOFF.md` › Decisions, per model
  and version; a model that did not pass never merges). Agrees the plan and each epic's split, answers the three
  gates, and is **the only one who merges or closes a pull request**, on the integration branch as on `main`, with
  GitHub's merge commit (`gh pr merge --merge`), never squash (it would make the owner the author). Never acts as
  coordinator or delegate: whoever merges did not write (owner, 2026-11-09). Merges only once the owner's dated label
  has turned `bive-merge-gate / merge-gate` green (`docs/REQUIRED-CHECKS.md`). Starts the coordinators and arbitrates
  the files two milestones share (owner, 2026-11-09).
- **Coordinator**: one per milestone branch (`milestone/<name>`; Bive's own is `bived`), at most two at once, each
  started by the supervisor in its own clone; it approves only pull requests based on its branch. Splits, briefs,
  starts delegates, creates and reviews issue pull requests, approves them and asks the supervisor to merge. Never
  merges, never closes a pull request, never pushes to the integration branch or `main`, never writes product code: a
  delegate's work that failed twice is split again or raised at gate 2, not taken over (owner, 2026-11-09). Its own
  pull requests (the inviolable files, `HANDOFF.md`, `ROADMAP.md`) go the same way: a branch, a pull request labelled
  `coordinator`, the supervisor's merge.
- **Delegate**: one issue and one worktree; pushes its branch, returns its report to the coordinator, then stops.
  Never creates a pull request or starts another agent.

## Rules

- **One branch and one pull request per issue**: `issue/<n>-<slug>`. Only the coordinator creates pull requests for
  issue work, after receiving the pushed branch and delegate's report. The body starts with `Closes #N` (or `Part of
  #N` and what is left) and holds the delegate's report.
- **Claim the issue** with a short comment before working on it; update it with the result.
- **Stay in your worktree**: the guard plugin refuses writes outside it, including shell redirections; a delegate's
  commands may not name any path outside it (absolute, `~`, `$HOME`, `..`) apart from the system folders. A
  delegate's worktree is `.worktrees/issue-<n>`, inside the checkout and git-ignored (never `../<repo>-<n>`: the
  coordinator's session may not write there).
- **Never**: force-push, rewrite pushed history, push to `main`, `rm -rf`, kill processes by pattern (`pkill -f`,
  `killall`); record the PID of each process you start and target that PID when stopping it. Never read SSH keys or the
  private paths listed in `opencode.jsonc`.
- **Keep sessions and prompts short**: continue a stuck delegate with one short message rather than a new session;
  a brief names files to read instead of pasting them. Delegate in small tasks with their own done-when and tests.
- **Keep `HANDOFF.md` and `ROADMAP.md` true**: the coordinator updates them once per batch of merges, in the same
  commit as the code they describe. Delete what is no longer accurate rather than adding contradictions.

## Coding rules

Generic, whatever the language (owner, 2026-11-08, taken from the practice of the owner's first project). The project's own rules go under
*Project rules* below.

- **Everything in English**: interface, code, comments, docstrings, documentation.
- **Fail-safe**: no exception swallowed in silence (catch the precise one, or log once and say why); a timeout on
  every subprocess and every network call; a file the program reads may be missing or corrupt without a crash.
- **A linter in the fast checks**; never reformat a whole file; every suppressed warning says why, in parentheses.
- **Tests in three tiers**: *fast* (the delegate, before handing its branch and report to the coordinator: lint and
  the tests of the files touched),
  *core* (the coordinator, once per batch of merges, never after each merge), *full* (before a release).
  CI is separate: run automated checks on pull requests and pushes to the default and integration branches, so a red
  base is visible quickly; this does not replace the coordinator's once-per-batch local core run.
- **Docs change in the same commit** as the code they describe (README, reference pages, HANDOFF, ROADMAP).
- **Commits are authored by the agent that made them, under an explicit name** (owner, 2026-11-08): in its working
  copy an agent sets `git config --worktree user.name "<role> <provider/model>"`, the model's name **and version**,
  the same name as in the registry's llm variable (e.g. `delegate anthropic/claude-sonnet-5-5`, never `delegate` or
  `Claude`), and `git config --worktree user.email "<role>@bive.invalid"`, never the owner's identity. `--worktree`
  is required: plain `git config` writes the config every worktree shares, so one delegate's name becomes everyone's;
  it needs `git config extensions.worktreeConfig true` once per clone. The name is that of the model running now:
  when the session's model changes, set it again before the next commit and sign comments with the new name. Merges
  are merge commits made by the supervisor, so every commit keeps its author; GitHub's squash button would attribute
  the result to the account that pressed it and is disabled in the repository's settings. Anyone must be able to tell
  from `git log` who wrote each change, human or model.
- **No Git hooks**: a delegate is started by the coordinator, never by a Git command.

## Inviolable prompts

- **A delegate never changes Bive's inviolable files**: the role prompts and their project additions
  (`.bive/prompts/`), the templates (`.bive/templates/`), the plugins (`.opencode/plugins/`), `opencode.jsonc`,
  `.bive/registry-id`, this file and the `bive-*` workflows. If one is wrong, it says so in its report. The guard
  plugin refuses these writes (each refusal counts as a violation in the registry) and the `bive-inviolable` check
  fails any `issue/*` pull request that touches them, unless it carries the label `coordinator`: the coordinator's
  own pull requests, the only ones that may change these files (only the coordinator sets that label).
- **Others complete, never edit, the role prompts**: the supervisor or the coordinator adds to a role in
  `.bive/prompts/project/<ROLE>.md`, which may narrow a rule but never loosen or contradict one; the core prompt wins.

## Field reports

- **When**: at the end of each milestone (with gate 3), and at once when a Bive rule, prompt, template or plugin had
  to be worked around or overridden.
- **How**: the coordinator (or the supervisor) fills `.bive/templates/field-report.md`: numbered remarks, each with
  what happened (numbers), what worked, the proposed change and the Bive file it touches. The project's owner passes
  it to Bive's supervisor, who files one issue per change in Bive's repository.
- **No names**: no project, product, repository, person, host, path or private data; "a project", "machine A",
  "the owner". Model ids stay canonical (Bive needs them per model).

## What goes into Bive

Nothing enters the template that is not read by one of the three roles, or by a human, during a task (owner,
2026-11-08). Anything else (a public page, a visualisation, a helper for the registry) lives in its own repository.

## Project rules

<!-- Filled at install, with the owner (cards). Keep each as one line:
- Data: where the program writes (caches, settings, user data) and what never leaves the machine.
- Licences: where a third-party model, asset or dataset is registered (file + table), checked by which test.
- Runtime and versions the owner's machine imposes.
- GitHub PR merge methods (for example `merge, squash`); keep this list aligned with the repository's GitHub settings.
- Anything the owner decided, dated: "**Topic (owner, YYYY-MM-DD)**: …". -->

- **Runtime (owner, 2026-11-08)**: Node 22 on the owner's machine; it runs the TypeScript tests directly
  (`node --test`), no bun. The plugins run inside OpenCode 2 (v2.2.5 verified), which supplies `@opencode/plugin`.
- **GitHub PR merge methods (owner, 2026-11-09)**: `merge` only. The desired repository setting, not an automatic
  one: the owner keeps Settings → General → Pull Requests aligned (squash and rebase off), so that a merge keeps
  each delegate's commits under its name.

## Before committing

<!-- The exact commands of each tier:
- fast (delegate):  <lint command> ; <tests of the files touched> ;
- core (coordinator, once per batch):  <the suite> ;
- full (release):  <everything, on every machine that matters>. -->

- fast (delegate): `node --test tests/<the test of the file touched>.test.ts`.
- core (coordinator, once per batch): `node --test tests/*.test.ts`; `opencode plugin list` shows every Bive plugin with a
  real ID (not `-`), run after a session has started in the checkout (before that it lists none).
- full (release): the two above, then in a fresh clone an OpenCode session where a write to `../outside.txt` is
  refused by the guard and `.bive/state/tokens.jsonl` fills.
