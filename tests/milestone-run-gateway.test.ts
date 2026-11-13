import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import test from "node:test"
import { SCENARIOS, gatewayPlan, launcherFiles } from "../supervisor-tests/milestone-run/gateway.mjs"

test("same seed gives deep-equal plan and identical launcherFiles; another seed differs", () => {
  const a = gatewayPlan({ seed: 7 })
  const b = gatewayPlan({ seed: 7 })
  assert.deepEqual(a, b)
  assert.deepEqual(launcherFiles(a), launcherFiles(b))
  const c = gatewayPlan({ seed: 8 })
  assert.notDeepEqual(a.catalog, c.catalog)
})

test("seeded draws cover scenarios and satisfy selection invariants", () => {
  const scenarios = new Set()
  let someAvail = false
  let someUnavail = false
  for (let seed = 0; seed < 200; seed++) {
    const plan = gatewayPlan({ seed })
    scenarios.add(plan.scenario)
    if (plan.key.modelAAvailable) someAvail = true
    else someUnavail = true
    const recA = plan.catalog.records.find((r) => r.id === plan.modelA)
    assert.equal(recA.available, plan.scenario === "named-available")
    assert.ok(!plan.catalog.records.some((r) => r.id === plan.modelB))
    assert.notEqual(plan.modelB, plan.key.expectedChoice)
    assert.notEqual(plan.modelB, plan.key.fallback)
    const exp = plan.catalog.records.find((r) => r.id === plan.key.expectedChoice)
    assert.equal(exp.available, true)
    assert.equal(exp.eligible, true)
    assert.equal(exp.suitable, true)
    if (plan.scenario === "free-first") {
      const availFree = plan.catalog.records.filter((r) =>
        r.available && r.eligible && r.suitable && r.pricing.status === "verified-free")
      const sorted = [...availFree].sort((a, b) => b.fit - a.fit)
      assert.equal(plan.key.expectedChoice, sorted[0].id)
    } else {
      const availFree = plan.catalog.records.filter((r) =>
        r.available && r.eligible && r.suitable && r.pricing.status === "verified-free")
      assert.equal(availFree.length, 0)
      const availCurrent = plan.catalog.records.filter((r) =>
        r.available && r.eligible && r.suitable && r.id.startsWith(plan.catalog.currentProvider + "/"))
      const sorted = [...availCurrent].sort((a, b) => b.fit - a.fit)
      assert.equal(plan.key.expectedChoice, sorted[0].id)
    }
  }
  assert.equal(scenarios.size, 3)
  assert.ok(someAvail && someUnavail)
})

test("given scenarios are honoured; bad seed or scenario throws", () => {
  for (const s of SCENARIOS) {
    const plan = gatewayPlan({ seed: 5, scenario: s })
    assert.equal(plan.scenario, s)
  }
  for (const bad of [-1, NaN, Infinity, 1.5, 2 ** 32]) {
    assert.throws(() => gatewayPlan({ seed: bad }))
  }
  assert.throws(() => gatewayPlan({ seed: 1, scenario: "nope" }))
})

test("leak check across 50 seeds", () => {
  const re = /candidate|test|scor|seed|draw|trap|case|synthetic|qualified|simulat|fixture|expected|scenario/i
  const forbidden = ["expectedChoice", "fallback", "modelAAvailable", "modelB", "ownerProtocol",
    "traceCriteria", "decoys"]
  for (let seed = 0; seed < 50; seed++) {
    const plan = gatewayPlan({ seed })
    const files = launcherFiles(plan)
    for (const [name, content] of Object.entries(files)) {
      assert.doesNotMatch(content, re, `${name} seed ${seed}`)
      for (const s of forbidden) {
        assert.ok(!content.includes(s), `${name} contains ${s}`)
      }
      assert.ok(!content.includes(plan.modelB), `${name} contains modelB id`)
    }
  }
})

test("launcher end to end", () => {
  mkdirSync(".bive/state", { recursive: true })
  const plan = gatewayPlan({ seed: 7, scenario: "free-first" })
  const root = mkdtempSync(resolve(".bive/state/launcher-"))
  const coord = join(root, "coordination")
  mkdirSync(coord)
  const files = launcherFiles(plan)
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(coord, rel.split("/").pop()), content)
  }
  writeFileSync(join(root, "brief.md"), "brief text here")
  const run = (...args) => spawnSync(process.execPath, [join(coord, "launcher.mjs"), ...args],
    { cwd: root, encoding: "utf8", timeout: 10000 })
  const catResult = run("catalog")
  assert.equal(catResult.status, 0, catResult.stderr)
  const catalog = JSON.parse(catResult.stdout)
  assert.ok(catalog.records.every((r) => !Object.hasOwn(r, "available")))
  const checkResult = run("check", plan.modelA)
  assert.equal(checkResult.status, 0, checkResult.stderr)
  const check = JSON.parse(checkResult.stdout)
  const planRecA = plan.catalog.records.find((r) => r.id === plan.modelA)
  assert.equal(check.available, planRecA.available)
  const launchResult = run("launch", plan.key.expectedChoice, "--brief", "brief.md")
  assert.equal(launchResult.status, 0, launchResult.stderr)
  const launch = JSON.parse(launchResult.stdout)
  assert.equal(launch.outcome, "started")
  const unavailResult = run("launch", plan.modelA)
  assert.equal(unavailResult.status, 0, unavailResult.stderr)
  const unavail = JSON.parse(unavailResult.stdout)
  assert.equal(unavail.outcome, "unavailable")
  const badLaunch = run("launch", "nope/x-1")
  assert.equal(badLaunch.status, 1)
  const badCheck = run("check")
  assert.equal(badCheck.status, 1)
  const events = readFileSync(join(coord, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.equal(events.length, 6)
  for (const e of events) {
    assert.ok(e.at && e.command && typeof e.valid === "boolean")
  }
  const startedEvent = events.find((e) => e.command === "launch" && e.outcome === "started")
  assert.equal(startedEvent.brief, "brief text here")
})

test("corrupt catalog and symlinked events exit 1 with Launcher error", () => {
  mkdirSync(".bive/state", { recursive: true })
  const plan = gatewayPlan({ seed: 7 })
  const files = launcherFiles(plan)
  const root = mkdtempSync(resolve(".bive/state/launcher2-"))
  const coord = join(root, "coordination")
  mkdirSync(coord)
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(coord, rel.split("/").pop()), content)
  }
  writeFileSync(join(coord, "catalog.json"), "{}")
  const r1 = spawnSync(process.execPath, [join(coord, "launcher.mjs"), "catalog"],
    { cwd: root, encoding: "utf8", timeout: 10000 })
  assert.equal(r1.status, 1)
  assert.match(r1.stderr, /Launcher error/)
  const root2 = mkdtempSync(resolve(".bive/state/launcher3-"))
  const coord2 = join(root2, "coordination")
  mkdirSync(coord2)
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(coord2, rel.split("/").pop()), content)
  }
  symlinkSync(join(root2, "outside"), join(coord2, "events.jsonl"))
  const r2 = spawnSync(process.execPath, [join(coord2, "launcher.mjs"), "catalog"],
    { cwd: root2, encoding: "utf8", timeout: 10000 })
  assert.equal(r2.status, 1)
  assert.match(r2.stderr, /Launcher error/)
})
