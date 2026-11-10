import assert from "node:assert/strict"
import test from "node:test"
import { evaluateMergeGate } from "../.github/scripts/merge-gate-lib.mjs"

const now = Date.parse("2026-11-09T12:00:00.000Z")
const validLabels = ["bive-merge-authorized-until-2026-11-09"]
const greenChecks = [
  { workflow: "bive-tests", name: "tests", bucket: "pass" },
  { workflow: "bive-inviolable", name: "check", bucket: "pass" },
]
const evaluate = (overrides = {}) => evaluateMergeGate({
  labels: validLabels, baseRef: "bived", checks: greenChecks, now, ...overrides,
})

test("permits one unexpired dated authorization when required checks pass", () => {
  assert.deepEqual(evaluate(), { ok: true, reason: "dated authorization and required checks are valid" })
})

test("authorization expires at the end of its UTC date", () => {
  assert.equal(evaluate({ now: Date.parse("2026-11-10T00:00:00.000Z") }).ok, false)
  assert.equal(evaluate({ now: Date.parse("2026-11-09T23:59:59.999Z") }).ok, true)
})

test("rejects missing, malformed, duplicate, expired, or invalid-date labels", () => {
  for (const labels of [
    [],
    ["bive-merge-authorized-until-tomorrow"],
    ["bive-merge-authorized-until-2026-02-30"],
    ["bive-merge-authorized-until-2026-11-09", "bive-merge-authorized-until-2026-11-10"],
  ]) assert.equal(evaluate({ labels }).ok, false)
  assert.equal(evaluate({ labels: ["bive-merge-authorized-until-2026-11-08"] }).ok, false)
})

test("authorization is scoped to bived and milestone/<name> branches", () => {
  assert.equal(evaluate({ baseRef: "milestone/0.2" }).ok, true)
  for (const baseRef of ["main", "milestone/", "milestone/a/b", "milestones/x", "issue/70-merge-gate", undefined]) {
    assert.equal(evaluate({ baseRef }).ok, false)
  }
})

test("requires exactly one passing instance of each required check", () => {
  assert.equal(evaluate({ checks: [greenChecks[0]] }).ok, false)
  assert.equal(evaluate({ checks: [...greenChecks, greenChecks[0]] }).ok, false)
  for (const bucket of ["pending", "fail", "cancel", "skipping"]) {
    assert.equal(evaluate({ checks: [greenChecks[0], { ...greenChecks[1], bucket }] }).ok, false)
  }
})

test("allows only the expected inviolable-check skip for coordinator PRs", () => {
  const labels = [...validLabels, "coordinator"]
  const checks = [greenChecks[0], { ...greenChecks[1], bucket: "skipping" }]
  assert.equal(evaluate({ labels, checks }).ok, true)
  assert.equal(evaluate({ labels, checks: [greenChecks[0]] }).ok, false)
  assert.equal(evaluate({ checks: [greenChecks[0], { ...greenChecks[1], bucket: "skipping" }] }).ok, false)
})

test("ignores its own check but refuses other pending or failed checks", () => {
  const own = { workflow: "bive-merge-gate", name: "merge-gate", bucket: "pending" }
  assert.equal(evaluate({ checks: [...greenChecks, own] }).ok, true)
  assert.equal(evaluate({ checks: [...greenChecks, { workflow: "other", name: "lint", bucket: "fail" }] }).ok, false)
  assert.equal(evaluate({ checks: [...greenChecks, { workflow: "other", name: "lint", bucket: "pending" }] }).ok, false)
})
