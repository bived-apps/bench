import assert from "node:assert/strict"
import test from "node:test"
import {
  runCoordinatorMerge as realRun,
  type MergeIO,
  type MergeScope,
  type MergeSnapshot,
} from "../.opencode/plugins/worktree-guard/coordinator-merge.ts"
// Parent approval is recorded by io.approve; after it, the head reads as approved (old two-read flow preserved).
function runMerge(req: MergeRequest, exec: string, io: MergeIO) {
  let approved = false
  return realRun(req, exec, {
    ...io,
    read: async () => { const s = await io.read(); return approved ? { ...s, headApproved: true } : s },
    approve: async (...a) => { await io.approve(...a); approved = true },
  })
}


const SHA = "a".repeat(40)
const OTHER_SHA = "b".repeat(40)
const HEAD_BRANCH = "issue/264-test"
const REQ = { number: 123, childSession: "child" }
const EXEC = "exec"

function baseSnapshot(overrides: Partial<MergeSnapshot> = {}): MergeSnapshot {
  const snap: MergeSnapshot = {
    repository: "owner/repo",
    number: 123,
    state: "OPEN",
    head: SHA,
    base: "bived",
    headBranch: HEAD_BRANCH,
    sameRepository: true,
    coordinatorPR: true,
    enabled: true,
    owner: "human",
    checks: [
      { workflow: "bive-tests", name: "tests", bucket: "pass" },
      { workflow: "bive-inviolable", name: "check", bucket: "pass" },
      { workflow: "bive-merge-gate", name: "merge-gate", bucket: "pass" },
    ],
    authorizationValid: true,
    headApproved: false,
    grantExpiresAt: 4_000_000_000_000,
    authorityChange: false,
    executor: { id: "exec", agent: "coordinator" },
    child: { id: "child", agent: "coordinator", parentID: "exec", branch: HEAD_BRANCH, head: SHA },
    selfAuthored: false,
  }
  return { ...snap, ...overrides }
}

test("success: exact scope, two reads, one approval, one merge", async () => {
  const snap = baseSnapshot()
  let readCount = 0
  let approveCount = 0
  let mergeCount = 0
  let capturedScope: MergeScope | undefined
  let capturedOwner: string | undefined
  const io: MergeIO = {
    read: async () => { readCount++; return snap },
    approve: async (scope, owner) => { approveCount++; capturedScope = scope; capturedOwner = owner },
    merge: async (scope) => { mergeCount++; assert.deepEqual(scope, capturedScope); return "merged-sha" },
    now: () => 1000,
  }
  const r = await runMerge(REQ, EXEC, io)
  assert.equal(r, "merged-sha")
  assert.equal(readCount, 2)
  assert.equal(approveCount, 1)
  assert.equal(mergeCount, 1)
  assert.deepEqual(capturedScope, {
    repository: "owner/repo",
    number: 123,
    head: SHA,
    base: "bived",
    headBranch: HEAD_BRANCH,
    executor: "exec",
    childSession: "child",
    expiresAt: 1000 + 120_000,
  })
  assert.equal(capturedOwner, "human")
})

test("accepts the inviolable check skip for a coordinator PR", async () => {
  const snap = baseSnapshot({
    checks: [
      { workflow: "bive-tests", name: "tests", bucket: "pass" },
      { workflow: "bive-inviolable", name: "check", bucket: "skipping" },
      { workflow: "bive-merge-gate", name: "merge-gate", bucket: "pass" },
    ],
  })
  let merges = 0
  const io: MergeIO = {
    read: async () => snap,
    approve: async () => {},
    merge: async () => { merges++; return "merged" },
    now: () => 1000,
  }
  assert.equal(await runMerge(REQ, EXEC, io), "merged")
  assert.equal(merges, 1)
})

test("refuses when owner opt-in is off", async () => {
  const snap = baseSnapshot({ enabled: false })
  let merges = 0
  const io: MergeIO = {
    read: async () => snap,
    approve: async () => {},
    merge: async () => { merges++; return "x" },
    now: () => 1000,
  }
  await assert.rejects(runMerge(REQ, EXEC, io), /owner opt-in is off on the base branch/)
  assert.equal(merges, 0)
})

test("refuses missing repository or owner", async () => {
  for (const overrides of [{ repository: "bad" }, { owner: "" }, { repository: "a/b/c" }]) {
    const snap = baseSnapshot(overrides as any)
    let merges = 0
    const io: MergeIO = {
      read: async () => snap,
      approve: async () => {},
      merge: async () => { merges++; return "x" },
      now: () => 1000,
    }
    await assert.rejects(runMerge(REQ, EXEC, io), /repository or human owner missing/)
    assert.equal(merges, 0)
  }
})

