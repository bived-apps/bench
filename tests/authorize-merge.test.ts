import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import {
  boundGrantLabel,
  validateBoundAuthorization,
  authorizeMerge,
  GRANT_LABEL_PREFIX,
} from "../.github/scripts/authorize-merge-lib.mjs"
import { createGitHubApi, parsePrNumber } from "../.github/scripts/authorize-merge.mjs"
import { isIntegrationBranch } from "../.github/scripts/merge-gate-lib.mjs"

const REPO = "owner/repo"
const NUMBER = 70
const HEAD = "a".repeat(40)
const BASE = "bived"
const OWNER = "octocat"
const NOW = Date.parse("2026-11-13T12:00:00.000Z")
const DATE = "2026-11-13"
const RUN_ID = 9001

function statusError(status, message = "request failed") {
  const error = new Error(message)
  error.status = status
  return error
}

function grantFor(number = NUMBER, head = HEAD, base = BASE, date = DATE) {
  return boundGrantLabel({ number, headSha: head, baseRef: base, date })
}

function datedLabel(date = DATE) {
  return `bive-merge-authorized-until-${date}`
}

function makeRun(overrides = {}) {
  return {
    id: RUN_ID,
    status: "completed",
    path: ".github/workflows/bive-merge-gate.yml",
    event: "pull_request_target",
    display_title: `Merge gate PR #${NUMBER} head ${HEAD} base ${BASE}`,
    pull_requests: [],
    ...overrides,
  }
}

function makePr(overrides = {}) {
  return {
    state: "open",
    draft: false,
    head: { sha: HEAD, repo: { full_name: REPO } },
    base: { ref: BASE, repo: { full_name: REPO } },
    labels: [],
    ...overrides,
  }
}

function makeHarness(options = {}) {
  const {
    prLabelsSequence = null,
    comments = [{ body: `Ready to merge ${HEAD} coordinator` }],
    runs = [makeRun()],
    runLookup = null,
    failOn = null,
  } = options

  const prState = { labels: [] }
  let prReadCount = 0
  const sequence = prLabelsSequence ? [...prLabelsSequence] : null

  const api = async (method, path, body) => {
    if (failOn && failOn(method, path, body)) {
      throw statusError(500, "forced failure")
    }

    if (method === "GET" && path === `/repos/${REPO}/pulls/${NUMBER}`) {
      prReadCount++
      let labels = prState.labels
      if (sequence && prReadCount <= sequence.length) {
        labels = sequence[prReadCount - 1]
      }
      return makePr({ labels })
    }

    if (method === "GET" && path.startsWith(`/repos/${REPO}/issues/${NUMBER}/comments`)) {
      return comments
    }

    if (method === "GET" && path.startsWith(`/repos/${REPO}/actions/workflows/bive-merge-gate.yml/runs`)) {
      return { workflow_runs: runs }
    }

    if (method === "GET" && path === `/repos/${REPO}/labels/${encodeURIComponent(datedLabel())}`) {
      throw statusError(404, "not found")
    }
    if (method === "GET" && path === `/repos/${REPO}/labels/${encodeURIComponent(grantFor())}`) {
      throw statusError(404, "not found")
    }
    if (method === "GET" && path.startsWith(`/repos/${REPO}/labels/`)) {
      return { name: "label" }
    }

    if (method === "POST" && path === `/repos/${REPO}/labels`) {
      return {}
    }

    if (method === "DELETE" && path.startsWith(`/repos/${REPO}/issues/${NUMBER}/labels/`)) {
      return null
    }

    if (method === "POST" && path === `/repos/${REPO}/issues/${NUMBER}/labels`) {
      prState.labels = body.labels
      return {}
    }

    if (method === "GET" && path === `/repos/${REPO}/actions/runs/${RUN_ID}`) {
      if (runLookup) return runLookup()
      return runs[0] || makeRun()
    }

    if (method === "POST" && path === `/repos/${REPO}/actions/runs/${RUN_ID}/rerun`) {
      return {}
    }

    throw new Error(`unexpected ${method} ${path}`)
  }

  api.calls = []
  const wrapped = async (method, path, body) => {
    const result = await api(method, path, body)
    wrapped.calls.push({ method, path, body })
    return result
  }
  wrapped.calls = []
  // Rebind calls tracking by wrapping again consistently
  const tracked = async (method, path, body) => {
    const result = await api(method, path, body)
    tracked.calls.push({ method, path, body })
    return result
  }
  tracked.calls = []
  return tracked
}

