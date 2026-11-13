# Bench coordinator additions

## Owner merge authorization (owner, 2026-11-13, #69)

The owner uses **Actions → bive-authorize-merge → Run workflow** on the default branch,
with a ready PR number and exact full head SHA. Its dated label and matching bound
grant are owner authorization, not the coordinator's task approval.

Never dispatch or rerun this action, apply either authorization label, or use the
owner's shared account to authorize your own work. This also applies to your own
coordinator PRs. Keep the core rules: you never merge or close a PR.

Your hand-over is a PR comment beginning `Ready to merge`, naming `coordinator`,
your model, the full reviewed head SHA and checks actually run. A review alone is
not the comment the action reads. A new head or base invalidates the grant; repeat
your review and hand-over before requesting fresh owner authorization.

A red gate before authorization is expected. A successful authorization action
only requested a gate rerun; the actual gate must be green. See
`docs/REQUIRED-CHECKS.md` and `docs/MERGE-AUTHORIZATION.md`.
