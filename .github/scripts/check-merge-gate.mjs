import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { evaluateMergeGate, isIntegrationBranch, validateMergeAuthorization } from "./merge-gate-lib.mjs"

const GH_TIMEOUT_MS = 15_000
const MAX_WAIT_MS = 12 * 60_000
const POLL_INTERVAL_MS = 10_000
const OWN_CHECK = "bive-merge-gate / merge-gate"
const REQUIRED_CHECKS = ["bive-tests / tests", "bive-inviolable / check"]

function runGh(args, timeoutMs = GH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && error.code !== 8) {
        reject(new Error(`gh ${args.join(" ")} failed: ${(stderr || error.message).trim()}`, { cause: error }))
        return
      }
      resolve({ stdout, exitCode: error ? error.code : 0 })
    })
  })
}

function parseJson(stdout, subject) {
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(`gh returned invalid JSON for ${subject}`, { cause: error })
  }
}

function parseChecks(stdout) {
  const data = parseJson(stdout, "pull request checks")
  if (!Array.isArray(data)) throw new Error("gh returned an invalid pull request checks list")
  return data.map((check) => {
    if (typeof check?.workflow !== "string" || typeof check?.name !== "string"
        || typeof check?.bucket !== "string") {
      throw new Error("gh returned a check without workflow, name, or bucket")
    }
    return { workflow: check.workflow, name: check.name, bucket: check.bucket }
  })
}

export function createGhReaders(runProcess = runGh) {
  return {
    async readPullRequest({ number, repository }) {
      const { stdout, exitCode } = await runProcess([
        "pr", "view", String(number), "--repo", repository, "--json", "baseRefName,headRefOid,labels",
      ], GH_TIMEOUT_MS)
      if (exitCode !== 0) throw new Error(`gh pr view exited with status ${exitCode}`)
      const data = parseJson(stdout, "pull request")
      if (typeof data?.baseRefName !== "string" || typeof data?.headRefOid !== "string"
          || !Array.isArray(data?.labels)) {
        throw new Error("gh returned an invalid pull request record")
      }
      const labels = data.labels.map((label) => label?.name)
      if (labels.some((label) => typeof label !== "string")) throw new Error("gh returned an invalid pull request label")
      return { baseRefName: data.baseRefName, headRefOid: data.headRefOid, labels }
    },

    async readChecks({ number, repository }) {
      const { stdout, exitCode } = await runProcess([
        "pr", "checks", String(number), "--repo", repository, "--json", "workflow,name,bucket,state",
      ], GH_TIMEOUT_MS)
      if (exitCode !== 0 && exitCode !== 8) throw new Error(`gh pr checks exited with status ${exitCode}`)
      return parseChecks(stdout)
    },
  }
}

function identity(check) {
  return `${check.workflow} / ${check.name}`
}

function checksArePending(checks) {
  const visible = checks.filter((check) => identity(check) !== OWN_CHECK)
  if (visible.some((check) => check.bucket === "pending")) return true
  return REQUIRED_CHECKS.some((required) => visible.filter((check) => identity(check) === required).length === 0)
}

export async function runMergeGate({
  event,
  repository,
  readPullRequest,
  readChecks,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxWaitMs = MAX_WAIT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
}) {
  const request = event?.pull_request
  if (!Number.isInteger(request?.number) || typeof request?.head?.sha !== "string"
      || typeof request?.base?.ref !== "string") {
    throw new Error("event does not contain a pull request number, head SHA, and base branch")
  }
  if (!isIntegrationBranch(request.base.ref)) {
    throw new Error("merge gate only runs for pull requests targeting bived or milestone/<name>")
  }

  const deadline = now() + maxWaitMs
  while (true) {
    const pr = await readPullRequest({ number: request.number, repository })
    if (pr.baseRefName !== request.base.ref) throw new Error("pull request base changed; refusing stale merge-gate run")
    if (pr.headRefOid !== request.head.sha) throw new Error("pull request head changed; refusing stale merge-gate run")

    const authorization = validateMergeAuthorization({ labels: pr.labels, baseRef: pr.baseRefName, now: now() })
    if (!authorization.ok) throw new Error(authorization.reason)

    const checks = await readChecks({ number: request.number, repository })
    if (checksArePending(checks)) {
      const remaining = deadline - now()
      if (remaining <= 0) throw new Error("timed out waiting for required CI checks to finish")
      await sleep(Math.min(pollIntervalMs, remaining))
      continue
    }

    // Refresh PR metadata after the checks read so a removed grant or updated head cannot pass on stale event data.
    const current = await readPullRequest({ number: request.number, repository })
    if (current.baseRefName !== pr.baseRefName || current.headRefOid !== pr.headRefOid) {
      throw new Error("pull request changed during merge-gate validation; refusing stale results")
    }
    const result = evaluateMergeGate({ labels: current.labels, baseRef: current.baseRefName, checks, now: now() })
    if (!result.ok) throw new Error(result.reason)
    return result
  }
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is not set")
  const event = parseJson(readFileSync(eventPath, "utf8"), "GitHub event")
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error("GITHUB_REPOSITORY is not set")
  const readers = createGhReaders()
  const result = await runMergeGate({ event, repository, ...readers })
  console.log(`bive-merge-gate: ${result.reason}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`bive-merge-gate: ${error.message}`)
    process.exitCode = 1
  })
}
