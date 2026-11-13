import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const workflow = readFileSync(new URL("../.github/workflows/bive-authorize-merge.yml", import.meta.url), "utf8")
const gate = readFileSync(new URL("../.github/workflows/bive-merge-gate.yml", import.meta.url), "utf8")

test("owner authorization is manual, bounded and has explicit PR/head inputs", () => {
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /pull_request:\n\s+description:/)
  assert.match(workflow, /head_sha:\n\s+description:/)
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request_target|issues|issue_comment):\s*$/m)
  assert.match(workflow, /timeout-minutes: 5/)
  assert.match(workflow, /cancel-in-progress: false/)
})

test("the write-token job checks out trusted default-branch code, never PR-head code", () => {
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/)
  assert.match(workflow, /persist-credentials: false/)
  assert.doesNotMatch(workflow, /ref:.*(?:head_sha|head\.sha|head_ref)/)
  assert.match(workflow, /contents: read/)
  assert.match(workflow, /pull-requests: read/)
  assert.match(workflow, /issues: write/)
  assert.match(workflow, /actions: write/)
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write|write-all/)
})

test("inputs and credentials are passed as environment data, not interpolated shell code", () => {
  assert.match(workflow, /BIVE_PR_NUMBER: \$\{\{ inputs\.pull_request \}\}/)
  assert.match(workflow, /BIVE_HEAD_SHA: \$\{\{ inputs\.head_sha \}\}/)
  assert.match(workflow, /BIVE_MERGE_OWNER: \$\{\{ vars\.BIVE_MERGE_OWNER \}\}/)
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/)
  assert.match(workflow, /run: node \.github\/scripts\/authorize-merge\.mjs/)
  assert.doesNotMatch(workflow, /run:.*\$\{\{/)
})

test("existing protected gate identity and base-only checkout remain unchanged", () => {
  assert.match(gate, /^name: bive-merge-gate$/m)
  assert.match(gate, /run-name: "Merge gate PR #\$\{\{ github\.event\.pull_request\.number \}\} head \$\{\{ github\.event\.pull_request\.head\.sha \}\} base \$\{\{ github\.event\.pull_request\.base\.ref \}\}"/)
  assert.match(gate, /^  merge-gate:$/m)
  assert.match(gate, /pull_request_target:/)
  assert.match(gate, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/)
  assert.doesNotMatch(gate, /(?:contents|pull-requests|checks): write/)
})
