// Bive's guard, the decision part: refuse any file write outside this session's git worktree (the bug that sank Delege:
// a delegate wrote into the main checkout instead of its worktree) and, for a delegate (isDelegate below), any change
// to Bive's inviolable files, also when it runs as a child session of the coordinator's. Pure: no OpenCode import,
// so `node --test tests/*.test.ts` exercises it; index.ts plugs it into OpenCode 2's tool hook. Best: each delegate
// in its own session rooted in its worktree, so that `root` is its own.
import os from "node:os"
import path from "node:path"

const WRITE_TOOLS = new Set(["write", "edit", "multiedit"])
const PATCH_TOOLS = new Set(["patch", "apply_patch"])
const SHELL_TOOLS = new Set(["shell", "bash"])            // OpenCode 2 names it `shell`; `bash` was the V1 name
// Bive's inviolable files: a delegate never changes them. The coordinator and the supervisor complete the role prompts
// in .bive/prompts/project/ (never the core ones) (AGENTS.md › Inviolable prompts). `.opencode/plugin/` was the V1
// folder (empty since #5); still matched in case a project kept one.
const PROTECTED = [/^\.bive\/registry-id$/, /^\.bive\/prompts\//, /^\.bive\/templates\//, /^\.opencode\/plugins?\//,
                   /^\.github\/workflows\/bive-/, /^opencode\.jsonc$/, /^AGENTS\.md$/]
const PROTECTED_WORDS = [".bive/registry-id", ".bive/prompts/", ".bive/templates", ".opencode/plugin",
                         ".github/workflows/bive-", "opencode.jsonc", "AGENTS.md"]
const SHELL_WRITE = /(\btee\b|\bsed\s+-i|\bperl\s+-[a-z]*i|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bgit\s+(rm|mv|checkout|restore|apply))/
// Shell paths: a command may name a file outside the worktree through an absolute path, `~`, `$HOME` or `..`
// (`echo x > /Users/you/app/f.py`, `cd ../app && …`: how a delegate's writes once escaped a worktree). A redirection
// target outside the worktree is refused for every role; for a delegate, any such path is, apart from the system
// prefixes below, which commands read but never write (interpreters, tools, /tmp for scratch).
const SYSTEM_PREFIXES = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/etc", "/dev", "/proc", "/sys", "/tmp",
                         "/var", "/private/tmp", "/private/var", "/Library", "/System", "/Applications", "/nix"]
const REDIRECT = /(?:^|[^<>])>{1,2}\s*["']?([^\s"';&|)]+)/g
// A heredoc body is data, not shell syntax: do not interpret its quoted redirect-like text as a live redirect.
function heredocDelimiters(line: string): string[] {
  const delimiters: string[] = []
  let quote = ""
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quote) {
      if (char === quote) quote = ""
      else if (char === "\\" && quote === '"') i++
      continue
    }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === "\\") { i++; continue }
    if (char === "#" && (i === 0 || /\s/.test(line[i - 1]))) break
    if (char !== "<" || line[i - 1] === "<" || line[i + 1] !== "<" || line[i + 2] === "<") continue
    i += 2
    if (line[i] === "-") i++
    while (/\s/.test(line[i] ?? "")) i++
    const delimiterQuote = line[i] === "'" || line[i] === '"' ? line[i++] : ""
    let delimiter = ""
    while (i < line.length) {
      const next = line[i]
      if (delimiterQuote ? next === delimiterQuote : /[\s;&|<>]/.test(next)) break
      if (next === "\\" && i + 1 < line.length) delimiter += line[++i]
      else delimiter += next
      i++
    }
    if (delimiter) delimiters.push(delimiter)
  }
  return delimiters
}

