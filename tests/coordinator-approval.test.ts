import assert from "node:assert/strict"
import test from "node:test"
import { generateKeyPairSync } from "node:crypto"
import { matchingGrant, readCoordinatorGrants, changesMergeAuthority, verifyParentApproval } from "../.github/scripts/coordinator-approval-lib.mjs"
import { runCoordinatorMerge } from "../.opencode/plugins/worktree-guard/coordinator-merge.ts"

const { publicKey } = generateKeyPairSync("ed25519")
const pem = publicKey.export({ type: "spki", format: "pem" }).toString()
const grant = (over: Record<string, unknown> = {}) => ({
  id: "g1", repository: "o/r", executor: "ses_parent", base: "bived", maxApprovals: 2, expiresAt: "2999-01-01T00:00:00Z",
  publicKey: pem, children: [{ id: "ses_child", branch: "coordinator/x" }], ...over,
})
const policy = (g: unknown) => JSON.stringify({ owner: "human", coordinatorMerges: true, coordinatorMergeGrants: [g] })

test("a grant for bived is read; a grant for main is ignored", () => {
  assert.equal(readCoordinatorGrants(policy(grant())).length, 1)
  assert.equal(readCoordinatorGrants(policy(grant({ base: "main" }))).length, 0)
})

test("opt-in off, no owner or a self-child grant yields nothing", () => {
  assert.equal(readCoordinatorGrants(JSON.stringify({ owner: "h", coordinatorMerges: false, coordinatorMergeGrants: [grant()] })).length, 0)
  assert.equal(readCoordinatorGrants(JSON.stringify({ coordinatorMerges: true, coordinatorMergeGrants: [grant()] })).length, 0)
  assert.equal(readCoordinatorGrants(policy(grant({ children: [{ id: "ses_parent", branch: "coordinator/x" }] }))).length, 0)
  assert.equal(readCoordinatorGrants("not json").length, 0)
})

test("matching needs executor, child, branch, base and an unexpired grant", () => {
  const t = policy(grant()), q = { repository: "o/r", executor: "ses_parent", childSession: "ses_child", headBranch: "coordinator/x", base: "bived" }
  assert.ok(matchingGrant(t, q))
  assert.equal(matchingGrant(t, { ...q, executor: "ses_other" }), null)
  assert.equal(matchingGrant(t, { ...q, childSession: "ses_other" }), null)
  assert.equal(matchingGrant(t, { ...q, headBranch: "coordinator/y" }), null)
  assert.equal(matchingGrant(t, { ...q, base: "main" }), null)
  assert.equal(matchingGrant(policy(grant({ expiresAt: "2000-01-01T00:00:00Z" })), q), null)
})

test("a PR that changes authority or enforcement files is the owner's to merge", () => {
  assert.equal(changesMergeAuthority([".bive/gate.json"]), true)
  assert.equal(changesMergeAuthority(["opencode.jsonc"]), true)
  assert.equal(changesMergeAuthority([".github/scripts/x.mjs"]), true)
  assert.equal(changesMergeAuthority(["docs/a.md"]), false)
})

test("an unsigned or forged approval comment is not authorization", () => {
  const pr = { repository: "o/r", number: 1, head: "a".repeat(40), base: "bived", coordinatorPR: true, sameRepository: true, state: "OPEN", files: ["docs/a.md"] }
  assert.equal(verifyParentApproval(policy(grant()), pr, [{ body: "approved" }, { body: "<!-- bive-parent-approval:v1 -->\n{}" }]), null)
})

test("no agent merges into main, even with every other condition met", async () => {
  let merged = false
  const snap: any = {
    repository: "o/r", number: 1, state: "OPEN", head: "a".repeat(40), base: "main", headBranch: "coordinator/x",
    sameRepository: true, coordinatorPR: true, enabled: true, owner: "human", checks: [], authorizationValid: true,
    headApproved: true, grantExpiresAt: Date.now() + 1e6, authorityChange: false, selfAuthored: false,
    executor: { id: "ses_parent", agent: "coordinator" },
    child: { id: "ses_child", agent: "coordinator", parentID: "ses_parent", branch: "coordinator/x", head: "a".repeat(40) },
  }
  await assert.rejects(runCoordinatorMerge({ number: 1, childSession: "ses_child" }, "ses_parent", {
    read: async () => snap, approve: async () => {}, merge: async () => { merged = true; return "" },
  }), /main is the owner's alone/)
  assert.equal(merged, false)
})
