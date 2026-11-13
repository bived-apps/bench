# Merge authorization

This page documents the bounded helper that implements the coordinator's manual
authorization workflow for pull requests targeting an integration branch
(`bived` or `milestone/<name>`).

## Labels

- `bive-merge-authorized-until-YYYY-MM-DD`: the dated authorization label produced
  by the merge gate. It expires at the end of that UTC date.
- `bive-grant-<32 hex>`: a bound grant label scoped to one PR, exact head SHA,
  base branch, and expiry date. It is binding metadata, not a signature or proof
  of a human actor.

## Helper

`.github/scripts/authorize-merge-lib.mjs` exports:

- `boundGrantLabel({ number, headSha, baseRef, date })`: computes the bound grant
  label from SHA-256 of the canonical inputs.
- `validateBoundAuthorization({ number, headSha, baseRef, labels, now })`: validates
  the dated label and requires exactly one matching bound grant label.
- `authorizeMerge({ repository, number, headSha, owner, actor, triggeringActor,
  workflowRef, defaultBranch, api, now })`: performs the authorization and reruns
  the merge gate. It never merges, approves, comments, or changes other branches.
  Gate runs are matched by their trusted `run-name` display title, not by
  `pull_requests` metadata, which GitHub leaves empty for `pull_request_target`.

## CLI

`.github/scripts/authorize-merge.mjs` reads the documented environment variables and
calls the helper through an injected GitHub REST client. It uses a fixed API
origin, a 15 second timeout, a 2 MiB response cap, and no retries.

## Fail-closed rules

Bad inputs, malformed API data, pagination exhaustion, missing or stale hand-over
comments, missing or malformed gate runs, and post-write verification failures all
abort the operation. If labels were added before a later failure, the bound grant
label is removed and any cleanup failure is reported with the primary error.