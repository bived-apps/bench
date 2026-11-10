// token-ratio's pure helpers: no OpenCode import, so `node --test tests/*.test.ts` exercises them; index.ts is the plugin.
import { readFileSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"

// 48213 -> 48000: a size, not a fingerprint (two significant figures; below 100, the number itself).
export function twoDigits(n: number): number {
  if (n < 100) return n
  const p = 10 ** (Math.floor(Math.log10(n)) - 1)
  return Math.round(n / p) * p
}

// Lines of the tracked text files of a checkout (binaries and files over 2 MB skipped).
export function codeLines(root: string): number {
  let lines = 0
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 << 20, timeout: 30_000 })
    .toString().split("\0")
  for (const f of files) {
    if (!f) continue
    try {
      const full = path.join(root, f)
      if (statSync(full).size > 2 << 20) continue
      const text = readFileSync(full, "utf8")
      if (text.includes("\0")) continue          // binary
      lines += text.split("\n").length
    } catch { /* deleted or unreadable since `git ls-files`: not counted */ }
  }
  return lines
}

// The main checkout of a worktree (where .bive/state/ lives, shared by every worktree); the directory itself when
// it is not a git checkout.
export function mainCheckout(dir: string): string {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
                                { cwd: dir, timeout: 10_000 })
    return path.dirname(common.toString().trim())
  } catch {
    return dir
  }
}

// Whether a session belongs to this plugin instance: OpenCode loads one instance per location, and every instance
// receives every session's events. Exact directory match: a sub-folder or a worktree has its own instance, and
// counting it here too would count it twice in the shared tokens.jsonl. An unknown directory is not ours.
export function ownSession(sessionDirectory: string | undefined, root: string): boolean {
  if (!sessionDirectory) return false
  return path.resolve(sessionDirectory) === path.resolve(root)
}

// Totals of a tokens.jsonl log: human and agent tokens and their ratio (null before the first human token).
// A corrupt line is skipped: the file is appended by several processes and may be cut.
export function totals(log: string): { human: number, agent: number, ratio: number | null } {
  let human = 0, agent = 0
  for (const line of log.split("\n")) {
    if (!line) continue
    let r: { kind?: string, tokens?: number }
    try { r = JSON.parse(line) } catch { continue }
    if (typeof r.tokens !== "number") continue
    if (r.kind === "human") human += r.tokens
    else if (r.kind === "agent") agent += r.tokens
  }
  return { human, agent, ratio: human ? Math.round(agent / human) : null }
}