test("boundGrantLabel is deterministic and fits GitHub's limit", () => {
  const label = boundGrantLabel({ number: NUMBER, headSha: HEAD, baseRef: BASE, date: DATE })
  assert.equal(label.startsWith("bive-grant-"), true)
  assert.equal(label.length, 43)
  assert.match(label.slice("bive-grant-".length), /^[0-9a-f]{32}$/)
  const expectedDigest = createHash("sha256").update(JSON.stringify([NUMBER, HEAD, BASE, DATE])).digest("hex").slice(0, 32)
  assert.equal(label, `bive-grant-${expectedDigest}`)
  assert.equal(boundGrantLabel({ number: NUMBER, headSha: HEAD, baseRef: BASE, date: DATE }), label)
})

test("boundGrantLabel rejects invalid inputs", () => {
  assert.throws(() => boundGrantLabel({ number: 0, headSha: HEAD, baseRef: BASE, date: DATE }), /positive safe integer/)
  assert.throws(() => boundGrantLabel({ number: 1.5, headSha: HEAD, baseRef: BASE, date: DATE }), /positive safe integer/)
  assert.throws(() => boundGrantLabel({ number: NUMBER, headSha: "G".repeat(40), baseRef: BASE, date: DATE }), /lowercase 40-hex/)
  assert.throws(() => boundGrantLabel({ number: NUMBER, headSha: HEAD.slice(0, 39), baseRef: BASE, date: DATE }), /lowercase 40-hex/)
  assert.throws(() => boundGrantLabel({ number: NUMBER, headSha: HEAD, baseRef: "main", date: DATE }), /integration branch/)
  assert.throws(() => boundGrantLabel({ number: NUMBER, headSha: HEAD, baseRef: BASE, date: "2026-02-30" }), /real YYYY-MM-DD/)
  assert.throws(() => boundGrantLabel({ number: NUMBER, headSha: HEAD, baseRef: BASE, date: "not-a-date" }), /real YYYY-MM-DD/)
})

test("bound grants do not carry across number, head, base, or date", () => {
  const base = grantFor()
  assert.notEqual(grantFor(NUMBER + 1), base)
  assert.notEqual(grantFor(NUMBER, "b".repeat(40)), base)
  assert.notEqual(grantFor(NUMBER, HEAD, "milestone/0.2"), base)
  assert.notEqual(grantFor(NUMBER, HEAD, BASE, "2026-11-14"), base)
})

test("validateBoundAuthorization accepts a matching grant", () => {
  const labels = [datedLabel(), grantFor()]
  const result = validateBoundAuthorization({ number: NUMBER, headSha: HEAD, baseRef: BASE, labels, now: NOW })
  assert.deepEqual(result, { ok: true })
})

