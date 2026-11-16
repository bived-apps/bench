import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const text = fs.readFileSync(new URL("../opencode.jsonc", import.meta.url), "utf8")
const cfg = JSON.parse(text.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"))

test("the delegate agent cannot start agents: subagent and opencode commands are denied", () => {
  const rules = cfg.agents.delegate.permissions as Array<{ action: string, resource: string, effect: string }>
  assert.ok(rules.some((r) => r.action === "subagent" && r.resource === "*" && r.effect === "deny"))
  assert.ok(rules.some((r) => r.action === "shell" && r.resource === "opencode *" && r.effect === "deny"))
  // agent rules are appended last and the last match wins: no later allow may reopen them
  const last = (action: string) => rules.filter((r) => r.action === action).at(-1)
  assert.equal(last("subagent")?.effect, "deny")
})

test("the coordinator keeps the right to start delegates", () => {
  const rules = (cfg.agents.coordinator.permissions ?? []) as Array<{ action: string, effect: string }>
  assert.ok(!rules.some((r) => r.action === "subagent" && r.effect === "deny"))
})

test("COORDINATING.md no longer claims the delegate shows under the coordinator", () => {
  const d = fs.readFileSync(new URL("../docs/COORDINATING.md", import.meta.url), "utf8")
  assert.doesNotMatch(d, /The session then shows under the coordinator's session/)
  assert.match(d, /not verified\*\* \(#243/)
})
