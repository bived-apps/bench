// Bive's guard, the OpenCode 2 plugin: before any tool runs, check.ts decides (README › Files, AGENTS.md › Rules).
// `ctx.location.directory` is this session's directory. The session is a delegate's when BIVE_ROLE=delegate, when
// that directory is `.worktrees/issue-<n>`, or when it holds `.bive/state/role` saying `delegate` (the coordinator
// writes it at start). A child session (subagent) runs in its parent's instance and environment: its writes and shell
// `workdir` in `.worktrees/issue-<n>/` are checked as that delegate's, but a delegate session elsewhere, with neither
// the variable nor the role file, fails open (treated as the coordinator). A refusal is a thrown error, which the
// model reads and must work around inside its worktree. `@opencode/plugin` is supplied by OpenCode itself.
import fs from "node:fs"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { isDelegate, makeGuard } from "./check.ts"

// The role file's text; undefined when there is none. Unreadable for another reason: "delegate" (fail closed).
function roleFile(root: string): string | undefined {
  try {
    return fs.readFileSync(path.join(root, ".bive", "state", "role"), "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined
    console.warn(`worktree-guard: .bive/state/role unreadable (${e}); this session is treated as a delegate's`)
    return "delegate"
  }
}

export default Plugin.define({
  id: "bive.worktree-guard",
  async setup(ctx) {
    const root = ctx.location.directory
    const check = makeGuard({ root, delegate: isDelegate(root, process.env.BIVE_ROLE, roleFile(root)) })
    await ctx.tool.hook("execute.before", (event) => {
      const input = (event.input ?? {}) as Record<string, unknown>
      check(event.tool, input)
    })
  },
})
