import assert from "node:assert/strict"
import test from "node:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { runMergeGate } from "../.github/scripts/check-merge-gate.mjs"
import { APPROVAL_PREFIX, approvalBytes } from "../.github/scripts/coordinator-approval-lib.mjs"

const HEAD = "a".repeat(40)
const keys = generateKeyPairSync("ed25519")
const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
const config = (over: Record<string, unknown> = {}) => JSON.stringify({ owner: "human", skippable: [], coordinatorMerges: true,
  coordinatorMergeGrants: [{ id: "g1", repository: "o/r", executor: "ses_p", base: "bived", maxApprovals: 3,
    expiresAt: "2999-01-01T00:00:00Z", publicKey: pem, children: [{ id: "ses_c", branch: "coordinator/x" }] }], ...over })
const payload = (over: Record<string, unknown> = {}) => ({ grant: "g1", repository: "o/r", number: 7, head: HEAD, base: "bived",
  executor: "ses_p", childSession: "ses_c", headBranch: "coordinator/x", issuedAt: Date.now() - 1000,
  expiresAt: Date.now() + 60_000, sequence: 1, ...over })
const comment = (p: any, key = keys.privateKey) =>
  ({ body: APPROVAL_PREFIX + JSON.stringify({ payload: p, signature: sign(null, approvalBytes(p), key).toString("base64") }) })
const green = [{ workflow: "bive-tests", name: "tests", bucket: "pass" }, { workflow: "bive-inviolable", name: "check", bucket: "skipping" }]

function run(over: { labels?: string[], base?: string, comments?: any[], files?: string[], cfg?: string } = {}) {
  const base = over.base ?? "bived"
  return runMergeGate({
    event: { pull_request: { number: 7, head: { sha: HEAD }, base: { ref: base } } }, repository: "o/r",
    readPullRequest: async () => ({ baseRefName: base, headRefOid: HEAD, labels: over.labels ?? ["coordinator"] }),
    readChecks: async () => green,
    readGateConfig: async () => over.cfg ?? config(),
    readParentContext: async () => ({ headBranch: "coordinator/x", sameRepository: true, state: "OPEN", files: over.files ?? ["docs/a.md"] }),
    readComments: async () => over.comments ?? [comment(payload())],
    readLabelEvents: async () => [], readRepositoryOwner: async () => "human",
  })
}

test("a signed parent approval under the owner's grant passes the gate with no label", async () => {
  assert.equal((await run()).ok, true)
})

test("no approval, a forged one, or another head fails", async () => {
  await assert.rejects(run({ comments: [] }), /dated merge-authorization label/)
  const other = generateKeyPairSync("ed25519").privateKey
  await assert.rejects(run({ comments: [comment(payload(), other)] }), /dated merge-authorization label/)
  await assert.rejects(run({ comments: [comment(payload({ head: "b".repeat(40) }))] }), /dated merge-authorization label/)
})

test("opt-in off, an expired approval or an expired grant fails", async () => {
  await assert.rejects(run({ cfg: config({ coordinatorMerges: false }) }), /dated merge-authorization label/)
  await assert.rejects(run({ comments: [comment(payload({ expiresAt: Date.now() - 1 }))] }), /dated merge-authorization label/)
})

test("changes to authority or enforcement files need the owner", async () => {
  for (const f of [".bive/gate.json", "AGENTS.md", ".github/scripts/x.mjs", ".opencode/plugins/a.ts"]) {
    await assert.rejects(run({ files: [f] }), /dated merge-authorization label/, f)
  }
})

test("main is never reachable by parent approval", async () => {
  await assert.rejects(run({ base: "main" }))
})

test("a required check that is red still fails with a valid approval", async () => {
  await assert.rejects(runMergeGate({
    event: { pull_request: { number: 7, head: { sha: HEAD }, base: { ref: "bived" } } }, repository: "o/r",
    readPullRequest: async () => ({ baseRefName: "bived", headRefOid: HEAD, labels: ["coordinator"] }),
    readChecks: async () => [{ workflow: "bive-tests", name: "tests", bucket: "fail" }, green[1]],
    readGateConfig: async () => config(),
    readParentContext: async () => ({ headBranch: "coordinator/x", sameRepository: true, state: "OPEN", files: ["docs/a.md"] }),
    readComments: async () => [comment(payload())],
  }), /bive-tests \/ tests is fail/)
})
