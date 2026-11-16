import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"
import { evaluateMergeGate, parseSkippable } from "../.github/scripts/merge-gate-lib.mjs"
import { createGhReaders, runMergeGate } from "../.github/scripts/check-merge-gate.mjs"

const ROOT = path.resolve(import.meta.dirname, "..")
const now = Date.parse("2026-11-09T12:00:00.000Z")
const labels = ["bive-merge-authorized-until-2026-11-09"]
const tests = { workflow: "bive-tests", name: "tests", bucket: "pass" }
const inviolable = { workflow: "bive-inviolable", name: "check", bucket: "pass" }
const evaluate = (checks: unknown[], skippable?: string[]) =>
  evaluateMergeGate({ labels, baseRef: "bived", checks, now, ...(skippable ? { skippable } : {}) })

test("Bive's own list is empty: its gate stays strict (#200)", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, ".bive/gate.json"), "utf8"))
  assert.deepEqual(cfg.skippable, [])
})

test("without a list, a skipped check is red, as before", () => {
  assert.equal(evaluate([tests, inviolable, { workflow: "ci", name: "lint", bucket: "skipping" }]).ok, false)
  assert.equal(evaluate([tests, { ...inviolable, bucket: "skipping" }]).ok, false)
})

test("a skipped check on the list passes; a failed or pending one still does not", () => {
  const lint = { workflow: "ci", name: "lint", bucket: "skipping" }
  assert.equal(evaluate([tests, inviolable, lint], ["ci / lint"]).ok, true)
  assert.equal(evaluate([tests, inviolable, { ...lint, bucket: "fail" }], ["ci / lint"]).ok, false)
  assert.equal(evaluate([tests, inviolable, { ...lint, bucket: "pending" }], ["ci / lint"]).ok, false)
  // another skipped check, not on the list, is still red
  assert.equal(evaluate([tests, inviolable, lint, { workflow: "ci", name: "docs", bucket: "skipping" }], ["ci / lint"]).ok, false)
})

test("a required check may be skipped only when the project lists it (a docs-only change skipping the tests)", () => {
  assert.equal(evaluate([{ ...tests, bucket: "skipping" }, inviolable]).ok, false)
  assert.equal(evaluate([{ ...tests, bucket: "skipping" }, inviolable], ["bive-tests / tests"]).ok, true)
  assert.equal(evaluate([{ ...tests, bucket: "fail" }, inviolable], ["bive-tests / tests"]).ok, false)
  assert.equal(evaluate([{ ...inviolable, bucket: "skipping" }, tests].reverse(), ["bive-inviolable / check"]).ok, true)
})

test("parseSkippable never throws and ignores anything that is not 'workflow / name'", () => {
  assert.deepEqual(parseSkippable(undefined), [])
  assert.deepEqual(parseSkippable(null as unknown as string), [])
  assert.deepEqual(parseSkippable("not json"), [])
  assert.deepEqual(parseSkippable("[]"), [])
  assert.deepEqual(parseSkippable('{"skippable": "ci / lint"}'), [])
  assert.deepEqual(parseSkippable('{"skippable": ["ci / lint", 3, "lint", "", " / x"]}'), ["ci / lint"])
})

test("runMergeGate reads the list from the base branch and falls back to strict when it cannot", async () => {
  const event = { pull_request: { number: 5, head: { sha: "abc" }, base: { ref: "bived" } } }
  const pr = { baseRefName: "bived", headRefOid: "abc", labels }
  const checks = [tests, inviolable, { workflow: "ci", name: "lint", bucket: "skipping" }]
  const seen: unknown[] = []
  const base = {
    event, repository: "o/r", now: () => now,
    readPullRequest: async () => pr, readChecks: async () => checks,
    readLabelEvents: async () => [{ createdAt: "2026-11-09T10:00:00Z", actor: "o", actorType: "User", performedViaApp: null }],
    readRepositoryOwner: async () => "o",
  }
  const ok = await runMergeGate({ ...base, readGateConfig: async (a: unknown) => { seen.push(a); return '{"skippable":["ci / lint"]}' } })
  assert.equal(ok.ok, true)
  assert.deepEqual(seen, [{ repository: "o/r", ref: "bived" }])
  for (const reader of [async () => null, async () => "garbage", async () => { throw new Error("boom") }]) {
    await assert.rejects(runMergeGate({ ...base, readGateConfig: reader }), /ci \/ lint is skipping/)
  }
  await assert.rejects(runMergeGate(base), /ci \/ lint is skipping/)
})

test("the gh reader asks for the file on the base ref and decodes it; any failure means null", async () => {
  const calls: string[][] = []
  const content = Buffer.from('{"skippable":["ci / lint"]}').toString("base64")
  const ok = createGhReaders(async (args: string[]) => { calls.push(args); return { stdout: content + "\n", exitCode: 0 } })
  assert.equal(await ok.readGateConfig({ repository: "o/r", ref: "milestone/0.2" }), '{"skippable":["ci / lint"]}')
  assert.match(calls[0].join(" "), /repos\/o\/r\/contents\/\.bive\/gate\.json\?ref=milestone%2F0\.2/)
  const bad = createGhReaders(async () => { throw new Error("404") })
  assert.equal(await bad.readGateConfig({ repository: "o/r", ref: "bived" }), null)
  const nonzero = createGhReaders(async () => ({ stdout: "", exitCode: 1 }))
  assert.equal(await nonzero.readGateConfig({ repository: "o/r", ref: "bived" }), null)
})
