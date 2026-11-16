import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")

// The workflow's own shell block, with the two GitHub expressions replaced, run against real temporary repositories.
function script(base: string, defaultBranch: string): string {
  const y = fs.readFileSync(path.join(ROOT, ".github/workflows/bive-inviolable.yml"), "utf8")
  const m = /- name: No inviolable file changed\n\s+run: \|\n([\s\S]+)$/.exec(y)
  assert.ok(m, "the run block exists")
  const lines = m[1].split("\n").map((l) => l.replace(/^ {10}/, ""))
  return lines.join("\n").replaceAll("${{ github.base_ref }}", base).replaceAll("${{ github.event.repository.default_branch }}", defaultBranch)
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" })
}

// origin has main and milestone/x; the clone checks out a head branch from milestone/x.
function setup(): { clone: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inviolable-"))
  const origin = path.join(dir, "origin"), clone = path.join(dir, "clone")
  fs.mkdirSync(origin)
  git(origin, "init", "-q", "-b", "main")
  fs.writeFileSync(path.join(origin, "AGENTS.md"), "v1\n")
  fs.writeFileSync(path.join(origin, "a.txt"), "a\n")
  git(origin, "add", "-A"); git(origin, "commit", "-qm", "init")
  git(origin, "branch", "milestone/x")
  git(dir, "clone", "-q", origin, clone)
  return { clone }
}

const run = (clone: string, base = "milestone/x") =>
  spawnSync("bash", ["-c", script(base, "main")], { cwd: clone, encoding: "utf8" })

test("a pull request that changes an inviolable file is refused", () => {
  const { clone } = setup()
  git(clone, "switch", "-q", "-c", "issue/1-x", "origin/milestone/x")
  fs.writeFileSync(path.join(clone, "AGENTS.md"), "changed by a delegate\n")
  git(clone, "commit", "-qam", "edit")
  const r = run(clone)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /AGENTS\.md/)
})

test("a pull request with no inviolable change passes", () => {
  const { clone } = setup()
  git(clone, "switch", "-q", "-c", "issue/2-x", "origin/milestone/x")
  fs.writeFileSync(path.join(clone, "a.txt"), "b\n")
  git(clone, "commit", "-qam", "edit")
  assert.equal(run(clone).status, 0)
})

test("a sync of the default branch into the milestone passes: its inviolable file equals the default branch's (#198)", () => {
  const { clone } = setup()
  // main moves on: AGENTS.md changes there
  const origin = path.join(path.dirname(clone), "origin")
  fs.writeFileSync(path.join(origin, "AGENTS.md"), "v2 on main\n")
  git(origin, "commit", "-qam", "main moves")
  git(clone, "fetch", "-q", "origin")
  git(clone, "switch", "-q", "-c", "issue/sync", "origin/milestone/x")
  git(clone, "merge", "-q", "--no-edit", "origin/main")
  assert.equal(fs.readFileSync(path.join(clone, "AGENTS.md"), "utf8"), "v2 on main\n")
  assert.equal(run(clone).status, 0)
})

test("a sync that also carries a different inviolable edit is still refused", () => {
  const { clone } = setup()
  const origin = path.join(path.dirname(clone), "origin")
  fs.writeFileSync(path.join(origin, "AGENTS.md"), "v2 on main\n")
  git(origin, "commit", "-qam", "main moves")
  git(clone, "fetch", "-q", "origin")
  git(clone, "switch", "-q", "-c", "issue/sync2", "origin/milestone/x")
  git(clone, "merge", "-q", "--no-edit", "origin/main")
  fs.writeFileSync(path.join(clone, "AGENTS.md"), "v3 not on main\n")
  git(clone, "commit", "-qam", "extra")
  const r = run(clone)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /AGENTS\.md/)
})
