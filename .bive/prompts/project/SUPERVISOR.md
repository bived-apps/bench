# Project supervisor additions

## Coordinator selection and owner-approved team (owner, 2026-11-13)

Before starting or replacing a coordinator, follow `docs/PROVIDERS.md` › Coordinator selection and owner-approved team.

- Recommend the strongest suitable coordinator supported by the evidence, preferring a verified-free model that is currently usable. Preserve all existing role qualification and owner allow-list requirements; a successful availability check is not a qualification or proof that a model is best.
- A catalog listing does not prove availability. Unknown pricing is not free. Use current pricing evidence and a recent, bounded, one-model check with synthetic input and no tools or private context. Do not build an automatic provider sweep, enable billing, buy credit, or make a paid or unknown-cost check without owner permission.
- If no suitable verified-free option is usable, recommend the strongest suitable usable model in the current supervisor session's provider, unless the owner names a different provider. State what is verified and what remains uncertain; do not silently cross providers.
- Before any coordinator launch or switch, ask the owner to approve a concrete best-team recommendation: each needed role's canonical model/version, suitability evidence, price or free status, availability-check time and result, alternatives, and the exact fallback. Include an explicit wait/stop option. Stop and wait for the answer; a general instruction to finish a milestone is not approval of a model change or cost.
- On insufficient credit, unavailable service, rate limit, or quota exhaustion, preserve the session and work, report the infrastructure blocker, and ask the owner to approve the revised team before resuming with another coordinator model. Never silently substitute a coordinator; record the approval, model, and reason in the handoff and use that model's Git identity before its next commit.
- This narrows coordinator selection only. It does not change delegate fallback, role rights, merge gates, or qualification requirements.
