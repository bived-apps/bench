import assert from "node:assert/strict"
import test from "node:test"
import { checkPlugins, parsePluginList } from "../.github/scripts/check-plugins.mjs"

test("checkPlugins passes when all expected plugins are present with real IDs", () => {
  const list = [
    { id: "bive.token-ratio", version: "local", source: "/path" },
    { id: "bive.worktree-guard", version: "local", source: "/path" },
  ]
  const r = checkPlugins(list, ["bive.token-ratio", "bive.worktree-guard"])
  assert.equal(r.ok, true)
  assert.deepEqual(r.missing, [])
  assert.deepEqual(r.rejected, [])
})

test("checkPlugins reports missing plugins", () => {
  const list = [{ id: "bive.token-ratio", version: "local", source: "/path" }]
  const r = checkPlugins(list, ["bive.token-ratio", "bive.worktree-guard"])
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, ["bive.worktree-guard"])
})

test("checkPlugins reports rejected plugins (id or version '-')", () => {
  const list = [
    { id: "bive.token-ratio", version: "-", source: "/path" },
    { id: "bive.worktree-guard", version: "local", source: "/path" },
  ]
  const r = checkPlugins(list, ["bive.token-ratio", "bive.worktree-guard"])
  assert.equal(r.ok, false)
  assert.deepEqual(r.rejected, ["bive.token-ratio"])
})

test("parsePluginList parses opencode plugin list output", () => {
  const output = "ID                   VERSION  SOURCE\nbive.token-ratio     local    /path/to/plugin\nbive.worktree-guard  local    /path/to/plugin\n"
  const list = parsePluginList(output)
  assert.equal(list.length, 2)
  assert.equal(list[0].id, "bive.token-ratio")
  assert.equal(list[1].id, "bive.worktree-guard")
})

test("parsePluginList handles empty output", () => {
  const list = parsePluginList("")
  assert.equal(list.length, 0)
})

test("checkPlugins with no expected plugins passes", () => {
  const r = checkPlugins([], [])
  assert.equal(r.ok, true)
})