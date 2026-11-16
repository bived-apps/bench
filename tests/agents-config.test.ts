import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")

// opencode.jsonc has only whole-line comments, so dropping those lines is enough (a `//` inside a URL string stays).
function loadConfig(): any {
  const text = fs.readFileSync(path.join(ROOT, "opencode.jsonc"), "utf8")
  return JSON.parse(text.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"))
}

// OpenCode's whole-value wildcard: `*` is zero or more characters including `/`, `?` is exactly one.
function matches(pattern: string, value: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${re}$`).test(value)
}

// Last matching rule wins; agent rules come after the global ones.
function effect(rules: any[], action: string, resource: string): string | undefined {
  let found: string | undefined
  for (const r of rules) if (matches(r.action, action) && matches(r.resource, resource)) found = r.effect
  return found
}

test("the coordinator agent exists next to the delegate and reads COORDINATOR.md", () => {
  const { agents } = loadConfig()
  assert.ok(agents.delegate, "delegate agent kept")
  assert.equal(agents.coordinator.mode, "primary")
  assert.match(agents.coordinator.system, /COORDINATOR\.md/)
  assert.ok(fs.existsSync(path.join(ROOT, ".bive/prompts/COORDINATOR.md")))
})

test("the coordinator may use a delegate's worktree and nothing else outside its own", () => {
  const cfg = loadConfig()
  const rules = [...cfg.permissions, ...cfg.agents.coordinator.permissions]
  const ext = (p: string) => effect(rules, "external_directory", p)
  assert.equal(ext("/home/u/proj/.worktrees/issue-187"), "allow")
  assert.equal(ext("/home/u/proj/.worktrees/issue-187/lib"), "allow")
  assert.equal(ext("/home/u/proj/.worktrees/issue-187/*"), "allow")
  assert.equal(ext("/home/u/proj/.worktrees/other"), "deny")
  assert.equal(ext("/home/u/.ssh"), "deny")
  assert.equal(ext("/tmp/x"), "deny")
})

test("the global deny stays for the delegate and the coordinator gets no edit or shell loosening", () => {
  const cfg = loadConfig()
  assert.equal(effect(cfg.permissions, "external_directory", "/home/u/proj/.worktrees/issue-1"), "deny")
  const own = cfg.agents.coordinator.permissions
  assert.deepEqual([...new Set(own.map((r: any) => r.action))], ["external_directory"])
  assert.ok(own.every((r: any) => r.effect === "allow" && /\.worktrees\/issue-/.test(r.resource)))
})