test("refuses malformed PR number", async () => {
  const snap = baseSnapshot()
  for (const num of [0, -1, 1.5, 2]) {
    let merges = 0
    const io: MergeIO = {
      read: async () => snap,
      approve: async () => {},
      merge: async () => { merges++; return "x" },
      now: () => 1000,
    }
    await assert.rejects(runMerge({ number: num as any, childSession: "child" }, EXEC, io), /wrong PR/)
    assert.equal(merges, 0)
  }
  const snap2 = baseSnapshot({ number: 999 })
  let merges = 0
  const io2: MergeIO = {
    read: async () => snap2,
    approve: async () => {},
    merge: async () => { merges++; return "x" },
    now: () => 1000,
  }
  await assert.rejects(runMerge(REQ, EXEC, io2), /wrong PR/)
  assert.equal(merges, 0)
})

test("refuses malformed head sha", async () => {
  const snap = baseSnapshot({ head: "abc" })
  let merges = 0
  const io: MergeIO = {
    read: async () => snap,
    approve: async () => {},
    merge: async () => { merges++; return "x" },
    now: () => 1000,
  }
  await assert.rejects(runMerge(REQ, EXEC, io), /PR is not an open same-repository head/)
  assert.equal(merges, 0)
})

test("refuses wrong state, cross-repository, or non-coordinator PR", async () => {
  {
    const snap = baseSnapshot({ state: "CLOSED" })
    let merges = 0
    const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
    await assert.rejects(runMerge(REQ, EXEC, io), /PR is not an open same-repository head/)
    assert.equal(merges, 0)
  }
  {
    const snap = baseSnapshot({ sameRepository: false })
    let merges = 0
    const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
    await assert.rejects(runMerge(REQ, EXEC, io), /PR is not an open same-repository head/)
    assert.equal(merges, 0)
  }
  {
    const snap = baseSnapshot({ coordinatorPR: false })
    let merges = 0
    const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
    await assert.rejects(runMerge(REQ, EXEC, io), /PR is not labelled coordinator/)
    assert.equal(merges, 0)
  }
})

