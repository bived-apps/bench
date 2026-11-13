import { createHash } from "node:crypto"
import { isIntegrationBranch, validateMergeAuthorization, AUTHORIZATION_LABEL_PREFIX } from "./merge-gate-lib.mjs"

export const GRANT_LABEL_PREFIX = "bive-grant-"
export const DATED_LABEL_PREFIX = AUTHORIZATION_LABEL_PREFIX
const SHA256_HEX_40 = /^[0-9a-f]{40}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function validSha(value) {
  return typeof value === "string" && SHA256_HEX_40.test(value)
}

function validDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.valueOf())) return false
  return parsed.toISOString().slice(0, 10) === value
}

function utcDateFromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

function reevaluateNow(now, date, fallbackMs) {
  const nowMs = typeof now === "function" ? now() : fallbackMs
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) throw new Error("now must be epoch milliseconds")
  if (utcDateFromMs(nowMs) !== date) throw new Error("UTC day changed during authorization")
  const expiresAt = Date.parse(`${date}T23:59:59.999Z`)
  if (nowMs > expiresAt) throw new Error("merge authorization has expired")
  return nowMs
}

function prLabels(pr) {
  if (!Array.isArray(pr.labels)) throw new Error("pull request labels must be an array")
  return pr.labels.map((label) => {
    if (typeof label === "string") return label
    if (label && typeof label === "object" && !Array.isArray(label) && typeof label.name === "string") return label.name
    throw new Error("pull request label is malformed")
  })
}

function errorStatus(error) {
  if (error && typeof error === "object") {
    if (typeof error.status === "number") return error.status
    if (typeof error.statusCode === "number") return error.statusCode
    if (error.response && typeof error.response.status === "number") return error.response.status
  }
  return undefined
}

export function boundGrantLabel({ number, headSha, baseRef, date } = {}) {
  if (!isPositiveSafeInteger(number)) throw new Error("PR number must be a positive safe integer")
  if (!validSha(headSha)) throw new Error("head SHA must be a full lowercase 40-hex SHA")
  if (!isIntegrationBranch(baseRef)) throw new Error("base ref must be a permitted integration branch")
  if (!validDate(date)) throw new Error("date must be a real YYYY-MM-DD date")
  const digest = createHash("sha256").update(JSON.stringify([number, headSha, baseRef, date])).digest("hex")
  return `${GRANT_LABEL_PREFIX}${digest.slice(0, 32)}`
}

export function validateBoundAuthorization({ number, headSha, baseRef, labels, now = Date.now() } = {}) {
  if (!isPositiveSafeInteger(number)) return { ok: false, reason: "PR number must be a positive safe integer" }
  if (!validSha(headSha)) return { ok: false, reason: "head SHA must be a full lowercase 40-hex SHA" }
  if (!isIntegrationBranch(baseRef)) return { ok: false, reason: "base ref must be a permitted integration branch" }
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) {
    return { ok: false, reason: "labels must be an array of strings" }
  }
  const nowMs = typeof now === "function" ? now() : now
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    return { ok: false, reason: "now must be epoch milliseconds" }
  }

  const dated = validateMergeAuthorization({ labels, baseRef, now: nowMs })
  if (!dated.ok) return dated

  const datedLabels = labels.filter((label) => label.startsWith(DATED_LABEL_PREFIX))
  const match = /^bive-merge-authorized-until-(\d{4}-\d{2}-\d{2})$/.exec(datedLabels[0])
  if (!match) return { ok: false, reason: "dated merge-authorization label is malformed" }
  const date = match[1]

  const grants = labels.filter((label) => label.startsWith(GRANT_LABEL_PREFIX))
  if (grants.length !== 1) return { ok: false, reason: "exactly one bound grant label is required" }

  let expected
  try {
    expected = boundGrantLabel({ number, headSha, baseRef, date })
  } catch (error) {
    return { ok: false, reason: error.message }
  }
  if (grants[0] !== expected) return { ok: false, reason: "bound grant label does not match this PR, head, base, or date" }
  return { ok: true }
}