function withoutHeredocBodies(command: string): string {
  const lines = command.split("\n")
  const syntax: string[] = []
  let delimiters: string[] = []
  let inBody = false
  for (const line of lines) {
    if (!inBody) {
      syntax.push(line)
      delimiters = heredocDelimiters(line)
      inBody = delimiters.length > 0
      continue
    }
    syntax.push("")
    const terminator = line.replace(/^\t+/, "")
    if (terminator === delimiters[0]) {
      delimiters.shift()
      inBody = delimiters.length > 0
    }
  }
  return syntax.join("\n")
}
const WORD = /(?:[^\s"'=;&|()<>]|\\ )+/g              // a shell word; `=` splits `--out=/x` into its value
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm

// Each refusal is a violation: counted in this process for the token-ratio plugin, which reports the count to the registry.
const g = globalThis as { __biveViolations?: number }
export const violations = (): number => g.__biveViolations ?? 0
const violation = (message: string): never => {
  g.__biveViolations = (g.__biveViolations ?? 0) + 1
  throw new Error(message)
}

// A delegate's worktree (AGENTS.md › Rules): `.worktrees/issue-<n>` inside the checkout.
const DELEGATE_WORKTREE = /^\.worktrees\/issue-\d+(?=\/|$)/
// Whether the session rooted at `root` is a delegate's: BIVE_ROLE=delegate, a root that is a delegate's worktree, or
// the role file `.bive/state/role` the coordinator writes there (its text, undefined when missing). A delegate
// started as a child session inherits the coordinator's environment, so the variable alone misses it.
export function isDelegate(root: string, role: string | undefined, roleFile: string | undefined): boolean {
  return role === "delegate" || /[\\/]\.worktrees[\\/]issue-\d+$/.test(path.resolve(root))
    || roleFile?.trim() === "delegate"
}

export type GuardOptions = {
  root: string          // the session's worktree: every write stays under it
  directory?: string    // where relative paths resolve from (default: root)
  delegate: boolean     // a delegate's session (isDelegate): inviolable files and any path outside are refused too
  home?: string         // what `~` and $HOME expand to (default: the user's home)
}
export type ToolInput = Record<string, unknown>
export type Check = (tool: string, input: ToolInput) => void

// The check: throws (and counts a violation) when the tool call must not run; returns when it may.
export function makeGuard(options: GuardOptions): Check {
  const root = path.resolve(options.root)
  const directory = path.resolve(options.directory ?? root)
  const home = options.home ?? os.homedir()
  const delegate = options.delegate
  const expand = (p: string) => p.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home)
  const inside = (p: string) => {
    const full = path.resolve(directory, expand(p))
    return full === root || full.startsWith(root + path.sep)
  }
  const system = (p: string) => {
    const full = path.resolve(directory, expand(p))
    return SYSTEM_PREFIXES.some((s) => full === s || full.startsWith(s + "/"))
  }
  // The words of a command that name a path: absolute, home-relative, or climbing with `..`. Flags, URLs and
  // option names are not paths (`--force`, `https://…`, `-o`); a relative name without `..` stays inside.
  const pathWords = (cmd: string): string[] => {
    const out: string[] = []
    for (const m of cmd.matchAll(WORD)) {
      const w = m[0].replace(/\\ /g, " ")
      if (w.startsWith("-") || /^[a-z][a-z0-9+.-]*:\/\//i.test(w)) continue
      if (w.startsWith("/") || w.startsWith("~") || w.startsWith("$HOME") || w.startsWith("${HOME}")
          || w === ".." || w.startsWith("../") || w.includes("/../") || w.endsWith("/..")) out.push(w)
    }
    return out
  }
  const rel = (p: string, base = root) =>
    path.relative(base, path.resolve(directory, expand(p))).split(path.sep).join("/")
  // Any other session: a path in `.worktrees/issue-<n>/` is a delegate's worktree (a child session runs in this
  // session's plugin instance), so it is checked as that delegate's. Returns that worktree, or undefined.
  const nested = (p: string): string | undefined => {
    const m = delegate ? null : DELEGATE_WORKTREE.exec(rel(p))
    return m ? path.join(root, m[0]) : undefined
  }
  const refuse = (p: string): never =>
    violation(`worktree-guard: ${p} is outside this session's worktree (${root}); work only inside it.`)
  const guard = (p: string) => {
    if (!inside(p)) refuse(p)
    const base = delegate ? root : nested(p)
    if (base !== undefined && PROTECTED.some((re) => re.test(rel(p, base)))) {
      violation(`worktree-guard: ${rel(p, base)} is one of Bive's inviolable files; a delegate never changes it. `
        + "Say in your report what should change and why.")
    }
  }
  return (tool, input) => {
    const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined)
    if (WRITE_TOOLS.has(tool)) {
      const p = str("path") ?? str("filePath") ?? str("file_path")
      if (p !== undefined) guard(p)
    } else if (PATCH_TOOLS.has(tool)) {
      const text = str("patchText") ?? str("patch") ?? ""
      for (const m of text.matchAll(PATCH_FILE)) guard((m[1] ?? m[2]).trim())
    } else if (SHELL_TOOLS.has(tool)) {
      const workdir = str("workdir") ?? str("cwd")
      if (workdir !== undefined && !inside(workdir)) refuse(workdir)
      const sub = workdir === undefined ? undefined : nested(workdir)
      if (sub !== undefined && workdir !== undefined) {
        const at = path.resolve(directory, expand(workdir))
        return makeGuard({ root: sub, directory: at, delegate: true, home })(tool, input)
      }
      const cmd = str("command") ?? ""
      // Every role: a redirection never lands outside the worktree (/dev/null and the system prefixes excepted).
      const shellSyntax = withoutHeredocBodies(cmd)
      const redirected = [...shellSyntax.matchAll(REDIRECT)].map((m) => m[1])
      for (const t of redirected) if (!inside(t) && !system(t)) refuse(t)
      // A delegate: no path outside its worktree at all, read or write, but the system prefixes.
      if (delegate) for (const w of pathWords(shellSyntax)) if (!inside(w) && !system(w)) refuse(w)
      if (delegate) {
        const hit = PROTECTED_WORDS.find((w) => redirected.some((t) => t.includes(w))
                                                 || (SHELL_WRITE.test(shellSyntax) && shellSyntax.includes(w)))
        if (hit) violation(`worktree-guard: this command may change ${hit}, one of Bive's inviolable files; `
          + "a delegate never changes it. Say in your report what should change and why.")
      }
    }
  }
}