test("refuses unsupported integration base", async () => {
  for (const base of ["main", "feature/x", "master"]) {
    const snap = baseSnapshot({ base })
    let merges = 0
    const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
    await assert.rejects(runMerge(REQ, EXEC, io), /unsupported integration base|main is the owner's alone/)
    assert.equal(merges, 0)
  }
})

test("refuses wrong executor identity or agent", async () => {
  {
    const snap = baseSnapshot({ executor: { id: "other", agent: "coordinator" } })
    let merges = 0
    const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
    await assert.rejects(runMerge(REQ, EXEC, io), /executor is not the designated coordinator/)
    assert.equal(merges, 0)
  }
  {
    const snap = baseSnapshot({ executor: { id: "exec", agent: "delegate" } })
    let merges = 0
    const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
    await assert.rejects(runMerge(REQ, EXEC, io), /executor is not the designated coordinator/)
    assert.equal(merges, 0)
  }
})

test("refuses non-direct or mismatched sub-coordinator", async () => {
  const cases: Array<Partial<MergeSnapshot["child"]>> = []
  const mk = (child: Partial<MergeSnapshot["child"]>) => baseSnapshot({ child: { ...baseSnapshot().child, ...child } })
  {
    const snap = baseSnapshot({ child: { id: "other-child", agent: "coordinator", parentID: "exec", branch: HEAD_BRANCH, head: SHA } })
    let merges = 0
    const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
    await assert.rejects(runMerge(REQ, EXEC, io), /not a direct sub-coordinator/)
    assert.equal(merges, 0)
  }
  {
    const snap = baseSnapshot({ child: { id: "exec", agent: "coordinator", parentID: "exec", branch: HEAD_BRANCH, head: SHA } })
    let merges = 0
    const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
    await assert.rejects(runMerge(REQ, EXEC, io), /not a direct sub-coordinator/)
    assert.equal(merges, 0)
  }
  {
    const snap = baseSnapshot({ child: { id: "child", agent: "coordinator", parentID: "someone-else", branch: HEAD_BRANCH, head: SHA } })
    let merges = 0
    const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
    await assert.rejects(runMerge(REQ, EXEC, io), /not a direct sub-coordinator/)
    assert.equal(merges, 0)
  }
  {
    const snap = baseSnapshot({ child: { id: "child", agent: "delegate", parentID: "exec", branch: HEAD_BRANCH, head: SHA } })
    let merges = 0
    const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
    await assert.rejects(runMerge(REQ, EXEC, io), /not a direct sub-coordinator/)
    assert.equal(merges, 0)
  }
  {
    const snap = baseSnapshot({ child: { id: "child", agent: "coordinator", parentID: "exec", branch: "other-branch", head: SHA } })
    let merges = 0
    const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
    await assert.rejects(runMerge(REQ, EXEC, io), /sub-coordinator branch or head changed/)
    assert.equal(merges, 0)
  }
  {
    const snap = baseSnapshot({ child: { id: "child", agent: "coordinator", parentID: "exec", branch: HEAD_BRANCH, head: OTHER_SHA } })
    let merges = 0
    const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
    await assert.rejects(runMerge(REQ, EXEC, io), /sub-coordinator branch or head changed/)
    assert.equal(merges, 0)
  }
})

test("refuses self-authored or unknown authorship", async () => {
  for (const selfAuthored of [true, undefined]) {
    const snap = baseSnapshot({ selfAuthored: selfAuthored as any })
    let merges = 0
    const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
    await assert.rejects(runMerge(REQ, EXEC, io), /executor authored work in this PR, or authorship is unknown/)
    assert.equal(merges, 0)
  }
})

test("refuses invalid authorization", async () => {
  const snap = baseSnapshot({ authorizationValid: false })
  let merges = 0
  const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  await assert.rejects(runMerge(REQ, EXEC, io), /current owner authorization is missing, expired or revoked/)
  assert.equal(merges, 0)
})

test("refuses missing required check", async () => {
  const snap = baseSnapshot({
    checks: [
      { workflow: "bive-tests", name: "tests", bucket: "pass" },
      { workflow: "bive-inviolable", name: "check", bucket: "pass" },
    ],
  })
  let merges = 0
  const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  assert.match(await runMerge(REQ, EXEC, io), /Parent head approval recorded; wait for bive-merge-gate/)
  assert.equal(merges, 0)
})

test("refuses duplicate required check", async () => {
  const snap = baseSnapshot({
    checks: [
      { workflow: "bive-tests", name: "tests", bucket: "pass" },
      { workflow: "bive-tests", name: "tests", bucket: "pass" },
      { workflow: "bive-inviolable", name: "check", bucket: "pass" },
      { workflow: "bive-merge-gate", name: "merge-gate", bucket: "pass" },
    ],
  })
  let merges = 0
  const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  await assert.rejects(runMerge(REQ, EXEC, io), /required check bive-tests \/ tests is not green/)
  assert.equal(merges, 0)
})

test("refuses red required check", async () => {
  const snap = baseSnapshot({
    checks: [
      { workflow: "bive-tests", name: "tests", bucket: "fail" },
      { workflow: "bive-inviolable", name: "check", bucket: "pass" },
      { workflow: "bive-merge-gate", name: "merge-gate", bucket: "pass" },
    ],
  })
  let merges = 0
  const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  await assert.rejects(runMerge(REQ, EXEC, io), /required check bive-tests \/ tests is not green/)
  assert.equal(merges, 0)
})

test("refuses pending required check", async () => {
  const snap = baseSnapshot({
    checks: [
      { workflow: "bive-tests", name: "tests", bucket: "pending" },
      { workflow: "bive-inviolable", name: "check", bucket: "pass" },
      { workflow: "bive-merge-gate", name: "merge-gate", bucket: "pass" },
    ],
  })
  let merges = 0
  const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  await assert.rejects(runMerge(REQ, EXEC, io), /required check bive-tests \/ tests is not green/)
  assert.equal(merges, 0)
})

test("refuses skipped required check except inviolable on coordinator PR", async () => {
  for (const wf of ["bive-tests", "bive-merge-gate"]) {
    const snap = baseSnapshot({
      checks: [
        { workflow: wf, name: wf === "bive-tests" ? "tests" : "merge-gate", bucket: "skipping" },
        { workflow: "bive-inviolable", name: "check", bucket: "pass" },
        { workflow: "bive-tests", name: "tests", bucket: "pass" },
        { workflow: "bive-merge-gate", name: "merge-gate", bucket: "pass" },
      ],
    })
    // remove duplicate of the skipped one's pass? keep simple: ensure not green due skipping duplicate bucket mismatch
    let merges = 0
    const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
    if (wf === "bive-merge-gate") assert.match(await runMerge(REQ, EXEC, io), /wait for bive-merge-gate/)
    else await assert.rejects(runMerge(REQ, EXEC, io), /a check is not green|required check .* is not green/)
    assert.equal(merges, 0)
  }
})

test("refuses a non-green extra check", async () => {
  const snap = baseSnapshot({
    checks: [
      { workflow: "bive-tests", name: "tests", bucket: "pass" },
      { workflow: "bive-inviolable", name: "check", bucket: "pass" },
      { workflow: "bive-merge-gate", name: "merge-gate", bucket: "pass" },
      { workflow: "extra", name: "job", bucket: "fail" },
    ],
  })
  let merges = 0
  const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  await assert.rejects(runMerge(REQ, EXEC, io), /a check is not green/)
  assert.equal(merges, 0)
})

test("refuses inviolable skip when not a coordinator PR", async () => {
  // coordinatorPR false fails earlier, but verify the combined guard still refuses
  const snap = baseSnapshot({
    coordinatorPR: false,
    checks: [
      { workflow: "bive-tests", name: "tests", bucket: "pass" },
      { workflow: "bive-inviolable", name: "check", bucket: "skipping" },
      { workflow: "bive-merge-gate", name: "merge-gate", bucket: "pass" },
    ],
  })
  let merges = 0
  const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  await assert.rejects(runMerge(REQ, EXEC, io), /PR is not labelled coordinator/)
  assert.equal(merges, 0)
})

test("refuses when owner denies permission prompt", async () => {
  const snap = baseSnapshot()
  let merges = 0
  let reads = 0
  const io: MergeIO = {
    read: async () => { reads++; return snap },
    approve: async () => { throw new Error("permission denied by owner") },
    merge: async () => { merges++; return "x" },
    now: () => 1000,
  }
  await assert.rejects(runMerge(REQ, EXEC, io), /permission denied by owner/)
  assert.equal(merges, 0)
  assert.equal(reads, 1)
})

test("refuses when grant expired immediately after permission", async () => {
  const snap = baseSnapshot()
  let t = 1000
  const now = () => t
  let merges = 0
  const io: MergeIO = { read: async () => snap, approve: async () => { t = 200000 }, merge: async () => { merges++; return "x" }, now }
  await assert.rejects(runMerge(REQ, EXEC, io), /one-call grant expired/)
  assert.equal(merges, 0)
})

test("refuses when grant expiry is non-finite", async () => {
  const snap = baseSnapshot()
  let calls = 0
  const now = () => { calls++; return calls === 1 ? 1000 : Infinity }
  let merges = 0
  const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now }
  await assert.rejects(runMerge(REQ, EXEC, io), /one-call grant expired/)
  assert.equal(merges, 0)
})

