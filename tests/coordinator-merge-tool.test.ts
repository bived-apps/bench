import assert from "node:assert/strict"
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test, { after } from "node:test"
import { APPROVAL_LIFETIME_MS, APPROVAL_PREFIX, approvalBytes } from "../.github/scripts/coordinator-approval-lib.mjs"
import { registerCoordinatorMerge } from "../.opencode/plugins/worktree-guard/merge-tool.ts"
import { runMergeGate } from "../.github/scripts/check-merge-gate.mjs"

const PARENT = "ses_parent"
const CHILD = "ses_child"
const REPOSITORY = "owner/repo"
const BASE = "bived"
const HEAD_BRANCH = "issue/266-adapter-tests"
const SHA = "a".repeat(40)
const OTHER_SHA = "b".repeat(40)
const ROOT = mkdtempSync(path.join(tmpdir(), "bive-coordinator-merge-"))
const CHILD_DIR = "/repo/child"

// The parent coordinator's signing key is handed over by the owner; the grant on the base carries its public half.
const { privateKey, publicKey } = generateKeyPairSync("ed25519")
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString()
const { privateKey: forgedKey } = generateKeyPairSync("ed25519")

process.env.BIVE_PARENT_APPROVAL_KEY = PRIVATE_PEM

after(() => rmSync(ROOT, { recursive: true, force: true }))

let grantSeq = 0
function makeGrant(overrides: any = {}) {
  grantSeq++
  return {
    id: `grant-266-${grantSeq}`,
    repository: REPOSITORY,
    executor: PARENT,
    base: BASE,
    maxApprovals: 2,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    publicKey: PUBLIC_PEM,
    children: [{ id: CHILD, branch: HEAD_BRANCH }],
    ...overrides,
  }
}

function passChecks() {
  return [
    { workflow: "bive-tests", name: "tests", bucket: "pass", state: "SUCCESS" },
    { workflow: "bive-inviolable", name: "check", bucket: "pass", state: "SUCCESS" },
    { workflow: "bive-merge-gate", name: "merge-gate", bucket: "pass", state: "SUCCESS" },
  ]
}

function pendingGate() {
  const checks = passChecks()
  checks[2] = { workflow: "bive-merge-gate", name: "merge-gate", bucket: "pending", state: "IN_PROGRESS" }
  return checks
}

