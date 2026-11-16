// Narrow execution path; never relaxes the shell policy or creates owner authorization.
import { execFile } from "node:child_process"
import { createPrivateKey, sign } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createGhReaders } from "../../../.github/scripts/check-merge-gate.mjs"
import { parseGateOwner } from "../../../.github/scripts/merge-gate-lib.mjs"
import { APPROVAL_LIFETIME_MS, APPROVAL_PREFIX, approvalBytes, changesMergeAuthority, matchingGrant,
  verifyParentApproval } from "../../../.github/scripts/coordinator-approval-lib.mjs"
import { isAdvisor, isDelegate } from "./check.ts"
import { runCoordinatorMerge, type MergeRequest, type MergeScope, type MergeSnapshot } from "./coordinator-merge.ts"

const TIMEOUT = 15_000
const unwrap = (value: any) => value && typeof value === "object" && "data" in value ? value.data : value
function processOutput(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, signal, timeout: TIMEOUT, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${command} failed: ${(stderr || error.message).trim()}`, { cause: error }))
        else resolve(stdout.trim())
      })
  })
}

// Uses the documented OpenCode 2 tool/permission APIs; ctx's runtime is supplied by OpenCode.
export async function registerCoordinatorMerge(ctx: any, root: string, role?: string, roleFile?: string,
  execute = processOutput): Promise<void> {
  // Direct shell merges stay denied; this tool is the only merge path. No owner prompt per PR: the owner's grant is the proof.
  await ctx.tool.transform((editor: any) => {
    editor.add({
      name: "bive_coordinator_merge",
      description: "Owner opt-in only: approve and merge one direct sub-coordinator PR into an integration branch under the owner's grant on the base. Never main. Default off.",
      input: {
        type: "object", additionalProperties: false,
        properties: { number: { type: "integer", minimum: 1 }, childSession: { type: "string", minLength: 1 } },
        required: ["number", "childSession"],
      },
      execute: async (input: MergeRequest, context: any) => {
        if (context.agent !== "coordinator" || isAdvisor(role, roleFile, context.agent)
            || isDelegate(root, role, roleFile, context.agent)) {
          throw new Error("coordinator merge refused: only a coordinator may request owner opt-in")
        }
        let lastGrant: ReturnType<typeof matchingGrant> = null
        let lastApprovals = 0
        const run = (command: string, args: string[], cwd = root) => execute(command, args, cwd, context.signal)
        const repository = await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("invalid repository identity")
        const readers = createGhReaders(async (args: string[]) => ({ stdout: await run("gh", args), exitCode: 0 }))
        const read = async (): Promise<MergeSnapshot> => {
          const pr = JSON.parse(await run("gh", ["pr", "view", String(input.number), "--repo", repository,
            "--json", "number,state,headRefOid,baseRefName,headRefName,headRepository,headRepositoryOwner,isCrossRepository,commits"]))
          const configText = await readers.readGateConfig({ repository, ref: pr.baseRefName })
          const config = configText === null ? null : JSON.parse(configText)
          const owner = parseGateOwner(configText)
          // Opt-in requires an explicitly named human owner even in a personally owned repository.
          if (config?.coordinatorMerges !== true || !owner) throw new Error("coordinator merge refused: base owner opt-in is off or invalid")
          const executor = unwrap(await ctx.session.get({ sessionID: context.sessionID }))
          const child = unwrap(await ctx.session.get({ sessionID: input.childSession }))
          const childDirectory = child?.location?.directory
          if (typeof childDirectory !== "string" || !path.isAbsolute(childDirectory)) throw new Error("sub-coordinator directory unavailable")
          // Verify the actual server-assigned child, not a role/session string supplied in PR text.
          if (executor?.agent !== "coordinator" || executor?.location?.directory !== root || child?.agent !== "coordinator"
              || child?.parentID !== context.sessionID) throw new Error("not a direct sub-coordinator session")
          const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], childDirectory)
          const childHead = await run("git", ["rev-parse", "HEAD"], childDirectory)
          const currentBranch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"])
          const authorName = await run("git", ["config", "--get", "user.name"])
          if (!authorName.startsWith("coordinator ") || !authorName.includes(`[session=${context.sessionID}]`)) {
            throw new Error("coordinator merge refused: executor needs its session-bound coordinator Git identity")
          }
          const authors = Array.isArray(pr.commits) ? pr.commits.flatMap((c: any) => Array.isArray(c.authors) ? c.authors : []) : []
          const selfAuthored = currentBranch === pr.headRefName || authors.length === 0
            || authors.some((a: any) => typeof a.name !== "string" || a.name === authorName
              || a.name.includes(`[session=${context.sessionID}]`)
              || (a.name.startsWith("coordinator ") && !/\[session=ses_[A-Za-z0-9]+\]$/.test(a.name)))
          const gatePr = await readers.readPullRequest({ repository, number: input.number })
          // Authority is the owner's grant on the protected BASE, never a label or a head-side file.
          const grant = matchingGrant(configText, { repository, executor: context.sessionID, childSession: input.childSession,
            headBranch: pr.headRefName, base: pr.baseRefName })
          const files = (JSON.parse(await run("gh", ["pr", "view", String(input.number), "--repo", repository, "--json", "files"])).files ?? [])
            .map((f: any) => f?.path)
          const raw = await run("gh", ["api", `repos/${repository}/issues/${input.number}/comments`, "--paginate", "--jq", ".[] | {body: .body}"])
          const comments = raw.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return {} } })
          const prInfo = { repository, number: pr.number, head: pr.headRefOid, base: pr.baseRefName, headBranch: pr.headRefName,
            coordinatorPR: gatePr.labels.includes("coordinator"), state: pr.state, files,
            sameRepository: pr.isCrossRepository === false
              && `${pr.headRepositoryOwner?.login}/${pr.headRepository?.name}`.toLowerCase() === repository.toLowerCase() }
          const approval = grant ? verifyParentApproval(configText, prInfo, comments) : null
          lastGrant = grant
          lastApprovals = grant ? comments.filter((c: any) => {
            try { return JSON.parse(String(c.body).slice(APPROVAL_PREFIX.length))?.payload?.grant === grant.id } catch { return false }
          }).length : 0
          return {
            repository, number: pr.number, state: pr.state, head: pr.headRefOid, base: pr.baseRefName,
            headBranch: pr.headRefName, sameRepository: prInfo.sameRepository, coordinatorPR: prInfo.coordinatorPR,
            enabled: true, owner, checks: await readers.readChecks({ repository, number: input.number }),
            authorizationValid: grant !== null,
            headApproved: approval !== null && approval.payload.executor === context.sessionID
              && approval.payload.childSession === input.childSession,
            grantExpiresAt: grant ? Date.parse(grant.expiresAt) : NaN,
            authorityChange: changesMergeAuthority(files),
            selfAuthored,
            executor: { id: executor.id, agent: executor.agent },
            child: { id: child.id, agent: child.agent, parentID: child.parentID, branch, head: childHead },
          }
        }
        const result = await runCoordinatorMerge(input, context.sessionID, {
          read,
          // Records the parent's signed approval of this exact head under the owner's grant; the owner is not asked per PR.
          approve: async (scope: MergeScope) => {
            const pem = process.env.BIVE_PARENT_APPROVAL_KEY
            if (!lastGrant || !pem) throw new Error("coordinator merge refused: no grant, or no approval key handed over by the owner")
            if (lastApprovals >= lastGrant.maxApprovals) throw new Error("coordinator merge refused: the grant's approvals are used up")
            const issuedAt = Date.now()
            const payload = { grant: lastGrant.id, repository: scope.repository, number: scope.number, head: scope.head,
              base: scope.base, executor: scope.executor, childSession: scope.childSession, headBranch: scope.headBranch,
              issuedAt, expiresAt: Math.min(issuedAt + APPROVAL_LIFETIME_MS, Date.parse(lastGrant.expiresAt)),
              sequence: lastApprovals + 1 }
            const signature = sign(null, approvalBytes(payload), createPrivateKey(pem)).toString("base64")
            const file = path.join(root, ".bive", "state", `approval-${scope.number}.md`)
            mkdirSync(path.dirname(file), { recursive: true })
            writeFileSync(file, APPROVAL_PREFIX + JSON.stringify({ payload, signature }))
            await run("gh", ["pr", "comment", String(scope.number), "--repo", scope.repository, "--body-file", file])
            // The gate does not fire on comments: ask GitHub to re-run its latest run for this head (best effort; it also
            // re-runs when the checks complete). This never creates authority: the gate re-reads the signed approval itself.
            try {
              const runId = (await run("gh", ["run", "list", "--repo", scope.repository, "--workflow", "bive-merge-gate.yml",
                "--commit", scope.head, "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId"])).trim()
              if (/^\d+$/.test(runId)) await run("gh", ["run", "rerun", runId, "--repo", scope.repository])
            } catch { /* the approval is recorded; the gate will re-run when checks complete */ }
          },
          merge: (scope: MergeScope) => run("gh", ["pr", "merge", String(scope.number), "--repo", scope.repository,
            "--merge", "--match-head-commit", scope.head]),
        })
        return { content: result || "Owner-opted-in sub-coordinator merge completed." }
      },
    })
  })
}