test("refuses when grant expired on second read", async () => {
  const snap = baseSnapshot()
  let t = 1000
  let reads = 0
  const now = () => t
  let merges = 0
  const io: MergeIO = { read: async () => { if (++reads === 2) t = 200000; return snap }, approve: async () => {}, merge: async () => { merges++; return "x" }, now }
  await assert.rejects(runMerge(REQ, EXEC, io), /scope changed or one-call grant expired/)
  assert.equal(merges, 0)
})

test("refuses when repository changes after permission", async () => {
  const first = baseSnapshot()
  const second = baseSnapshot({ repository: "other/repo" })
  let reads = 0
  const read = async () => { reads++; return reads === 1 ? first : second }
  let merges = 0
  const io: MergeIO = { read, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  await assert.rejects(runMerge(REQ, EXEC, io), /scope changed or one-call grant expired/)
  assert.equal(merges, 0)
})

test("refuses when head changes after permission", async () => {
  const first = baseSnapshot()
  const second = baseSnapshot({ head: OTHER_SHA, child: { id: "child", agent: "coordinator", parentID: "exec", branch: HEAD_BRANCH, head: OTHER_SHA } })
  let reads = 0
  const read = async () => { reads++; return reads === 1 ? first : second }
  let merges = 0
  const io: MergeIO = { read, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  await assert.rejects(runMerge(REQ, EXEC, io), /scope changed or one-call grant expired/)
  assert.equal(merges, 0)
})

test("refuses when base changes after permission", async () => {
  const first = baseSnapshot()
  const second = baseSnapshot({ base: "milestone/0.2" })
  let reads = 0
  const read = async () => { reads++; return reads === 1 ? first : second }
  let merges = 0
  const io: MergeIO = { read, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  await assert.rejects(runMerge(REQ, EXEC, io), /scope changed or one-call grant expired/)
  assert.equal(merges, 0)
})

test("refuses when owner changes after permission", async () => {
  const first = baseSnapshot()
  const second = baseSnapshot({ owner: "other-human" })
  let reads = 0
  const read = async () => { reads++; return reads === 1 ? first : second }
  let merges = 0
  const io: MergeIO = { read, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  await assert.rejects(runMerge(REQ, EXEC, io), /scope changed or one-call grant expired/)
  assert.equal(merges, 0)
})

test("refuses when authorization revoked after permission", async () => {
  const first = baseSnapshot()
  const second = baseSnapshot({ authorizationValid: false })
  let reads = 0
  const read = async () => { reads++; return reads === 1 ? first : second }
  let merges = 0
  const io: MergeIO = { read, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  await assert.rejects(runMerge(REQ, EXEC, io), /current owner authorization is missing, expired or revoked/)
  assert.equal(merges, 0)
})

test("refuses when child changes after permission", async () => {
  const first = baseSnapshot()
  const second = baseSnapshot({ child: { id: "child", agent: "coordinator", parentID: "exec", branch: "other-branch", head: SHA } })
  let reads = 0
  const read = async () => { reads++; return reads === 1 ? first : second }
  let merges = 0
  const io: MergeIO = { read, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  await assert.rejects(runMerge(REQ, EXEC, io), /sub-coordinator branch or head changed/)
  assert.equal(merges, 0)
})

test("each invocation requires a fresh permission and merge (no reusable grant)", async () => {
  const snap = baseSnapshot()
  let approveCount = 0
  let mergeCount = 0
  let readCount = 0
  const makeIO = (): MergeIO => ({
    read: async () => { readCount++; return snap },
    approve: async () => { approveCount++ },
    merge: async () => { mergeCount++; return "merged" },
    now: () => 1000,
  })
  const r1 = await runMerge(REQ, EXEC, makeIO())
  const r2 = await runMerge(REQ, EXEC, makeIO())
  assert.equal(r1, "merged")
  assert.equal(r2, "merged")
  assert.equal(approveCount, 2)
  assert.equal(mergeCount, 2)
  assert.equal(readCount, 4)
})

test("refuses an already merged PR", async () => {
  const snap = baseSnapshot({ state: "MERGED" })
  let merges = 0
  const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  await assert.rejects(runMerge(REQ, EXEC, io), /PR is not an open same-repository head/)
  assert.equal(merges, 0)
})

test("refuses when owner opt-in is missing (undefined)", async () => {
  const snap = baseSnapshot({ enabled: undefined as any })
  let merges = 0
  const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  await assert.rejects(runMerge(REQ, EXEC, io), /owner opt-in is off on the base branch/)
  assert.equal(merges, 0)
})

test("refuses a skipped bive-tests required check", async () => {
  const snap = baseSnapshot({
    checks: [
      { workflow: "bive-tests", name: "tests", bucket: "skipping" },
      { workflow: "bive-inviolable", name: "check", bucket: "pass" },
      { workflow: "bive-merge-gate", name: "merge-gate", bucket: "pass" },
    ],
  })
  let merges = 0
  const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  await assert.rejects(runMerge(REQ, EXEC, io), /required check bive-tests \/ tests is not green/)
  assert.equal(merges, 0)
})

test("refuses a skipped merge-gate required check", async () => {
  const snap = baseSnapshot({
    checks: [
      { workflow: "bive-tests", name: "tests", bucket: "pass" },
      { workflow: "bive-inviolable", name: "check", bucket: "pass" },
      { workflow: "bive-merge-gate", name: "merge-gate", bucket: "skipping" },
    ],
  })
  let merges = 0
  const io: MergeIO = { read: async () => snap, approve: async () => {}, merge: async () => { merges++; return "x" }, now: () => 1000 }
  assert.match(await runMerge(REQ, EXEC, io), /Parent head approval recorded; wait for bive-merge-gate/)
  assert.equal(merges, 0)
})

test("uses Date.now by default when now is omitted", async () => {
  const snap = baseSnapshot()
  let merges = 0
  const io: MergeIO = {
    read: async () => snap,
    approve: async () => {},
    merge: async () => { merges++; return "merged-default" },
  }
  assert.equal(await runMerge(REQ, EXEC, io), "merged-default")
  assert.equal(merges, 1)
})