function createEnv(overrides: any = {}) {
  const grant = overrides.grant ?? makeGrant()
  const S: any = {
    root: ROOT,
    childDir: CHILD_DIR,
    parentSession: PARENT,
    childSession: CHILD,
    sha: SHA,
    repository: REPOSITORY,
    grant,
    gateConfig: { owner: "human", coordinatorMerges: true, skippable: [], coordinatorMergeGrants: [grant] },
    pr: {
      number: 123,
      state: "OPEN",
      headRefOid: SHA,
      baseRefName: BASE,
      headRefName: HEAD_BRANCH,
      headRepository: { name: "repo" },
      headRepositoryOwner: { login: "owner" },
      isCrossRepository: false,
      commits: [{ authors: [{ name: "coordinator model [session=ses_child]" }] }],
    },
    childBranch: HEAD_BRANCH,
    childHead: SHA,
    rootBranch: "main",
    authorName: "coordinator model [session=ses_parent]",
    executorAgent: "coordinator",
    executorDir: ROOT,
    childAgent: "coordinator",
    childParentID: PARENT,
    gatePr: {
      baseRefName: BASE,
      headRefOid: SHA,
      labels: ["coordinator"],
    },
    checks: passChecks(),
    files: ["tests/coordinator-merge-tool.test.ts"],
    comments: [] as any[],
    commentCalls: [] as any[],
    mergeCalls: [] as any[],
    mutateAfterApprove: null,
    ...overrides,
  }

  // Every process is stubbed: this test never calls the real gh or git and never merges.
  const execute = async (command: string, args: string[], cwd?: string) => {
    if (command === "gh") {
      if (args[0] === "repo" && args[1] === "view") return S.repository
      if (args[0] === "pr" && args[1] === "view") {
        const fields = args[args.indexOf("--json") + 1]
        if (fields === "files") return JSON.stringify({ files: S.files.map((file: string) => ({ path: file })) })
        if (fields === "baseRefName,headRefOid,labels") {
          return JSON.stringify({
            baseRefName: S.gatePr.baseRefName,
            headRefOid: S.gatePr.headRefOid,
            labels: S.gatePr.labels.map((name: string) => ({ name })),
          })
        }
        return JSON.stringify(S.pr)
      }
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify(S.checks)
      if (args[0] === "pr" && args[1] === "comment") {
        const body = readFileSync(args[args.indexOf("--body-file") + 1], "utf8")
        S.commentCalls.push({ command, args: [...args], cwd, body })
        S.comments.push({ body })
        if (typeof S.mutateAfterApprove === "function") S.mutateAfterApprove(S)
        return ""
      }
      if (args[0] === "pr" && args[1] === "merge") {
        S.mergeCalls.push({ command, args: [...args], cwd })
        return "Merged #123"
      }
      if (args[0] === "api") {
        const target = args[1]
        if (target.includes("/contents/.bive/gate.json")) {
          if (S.gateConfig === null) throw new Error("not found")
          const text = typeof S.gateConfig === "string" ? S.gateConfig : JSON.stringify(S.gateConfig)
          return Buffer.from(text, "utf8").toString("base64")
        }
        if (target.endsWith("/comments")) {
          return S.comments.map((comment: any) => JSON.stringify({ body: comment.body })).join("\n")
        }
        throw new Error(`unknown gh api path: ${target}`)
      }
      throw new Error(`unknown gh args: ${args.join(" ")}`)
    }
    if (command === "git") {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
        return cwd === S.childDir ? S.childBranch : S.rootBranch
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") return cwd === S.childDir ? S.childHead : S.sha
      if (args[0] === "config" && args[1] === "--get" && args[2] === "user.name") return S.authorName
      throw new Error(`unknown git args: ${args.join(" ")}`)
    }
    throw new Error(`unknown command: ${command}`)
  }

  const captured: any = { tool: null }
  const ctx: any = {
    tool: {
      transform: async (cb: any) => {
        const editor = { add: (tool: any) => { captured.tool = tool } }
        cb(editor)
      },
    },
    session: {
      get: async ({ sessionID }: any) => {
        if (sessionID === S.parentSession) {
          return { data: { id: S.parentSession, agent: S.executorAgent, location: { directory: S.executorDir } } }
        }
        if (sessionID === S.childSession) {
          return { data: { id: S.childSession, agent: S.childAgent, parentID: S.childParentID, location: { directory: S.childDir } } }
        }
        return { data: null }
      },
    },
  }

  return { S, root: ROOT, parentSession: PARENT, childSession: CHILD, sha: SHA, execute, ctx, captured }
}

async function register(env: any, role = "coordinator", roleFile?: string) {
  await registerCoordinatorMerge(env.ctx, env.root, role, roleFile, env.execute)
  if (!env.captured.tool) throw new Error("tool was not registered")
  return env.captured.tool
}

function contextFor(env: any, agent = "coordinator") {
  return { agent, sessionID: env.parentSession, messageID: "msg", id: "toolcall", signal: undefined }
}

// A comment shaped like the parent's signed approval; `signer` and `signature` let a test forge or strip it.
function approvalComment(env: any, options: any = {}) {
  const issuedAt = Date.now()
  const payload = {
    grant: env.S.grant.id,
    repository: REPOSITORY,
    number: 123,
    head: SHA,
    base: BASE,
    executor: PARENT,
    childSession: CHILD,
    headBranch: HEAD_BRANCH,
    issuedAt,
    expiresAt: Math.min(issuedAt + APPROVAL_LIFETIME_MS, Date.parse(env.S.grant.expiresAt)),
    sequence: 1,
    ...options.payload,
  }
  const signature = options.signature !== undefined
    ? options.signature
    : sign(null, approvalBytes(payload), options.signer ?? privateKey).toString("base64")
  return { body: APPROVAL_PREFIX + JSON.stringify({ payload, signature }) }
}

