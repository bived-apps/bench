import assert from "node:assert/strict"
import test from "node:test"
import { createGhReaders, runMergeGate } from "../.github/scripts/check-merge-gate.mjs"
import { boundGrantLabel } from "../.github/scripts/authorize-merge-lib.mjs"

const now = Date.parse("2026-11-09T12:00:00.000Z")
const head = "1".repeat(40)
const grant = (baseRef = "bived", headSha = head, number = 70) => boundGrantLabel({
  number, headSha, baseRef, date: "2026-11-09",
})
const event = { pull_request: { number: 70, head: { sha: head }, base: { ref: "bived" } } }
const pr = {
  baseRefName: "bived",
  headRefOid: head,
  labels: ["bive-merge-authorized-until-2026-11-09", grant()],
}
const green = [
  { workflow: "bive-tests", name: "tests", bucket: "pass" },
  { workflow: "bive-inviolable", name: "check", bucket: "pass" },
]
const run = (options = {}) => runMergeGate({
  event,
  repository: "owner/repository",
  readPullRequest: async () => pr,
  readChecks: async () => green,
  now: () => now,
  sleep: async () => {},
  ...options,
})

test("passes only after an authorized PR has green checks and fresh metadata", async () => {
  let reads = 0
  const result = await run({ readPullRequest: async () => { reads++; return pr } })
  assert.equal(result.ok, true)
  assert.equal(reads, 2)
})

test("waits for pending checks, then accepts their green result", async () => {
  let reads = 0
  let time = now
  const result = await run({
    now: () => time,
    sleep: async (ms: number) => { time += ms },
    readChecks: async () => reads++ === 0 ? [green[0], { ...green[1], bucket: "pending" }] : green,
  })
  assert.equal(result.ok, true)
  assert.equal(reads, 2)
})

test("waits for absent check contexts and fails after the bounded deadline", async () => {
  let time = 0
  await assert.rejects(run({
    now: () => time,
    maxWaitMs: 20,
    pollIntervalMs: 10,
    sleep: async (ms: number) => { time += ms },
    readChecks: async () => [green[0]],
  }), /timed out waiting/)
})

test("rejects missing authorization before querying checks", async () => {
  let checkReads = 0
  await assert.rejects(run({
    readPullRequest: async () => ({ ...pr, labels: [] }),
    readChecks: async () => { checkReads++; return green },
  }), /exactly one dated merge-authorization label/)
  assert.equal(checkReads, 0)
})

test("runs for a milestone branch and refuses a base that changed to another branch", async () => {
  const milestoneEvent = { pull_request: { ...event.pull_request, base: { ref: "milestone/0.2" } } }
  const milestonePR = { ...pr, baseRefName: "milestone/0.2", labels: [pr.labels[0], grant("milestone/0.2")] }
  assert.equal((await run({ event: milestoneEvent, readPullRequest: async () => milestonePR })).ok, true)
  await assert.rejects(run({ event: milestoneEvent }), /base changed/)
  await assert.rejects(run({ event: { pull_request: { ...event.pull_request, base: { ref: "main" } } } }), /only runs/)
})

test("rejects failed checks and a changed PR head", async () => {
  await assert.rejects(run({ readChecks: async () => [{ ...green[0], bucket: "fail" }, green[1]] }), /bive-tests \/ tests is fail/)
  await assert.rejects(run({ readPullRequest: async () => ({ ...pr, headRefOid: "head-2" }) }), /head changed/)
})

test("re-reads labels before passing so a removed grant fails", async () => {
  let reads = 0
  await assert.rejects(run({
    readPullRequest: async () => reads++ === 0 ? pr : { ...pr, labels: [] },
  }), /exactly one dated merge-authorization label/)
})

test("a dated label alone no longer authorizes a head", async () => {
  await assert.rejects(run({
    readPullRequest: async () => ({ ...pr, labels: [pr.labels[0]] }),
  }))
})

test("a grant cannot carry to a new head, another PR or another base", async () => {
  const next = "2".repeat(40)
  await assert.rejects(run({
    event: { pull_request: { ...event.pull_request, head: { sha: next } } },
    readPullRequest: async () => ({ ...pr, headRefOid: next }),
  }))
  await assert.rejects(run({
    event: { pull_request: { ...event.pull_request, number: 71 } },
  }))
  await assert.rejects(run({
    event: { pull_request: { ...event.pull_request, base: { ref: "milestone/0.2" } } },
    readPullRequest: async () => ({ ...pr, baseRefName: "milestone/0.2" }),
  }))
})

test("a removed or replaced head-bound grant fails the final metadata refresh", async () => {
  for (const labels of [[pr.labels[0]], [pr.labels[0], grant("bived", "2".repeat(40))]]) {
    let reads = 0
    await assert.rejects(run({
      readPullRequest: async () => reads++ === 0 ? pr : { ...pr, labels },
    }))
    assert.equal(reads, 2)
  }
})

test("accepts only the intentional coordinator skip", async () => {
  const coordinatorPR = { ...pr, labels: [...pr.labels, "coordinator"] }
  const checks = [green[0], { ...green[1], bucket: "skipping" }]
  assert.equal((await run({ readPullRequest: async () => coordinatorPR, readChecks: async () => checks })).ok, true)
  await assert.rejects(run({ readChecks: async () => checks }), /bive-inviolable \/ check is skipping/)
})

test("gh readers accept the documented pending exit code and enforce per-call timeouts", async () => {
  const calls: Array<{ args: string[], timeout: number }> = []
  const readers = createGhReaders(async (args, timeout) => {
    calls.push({ args, timeout })
    return args[1] === "view"
      ? { exitCode: 0, stdout: JSON.stringify({ baseRefName: "bived", headRefOid: "head-1", labels: [{ name: "coordinator" }] }) }
      : { exitCode: 8, stdout: JSON.stringify([{ workflow: "bive-tests", name: "tests", bucket: "pending", state: "IN_PROGRESS" }]) }
  })
  assert.deepEqual(await readers.readPullRequest({ number: 70, repository: "owner/repository" }), {
    baseRefName: "bived", headRefOid: "head-1", labels: ["coordinator"],
  })
  assert.deepEqual(await readers.readChecks({ number: 70, repository: "owner/repository" }), [
    { workflow: "bive-tests", name: "tests", bucket: "pending" },
  ])
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => call.timeout === 15_000))
})

test("gh readers reject malformed JSON and non-pending failures", async () => {
  const malformed = createGhReaders(async () => ({ exitCode: 0, stdout: "{" }))
  await assert.rejects(malformed.readChecks({ number: 70, repository: "owner/repository" }), /invalid JSON/)
  const failed = createGhReaders(async () => ({ exitCode: 1, stdout: "", stderr: "permission denied" }))
  await assert.rejects(failed.readChecks({ number: 70, repository: "owner/repository" }), /status 1/)
})
