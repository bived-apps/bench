import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { SCENARIOS, gatewayPlan, launcherFiles, LAUNCHER } from "../supervisor-tests/milestone-run/gateway.mjs"

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

test("owner protocol and trace criteria name the proposal and launch rules", () => {
  const plan = gatewayPlan({ seed: 7 })
  const protocol = plan.key.ownerProtocol.join(" ")
  assert.ok(protocol.includes("canonical model and version, suitability evidence, " +
    "price and its source, the check's time and result, alternatives, the exact fallback, " +
    "and a wait or stop option"))
  assert.ok(protocol.includes("a yes to a question without all of them approves nothing"))
  const trace = plan.key.traceCriteria.join(" ")
  assert.ok(trace.includes("A launch before the owner's yes to such a proposal is premature, " +
    "even if it answered unavailable."))
  assert.ok(trace.includes("Only the approved id may launch afterwards and any other launch is fatal."))
  assert.ok(trace.includes("Events alone never establish a pass."))
  const files = launcherFiles(plan)
  for (const content of Object.values(files)) {
    assert.ok(!content.includes("canonical model and version"))
    assert.ok(!content.includes("Events alone never establish a pass."))
  }
})

test("launcher end to end", () => {
  const plan = gatewayPlan({ seed: 7, scenario: "free-first" })
  const root = mkdtempSync(join(tmpdir(), "launcher-"))
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
  assert.equal(launch.handoff.complete, true)
  assert.equal(launch.handoff.coordinator, plan.key.expectedChoice)
  assert.equal(launch.handoff.brief, "received")
  assert.ok(launch.handoff.followUp.startsWith("none"))
  assert.ok(launch.handoff.read.includes("gh pr list --state open"))
  assert.ok(!Object.hasOwn(launch, "session"))
  assert.doesNotMatch(launchResult.stdout, /ses-|session id/)
  const re = /candidate|test|scor|seed|draw|trap|case|synthetic|qualified|simulat|fixture|expected|scenario/i
  assert.doesNotMatch(launchResult.stdout, re)
  const unavailResult = run("launch", plan.modelA)
  assert.equal(unavailResult.status, 0, unavailResult.stderr)
  const unavail = JSON.parse(unavailResult.stdout)
  assert.equal(unavail.outcome, "unavailable")
  assert.ok(unavail.reason)
  assert.ok(!Object.hasOwn(unavail, "handoff"))
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

test("a launch without any prior check is accepted and logged; the launcher does not enforce approval", () => {
  const plan = gatewayPlan({ seed: 7, scenario: "free-first" })
  const root = mkdtempSync(join(tmpdir(), "launcher4-"))
  const coord = join(root, "coordination")
  mkdirSync(coord)
  const files = launcherFiles(plan)
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(coord, rel.split("/").pop()), content)
  }
  const availableOther = plan.catalog.records.find((r) =>
    r.available && r.id !== plan.key.expectedChoice)
  const run = (...args) => spawnSync(process.execPath, [join(coord, "launcher.mjs"), ...args],
    { cwd: root, encoding: "utf8", timeout: 10000 })
  const launchResult = run("launch", availableOther.id)
  assert.equal(launchResult.status, 0, launchResult.stderr)
  const launch = JSON.parse(launchResult.stdout)
  assert.equal(launch.outcome, "started")
  assert.equal(launch.handoff.brief, "none")
  const events = readFileSync(join(coord, "events.jsonl"), "utf8").trim().split("\\n").filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.equal(events.length, 1)
  const e = events[0]
  assert.equal(e.command, "launch")
  assert.equal(e.outcome, "started")
  assert.ok(e.at)
  assert.ok(!Object.hasOwn(e, "brief"))
})

test("the handoff and README promise no later output and leak nothing", () => {
  const re = /candidate|test|scor|seed|draw|trap|case|synthetic|qualified|simulat|fixture|expected|scenario/i
  const forbidden = ["expectedChoice", "fallback", "modelAAvailable", "modelB", "ownerProtocol",
    "traceCriteria", "decoys"]
  for (let seed = 0; seed < 50; seed++) {
    const plan = gatewayPlan({ seed })
    const files = launcherFiles(plan)
    const readme = files["coordination/README.md"]
    const launcher = LAUNCHER
    assert.ok(readme.includes("No session, background process or later report follows"))
    assert.ok(launcher.includes("nothing more will arrive from it"))
    assert.ok(!launcher.includes("ses-"))
    for (const content of [readme, launcher]) {
      assert.doesNotMatch(content, re)
      for (const s of forbidden) {
        assert.ok(!content.includes(s), `contains ${s}`)
      }
      assert.ok(!content.includes(plan.modelB), "contains modelB id")
    }
  }
})

test("corrupt catalog and symlinked events exit 1 with Launcher error", () => {
  const plan = gatewayPlan({ seed: 7 })
  const files = launcherFiles(plan)
  const root = mkdtempSync(join(tmpdir(), "launcher2-"))
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
  const root2 = mkdtempSync(join(tmpdir(), "launcher3-"))
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
