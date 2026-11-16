# Exceptional coordinator merges

Generic to **any app made with Bive**, not a repository-specific privilege. The owner alone holds supervisory
authority. A coordinator may execute one named direct sub-coordinator PR merge only through the opt-in path below.
An advisor has no workflow privileges; a qualification is capability evidence, never a grant.

## Default off; two owner decisions

1. The app's human owner explicitly opts in, through a reviewed change to `.bive/gate.json` on the PR's **base**:
   `{"owner": "<human login>", "skippable": [], "coordinatorMerges": true}`.
   Missing, invalid or false means disabled. Bive ships `false`; this task does not enable it.
2. For each specific merge, the owner applies the normal dated PR authorization, waits for required checks and the
   gate to pass, then approves the exact-scope OpenCode permission prompt from `bive_coordinator_merge`.
   No automatic or saved standing approval: the plugin forces a fresh question even if an inherited rule says allow.
   Explicit deny rules still win.

The prompt names repository, PR, exact head, base, executing coordinator session, direct sub-coordinator session and
expiry (two minutes from request preparation). It covers only that tool invocation. Reject it if you are not the app's
human owner, the request is incomplete, or the scope is not the work you intend to authorize. Silence is not consent.
An owner asking for advice, saying "coordinator decides", or approving a team does not issue this merge permission.

## Requesting execution

The executor must be an actual `coordinator` session. The child must be another actual `coordinator` session whose
server-recorded `parentID` is the executor, in its own clone/worktree. Session names quoted in PR text are not proof.
The PR is labelled `coordinator`, open, same-repository, and based on `bived` or `milestone/<name>`.

Use the session-bound Git identities in `AGENTS.md` before either coordinator authors commits:

```text
coordinator <canonical provider/model> [session=<actual session id>]
```

Never rename an identity to hide authorship. An executor cannot merge its own current branch or work it authored.
Unknown authorship or old coordinator author names without session attribution fail closed; the owner merges those
PRs manually. No history rewriting to make a PR eligible.

Invoke `bive_coordinator_merge` with the PR number and `childSession`. The tool derives the repository and executor,
reads opt-in and the named owner from the remote base, verifies the actual child's branch/head against the PR, checks
authorship and the owner authorization's latest label event, and reruns the gate. It requires every check to pass,
except the existing inviolable-check skip on a `coordinator` PR. Owner overrides do not let this tool merge red,
missing or pending checks.

After the owner answers the permission prompt, it reads the scope, opt-in, labels and checks again. Changed head/base,
owner, relationship, branch, expired/revoked authorization or timeout refuses the operation. It executes only
`gh pr merge --merge --match-head-commit <head>`, with the exact repository and PR. A second invocation needs a new
owner decision; a merged/closed PR is ineligible. Removing the authorization or disabling base opt-in revokes pending
requests when their final validation runs.

## What it never permits

- No general merge right, self-merge, arbitrary PRs, inherited grant or onward delegation.
- No direct push, squash/rebase, PR closure, owner-authorization action or label application by agents.
- No approval of work, teams or gates, test release, provider fallback or billing changes.
- No advisor or delegate execution; changing a role name in the request does not make it a coordinator session.
- No change to the general shell merge/close denials in `opencode.jsonc`.

## Enforcement limits and verification

The path uses OpenCode 2's tool, permission and session APIs and bounded `gh`/Git subprocesses. Pure and injected
adapter tests must not authorize or perform a real merge. A live end-to-end merge is a separate owner-run acceptance
step; do not infer it from unit tests or enable opt-in just to test.

The existing shared-GitHub-account caveat remains: a login cannot prove which person or agent used its credentials.
This path adds a fresh local human permission boundary, but is not an OS sandbox or a defence against a malicious
operator with unrestricted server/credential access. Keep private credentials and owner-only authorization workflows
out of agent control. A check and its subsequent GitHub merge are not an atomic transaction: require branch protection
and retain GitHub's pinned-head check. Do not describe this helper as a replacement for repository protections.

Install/update this feature from reviewed Bive source, including the protected guard files and permission rule.
Do not copy grants, permissions, session IDs or another app's owner identity into a new installation. Opt-in remains
an independent decision by each app's owner.

## Main is the owner's alone; parent approval of direct children (owner, 2026-11-13)

- No agent approves or merges into `main`, under any grant. The code refuses it (`coordinator-merge.ts`) and the
  grant reader ignores any grant whose base is not `bived` or `milestone/<name>`.
- The owner's opt-in is a grant in `.bive/gate.json` on the protected base (`coordinatorMergeGrants`): repository,
  executor session, direct child sessions and branches, base, expiry, maximum approvals, and a public key. Only the
  owner changes that file, so an agent cannot widen it. A PR that touches it, or any other authority or enforcement
  file, is merged by the owner.
- Within a grant, the parent coordinator approves its direct child's PR head with a signed, short-lived comment
  (`coordinator-approval-lib.mjs` verifies it). No manual label and no owner prompt per PR. Never its own PR or work
  it authored.
- Status: implemented and tested: the grant reader, the signed approval, the `main` refusal, the merge tool
  (`merge-tool.ts`, signs with `BIVE_PARENT_APPROVAL_KEY`, posts the comment, asks GitHub to re-run the gate) and the
  gate (`check-merge-gate.mjs` accepts the approval instead of the dated label, `tests/gate-parent-approval.test.ts`).
  Verified offline end to end (owner's choice, 2026-11-14): `tests/coordinator-merge-tool.test.ts` runs the real tool, signing,
  grant lookup and gate against a fake GitHub. Not verified live on GitHub. Opt-in stays off (`coordinatorMerges: false`) and no grant exists.