async function refused(env: any, pattern: RegExp, role = "coordinator", roleFile?: string, input: any = { number: 123, childSession: CHILD }) {
  const tool = await register(env, role, roleFile)
  await assert.rejects(tool.execute(input, contextFor(env)), pattern)
  assert.equal(env.S.mergeCalls.length, 0, "a refused merge must never run gh pr merge")
  return env
}

test("registers the tool with no owner permission prompt", async () => {
  const env = createEnv()
  const tool = await register(env)
  assert.equal(tool.name, "bive_coordinator_merge")
  assert.equal(env.ctx.permission, undefined)
  assert.deepEqual(tool.input.required, ["number", "childSession"])
})

test("first call records the parent approval and waits for the merge gate", async () => {
  const env = createEnv({ checks: pendingGate() })
  const tool = await register(env)
  const res = await tool.execute({ number: 123, childSession: CHILD }, contextFor(env))

  assert.match(res.content, /Parent head approval recorded; wait for bive-merge-gate/)
  assert.equal(env.S.mergeCalls.length, 0)
  assert.equal(env.S.commentCalls.length, 1)

  const call = env.S.commentCalls[0]
  assert.deepEqual(call.args.slice(0, 2), ["pr", "comment"])
  assert.ok(call.args.includes("--repo") && call.args.includes(REPOSITORY))
  assert.ok(call.args.includes("--body-file"))
  assert.equal(call.args[call.args.indexOf("--body-file") + 1], path.join(ROOT, ".bive", "state", "approval-123.md"))
  assert.ok(call.body.startsWith(APPROVAL_PREFIX))

  const envelope = JSON.parse(call.body.slice(APPROVAL_PREFIX.length))
  assert.deepEqual(Object.keys(envelope.payload).sort(), ["base", "childSession", "executor", "expiresAt", "grant",
    "head", "headBranch", "issuedAt", "number", "repository", "sequence"])
  assert.equal(envelope.payload.grant, env.S.grant.id)
  assert.equal(envelope.payload.repository, REPOSITORY)
  assert.equal(envelope.payload.number, 123)
  assert.equal(envelope.payload.head, SHA)
  assert.equal(envelope.payload.base, BASE)
  assert.equal(envelope.payload.executor, PARENT)
  assert.equal(envelope.payload.childSession, CHILD)
  assert.equal(envelope.payload.headBranch, HEAD_BRANCH)
  assert.equal(envelope.payload.sequence, 1)
  assert.equal(typeof envelope.signature, "string")
  assert.ok(verify(null, approvalBytes(envelope.payload), createPublicKey(PUBLIC_PEM),
    Buffer.from(envelope.signature, "base64")), "the parent approval must be signed by the granted key")
})

test("a valid approval already present plus a green gate merges the pinned head", async () => {
  const env = createEnv()
  env.S.comments.push(approvalComment(env))
  const tool = await register(env)

  const res = await tool.execute({ number: 123, childSession: CHILD }, contextFor(env))
  assert.deepEqual(res, { content: "Merged #123" })
  assert.equal(env.S.commentCalls.length, 0, "an existing valid approval is reused, not posted twice")
  assert.equal(env.S.mergeCalls.length, 1)
  assert.deepEqual(env.S.mergeCalls[0].args,
    ["pr", "merge", "123", "--repo", REPOSITORY, "--merge", "--match-head-commit", SHA])
  assert.equal(env.S.mergeCalls[0].cwd, ROOT)
})

