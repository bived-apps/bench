# Required checks

Bive's expected checks before merging a pull request. This page is a repository-readable inventory: it names the
automated GitHub Actions checks, their conditions, and the checks that are run locally by a coordinator. It describes
Bive's intended merge policy and maps to the workflow files; it does **not** prove which checks GitHub branch
protection currently requires (that configuration lives in the repository's settings). The workflow files named below
are the source to compare against and to update when check names or behavior change.

## Automated checks (GitHub Actions)

These run on GitHub and appear as commit statuses on a pull request.

### `bive-tests / tests`

- **Workflow file**: `.github/workflows/bive-tests.yml`
- **Job**: `tests`
- **Triggers**: `push` to `main` and `bived`; `pull_request` (default activity types: `opened`, `synchronize`, `reopened`).
- **Runs**: `ubuntu-latest`, Node 22, `node --test tests/*.test.ts`, timeout 10 minutes.
- **What it checks**: the repository's test suite (`tests/*.test.ts`).
- **Expected on PRs**: yes — the `pull_request` trigger runs it on pull requests (default activity types).

### `bive-inviolable / check`

- **Workflow file**: `.github/workflows/bive-inviolable.yml`
- **Job**: `check`
- **Triggers**: `pull_request` of types `opened`, `synchronize`, `reopened`, `labeled`, `unlabeled`.
- **Condition (job `if`)**: runs only when `github.head_ref` starts with `issue/` **and** the pull request does not
  carry the `coordinator` label:
  `startsWith(github.head_ref, 'issue/') && !contains(github.event.pull_request.labels.*.name, 'coordinator')`.
- **What it checks**: compares the changed files against the base branch and fails if any inviolable path changed.
  The matched paths are: `.bive/registry-id`, anything under `.bive/prompts/` or `.bive/templates/`, anything under
  `.opencode/plugins/` or `.opencode/plugin/`, files matching `.github/workflows/bive-*`, `opencode.jsonc`, and
  `AGENTS.md`.
- **Skip conditions** (the job is skipped, not failed):
  - the head branch does not start with `issue/` (for example a coordinator's own pull request on another branch);
  - the pull request carries the `coordinator` label (a coordinator's own pull request that legitimately changes an
    inviolable file).
- **Why**: a delegate's pull request must never change Bive's inviolable files (see `AGENTS.md` › Inviolable prompts).
  Only the coordinator changes them, and only on pull requests it labels `coordinator`.

### `bive-merge-gate / merge-gate`

- **Workflow file**: `.github/workflows/bive-merge-gate.yml`; script `.github/scripts/check-merge-gate.mjs`, decision
  in `.github/scripts/merge-gate-lib.mjs`.
- **Job**: `check`
- **Triggers**: `pull_request_target` on pull requests targeting `bived` or `milestone/**`, types `opened`,
  `synchronize`, `reopened`, `labeled`, `unlabeled`. It checks out the base commit only and never runs code from the
  pull request's head; its permissions are read-only (`contents`, `pull-requests`, `checks`).
- **Runs**: `ubuntu-latest`, Node 22, timeout 15 minutes. It waits (every 10 seconds, at most 12 minutes, each `gh`
  call limited to 15 seconds) until the other checks have finished, then decides.
- **Authorization**: exactly one label `bive-merge-authorized-until-YYYY-MM-DD` on the pull request, a real calendar
  date, valid through 23:59:59 UTC of that date and only while the base is `bived` or `milestone/<name>` (one path
  segment). Only the owner applies it, after the coordinator's approval and when the supervisor is about to merge;
  the coordinator never does, also on its own pull requests. Adding or removing it re-runs the gate.
- **Red before the label is expected**: on every pull request without the label the gate fails with "exactly one
  dated merge-authorization label is required". It means "waiting for the owner", not a failure to fix.
- **What it checks**: the authorization above; exactly one `bive-tests / tests` and one `bive-inviolable / check`,
  both `pass`; every other check except its own `pass` as well. The one accepted exception: `bive-inviolable / check`
  may be `skipping` on a pull request labelled `coordinator` (its job condition skips it there). It re-reads the pull
  request after reading the checks and fails if the head, base or labels changed.
- **Fails on**: a missing, malformed, duplicate or expired label; any check pending past the deadline, missing,
  skipped (other than the exception), failed or cancelled; a pull request whose head or base changed during the run.
- **Several coordinators**: each approves only pull requests based on its own milestone branch; the gate does not
  check which coordinator approved, the supervisor does (`AGENTS.md` › Roles).
- **Expiry is not re-evaluated on its own**: a gate that passed stays green after its date. The owner applies the
  label dated the day of the merge, and the supervisor merges that day with `gh pr merge --merge
  --match-head-commit <sha>`, so a push after the gate's run refuses the merge.

## Branch protection (owner, in GitHub's settings)

The workflows report checks; they do not make GitHub enforce them. For the gate to block GitHub's merge button and
direct pushes, the owner configures branch protection (or a ruleset) on `bived` and `milestone/*` to
require the status checks `bive-merge-gate / merge-gate` and `bive-tests / tests`; the gate itself judges
`bive-inviolable / check`, including its skip on coordinator pull requests. A ruleset names a required check by its
job (check-run) name alone, `merge-gate` and `tests` with GitHub Actions as source: every workflow's job keeps a
name of its own, or the requirement matches several checks (#94). Until that configuration exists, the
gate is only as strong as the supervisor's procedure. No file in this repository proves that it exists; check the
settings.

## Local and manual checks (not GitHub statuses)

These are run by people or agents on their own machine. They are **not** GitHub required statuses and do not appear as
commit checks on a pull request.

- **Fast checks (delegate)**: lint and the tests of the files touched, for example
  `node --test tests/<the test of the file touched>.test.ts`.
- **Core checks (coordinator, once per batch of merges)**: `node --test tests/*.test.ts`; and
  `opencode plugin list` showing every Bive plugin with a real ID (not `-`), run after a session has started in the
  checkout.
- **Full checks (before a release)**: the two above, plus a fresh-clone install check where a write to
  `../outside.txt` is refused by the guard and `.bive/state/tokens.jsonl` fills.
- **`opencode plugin list`** is a local/manual check; it is not a GitHub required status.

## What this document does not say

- It does not prove which checks GitHub branch protection currently requires, nor that any check is marked
  "required" in repository settings. Branch protection and rulesets are configured under the repository's settings;
  compare them against the checks listed here.
- It does not say who merges: the supervisor alone, after the coordinator's approval (`AGENTS.md` › Roles).
- Workflow job names are part of the check identity. If a workflow or job is renamed, update this document and the
  repository's branch-protection configuration together so they keep matching.