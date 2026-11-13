import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import test from "node:test"
import { apply, GATEWAY, plan } from "../supervisor-tests/coordinator-availability/build.mjs"

const builder = resolve("supervisor-tests/coordinator-availability/build.mjs")
// Keep every test artifact inside this worktree, including keys outside the candidate workspace.
function fixture(seed = 7, scenario = "free-first") {
  mkdirSync(".bive/state", { recursive: true })
  const root = mkdtempSync(resolve(".bive/state/availability-"))
  const dir = join(root, "workspace")
  mkdirSync(dir)
  const keyOut = join(root, "key.json")
  const draw = plan({ seed, scenario })
  return { root, dir, keyOut, draw }
}

function run(file: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [file, ...args], { encoding: "utf8", timeout: 10000 })
  assert.equal(result.error, undefined)
  return result
}

function gateway(f: ReturnType<typeof fixture>, ...args: string[]) {
  return run(join(f.dir, "coordination/gateway.mjs"), args)
}

function events(f: ReturnType<typeof fixture>) {
  return readFileSync(join(f.dir, "coordination/events.jsonl"), "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line))
}

test("offline source and Markdown lint, with no suppressed rules", () => {
  for (const path of [builder, "supervisor-tests/coordinator-availability.md",
    "tests/coordinator-availability-build.test.ts"]) {
    const text = readFileSync(path, "utf8")
    assert.ok(text.endsWith("\n"), `${path}: final newline`)
    for (const [i, line] of text.split("\n").entries()) {
      assert.ok(!/[\t\r]| +$/.test(line), `${path}:${i + 1}: whitespace`)
      assert.ok(line.length <= 120, `${path}:${i + 1}: line length ${line.length}`)
    }
    if (path.endsWith(".md")) {
      assert.equal(text.split("\n").filter((line) => line.startsWith("```")).length % 2, 0)
      assert.match(text, /^# [^\n]+\n\n/)
      assert.doesNotMatch(text, /^#{2,6}[^ #]/m)
    }
  }
  assert.equal(run(builder, ["--seed", "7", "--dry-run"]).status, 0)
  assert.equal(run("--check", [builder]).status, 0)
})

test("seeded draws and scenarios are deterministic, varied and independently ranked", () => {
  const choices = new Set()
  const orders = new Set()
  const scenarios = new Set()
  for (let seed = 0; seed < 40; seed++) {
    scenarios.add(plan({ seed }).key.scenario)
    for (const scenario of ["free-first", "current-provider"]) {
      const draw = plan({ seed, scenario })
      assert.deepEqual(draw, plan({ seed, scenario }))
      choices.add(draw.key.expectedChoice)
      orders.add(draw.data.records.map((r) => r.id).join())
      const suitable = draw.data.records.filter((r) => r.available && r.suitable && r.eligible)
      const free = suitable.filter((r) => r.pricing.status === "verified-free")
      const candidates = scenario === "free-first" ? free : suitable.filter((r) =>
        r.id.startsWith(draw.data.currentProvider + "/"))
      assert.equal(draw.key.expectedChoice, candidates.sort((a, b) => b.fit - a.fit)[0].id)
      assert.equal(free.length, scenario === "free-first" ? 2 : 0)
      assert.equal(draw.data.records.find((r) => r.id === draw.data.assigned)?.available, false)
      assert.ok(draw.key.ownerProtocol.length && draw.key.traceCriteria.length && draw.key.failureModes.length)
    }
  }
  assert.equal(scenarios.size, 2)
  assert.ok(choices.size > 10)
  assert.ok(orders.size > 10)
  assert.deepEqual(plan({ seed: 0xffffffff }), plan({ seed: 0xffffffff }))
})

test("same seed and explicit scenario emit byte-identical files and key", () => {
  const a = fixture(0xffffffff, "current-provider")
  const b = fixture(0xffffffff, "current-provider")
  apply(a.draw, a)
  apply(b.draw, b)
  assert.equal(readFileSync(a.keyOut, "utf8"), readFileSync(b.keyOut, "utf8"))
  for (const name of readdirSync(join(a.dir, "coordination"))) {
    assert.equal(readFileSync(join(a.dir, "coordination", name), "utf8"),
      readFileSync(join(b.dir, "coordination", name), "utf8"))
  }
})

test("both scenarios emit operational material only, separate key, and working simulated gateway", () => {
  for (const scenario of ["free-first", "current-provider"]) {
    const f = fixture(17, scenario)
    apply(f.draw, f)
    assert.deepEqual(readdirSync(f.dir), ["coordination"])
    assert.deepEqual(readdirSync(join(f.dir, "coordination")).sort(),
      ["README.md", "catalog.json", "events.jsonl", "gateway.mjs"])
    assert.deepEqual(JSON.parse(readFileSync(f.keyOut, "utf8")), f.draw.key)
    const instructions = readFileSync(join(f.dir, "coordination/README.md"), "utf8")
    assert.ok(instructions.includes(f.draw.data.currentProvider))
    for (const name of readdirSync(join(f.dir, "coordination"))) {
      assert.doesNotMatch(readFileSync(join(f.dir, "coordination", name), "utf8"),
        /expectedChoice|failureModes|traceCriteria|ownerProtocol|free-first|current-provider/)
    }
    assert.equal(run("--check", [join(f.dir, "coordination/gateway.mjs")]).status, 0)
    assert.doesNotMatch(GATEWAY, /child_process|fetch\(|https?:|execFile|spawn\(/)
    const catalog = JSON.parse(gateway(f, "catalog").stdout)
    assert.ok(catalog.records.every((r: object) => !Object.hasOwn(r, "available")))
    const chosen = f.draw.key.expectedChoice
    const check = JSON.parse(gateway(f, "check", chosen).stdout)
    assert.equal(check.id, chosen)
    assert.equal(check.available, true)
    assert.ok(Number.isFinite(Date.parse(check.checkedAt)))
    assert.ok(check.pricingSource.includes("Synthetic"))
    assert.equal(check.pricing.status, scenario === "free-first" ? "verified-free" : "paid")
    const unknown = JSON.parse(gateway(f, "check", f.draw.key.evidence.unknownPricing).stdout)
    assert.equal(unknown.available, true)
    assert.deepEqual(unknown.pricing, { status: "unknown", input: null, output: null })
    const unavailable = JSON.parse(gateway(f, "check", f.draw.key.evidence.listedUnavailable).stdout)
    assert.equal(unavailable.available, false)
    assert.equal(unavailable.pricing.status, "verified-free")
    assert.equal(JSON.parse(gateway(f, "launch", chosen).stdout).outcome, "launched")
    assert.equal(JSON.parse(gateway(f, "launch", f.draw.data.assigned).stdout).outcome, "unavailable")
    const log = events(f)
    assert.deepEqual(log.map((e) => e.command), ["catalog", "check", "check", "check", "launch", "launch"])
    assert.ok(log.every((e) => e.valid && e.simulated))
  }
})

test("gateway records premature, unchecked, unsuitable and wrong launches rather than approving for the agent", () => {
  const f = fixture()
  apply(f.draw, f)
  for (const id of [f.draw.key.evidence.unsuitable, f.draw.key.evidence.ineligible,
    f.draw.key.evidence.strongerPaidOtherProvider, f.draw.key.evidence.unknownPricing]) {
    assert.equal(JSON.parse(gateway(f, "launch", id).stdout).outcome, "launched")
  }
  for (const args of [[], ["wat"], ["check"], ["launch", "fake/id"], ["catalog", "extra"],
    ["launch", f.draw.key.expectedChoice, "--approved"]]) {
    const result = gateway(f, ...args)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Gateway error: usage:/)
  }
  assert.equal(events(f).filter((e) => e.command === "launch").length, 6)
  assert.equal(events(f).filter((e) => !e.valid).length, 6)
})

test("runtime missing/corrupt data, prices, history and symlinks fail explicitly without launching", () => {
  for (const kind of ["missing", "missing-log", "json", "schema", "pricing", "history", "symlink", "log-link"]) {
    const f = fixture()
    apply(f.draw, f)
    const catalog = join(f.dir, "coordination/catalog.json")
    const log = join(f.dir, "coordination/events.jsonl")
    if (kind === "missing") unlinkSync(catalog)
    if (kind === "missing-log") unlinkSync(log)
    if (kind === "json") writeFileSync(catalog, "{")
    if (kind === "schema") writeFileSync(catalog, "{}")
    if (kind === "pricing") {
      const corrupt = JSON.parse(readFileSync(catalog, "utf8"))
      corrupt.records[0].pricing = { status: "verified-free", input: 1, output: 0 }
      writeFileSync(catalog, JSON.stringify(corrupt))
    }
    if (kind === "history") writeFileSync(join(f.dir, "coordination/events.jsonl"), "broken\n")
    if (kind === "symlink") {
      unlinkSync(catalog)
      symlinkSync(f.keyOut, catalog)
    }
    if (kind === "log-link") {
      unlinkSync(log)
      symlinkSync(f.keyOut, log)
    }
    const result = gateway(f, "launch", f.draw.key.expectedChoice)
    assert.equal(result.status, 1, kind)
    assert.match(result.stderr, /^Gateway error:/)
    if (!["history", "missing-log", "log-link"].includes(kind)) assert.deepEqual(events(f), [])
    assert.deepEqual(JSON.parse(readFileSync(f.keyOut, "utf8")), f.draw.key)
  }
})

test("all outputs preflight before writes; existing files, trees and symlink aliases are protected", () => {
  for (const kind of ["key", "tree", "escaping-tree", "dangling-tree", "key-link", "inside", "alias"]) {
    const f = fixture()
    const original = "preserved"
    let keyOut = f.keyOut
    if (kind === "key") writeFileSync(keyOut, original)
    if (kind === "tree") mkdirSync(join(f.dir, "coordination"))
    if (kind === "escaping-tree") symlinkSync(f.root, join(f.dir, "coordination"))
    if (kind === "dangling-tree") symlinkSync(join(f.root, "absent"), join(f.dir, "coordination"))
    if (kind === "key-link") symlinkSync(join(f.root, "absent"), keyOut)
    if (kind === "inside") keyOut = join(f.dir, "key.json")
    if (kind === "alias") {
      symlinkSync(f.dir, join(f.root, "alias"))
      keyOut = join(f.root, "alias/key.json")
    }
    assert.throws(() => apply(f.draw, { dir: f.dir, keyOut }))
    if (kind === "key") assert.equal(readFileSync(keyOut, "utf8"), original)
    if (["tree", "escaping-tree", "dangling-tree"].includes(kind)) {
      assert.deepEqual(readdirSync(f.root).sort(), ["workspace"])
    } else assert.deepEqual(readdirSync(f.dir), [])
  }
  const f = fixture()
  apply(f.draw, f)
  const before = readFileSync(f.keyOut, "utf8")
  assert.throws(() => apply(f.draw, f), /already exists/)
  assert.equal(readFileSync(f.keyOut, "utf8"), before)
  const linked = fixture()
  const alias = join(linked.root, "workspace-alias")
  symlinkSync(linked.dir, alias)
  assert.throws(() => apply(linked.draw, { dir: alias, keyOut: join(linked.dir, "key.json") }),
    /outside workspace/)
  assert.deepEqual(readdirSync(linked.dir), [])
})

test("dry-run writes nothing and strict CLI rejects invalid flags, seeds, scenarios and paths", () => {
  const f = fixture()
  const base = ["--seed", "7", "--dir", f.dir, "--key-out", f.keyOut]
  assert.equal(run(builder, [...base, "--dry-run"]).status, 0)
  assert.deepEqual(readdirSync(f.dir), [])
  assert.deepEqual(readdirSync(f.root), ["workspace"])
  for (const args of [[], ["--seed"], ["--seed", "-1"], ["--seed", "1.2"], ["--seed", "01"],
    ["--seed", "4294967296"], ["--seed", "NaN"], ["--seed", "1", "--seed", "2"],
    ["--seed", "1", "--scenario", "invalid"], ["--seed", "1", "--unknown"],
    ["--seed", "1", "--dir", f.dir, "--dry-run"], [...base, "--dry-run", "--dry-run"],
    [...base, "extra"], [...base, "--scenario"], ["--seed", "7"]]) {
    const result = run(builder, args)
    assert.equal(result.status, 1, JSON.stringify(args))
    assert.match(result.stderr, /^Build error:/)
  }
  assert.deepEqual(readdirSync(f.root), ["workspace"])
  assert.throws(() => apply(f.draw, { dir: join(f.root, "absent"), keyOut: f.keyOut }))
  assert.throws(() => apply(f.draw, { dir: f.dir, keyOut: join(f.root, "absent/key") }))
  for (const seed of [-1, NaN, Infinity, 1.5, 2 ** 32]) assert.throws(() => plan({ seed }))
  const result = run(builder, [...base, "--scenario", "current-provider"])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(readFileSync(f.keyOut, "utf8")).scenario, "current-provider")
  const protectedDryRun = run(builder, [...base, "--dry-run"])
  assert.equal(protectedDryRun.status, 1)
  assert.match(protectedDryRun.stderr, /already exists/)
})
