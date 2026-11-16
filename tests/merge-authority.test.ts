import assert from "node:assert/strict"
import test from "node:test"
import { checkMergeAuthority } from "../.github/scripts/check-merge-authority.mjs"

test("a merge commit whose committer did not author any brought-in commit passes", () => {
  const r = checkMergeAuthority({ isMergeCommit: true, committer: "supervisor <s@bive.invalid>",
    authors: ["delegate opencode/beam-free <delegate@bive.invalid>"] })
  assert.equal(r.ok, true)
})

test("refuses a non-merge commit", () => {
  const r = checkMergeAuthority({ isMergeCommit: false, committer: "x", authors: [] })
  assert.equal(r.ok, false)
  assert.match(r.reason, /merge commit/)
})

test("refuses when the committer also authored a brought-in commit", () => {
  const r = checkMergeAuthority({ isMergeCommit: true, committer: "delegate opencode/beam-free <delegate@bive.invalid>",
    authors: ["delegate opencode/beam-free <delegate@bive.invalid>", "other <o@bive.invalid>"] })
  assert.equal(r.ok, false)
  assert.match(r.reason, /author of a commit it brings in/)
})

test("passes with no brought-in authors", () => {
  const r = checkMergeAuthority({ isMergeCommit: true, committer: "supervisor <s@bive.invalid>", authors: [] })
  assert.equal(r.ok, true)
})