test("after the gate turns green the recorded approval is reused and the head is merged", async () => {
  const env = createEnv({ checks: pendingGate() })
  const tool = await register(env)
  const first = await tool.execute({ number: 123, childSession: CHILD }, contextFor(env))
  assert.match(first.content, /wait for bive-merge-gate/)
  assert.equal(env.S.mergeCalls.length, 0)

  env.S.checks = passChecks()
  const res = await tool.execute({ number: 123, childSession: CHILD }, contextFor(env))
  assert.deepEqual(res, { content: "Merged #123" })
  assert.equal(env.S.commentCalls.length, 1)
  assert.equal(env.S.mergeCalls.length, 1)
  assert.deepEqual(env.S.mergeCalls[0].args,
    ["pr", "merge", "123", "--repo", REPOSITORY, "--merge", "--match-head-commit", SHA])
})

test("denies advisor role", async () => {
  await refused(createEnv(), /only a coordinator may request owner opt-in/, "advisor")
})

test("denies legacy supervisor role", async () => {
  await refused(createEnv(), /only a coordinator may request owner opt-in/, "supervisor")
})

test("denies delegate role", async () => {
  await refused(createEnv(), /only a coordinator may request owner opt-in/, "delegate")
})

test("denies delegate role file", async () => {
  await refused(createEnv(), /only a coordinator may request owner opt-in/, "coordinator", "delegate")
})

test("denies non-coordinator agent", async () => {
  const env = createEnv()
  const tool = await register(env)
  await assert.rejects(tool.execute({ number: 123, childSession: CHILD }, contextFor(env, "build")),
    /only a coordinator may request owner opt-in/)
  assert.equal(env.S.mergeCalls.length, 0)
})

test("denies when opt-in is false", async () => {
  await refused(createEnv({ gateConfig: { owner: "human", coordinatorMerges: false } }),
    /base owner opt-in is off or invalid/)
})

test("denies when opt-in is missing", async () => {
  await refused(createEnv({ gateConfig: { owner: "human" } }), /base owner opt-in is off or invalid/)
})

test("denies when opt-in config is corrupt", async () => {
  await refused(createEnv({ gateConfig: "{bad json" }), /./)
})

test("denies when human owner is missing", async () => {
  await refused(createEnv({ gateConfig: { coordinatorMerges: true } }), /base owner opt-in is off or invalid/)
})

test("denies when the base lists no grants", async () => {
  await refused(createEnv({ gateConfig: { owner: "human", coordinatorMerges: true, coordinatorMergeGrants: [] } }),
    /current owner authorization is missing, expired or revoked/)
})

test("denies a grant for another repository", async () => {
  await refused(createEnv({ grant: makeGrant({ repository: "other/repo" }) }),
    /current owner authorization is missing, expired or revoked/)
})

test("denies a grant for another executor session", async () => {
  await refused(createEnv({ grant: makeGrant({ executor: "ses_other" }) }),
    /current owner authorization is missing, expired or revoked/)
})

test("denies a grant for another base", async () => {
  await refused(createEnv({ grant: makeGrant({ base: "milestone/0.2" }) }),
    /current owner authorization is missing, expired or revoked/)
})

test("denies a grant whose child session is not listed", async () => {
  await refused(createEnv({ grant: makeGrant({ children: [{ id: "ses_other", branch: HEAD_BRANCH }] }) }),
    /current owner authorization is missing, expired or revoked/)
})

test("denies a grant for another child branch", async () => {
  await refused(createEnv({ grant: makeGrant({ children: [{ id: CHILD, branch: "issue/999-other" }] }) }),
    /current owner authorization is missing, expired or revoked/)
})

test("denies an expired grant", async () => {
  await refused(createEnv({ grant: makeGrant({ expiresAt: new Date(Date.now() - 60_000).toISOString() }) }),
    /current owner authorization is missing, expired or revoked/)
})

