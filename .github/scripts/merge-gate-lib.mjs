export const AUTHORIZATION_LABEL_PREFIX = "bive-merge-authorized-until-"

// Integration branches the gate covers: Bive's own `bived`, and one `milestone/<name>` per coordinator (#88).
export function isIntegrationBranch(ref) {
  return ref === "bived" || (typeof ref === "string" && /^milestone\/[A-Za-z0-9._-]+$/.test(ref))
}

const identity = (check) => `${check.workflow} / ${check.name}`
const REQUIRED_CHECKS = [
  { workflow: "bive-tests", name: "tests" },
  { workflow: "bive-inviolable", name: "check" },
]

export function validateMergeAuthorization({ labels = [], baseRef, now = Date.now() }) {
  if (!isIntegrationBranch(baseRef)) {
    return { ok: false, reason: "merge gate only authorizes pull requests targeting bived or milestone/<name>" }
  }
  const matches = labels.filter((label) => label.startsWith(AUTHORIZATION_LABEL_PREFIX))
  if (matches.length !== 1) return { ok: false, reason: "exactly one dated merge-authorization label is required" }

  const match = /^bive-merge-authorized-until-(\d{4}-\d{2}-\d{2})$/.exec(matches[0])
  if (!match) return { ok: false, reason: "merge-authorization label must end in YYYY-MM-DD" }
  const date = new Date(`${match[1]}T00:00:00.000Z`)
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== match[1]) {
    return { ok: false, reason: "merge-authorization label contains an invalid UTC date" }
  }
  const expiresAt = Date.parse(`${match[1]}T23:59:59.999Z`)
  if (now > expiresAt) return { ok: false, reason: "merge authorization has expired" }
  return { ok: true }
}

export function evaluateMergeGate({ labels = [], baseRef, checks = [], now = Date.now() }) {
  const grant = validateMergeAuthorization({ labels, baseRef, now })
  if (!grant.ok) return grant

  const coordinator = labels.includes("coordinator")
  const actionableChecks = checks.filter((check) => identity(check) !== "bive-merge-gate / merge-gate")
  for (const required of REQUIRED_CHECKS) {
    const found = actionableChecks.filter((check) => identity(check) === identity(required))
    if (found.length !== 1) return { ok: false, reason: `expected exactly one ${identity(required)} check` }
    const bucket = found[0].bucket
    const expectedSkip = coordinator && identity(required) === "bive-inviolable / check" && bucket === "skipping"
    if (bucket !== "pass" && !expectedSkip) {
      return { ok: false, reason: `${identity(required)} is ${bucket || "missing a result"}` }
    }
  }

  const unexpected = actionableChecks.find((check) => check.bucket !== "pass"
    && !(coordinator && identity(check) === "bive-inviolable / check" && check.bucket === "skipping"))
  if (unexpected) return { ok: false, reason: `${identity(unexpected)} is ${unexpected.bucket || "missing a result"}` }
  return { ok: true, reason: "dated authorization and required checks are valid" }
}
