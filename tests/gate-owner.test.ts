import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"
import { parseGateOwner } from "../.github/scripts/merge-gate-lib.mjs"
import { runMergeGate } from "../.github/scripts/check-merge-gate.mjs"

// Issue #249: on a repository that belongs to an organization, the owner is named in `.bive/gate.json` of the base.
const ROOT = path.resolve(import.meta.dirname, "..")
const now = Date.parse("2026-11-13T12:00:00.000Z")
const labels = ["bive-merge-authorized-until-2026-11-13"]
const checks = [
  { workflow: "bive-tests", name: "tests", bucket: "pass" },
  { workflow: "bive-inviolable", name: "check", bucket: "pass" },
]
const event = { pull_request: { number: 7, head: { sha: "abc" }, base: { ref: "bived" } } }
const applied = (actor: string, actorType = "User") =>
  async () => [{ createdAt: "2026-11-13T10:00:00Z", actor, actorType, performedViaApp: null }]
const base = {
  event, repository: "org/r", now: () => now,
  readPullRequest: async () => ({ baseRefName: "bived", headRefOid: "abc", labels }),
  readChecks: async () => checks,
  readRepositoryOwner: async () => "org",
}

test("parseGateOwner reads a GitHub login and nothing else", () => {
  assert.equal(parseGateOwner('{"skippable": [], "owner": "someone"}'), "someone")
  assert.equal(parseGateOwner('{"owner": "a-b-1"}'), "a-b-1")
  for (const text of [undefined, null, "", "garbage", "[]", '{"owner": 3}', '{"owner": ""}', '{"owner": "-x"}',
                      '{"owner": "two words"}', '{"owner": "x/y"}', `{"owner": "${"a".repeat(40)}"}`]) {
    assert.equal(parseGateOwner(text as unknown as string), null, String(text))
  }
})

test("an organization-owned repository: the named owner's label passes, the organization login is not needed", async () => {
  const ok = await runMergeGate({ ...base, readLabelEvents: applied("someone"),
    readGateConfig: async () => '{"skippable": [], "owner": "someone"}' })
  assert.equal(ok.ok, true)
})

test("someone else's label is refused even when an owner is named", async () => {
  await assert.rejects(runMergeGate({ ...base, readLabelEvents: applied("other"),
    readGateConfig: async () => '{"skippable": [], "owner": "someone"}' }), /not applied by the repository owner/)
})

test("without a named owner the gate compares with the repository owner, as before", async () => {
  for (const reader of [async () => null, async () => '{"skippable": []}', async () => "garbage",
                        async () => { throw new Error("boom") }]) {
    await assert.rejects(runMergeGate({ ...base, readLabelEvents: applied("someone"), readGateConfig: reader }),
      /not applied by the repository owner/)
  }
  const userOwned = await runMergeGate({ ...base, readRepositoryOwner: async () => "someone",
    readLabelEvents: applied("someone"), readGateConfig: async () => '{"skippable": []}' })
  assert.equal(userOwned.ok, true)
})

test("a Bot or App label is refused even under the named owner's login (#130)", async () => {
  await assert.rejects(runMergeGate({ ...base, readLabelEvents: applied("someone", "Bot"),
    readGateConfig: async () => '{"skippable": [], "owner": "someone"}' }), /agent \(Bot or GitHub App\)/)
})

test("the gate reads the owner from the base branch, never from the pull request", async () => {
  const seen: unknown[] = []
  await runMergeGate({ ...base, readLabelEvents: applied("someone"),
    readGateConfig: async (a: unknown) => { seen.push(a); return '{"skippable": [], "owner": "someone"}' } })
  assert.deepEqual(seen, [{ repository: "org/r", ref: "bived" }])
})

test("Bive's own gate file names a valid owner, since bived-apps/bive belongs to an organization", () => {
  const text = fs.readFileSync(path.join(ROOT, ".bive/gate.json"), "utf8")
  assert.notEqual(parseGateOwner(text), null)
})