test("denies a grant with an invalid public key", async () => {
  await refused(createEnv({ grant: makeGrant({ publicKey: "not an ed25519 key" }) }),
    /current owner authorization is missing, expired or revoked/)
})

test("denies a grant with an invalid approval budget", async () => {
  await refused(createEnv({ grant: makeGrant({ maxApprovals: 0 }) }),
    /current owner authorization is missing, expired or revoked/)
})

test("denies once the grant's approvals are used up", async () => {
  const env = createEnv({ grant: makeGrant({ maxApprovals: 1 }) })
  env.S.comments.push({ body: APPROVAL_PREFIX + JSON.stringify({ payload: { grant: env.S.grant.id } }) })
  await refused(env, /the grant's approvals are used up/)
  assert.equal(env.S.commentCalls.length, 0)
})

test("denies when the parent approval key is missing", async () => {
  const saved = process.env.BIVE_PARENT_APPROVAL_KEY
  delete process.env.BIVE_PARENT_APPROVAL_KEY
  try {
    const env = createEnv()
    await refused(env, /no grant, or no approval key handed over by the owner/)
    assert.equal(env.S.commentCalls.length, 0)
  } finally {
    process.env.BIVE_PARENT_APPROVAL_KEY = saved
  }
})

test("denies a forged approval comment", async () => {
  const env = createEnv()
  env.S.comments.push(approvalComment(env, { signer: forgedKey }))
  const saved = process.env.BIVE_PARENT_APPROVAL_KEY
  delete process.env.BIVE_PARENT_APPROVAL_KEY
  try {
    await refused(env, /no grant, or no approval key handed over by the owner/)
    assert.equal(env.S.commentCalls.length, 0)
  } finally {
    process.env.BIVE_PARENT_APPROVAL_KEY = saved
  }
})

test("denies an unsigned approval comment", async () => {
  const env = createEnv()
  env.S.comments.push(approvalComment(env, { signature: "" }))
  const saved = process.env.BIVE_PARENT_APPROVAL_KEY
  delete process.env.BIVE_PARENT_APPROVAL_KEY
  try {
    await refused(env, /no grant, or no approval key handed over by the owner/)
    assert.equal(env.S.commentCalls.length, 0)
  } finally {
    process.env.BIVE_PARENT_APPROVAL_KEY = saved
  }
})

test("denies wrong executor location", async () => {
  await refused(createEnv({ executorDir: "/elsewhere" }), /not a direct sub-coordinator session/)
})

test("denies wrong executor agent", async () => {
  await refused(createEnv({ executorAgent: "delegate" }), /not a direct sub-coordinator session/)
})

test("denies wrong child parent", async () => {
  await refused(createEnv({ childParentID: "someone-else" }), /not a direct sub-coordinator session/)
})

test("denies wrong child agent", async () => {
  await refused(createEnv({ childAgent: "delegate" }), /not a direct sub-coordinator session/)
})

test("denies wrong child branch", async () => {
  await refused(createEnv({ childBranch: "other-branch" }), /sub-coordinator branch or head changed/)
})

test("denies wrong child head", async () => {
  await refused(createEnv({ childHead: OTHER_SHA }), /sub-coordinator branch or head changed/)
})

test("denies same own branch (self-authored)", async () => {
  await refused(createEnv({ rootBranch: HEAD_BRANCH }),
    /executor authored work in this PR, or authorship is unknown/)
})

test("denies self-authored commit", async () => {
  const env = createEnv()
  env.S.pr.commits = [{ authors: [{ name: "coordinator model [session=ses_parent]" }] }]
  await refused(env, /executor authored work in this PR, or authorship is unknown/)
})

test("denies unknown authorship (no commits)", async () => {
  const env = createEnv()
  env.S.pr.commits = []
  await refused(env, /executor authored work in this PR, or authorship is unknown/)
})

test("denies ambiguous old coordinator author", async () => {
  const env = createEnv()
  env.S.pr.commits = [{ authors: [{ name: "coordinator legacy" }] }]
  await refused(env, /executor authored work in this PR, or authorship is unknown/)
})

for (const file of [".bive/gate.json", "AGENTS.md", "opencode.jsonc", ".bive/prompts/DELEGATE.md",
  ".opencode/plugins/worktree-guard/merge-tool.ts", ".github/scripts/coordinator-approval-lib.mjs",
  ".github/workflows/bive-tests.yml"]) {
  test(`denies authority or enforcement change: ${file}`, async () => {
    const env = await refused(createEnv({ files: [file] }), /owner must merge changes to authority or enforcement/)
    assert.equal(env.S.commentCalls.length, 0)
  })
}

test("denies pending checks", async () => {
  const env = createEnv()
  env.S.checks = [
    { workflow: "bive-tests", name: "tests", bucket: "pending", state: "IN_PROGRESS" },
    { workflow: "bive-inviolable", name: "check", bucket: "pass", state: "SUCCESS" },
    { workflow: "bive-merge-gate", name: "merge-gate", bucket: "pass", state: "SUCCESS" },
  ]
  await refused(env, /required check bive-tests \/ tests is not green/)
})

test("denies red checks", async () => {
  const env = createEnv()
  env.S.checks = [
    { workflow: "bive-tests", name: "tests", bucket: "fail", state: "FAILURE" },
    { workflow: "bive-inviolable", name: "check", bucket: "pass", state: "SUCCESS" },
    { workflow: "bive-merge-gate", name: "merge-gate", bucket: "pass", state: "SUCCESS" },
  ]
  await refused(env, /required check bive-tests \/ tests is not green/)
})

test("denies missing required checks", async () => {
  const env = createEnv()
  env.S.checks = [
    { workflow: "bive-inviolable", name: "check", bucket: "pass", state: "SUCCESS" },
    { workflow: "bive-merge-gate", name: "merge-gate", bucket: "pass", state: "SUCCESS" },
  ]
  await refused(env, /required check bive-tests \/ tests is not green/)
})

test("a red merge gate only waits and never merges", async () => {
  const env = createEnv({
    checks: [
      { workflow: "bive-tests", name: "tests", bucket: "pass", state: "SUCCESS" },
      { workflow: "bive-inviolable", name: "check", bucket: "pass", state: "SUCCESS" },
      { workflow: "bive-merge-gate", name: "merge-gate", bucket: "fail", state: "FAILURE" },
    ],
  })
  const tool = await register(env)
  const res = await tool.execute({ number: 123, childSession: CHILD }, contextFor(env))
  assert.match(res.content, /Parent head approval recorded; wait for bive-merge-gate/)
  assert.equal(env.S.mergeCalls.length, 0)
  assert.equal(env.S.commentCalls.length, 1)
})

test("denies when head changes during approval", async () => {
  const env = createEnv()
  env.S.mutateAfterApprove = (S: any) => {
    S.pr.headRefOid = OTHER_SHA
    S.gatePr.headRefOid = OTHER_SHA
    S.childHead = OTHER_SHA
  }
  await refused(env, /scope changed or one-call grant expired/)
})

test("denies when base changes during approval", async () => {
  const env = createEnv()
  env.S.mutateAfterApprove = (S: any) => {
    S.pr.baseRefName = "milestone/0.2"
    S.gatePr.baseRefName = "milestone/0.2"
  }
  await refused(env, /current owner authorization is missing, expired or revoked|scope changed/)
})

test("denies when opt-in is disabled during approval", async () => {
  const env = createEnv()
  env.S.mutateAfterApprove = (S: any) => {
    S.gateConfig = { owner: "human", coordinatorMerges: false }
  }
  await refused(env, /base owner opt-in is off or invalid/)
})

test("cross-repository PR is denied", async () => {
  const env = createEnv()
  env.S.pr.isCrossRepository = true
  env.S.pr.headRepositoryOwner = { login: "other" }
  await refused(env, /not an open same-repository head/)
})

test("closed PR is denied", async () => {
  const env = createEnv()
  env.S.pr.state = "CLOSED"
  await refused(env, /not an open same-repository head/)
})

test("non-coordinator labelled PR is denied", async () => {
  const env = createEnv()
  env.S.gatePr.labels = []
  await refused(env, /PR is not labelled coordinator/)
})

test("main as base is denied", async () => {
  const env = createEnv()
  env.S.pr.baseRefName = "main"
  env.S.gatePr.baseRefName = "main"
  await refused(env, /main is the owner's alone/)
})

test("unsupported base is denied", async () => {
  const env = createEnv()
  env.S.pr.baseRefName = "develop"
  env.S.gatePr.baseRefName = "develop"
  await refused(env, /unsupported integration base/)
})

// Offline end-to-end simulation (owner chose it over a scratch repository, 2026-11-14): the approval the tool posts is the
// very text the gate verifies, then the tool merges the pinned head. Only GitHub is faked; the signing, the grant lookup,
// the comment format and the gate's own decision are the real code.
function gateFor(env: any, comments: any[], opts: { labels?: string[], files?: string[], base?: string, config?: any } = {}) {
  const base = opts.base ?? BASE
  return runMergeGate({
    event: { pull_request: { number: 123, head: { sha: SHA }, base: { ref: base } } }, repository: REPOSITORY,
    readPullRequest: async () => ({ baseRefName: base, headRefOid: SHA, labels: opts.labels ?? ["coordinator"] }),
    readChecks: async () => [{ workflow: "bive-tests", name: "tests", bucket: "pass" }, { workflow: "bive-inviolable", name: "check", bucket: "skipping" }],
    readGateConfig: async () => JSON.stringify(opts.config ?? env.S.gateConfig),
    readParentContext: async () => ({ headBranch: HEAD_BRANCH, sameRepository: true, state: "OPEN", files: opts.files ?? ["docs/a.md"] }),
    readComments: async () => comments,
    readLabelEvents: async () => [], readRepositoryOwner: async () => "human",
  })
}

test("simulation: the tool's approval comment passes the real gate with no label, then the tool merges the pinned head", async () => {
  const env = createEnv({ checks: pendingGate() })
  const tool = await register(env)
  await tool.execute({ number: 123, childSession: CHILD }, contextFor(env))
  assert.equal(env.S.commentCalls.length, 1)
  const posted = { body: env.S.commentCalls[0].body }
  assert.equal((await gateFor(env, [posted])).ok, true, "the gate accepts exactly what the tool posted")

  const second = createEnv()
  second.S.comments.push(posted)
  const res = await (await register(second)).execute({ number: 123, childSession: CHILD }, contextFor(second))
  assert.deepEqual(res, { content: "Merged #123" })
  assert.equal(second.S.mergeCalls.length, 1)
})

test("simulation: the same approval does not pass when the PR touches authority files, targets main, or opt-in is off", async () => {
  const env = createEnv({ checks: pendingGate() })
  await (await register(env)).execute({ number: 123, childSession: CHILD }, contextFor(env))
  const posted = { body: env.S.commentCalls[0].body }
  await assert.rejects(gateFor(env, [posted], { files: [".bive/gate.json"] }), /dated merge-authorization label/)
  await assert.rejects(gateFor(env, [posted], { files: ["AGENTS.md"] }), /dated merge-authorization label/)
  await assert.rejects(gateFor(env, [posted], { base: "main" }), /only runs for pull requests targeting bived or milestone/)
  await assert.rejects(gateFor(env, [posted], { config: { ...env.S.gateConfig, coordinatorMerges: false } }), /dated merge-authorization label/)
  await assert.rejects(gateFor(env, []), /dated merge-authorization label/)
})