test("validateBoundAuthorization fails closed on bad inputs and mismatches", () => {
  const labels = [datedLabel(), grantFor()]
  assert.equal(validateBoundAuthorization({ number: 0, headSha: HEAD, baseRef: BASE, labels, now: NOW }).ok, false)
  assert.equal(validateBoundAuthorization({ number: NUMBER, headSha: "Z".repeat(40), baseRef: BASE, labels, now: NOW }).ok, false)
  assert.equal(validateBoundAuthorization({ number: NUMBER, headSha: HEAD, baseRef: "main", labels, now: NOW }).ok, false)
  assert.equal(validateBoundAuthorization({ number: NUMBER, headSha: HEAD, baseRef: BASE, labels: "nope", now: NOW }).ok, false)
  assert.equal(validateBoundAuthorization({ number: NUMBER, headSha: HEAD, baseRef: BASE, labels, now: "x" }).ok, false)

  // missing grant
  assert.equal(validateBoundAuthorization({ number: NUMBER, headSha: HEAD, baseRef: BASE, labels: [datedLabel()], now: NOW }).ok, false)
  // wrong grant (different number)
  const wrong = [datedLabel(), grantFor(NUMBER + 1)]
  assert.equal(validateBoundAuthorization({ number: NUMBER, headSha: HEAD, baseRef: BASE, labels: wrong, now: NOW }).ok, false)
  // expired dated label
  const expiredLabels = [`bive-merge-authorized-until-2026-11-12`, grantFor(NUMBER, HEAD, BASE, "2026-11-12")]
  assert.equal(validateBoundAuthorization({ number: NUMBER, headSha: HEAD, baseRef: BASE, labels: expiredLabels, now: NOW }).ok, false)
  // duplicate grant
  const dup = [datedLabel(), grantFor(), grantFor()]
  assert.equal(validateBoundAuthorization({ number: NUMBER, headSha: HEAD, baseRef: BASE, labels: dup, now: NOW }).ok, false)
})

test("authorizeMerge happy path authorizes and reruns the gate", async () => {
  const api = makeHarness()
  const result = await authorizeMerge({
    repository: REPO,
    number: NUMBER,
    headSha: HEAD,
    owner: OWNER,
    actor: OWNER,
    triggeringActor: OWNER,
    workflowRef: `${REPO}/.github/workflows/bive-authorize-merge.yml@refs/heads/main`,
    defaultBranch: "main",
    api,
    now: NOW,
  })
  // workflowRef uses defaultBranch main, but repository? Wait base is bived. The workflowRef default branch is independent? 
  // The contract uses defaultBranch for workflowRef. Tests use main here; but base integration still bived.
  assert.equal(result.number, NUMBER)
  assert.equal(result.headSha, HEAD)
  assert.equal(result.baseRef, BASE)
  assert.equal(result.date, DATE)
  assert.equal(result.label, datedLabel())
  assert.equal(result.grantLabel, grantFor())
  assert.equal(result.runId, RUN_ID)

  const methods = api.calls.map((c) => `${c.method} ${c.path}`)
  assert.ok(methods.some((m) => m.startsWith("POST /repos/owner/repo/issues/70/labels")))
  assert.ok(methods.some((m) => m === `POST /repos/${REPO}/actions/runs/${RUN_ID}/rerun`))
})

test("authorizeMerge rejects bad top-level inputs", async () => {
  const api = makeHarness()
  const base = {
    repository: REPO, number: NUMBER, headSha: HEAD, owner: OWNER, actor: OWNER,
    triggeringActor: OWNER, workflowRef: `${REPO}/.github/workflows/bive-authorize-merge.yml@refs/heads/main`,
    defaultBranch: "main", api, now: NOW,
  }
  await assert.rejects(authorizeMerge({ ...base, repository: "bad" }), /owner\/name/)
  await assert.rejects(authorizeMerge({ ...base, number: 0 }), /positive safe integer/)
  await assert.rejects(authorizeMerge({ ...base, headSha: "X".repeat(40) }), /lowercase 40-hex/)
  await assert.rejects(authorizeMerge({ ...base, owner: "" }), /nonempty/)
  await assert.rejects(authorizeMerge({ ...base, actor: "other" }), /actor must equal owner/)
  await assert.rejects(authorizeMerge({ ...base, triggeringActor: "other" }), /triggering actor must equal owner/)
  await assert.rejects(authorizeMerge({ ...base, defaultBranch: "" }), /nonempty/)
  await assert.rejects(authorizeMerge({ ...base, workflowRef: "wrong" }), /workflow ref/)
  await assert.rejects(authorizeMerge({ ...base, api: "nope" }), /function/)
  await assert.rejects(authorizeMerge({ ...base, now: NaN }), /epoch milliseconds/)
})

