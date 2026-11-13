# Provider fallback

No automatic provider probe by default. Each role lists models in order in `.bive/models.json`; when a delegate call
fails (unreachable, 429, quota), the coordinator retries the same brief with the next delegate model and says so in the
report. Coordinator launch and substitution require the owner-approved team described below, not automatic fallback.
When every model of the list failed, a project can offer a provider search: a script (or MCP tool) that tries every
model OpenCode knows with one tiny prompt and prints the ones that answer, fastest first, as a `.bive/models.json`
line. A delegate's work that a reviewer rejects is redone by the next model, not patched by the same one.

## Coordinator selection and owner-approved team

The supervisor's project additions in `.bive/prompts/project/SUPERVISOR.md` apply before starting or replacing a
coordinator. Prefer the strongest suitable model whose current free pricing and usability can be verified, while
preserving every existing qualification and owner allow-list requirement. A listing is not availability, a successful
tiny request is not a capability benchmark, and unknown pricing is not free. State the evidence and uncertainty
instead of claiming an objectively best model without a comparison.

Inspect the available catalog and existing results first. Manually check a shortlisted model with one small synthetic
request, no tools or private context, and a timeout; record the canonical/resolved ID, UTC time, pricing source, and
outcome. Do not sweep providers or incur paid/unknown-cost checks without owner permission. Availability is temporary:
recheck before launch if the evidence is stale or the account, machine, or quota changed.

If no suitable verified-free coordinator is usable, recommend the strongest suitable usable model from the current
supervisor session's provider, unless the owner names another provider. Do not silently substitute a paid model,
cross providers, buy credits, or turn on billing. A named but unfunded model is not a usable launch choice.

Ask the owner to approve a concrete team before launching or switching a coordinator:

| Item | What the proposal states |
| --- | --- |
| Needed roles | Supervisor, coordinator, and delegates only where the task needs them; canonical model/version per role |
| Suitability | Relevant results, task fit, qualification or allow-list status, and limitations |
| Cost and availability | Verified-free, paid, or unknown; evidence source and recent check time/outcome |
| Recommendation | Best supported team, alternatives, current-provider fallback, and a wait/stop choice |
| Approval | Exact requested launch or change and any cost; stop and wait for the owner's answer |

No general milestone mandate authorizes a model change. On credit, service, rate-limit, or quota failure, preserve the
session and work, explain the infrastructure blocker, and obtain approval of the revised team before another
coordinator takes over. Record the approved model and reason in the handoff and set its Git identity before its next
commit. An outage alone is not evidence of poor model judgement; assess separately how an agent handles it. This
policy changes neither delegate fallback nor role rights, merge gates, or qualifications.

## Per-machine model aliases

`.bive/models.json` is shared and contains canonical model IDs. If a machine serves one of those models through a
different OpenCode provider ID, keep a local, untracked mapping in `.bive/state/models.local.json`:

```json
{
  "aliases": {
    "anthropic/claude-sonnet-5-5": "claude-agent/sonnet"
  }
}
```

The keys are canonical IDs from `.bive/models.json`; values are the `provider/model` IDs that work on this machine.
`.bive/state/` is git-ignored, so never commit this file; it contains model IDs only, not credentials. If it is absent
or unreadable, use the canonical ID and tell the owner. Keep the canonical model in the worktree-specific Git author
identity (`git config --worktree user.name`) as required by `AGENTS.md`; when useful, report both the canonical and
resolved IDs.

OpenCode configuration can add or override model IDs under a provider, and `modelID` can change the ID sent to that
provider. That is useful when only the upstream model ID differs. It does not directly alias a canonical
`provider/model` reference to a different OpenCode provider/model pair, so use the local map when provider IDs differ.

Before dispatching a model on a new machine, check that the resolved ID answers:

```bash
opencode run -m <provider/model> "Reply with your model id only."
```

This is a one-model manual check, not an automatic provider search. For a delegate, an unavailable model or an
insufficient-funds error counts as a model error; continue to the next canonical delegate model in `.bive/models.json`,
applying its local alias if present. For a coordinator, stop and seek owner approval of the revised team instead.
