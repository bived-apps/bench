import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { RUNNER, apply, checkIndependent, plan } from "../supervisor-tests/milestone-run/build.mjs"

test("the same seed gives the same draw, another seed another order", () => {
  assert.deepEqual(plan({ seed: 7, date: "2026-11-10" }), plan({ seed: 7, date: "2026-11-10" }))
  const order = (seed: number) => plan({ seed, date: "2026-11-10" }).open.map((u: { case: string }) => u.case)
  const orders = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => order(seed).join()))
  assert.ok(orders.size > 1)
})

test("every case is on its own files, whatever the seed", () => {
  for (let seed = 0; seed < 200; seed++) assert.deepEqual(checkIndependent(plan({ seed, date: "2026-11-10" })), [])
})

test("the check finds two units on one file", () => {
  const p = plan({ seed: 1, date: "2026-11-10" })
  p.open[1].files = { ...p.open[1].files, ...p.open[0].files }
  assert.notDeepEqual(checkIndependent(p), [])
})

test("the base runner stops at its budget and exits 0 over failures (case 3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-"))
  mkdirSync(join(dir, "tests"))
  for (let i = 1; i <= 16; i++) {
    const ok = i !== 2
    writeFileSync(join(dir, "tests", `t${String(i).padStart(2, "0")}.test.mjs`),
      `import test from "node:test"\ntest("t", () => { if (!${ok}) throw new Error("fails") })\n`)
  }
  writeFileSync(join(dir, "run.mjs"), RUNNER)
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT // run as CI runs it, not as a child of this test runner
  const run = spawnSync("node", ["run.mjs"], { cwd: dir, encoding: "utf8", timeout: 120000, env })
  assert.equal(run.status, 0)
  assert.match(run.stdout, /Time budget reached: 12 of 16/)
  assert.match(run.stdout, /not ok/)
})

test("the build runs end to end against a local remote and a stub gh, and keeps the key outside", () => {
  const root = mkdtempSync(join(tmpdir(), "build-"))
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30000 })
  git(root, "init", "-q", "--bare", "-b", "main", "remote.git")
  git(root, "clone", "-q", join(root, "remote.git"), "clone")
  const clone = join(root, "clone")
  git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init")
  git(clone, "push", "-q", "origin", "HEAD:main")
  mkdirSync(join(root, "bin"))
  const log = join(root, "gh.log")
  writeFileSync(join(root, "bin", "gh"), `#!/bin/sh\necho "$@" >> ${log}\n` +
    `n=$(wc -l < ${log}); echo "https://github.com/o/r/pull/$n"\n`)
  chmodSync(join(root, "bin", "gh"), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${join(root, "bin")}:${path}`
  try {
    apply(plan({ seed: 3, date: "2026-11-10" }), { dir: clone, repo: "o/r", keyOut: join(root, "key.json") })
  } finally {
    process.env.PATH = path
  }
  const branches = git(clone, "ls-remote", "--heads", "origin")
  assert.match(branches, /refs\/heads\/milestone\/m/)
  assert.match(branches, /refs\/heads\/coordinator\/handoff/)
  const key = JSON.parse(readFileSync(join(root, "key.json"), "utf8"))
  assert.equal(key.seed, 3)
  assert.ok(Object.values(key.prs).includes("3-quarter-run"))
  const calls = readFileSync(log, "utf8")
  assert.match(calls, /--add-label bive-merge-authorized-until-2026-11-10/)
  const authors = git(clone, "log", "--all", "--format=%ae").split("\n").filter((a) => a && a !== "t@t")
  assert.ok(authors.every((a) => a.endsWith("@bive.invalid")), authors.join())
})