test("authorizeMerge requires case-insensitive actor equality but exact workflow ref", async () => {
  const api = makeHarness()
  const owner = "OctoCat"
  const result = await authorizeMerge({
    repository: REPO, number: NUMBER, headSha: HEAD, owner, actor: "octocat", triggeringActor: "OCTOCAT",
    workflowRef: `${REPO}/.github/workflows/bive-authorize-merge.yml@refs/heads/main`,
    defaultBranch: "main", api, now: NOW,
  })
  assert.equal(result.number, NUMBER)
})

test("authorizeMerge rejects closed or draft or fork or bad base PRs", async () => {
  // closed
  let api = makeHarness()
  // override first PR state via makeHarness not enough; build custom
  api = makeCustomApi({ pr: makePr({ state: "closed" }) })
  await assert.rejects(authorizeMerge(common(api)), /must be open/)

  api = makeCustomApi({ pr: makePr({ draft: true }) })
  await assert.rejects(authorizeMerge(common(api)), /must not be a draft/)

  api = makeCustomApi({ pr: makePr({ head: { sha: HEAD, repo: { full_name: "other/repo" } } }) })
  await assert.rejects(authorizeMerge(common(api)), /same repository/)

  api = makeCustomApi({ pr: makePr({ base: { ref: BASE, repo: { full_name: "other/repo" } } }) })
  await assert.rejects(authorizeMerge(common(api)), /same repository/)

  api = makeCustomApi({ pr: makePr({ base: { ref: "main", repo: { full_name: REPO } } }) })
  await assert.rejects(authorizeMerge(common(api)), /allowed integration branch/)

  api = makeCustomApi({ pr: makePr({ head: { sha: "b".repeat(40), repo: { full_name: REPO } } }) })
  await assert.rejects(authorizeMerge(common(api)), /head changed|invalid/)
})

test("authorizeMerge rejects stale or missing hand-over comments", async () => {
  // missing
  let api = makeHarness({ comments: [] })
  await assert.rejects(authorizeMerge(common(api)), /missing Ready to merge/)

  // no coordinator
  api = makeHarness({ comments: [{ body: `Ready to merge ${HEAD}` }] })
  await assert.rejects(authorizeMerge(common(api)), /coordinator/)

  // wrong sha
  api = makeHarness({ comments: [{ body: `Ready to merge ${"b".repeat(40)} coordinator` }] })
  await assert.rejects(authorizeMerge(common(api)), /exact head SHA/)
})

test("authorizeMerge rejects missing or malformed gate runs", async () => {
  // missing
  let api = makeHarness({ runs: [] })
  await assert.rejects(authorizeMerge(common(api)), /no completed.*run/)

  // malformed status
  api = makeHarness({ runs: [makeRun({ status: "in_progress" })] })
  await assert.rejects(authorizeMerge(common(api)), /no completed.*run/)

  // wrong path
  api = makeHarness({ runs: [makeRun({ path: ".github/workflows/other.yml" })] })
  await assert.rejects(authorizeMerge(common(api)), /no completed.*run/)

  // wrong event
  api = makeHarness({ runs: [makeRun({ event: "push" })] })
  await assert.rejects(authorizeMerge(common(api)), /no completed.*run/)

  // wrong trusted title
  api = makeHarness({ runs: [makeRun({ display_title: `Merge gate PR #${NUMBER} head ${"b".repeat(40)} base ${BASE}` })] })
  await assert.rejects(authorizeMerge(common(api)), /no completed.*run/)

  // missing trusted title (old run)
  api = makeHarness({ runs: [makeRun({ display_title: undefined })] })
  await assert.rejects(authorizeMerge(common(api)), /no completed.*run/)
})