function validateRepository(repository) {
  if (typeof repository !== "string" || !REPOSITORY_RE.test(repository)) {
    throw new Error("repository must be in owner/name form")
  }
}

function validateCommon({ repository, number, headSha, owner, actor, triggeringActor, workflowRef, defaultBranch, api, now }) {
  validateRepository(repository)
  if (!isPositiveSafeInteger(number)) throw new Error("PR number must be a positive safe integer")
  if (!validSha(headSha)) throw new Error("head SHA must be a full lowercase 40-hex SHA")
  if (typeof owner !== "string" || owner.trim() === "") throw new Error("owner must be a nonempty string")
  if (typeof actor !== "string" || actor.trim() === "") throw new Error("actor must be a nonempty string")
  if (typeof triggeringActor !== "string" || triggeringActor.trim() === "") throw new Error("triggering actor must be a nonempty string")
  if (actor.toLowerCase() !== owner.toLowerCase()) throw new Error("actor must equal owner")
  if (triggeringActor.toLowerCase() !== owner.toLowerCase()) throw new Error("triggering actor must equal owner")
  if (typeof defaultBranch !== "string" || defaultBranch.trim() === "") throw new Error("default branch must be a nonempty string")
  const expectedRef = `${repository}/.github/workflows/bive-authorize-merge.yml@refs/heads/${defaultBranch}`
  if (workflowRef !== expectedRef) throw new Error("workflow ref must be the canonical authorization workflow ref")
  if (typeof api !== "function") throw new Error("api must be a function")
  const nowMs = typeof now === "function" ? now() : now
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) throw new Error("now must be epoch milliseconds")
  return { nowMs }
}

function validatePrShape(pr, repository, { requireOpen = true, requireNotDraft = true, expectedHeadSha = null, expectedBaseRef = null, expectedState = null } = {}) {
  if (!pr || typeof pr !== "object" || Array.isArray(pr)) throw new Error("pull request response must be an object")
  if (typeof pr.state !== "string") throw new Error("pull request is missing state")
  if (typeof pr.draft !== "boolean") throw new Error("pull request is missing draft flag")
  if (requireOpen && pr.state !== "open") throw new Error("pull request must be open")
  if (expectedState !== null && pr.state !== expectedState) throw new Error("pull request state changed")
  if (requireNotDraft && pr.draft) throw new Error("pull request must not be a draft")
  if (!pr.head || typeof pr.head !== "object" || Array.isArray(pr.head)) throw new Error("pull request is missing head metadata")
  if (typeof pr.head.sha !== "string" || !SHA256_HEX_40.test(pr.head.sha)) throw new Error("pull request head SHA is invalid")
  if (expectedHeadSha !== null && pr.head.sha !== expectedHeadSha) throw new Error("pull request head changed")
  if (!pr.head.repo || typeof pr.head.repo !== "object" || Array.isArray(pr.head.repo)) throw new Error("pull request head repository is missing")
  if (typeof pr.head.repo.full_name !== "string" || pr.head.repo.full_name !== repository) throw new Error("pull request head must be in the same repository")
  if (!pr.base || typeof pr.base !== "object" || Array.isArray(pr.base)) throw new Error("pull request is missing base metadata")
  if (typeof pr.base.ref !== "string" || !isIntegrationBranch(pr.base.ref)) throw new Error("pull request base must be an allowed integration branch")
  if (expectedBaseRef !== null && pr.base.ref !== expectedBaseRef) throw new Error("pull request base changed")
  if (!pr.base.repo || typeof pr.base.repo !== "object" || Array.isArray(pr.base.repo)) throw new Error("pull request base repository is missing")
  if (typeof pr.base.repo.full_name !== "string" || pr.base.repo.full_name !== repository) throw new Error("pull request base must be in the same repository")
  return {
    state: pr.state,
    draft: pr.draft,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    headRepo: pr.head.repo.full_name,
    baseRepo: pr.base.repo.full_name,
  }
}

function prSnapshot(pr) {
  return {
    state: pr.state,
    draft: pr.draft,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    headRepo: pr.head.repo.full_name,
    baseRepo: pr.base.repo.full_name,
  }
}

