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
- **Job**: `merge-gate`
- **Triggers**: `pull_request_target` on pull requests targeting `bived` or `milestone/**`, types `opened`,
  `synchronize`, `reopened`, `labeled`, `unlabeled`. It checks out the base commit only and never runs code from the
  pull request's head; its permissions are read-only (`contents`, `pull-requests`, `checks`).
- **Runs**: `ubuntu-latest`, Node 22, timeout 15 minutes. It waits (every 10 seconds, at most 12 minutes, each `gh`
  call limited to 15 seconds) until the other checks have finished, then decides.
- **Authorization**: exactly one label `bive-merge-authorized-until-YYYY-MM-DD` and one matching `bive-grant-*`
  label. The date must be real and is valid through 23:59:59.999 UTC, only on `bived` or `milestone/<name>` (one path
  segment). The bound grant is derived from the PR number, full head SHA, base and expiry date; a push, retarget,
  another PR or changed date invalidates it. It is binding metadata, not a signature or proof of a human.
  Only the owner grants authorization, using the manual action after the coordinator's hand-over and when the
  supervisor is about to merge. Neither coordinator nor delegate may invoke that action on the owner's behalf.
- **Red before authorization is expected**: a missing dated label or matching bound grant means "waiting for the
  owner", not a failure to fix. A dated label alone is no longer sufficient.
- **What it checks**: the authorization above; exactly one `bive-tests / tests` and one `bive-inviolable / check`,
  both `pass`; every other check except its own `pass` as well. The one accepted exception: `bive-inviolable / check`
  may be `skipping` on a pull request labelled `coordinator` (its job condition skips it there). It re-reads the pull
  request after reading the checks and fails if the head, base or labels changed.
- **Fails on**: a missing, malformed, duplicate, expired or mismatched grant; any check pending past the deadline, missing,
  skipped (other than the exception), failed or cancelled; a pull request whose head or base changed during the run.
- **Several coordinators**: each approves only pull requests based on its own milestone branch; the gate does not
  check which coordinator approved, the supervisor does (`AGENTS.md` › Roles).
- **Expiry is not re-evaluated on its own**: a gate that passed stays green after its date. The supervisor must merge
  that UTC day with `gh pr merge --merge --match-head-commit <sha>` and re-run the gate immediately before merging
  if there is any delay. Crossing UTC midnight requires fresh owner authorization. Pinning the merge protects
  against a changed head, not against expiry or a changed base: check those too.

### `bive-authorize-merge / authorize` (owner action, not a required PR check)

- **Workflow file**: `.github/workflows/bive-authorize-merge.yml`; helper `.github/scripts/authorize-merge.mjs`.
- **Trigger**: `workflow_dispatch` on the repository's default branch, with PR number and full reviewed head SHA.
- **Setup**: repository variable `BIVE_MERGE_OWNER` names the human owner's GitHub login, not an organisation name.
  In **Settings → Secrets and variables → Actions → Variables**, create `BIVE_MERGE_OWNER` with that login.
  No PAT or additional secret is needed. Missing configuration fails closed.
  Then select the default branch in **Actions → bive-authorize-merge → Run workflow**, enter the PR number and
  full reviewed head SHA, and run it yourself. See [`MERGE-AUTHORIZATION.md`](MERGE-AUTHORIZATION.md).
- **Trust**: verifies original and rerun actor against that owner and the exact default-branch workflow ref; checks
  out default-branch code only, never PR-head code; no stored PAT. Account identity cannot distinguish a human
  from an agent using the same account: agents remain prohibited from dispatching or rerunning this action.
- **Runs**: Node 22, timeout five minutes; each GitHub request bounded to 15 seconds, with bounded pagination.
  Token permissions: contents/pull-requests read, issues/actions write. Never merges or approves a PR.
- **Checks**: open, non-draft, same-repository PR on an allowed base; exact head; a latest `Ready to merge`
  comment containing that head and the coordinator role; a completed, matching trusted gate run to rerun.
  A comment is procedural evidence, not cryptographic role verification. The supervisor still reviews the hand-over.
- **Effect**: preserves unrelated labels, replaces old authorization metadata with today's bound grant, rechecks
  the head/base/state and grant, and explicitly reruns the matching gate. GITHUB_TOKEN label changes do not trigger
  `pull_request_target`, so relying on a label event would leave the gate red.
  Gate runs use the exact title `Merge gate PR #<number> head <sha> base <base>`; the action checks that title,
  workflow path and event. `pull_request_target` runs may have an empty API `pull_requests` array, so it is not
  used for matching. Older runs without this title cannot be selected; deploy the gate update before using the action.
  An already-open PR may need a fresh normal `pull_request_target` event after rollout (for example an owner adding
  a harmless label) to create such a run. Rerunning an older run does not update its frozen workflow/base revision.
- **Failure**: partial writes are reported and the new bound grant is removed on subsequent failure, with cleanup
  failures explicit. A successful action means the gate rerun was requested, not that checks passed or merging is
  authorized already. Read the actual gate result.
- **Deployment**: the workflow/helper must reach the default branch to expose the button, and gate/helper changes
  must reach each relevant integration base. Before rollout, the old gate is used for bootstrap; do not claim the
  action is available from an unmerged feature branch. Frozen benchmark fixture revisions are not rewritten.

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