test("authorizeMerge enforces pagination limits", async () => {
  // comments exhausted
  const fullPage = Array.from({ length: 100 }, (_, i) => ({ body: "x" }))
  const commentApi = makeHarness({ comments: null })
  // build custom: 10 full pages
  const api = makeCustomApi({
    comments: Array.from({ length: 10 }, () => fullPage),
    runs: [makeRun()],
  })
  await assert.rejects(authorizeMerge(common(api)), /exceeded the 10-page limit/)

  // runs exhausted
  const runApi = makeCustomApi({
    comments: [{ body: `Ready to merge ${HEAD} coordinator` }],
    runs: Array.from({ length: 10 }, () => Array.from({ length: 100 }, () => makeRun())),
    flattenRuns: true,
  })
  await assert.rejects(authorizeMerge(common(runApi)), /exceeded the 10-page limit/)
})

test("authorizeMerge rejects malformed pull request label entries", async () => {
  const api = makeCustomApi({ pr: makePr({ labels: [42] }) })
  await assert.rejects(authorizeMerge(common(api)), /malformed/)
})

test("authorizeMerge rejects non-positive-safe-integer run ids", async () => {
  const api = makeHarness({ runs: [makeRun({ id: 0 })] })
  await assert.rejects(authorizeMerge(common(api)), /positive safe integer/)
})

test("authorizeMerge preserves unrelated labels and removes old authorization labels", async () => {
  const oldDated = "bive-merge-authorized-until-2026-11-12"
  const oldGrant = grantFor(NUMBER, HEAD, BASE, "2026-11-12")
  const api = makeHarnessWithLabels([oldDated, oldGrant, "unrelated"])
  await authorizeMerge(common(api))
  const deletes = api.calls.filter((c) => c.method === "DELETE").map((c) => decodeURIComponent(c.path.split("/").pop()))
  assert.ok(deletes.includes(oldDated))
  assert.ok(deletes.includes(oldGrant))
  assert.ok(!deletes.includes("unrelated"))
  const addCall = api.calls.find((c) => c.method === "POST" && c.path.endsWith("/issues/70/labels"))
  assert.deepEqual(addCall.body.labels, [datedLabel(), grantFor()])
})

test("authorizeMerge fails after writes and cleans up bound grant", async () => {
  // rerun fails
  const api = makeHarness({ failOn: (m, p) => m === "POST" && p.endsWith("/rerun") })
  await assert.rejects(authorizeMerge(common(api)), /forced failure/)
  const deletes = api.calls.filter((c) => c.method === "DELETE" && c.path.includes("/labels/")).map((c) => decodeURIComponent(c.path.split("/").pop()))
  assert.ok(deletes.includes(grantFor()))
})

test("authorizeMerge reports cleanup failure alongside primary error", async () => {
  const api = makeHarness({
    failOn: (m, p) => m === "POST" && p.endsWith("/rerun"),
  })
  // make cleanup DELETE fail by overriding: wrap api
  const original = api
  const wrapped = async (method, path, body) => {
    if (method === "DELETE" && path.endsWith(`/labels/${encodeURIComponent(grantFor())}`)) {
      throw statusError(500, "cleanup boom")
    }
    return original(method, path, body)
  }
  wrapped.calls = original.calls
  await assert.rejects(authorizeMerge(common(wrapped)), /cleanup failed: cleanup boom/)
})

test("authorizeMerge marks an ambiguous label POST as uncertain and attempts cleanup", async () => {
  const api = makeHarness({
    failOn: (m, p) => m === "POST" && p === `/repos/${REPO}/issues/${NUMBER}/labels`,
  })
  await assert.rejects(authorizeMerge(common(api)), /forced failure/)
  const deletes = api.calls.filter((c) => c.method === "DELETE" && c.path.includes("/labels/")).map((c) => decodeURIComponent(c.path.split("/").pop()))
  assert.ok(deletes.includes(grantFor()))
})