function snapshotsEqual(a, b) {
  return a.state === b.state && a.draft === b.draft && a.headSha === b.headSha
    && a.baseRef === b.baseRef && a.headRepo === b.headRepo && a.baseRepo === b.baseRepo
}

async function readComments(api, repository, number) {
  const all = []
  for (let page = 1; page <= 10; page++) {
    const batch = await api("GET", `/repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`)
    if (!Array.isArray(batch)) throw new Error("issue comments response must be an array")
    all.push(...batch)
    if (batch.length < 100) return all
    if (page === 10) throw new Error("issue comments exceeded the 10-page limit")
  }
  return all
}

async function readRuns(api, repository) {
  const all = []
  for (let page = 1; page <= 10; page++) {
    const response = await api("GET", `/repos/${repository}/actions/workflows/bive-merge-gate.yml/runs?event=pull_request_target&per_page=100&page=${page}`)
    let batch
    if (Array.isArray(response)) batch = response
    else if (response && typeof response === "object" && Array.isArray(response.workflow_runs)) batch = response.workflow_runs
    else throw new Error("workflow runs response must contain a workflow_runs array")
    all.push(...batch)
    if (batch.length < 100) return all
    if (page === 10) throw new Error("workflow runs exceeded the 10-page limit")
  }
  return all
}

function expectedRunTitle(number, headSha, baseRef) {
  return `Merge gate PR #${number} head ${headSha} base ${baseRef}`
}

function runMatchesPr(run, number, headSha, baseRef) {
  if (!run || typeof run !== "object" || Array.isArray(run)) return false
  if (run.status !== "completed") return false
  if (run.path !== ".github/workflows/bive-merge-gate.yml") return false
  if (run.event !== "pull_request_target") return false
  if (typeof run.display_title !== "string") return false
  return run.display_title === expectedRunTitle(number, headSha, baseRef)
}

function validateRunShape(run) {
  if (!run || typeof run !== "object" || Array.isArray(run)) throw new Error("workflow run must be an object")
  if (typeof run.id !== "number" || !Number.isSafeInteger(run.id) || run.id <= 0) throw new Error("workflow run id must be a positive safe integer")
  if (run.status !== "completed") throw new Error("workflow run is not completed")
  if (run.path !== ".github/workflows/bive-merge-gate.yml") throw new Error("workflow run path is invalid")
  if (run.event !== "pull_request_target") throw new Error("workflow run event is invalid")
  if (typeof run.display_title !== "string") throw new Error("workflow run is missing trusted display title")
  return run
}

