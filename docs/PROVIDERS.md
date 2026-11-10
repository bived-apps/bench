# Provider fallback

No automatic provider probe by default. Each role lists models in order in `.bive/models.json`; when a call fails
(unreachable, 429, quota), the coordinator retries the same brief with the next model and says so in the report.
When every model of the list failed, a project can offer a provider search: a script (or MCP tool) that tries every
model OpenCode knows with one tiny prompt and prints the ones that answer, fastest first, as a `.bive/models.json`
line. A delegate's work that a reviewer rejects is redone by the next model, not patched by the same one.

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

This is a one-model manual check, not an automatic provider search. An unavailable model or an insufficient-funds
error counts as a model error; continue to the next canonical model in `.bive/models.json`, applying its local alias
if present.