test("authorizeMerge treats a 404 during grant cleanup as harmless", async () => {
  const base = makeHarness({
    failOn: (m, p) => m === "POST" && p.endsWith("/rerun"),
  })
  const api = async (method, path, body) => {
    if (method === "DELETE" && path.endsWith(`/labels/${encodeURIComponent(grantFor())}`)) {
      throw statusError(404, "already gone")
    }
    return base(method, path, body)
  }
  const tracked = async (method, path, body) => {
    const r = await api(method, path, body)
    tracked.calls.push({ method, path, body })
    return r
  }
  tracked.calls = []
  let message = ""
  try {
    await authorizeMerge(common(tracked))
  } catch (error) {
    message = error.message
  }
  assert.match(message, /forced failure/)
  assert.doesNotMatch(message, /cleanup failed/)
})

test("authorizeMerge re-reads PR after adding and validates effective authorization", async () => {
  // third PR missing grant -> fail
  const api = makeHarness({ prLabelsSequence: [[], [], [datedLabel()]] }) // first, second, third labels
  await assert.rejects(authorizeMerge(common(api)), /bound grant label/)
})

test("authorizeMerge fails if the UTC day changes before success", async () => {
  let calls = 0
  const now = () => {
    calls++
    return calls === 1
      ? Date.parse("2026-11-13T12:00:00.000Z")
      : Date.parse("2026-11-14T00:00:00.000Z")
  }
  const api = makeHarness()
  await assert.rejects(authorizeMerge({
    repository: REPO, number: NUMBER, headSha: HEAD, owner: OWNER, actor: OWNER,
    triggeringActor: OWNER, workflowRef: `${REPO}/.github/workflows/bive-authorize-merge.yml@refs/heads/main`,
    defaultBranch: "main", api, now,
  }), /UTC day changed/)
})

test("authorizeMerge re-reads run before rerun and fails if changed", async () => {
  const api = makeHarness({ runLookup: () => makeRun({ status: "completed", id: RUN_ID, path: ".github/workflows/bive-merge-gate.yml", event: "pull_request_target", display_title: `Merge gate PR #999 head ${HEAD} base ${BASE}` }) })
  await assert.rejects(authorizeMerge(common(api)), /PR association changed/)
})