export async function authorizeMerge({ repository, number, headSha, owner, actor, triggeringActor, workflowRef, defaultBranch, api, now = Date.now() } = {}) {
  const { nowMs: initialNowMs } = validateCommon({ repository, number, headSha, owner, actor, triggeringActor, workflowRef, defaultBranch, api, now })
  let currentNowMs = initialNowMs
  const date = utcDateFromMs(currentNowMs)

  let labelsAdded = false
  let grantLabelForCleanup = null
  try {
    // Read PR
    const firstPr = await api("GET", `/repos/${repository}/pulls/${number}`)
    const first = validatePrShape(firstPr, repository, { expectedHeadSha: headSha })
    const baseRef = first.baseRef
    const initialSnapshot = prSnapshot(firstPr)

    // Read issue comments
    const comments = await readComments(api, repository, number)
    const handovers = comments.filter((comment) => typeof comment?.body === "string" && comment.body.startsWith("Ready to merge"))
    if (handovers.length === 0) throw new Error("missing Ready to merge hand-over comment")
    const latestHandover = handovers[handovers.length - 1]
    if (typeof latestHandover.body !== "string" || !latestHandover.body.includes(headSha)) {
      throw new Error("hand-over comment does not name the exact head SHA")
    }
    if (!latestHandover.body.includes("coordinator")) throw new Error("hand-over comment does not contain coordinator")

    // Read gate runs
    const runs = await readRuns(api, repository)
    const chosen = runs.find((run) => runMatchesPr(run, number, headSha, baseRef))
    if (!chosen) throw new Error("no completed bive-merge-gate run matches this pull request")
    const chosenRun = validateRunShape(chosen)
    const runId = chosenRun.id

    // Re-read PR
    const secondPrRaw = await api("GET", `/repos/${repository}/pulls/${number}`)
    const second = validatePrShape(secondPrRaw, repository, { expectedHeadSha: headSha, expectedBaseRef: baseRef })
    const secondSnapshot = prSnapshot(secondPrRaw)
    if (!snapshotsEqual(initialSnapshot, secondSnapshot)) throw new Error("pull request changed before authorization")
    currentNowMs = reevaluateNow(now, date, currentNowMs)

    // Compute labels
    const datedLabel = `${DATED_LABEL_PREFIX}${date}`
    const grantLabel = boundGrantLabel({ number, headSha, baseRef, date })
    grantLabelForCleanup = grantLabel

    // Ensure labels exist
    for (const name of [datedLabel, grantLabel]) {
      try {
        await api("GET", `/repos/${repository}/labels/${encodeURIComponent(name)}`)
      } catch (error) {
        if (errorStatus(error) !== 404) throw error
        await api("POST", `/repos/${repository}/labels`, { name, color: "ededed" })
      }
    }

    // Remove existing dated/grant labels individually
    const currentLabels = prLabels(secondPrRaw)
    const toRemove = currentLabels.filter((label) => label.startsWith(DATED_LABEL_PREFIX) || label.startsWith(GRANT_LABEL_PREFIX))
    for (const label of toRemove) {
      await api("DELETE", `/repos/${repository}/issues/${number}/labels/${encodeURIComponent(label)}`)
    }

    // Add both together. Mark the write as uncertain before awaiting it, because
    // the server may apply it even when the transport later reports a timeout.
    labelsAdded = true
    await api("POST", `/repos/${repository}/issues/${number}/labels`, { labels: [datedLabel, grantLabel] })

    // Re-read PR after adding
    const thirdPrRaw = await api("GET", `/repos/${repository}/pulls/${number}`)
    const third = validatePrShape(thirdPrRaw, repository, { expectedHeadSha: headSha, expectedBaseRef: baseRef, expectedState: "open" })
    if (third.draft) throw new Error("pull request must not be a draft")
    const thirdLabels = prLabels(thirdPrRaw)
    currentNowMs = reevaluateNow(now, date, currentNowMs)
    const effective = validateBoundAuthorization({ number, headSha: third.headSha, baseRef: third.baseRef, labels: thirdLabels, now: currentNowMs })
    if (!effective.ok) throw new Error(effective.reason)

    // Re-read chosen run
    const rerunCandidate = await api("GET", `/repos/${repository}/actions/runs/${runId}`)
    validateRunShape(rerunCandidate)
    if (String(rerunCandidate.id) !== String(runId)) throw new Error("chosen run id changed")
    if (rerunCandidate.status !== "completed") throw new Error("chosen run is no longer completed")
    if (rerunCandidate.path !== ".github/workflows/bive-merge-gate.yml") throw new Error("chosen run path changed")
    if (rerunCandidate.event !== "pull_request_target") throw new Error("chosen run event changed")
    if (!runMatchesPr(rerunCandidate, number, headSha, baseRef)) throw new Error("chosen run PR association changed")

    // Rerun
    await api("POST", `/repos/${repository}/actions/runs/${runId}/rerun`)

    return {
      number,
      headSha,
      baseRef,
      date,
      label: datedLabel,
      grantLabel,
      runId,
    }
  } catch (error) {
    if (labelsAdded && grantLabelForCleanup) {
      try {
        await api("DELETE", `/repos/${repository}/issues/${number}/labels/${encodeURIComponent(grantLabelForCleanup)}`)
      } catch (cleanupError) {
        if (errorStatus(cleanupError) !== 404) {
          throw new Error(`${error.message}; cleanup failed: ${cleanupError.message}`, { cause: error })
        }
      }
    }
    throw error
  }
}