test("CLI transport handles timeout, invalid JSON, oversized and redirect", async () => {
  const originalFetch = globalThis.fetch
  try {
    // timeout
    globalThis.fetch = async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e }
    const api = createGitHubApi("token")
    await assert.rejects(api("GET", "/x"), /timed out/)

    // invalid JSON
    globalThis.fetch = async () => new Response("{", { status: 200, headers: { "content-type": "application/json" } })
    const api2 = createGitHubApi("token")
    await assert.rejects(api2("GET", "/x"), /invalid JSON/)

    // HTTP status
    globalThis.fetch = async () => new Response("nope", { status: 404 })
    const api3 = createGitHubApi("token")
    await assert.rejects(api3("GET", "/x"), /status 404/)

    // oversized chunked body
    const max = 2 * 1024 * 1024
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(max + 1)); controller.close() },
    }), { status: 200 })
    const api4 = createGitHubApi("token")
    await assert.rejects(api4("GET", "/x"), /exceeded/)

    // body timeout
    globalThis.fetch = async () => ({
      ok: true, status: 200, body: {
        getReader: () => ({ read: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e }, cancel: async () => {} }),
      },
    })
    const api5 = createGitHubApi("token")
    await assert.rejects(api5("GET", "/x"), /timed out/)

    // redirect option enforced
    let seenRedirect
    globalThis.fetch = async (_url, init) => { seenRedirect = init.redirect; return new Response("{}", { status: 200 }) }
    const api6 = createGitHubApi("secret-token")
    await api6("GET", "/x")
    assert.equal(seenRedirect, "error")

    // token redaction
    globalThis.fetch = async () => { throw new Error("boom secret-token") }
    const api7 = createGitHubApi("secret-token")
    await assert.rejects(api7("GET", "/x"), /boom \[redacted\]/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// Helpers for custom mocks
function common(api) {
  return {
    repository: REPO,
    number: NUMBER,
    headSha: HEAD,
    owner: OWNER,
    actor: OWNER,
    triggeringActor: OWNER,
    workflowRef: `${REPO}/.github/workflows/bive-authorize-merge.yml@refs/heads/main`,
    defaultBranch: "main",
    api,
    now: NOW,
  }
}

function makeCustomApi(options) {
  const {
    pr = makePr(),
    comments = [{ body: `Ready to merge ${HEAD} coordinator` }],
    runs = [makeRun()],
    flattenRuns = false,
    prSequence = null,
  } = options
  let prReadCount = 0
  let currentLabels = Array.isArray(pr.labels) ? [...pr.labels] : []
  const api = async (method, path, body) => {
    if (method === "GET" && path === `/repos/${REPO}/pulls/${NUMBER}`) {
      prReadCount++
      if (prSequence && prReadCount <= prSequence.length) return prSequence[prReadCount - 1]
      return makePr({ ...pr, labels: [...currentLabels] })
    }
    if (method === "GET" && path.startsWith(`/repos/${REPO}/issues/${NUMBER}/comments`)) {
      const page = Number(new URL(path, "http://x").searchParams.get("page") || "1")
      if (Array.isArray(comments[0]) && comments[0].length === 100) {
        // comments is array of pages
        if (page <= comments.length) return comments[page - 1]
        return []
      }
      if (page === 1) return comments
      return []
    }
    if (method === "GET" && path.startsWith(`/repos/${REPO}/actions/workflows/bive-merge-gate.yml/runs`)) {
      const page = Number(new URL(path, "http://x").searchParams.get("page") || "1")
      if (flattenRuns) {
        // runs is array of pages
        if (page <= runs.length) return { workflow_runs: runs[page - 1] }
        return { workflow_runs: [] }
      }
      if (page === 1) return { workflow_runs: runs }
      return { workflow_runs: [] }
    }
    if (method === "GET" && path.startsWith(`/repos/${REPO}/labels/`)) {
      throw statusError(404, "not found")
    }
    if (method === "POST" && path === `/repos/${REPO}/labels`) return {}
    if (method === "DELETE" && path.startsWith(`/repos/${REPO}/issues/${NUMBER}/labels/`)) {
      const name = decodeURIComponent(path.split("/").pop())
      currentLabels = currentLabels.filter((l) => l !== name)
      return null
    }
    if (method === "POST" && path === `/repos/${REPO}/issues/${NUMBER}/labels`) {
      currentLabels = [...currentLabels, ...(body.labels || [])]
      return {}
    }
    if (method === "GET" && path === `/repos/${REPO}/actions/runs/${RUN_ID}`) return runs.flat ? runs.flat()[0] || makeRun() : makeRun()
    if (method === "POST" && path.endsWith("/rerun")) return {}
    throw new Error(`unexpected ${method} ${path}`)
  }
  const tracked = async (method, path, body) => {
    const r = await api(method, path, body)
    tracked.calls.push({ method, path, body })
    return r
  }
  tracked.calls = []
  return tracked
}

function makeHarnessWithLabels(initialLabels) {
  const api = makeHarness()
  // inject initial labels into first/second PR by monkey: makeHarness doesn't support; use makeCustomApi
  const pr = makePr({ labels: initialLabels })
  const custom = makeCustomApi({ pr, comments: [{ body: `Ready to merge ${HEAD} coordinator` }], runs: [makeRun()] })
  // track calls on same object
  return custom
}

test("parsePrNumber accepts only canonical positive integer strings", () => {
  assert.equal(parsePrNumber("70"), 70)
  for (const value of ["", "0", "01", "+1", " 1", "1 ", "1e2", "1.0", "abc"]) {
    assert.throws(() => parsePrNumber(value), /canonical|positive/)
  }
})