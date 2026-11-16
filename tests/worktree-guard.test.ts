// node --test tests/*.test.ts — the guard's decisions (README › Files) on fake tool calls; no OpenCode needed.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { isDelegate, isAdvisor, makeGuard, violations, withoutInertText, type Check } from "../.opencode/plugins/worktree-guard/check.ts"

// Fake paths under the home folder, never created: /tmp is a system prefix the guard lets through.
const base = path.join(os.homedir(), ".bive-guard-test")
const main = path.join(base, "repo")
const wt = path.join(base, "repo-3")
const delegate = makeGuard({ root: wt, delegate: true })
const coordinator = makeGuard({ root: wt, delegate: false })
const advisor = makeGuard({ root: main, delegate: false, advisor: true })
const mixed = makeGuard({ root: wt, delegate: true, advisor: true })

const shell = (check: Check, command: string, workdir?: string) => () => check("shell", { command, workdir })
const write = (check: Check, p: string) => () => check("write", { path: p })
const passes = (fn: () => void) => {
  const before = violations()
  assert.doesNotThrow(fn)
  assert.equal(violations(), before, "a passing call must not count a violation")
}
const refused = (fn: () => void, re: RegExp) => {
  const before = violations()
  assert.throws(fn, re)
  assert.equal(violations(), before + 1, "each refusal must increment the violation count exactly once")
}

describe("write tools", () => {
  test("inside the worktree passes", () => {
    passes(write(delegate, "src/a.py"))
    passes(() => delegate("edit", { path: "src/a.py", oldString: "a", newString: "b" }))
  })
  test("outside the worktree is refused for every role", () => {
    refused(write(delegate, path.join(main, "a.py")), /outside this session's worktree/)
    refused(write(coordinator, "../repo/a.py"), /outside/)
    refused(write(advisor, "src/a.py"), /read-only/)
  })
  test("a delegate never touches an inviolable file", () => {
    refused(write(delegate, "AGENTS.md"), /inviolable/)
    refused(write(delegate, ".opencode/plugins/worktree-guard/check.ts"), /inviolable/)
    refused(write(delegate, ".opencode/plugin/token-ratio.ts"), /inviolable/)
    refused(write(delegate, ".bive/gate.json"), /inviolable/)
    passes(write(coordinator, "AGENTS.md"))
    passes(write(coordinator, ".bive/gate.json"))
    refused(write(advisor, "AGENTS.md"), /read-only/)
  })
  test("the V1 names still work (filePath, bash)", () => {
    refused(() => delegate("write", { filePath: path.join(main, "a.py") }), /outside/)
    refused(() => delegate("bash", { command: `echo x > ${main}/f.py` }), /outside/)
  })
  test("mixed delegate+advisor never gains write rights", () => {
    refused(write(mixed, "src/a.py"), /read-only/)
    refused(() => mixed("edit", { path: "src/a.py", oldString: "a", newString: "b" }), /read-only/)
    refused(() => mixed("multiedit", { path: "src/a.py" }), /read-only/)
  })
})

describe("patch", () => {
  test("every file of a patch is checked", () => {
    const patch = `*** Begin Patch\n*** Update File: src/a.py\n-a\n+b\n*** Add File: ${main}/b.py\n+x\n*** End Patch`
    refused(() => coordinator("patch", { patchText: patch }), /outside/)
    passes(() => coordinator("patch", { patchText: "*** Begin Patch\n*** Update File: src/a.py\n-a\n+b\n*** End Patch" }))
    refused(() => delegate("patch", { patchText: "*** Begin Patch\n*** Update File: opencode.jsonc\n-a\n+b\n*** End Patch" }),
            /inviolable/)
    refused(() => advisor("patch", { patchText: "*** Begin Patch\n*** Update File: src/a.py\n-a\n+b\n*** End Patch" }), /read-only/)
  })
  test("a delegate patch inside the worktree passes, outside is refused", () => {
    // Delegate patches are subject to the same boundary as writes: inside passes, outside is refused.
    passes(() => delegate("patch", { patchText: "*** Begin Patch\n*** Update File: src/a.py\n-a\n+b\n*** End Patch" }))
    refused(() => delegate("patch", { patchText: `*** Begin Patch\n*** Add File: ${main}/b.py\n+x\n*** End Patch` }), /outside/)
  })
})

describe("advisor read-only", () => {
  test("only read, glob, grep and skill pass; every other tool is refused", () => {
    for (const tool of ["write", "edit", "multiedit", "patch", "apply_patch", "comment", "merge", "task", "subagent",
                        "shell", "bash", "unknown_tool"]) {
      refused(() => advisor(tool, {}), /read-only/)
    }
    passes(() => advisor("read", {}))
    passes(() => advisor("glob", {}))
    passes(() => advisor("grep", {}))
    passes(() => advisor("skill", {}))
  })
  test("no shell, not even git status", () => {
    refused(shell(advisor, "git status"), /read-only/)
    refused(shell(advisor, "git log --oneline -n 5"), /read-only/)
    refused(shell(advisor, "ls"), /read-only/)
  })
  test("mixed delegate+advisor has no shell either", () => {
    refused(shell(mixed, "git status"), /read-only/)
    refused(shell(mixed, "ls"), /read-only/)
  })
  test("inside reads pass; outside read, glob and grep paths refuse", () => {
    passes(() => advisor("read", { path: "src/a.py" }))
    passes(() => advisor("glob", { path: ".", pattern: "src/**/*.ts" }))
    passes(() => advisor("grep", { path: ".", pattern: "x" }))
    refused(() => advisor("read", { path: path.join(main, "..", "outside.txt") }), /outside/)
    refused(() => advisor("glob", { path: path.join(main, "..", "outside"), pattern: "**/*.ts" }), /outside/)
    refused(() => advisor("grep", { path: path.join(main, "..", "outside"), pattern: "x" }), /outside/)
  })
  test("an outside glob pattern is refused", () => {
    refused(() => advisor("glob", { path: ".", pattern: path.join(main, "..", "**", "*.ts") }), /outside/)
    passes(() => advisor("glob", { path: ".", pattern: "src/**/*.ts" }))
  })
  test("advisor blocks shell before author-override and reports read-only", () => {
    refused(shell(advisor, "git -c user.name='delegate x/y' commit -m m"), /read-only/)
    refused(shell(advisor, "git commit --author='A <a@b.c>' -m m"), /read-only/)
    refused(shell(advisor, "GIT_AUTHOR_NAME=x git commit -m m"), /read-only/)
  })
})

describe("shell, every role", () => {
  test("a redirection outside the worktree is refused", () => {
    refused(shell(coordinator, `echo x > ${main}/f.py`), /outside/)
    refused(shell(coordinator, "echo x >> ../repo/f.py"), /outside/)
  })
  test("redirections to /dev/null, stderr and inside pass", () => {
    passes(shell(coordinator, "pytest -q > out.txt 2>&1"))
    passes(shell(coordinator, "cmd >/dev/null 2>&1; echo >&2 oops"))
    passes(shell(coordinator, "cat <<EOF > notes.md\nhi\nEOF"))
  })
  test("a here-document that redirects outside the worktree is refused", () => {
    // The redirect in 'cat <<EOF > ../x' lands outside the worktree, so it is refused for every role.
    refused(shell(coordinator, "cat <<EOF > ../x"), /outside/)
  })
  test("heredoc-like text in quotes or a comment cannot hide a later redirect", () => {
    // Here-document syntax only counts outside shell quotes and comments; later commands remain checked.
    refused(shell(coordinator, "echo '<<EOF'\n> ../x"), /outside/)
    refused(shell(coordinator, "echo ok # <<EOF\n> ../x\nEOF"), /outside/)
  })
  test("a quoted here-document whose body only contains '> ../x' is allowed", () => {
    // Quoted here-document body text is data, not a live shell redirection.
    passes(shell(coordinator, "cat <<'EOF'\n> ../x\nEOF"))
    passes(shell(coordinator, "cat <<FIRST <<'SECOND'\n> ../x\nFIRST\n> ../y\nSECOND"))
  })
  test("a working directory outside the worktree is refused", () => {
    refused(shell(coordinator, "ls", main), /outside/)
    passes(shell(coordinator, "ls", path.join(wt, "src")))
  })
  test("a coordinator may name paths outside (it creates worktrees)", () => {
    passes(shell(coordinator, "git worktree add ../repo-4 -b issue/4-x dev"))
  })
  test("a coordinator may push, open and merge pull requests", () => {
    // These commands name no path outside the worktree, so the coordinator (not a delegate) may run them.
    passes(shell(coordinator, "git push origin issue/15-guard-tests"))
    passes(shell(coordinator, "gh pr create --base bived --head issue/15-guard-tests --body-file .bive/state/briefs/15.md"))
    passes(shell(coordinator, "gh pr merge 15"))
  })
})

describe("shell, delegate", () => {
  test("an absolute, ~, $HOME or .. path outside the worktree is refused", () => {
    refused(shell(delegate, `cd ${main} && git status`), /outside/)
    refused(shell(delegate, "cd ../repo && ls"), /outside/)
    refused(shell(delegate, "cat ~/.app/agent.json"), /outside/)
    refused(shell(delegate, "ls $HOME/other"), /outside/)
    refused(shell(delegate, "cp a.py src/../../repo/a.py"), /outside/)
  })
  test("system prefixes, flags, URLs and relative names pass", () => {
    passes(shell(delegate, "/usr/bin/python3 -m pytest tests/test_a.py -q --tb=short"))
    passes(shell(delegate, "curl -sS https://example.com/x.json -o .bive/state/x.json"))
    passes(shell(delegate, "cat /tmp/notes.txt && ls /var/log && head -n 3 /private/var/x"))   // system reads stay usable
    passes(shell(delegate, `ls ${wt}/src && git add -A && git commit -m 'x (#3)'`))
    passes(shell(delegate, "ruff check src tests"))
  })
  test("an inviolable file is still refused through the shell", () => {
    refused(shell(delegate, "sed -i 's/a/b/' opencode.jsonc"), /inviolable/)
    refused(shell(delegate, "cp x.ts .opencode/plugins/worktree-guard/index.ts"), /inviolable/)
  })
  test("a refused command is a hard stop that preserves the worktree (#146)", () => {
    // The guard throws on refusal and does not return; uncommitted work is preserved (the guard never modifies files).
    refused(shell(delegate, `echo x > ${main}/f.py`), /outside/)
    // A second, independent refusal still throws (the hard stop is not bypassed by a prior refusal).
    refused(shell(delegate, "sed -i 's/a/b/' opencode.jsonc"), /inviolable/)
    // Count both refusals above too.
    // (They are counted by the global violation counter; assert delta by re-checking is not possible here,
    //  so rely on the per-call refused() invariant elsewhere.)
  })
  test("a pipe is refused as invalid-structure", () => {
    refused(shell(delegate, "git status | xargs rm"), /invalid-structure/)
  })
  test("read-only filters at the end of a statement pass (#204)", () => {
    passes(shell(delegate, "node --test tests/a.test.ts 2>&1 | tail -15"))
    passes(shell(delegate, "git log --oneline | head -n 5"))
    passes(shell(delegate, "git status | grep foo"))
    passes(shell(delegate, 'node --test tests/*.test.ts 2>&1 | grep -E "^# (pass|fail)"'))
    passes(shell(delegate, "node --test a 2>&1 | tail -5; node --test b | tail -n 3"))
    passes(shell(delegate, "git log | grep -i fix | tail -3"))
    passes(shell(delegate, "git status | tail -n 3 && git diff --stat"))
  })
  test("anything else after a pipe, or a filter with a file or an expansion, is still refused (#204)", () => {
    refused(shell(delegate, "git status | tail -n 3 /etc/passwd"), /invalid-structure|outside/)
    refused(shell(delegate, "git status | grep foo AGENTS.md"), /invalid-structure/)
    refused(shell(delegate, "git status | grep $(cat x)"), /invalid-structure/)
    refused(shell(delegate, 'git status | grep "$(cat x)"'), /invalid-structure/)
    refused(shell(delegate, "git status | grep `cat x`"), /invalid-structure/)
    refused(shell(delegate, "git status | tail | sh"), /invalid-structure/)
    refused(shell(delegate, "cat a | tee b"), /invalid-structure/)
    refused(shell(delegate, "git status | head -n 3 > ../x"), /outside/)
    refused(shell(delegate, "echo $(cat /etc/passwd) | tail -1"), /invalid-structure/)
  })
  test("a coordinator keeps its pipes (the filters matter to delegates only)", () => {
    const c = makeGuard({ root: main, delegate: false })
    passes(shell(c, "git status | xargs echo"))
  })
  test("command substitution is refused as invalid-structure", () => {
    refused(shell(delegate, "echo $(cat /etc/passwd)"), /invalid-structure/)
  })
  test("backticks are refused as invalid-structure", () => {
    refused(shell(delegate, "echo `cat /etc/passwd`"), /invalid-structure/)
  })
  test("process substitution is refused as invalid-structure", () => {
    refused(shell(delegate, "diff <(ls a) <(ls b)"), /invalid-structure/)
  })
})

describe("nested worktree (.worktrees/issue-<n>, AGENTS.md › Rules)", () => {
  const nested = path.join(main, ".worktrees", "issue-5")
  const d = makeGuard({ root: nested, delegate: true })
  const c = makeGuard({ root: main, delegate: false })
  test("a delegate there cannot write into the parent checkout", () => {
    refused(write(d, "../../a.py"), /outside/)
    refused(write(d, path.join(main, "a.py")), /outside/)
    refused(shell(d, "cd ../.. && git status"), /outside/)
    passes(write(d, "src/a.py"))
  })
  test("the coordinator creates it from its own checkout", () => {
    passes(shell(c, "git worktree add .worktrees/issue-5 -b issue/5-x bived", main))
  })
})

describe("delegate detection (child sessions inherit the coordinator's environment, #36)", () => {
  test("BIVE_ROLE, a .worktrees/issue-<n> root or the role file make a delegate", () => {
    assert.equal(isDelegate(main, "delegate", undefined), true)
    assert.equal(isDelegate(path.join(main, ".worktrees", "issue-12"), undefined, undefined), true)
    assert.equal(isDelegate(wt, undefined, "delegate\n"), true)
    assert.equal(isDelegate(main, undefined, undefined), false)
    assert.equal(isDelegate(path.join(main, ".worktrees", "issue-12x"), "coordinator", "coordinator"), false)
  })
  test("the session's agent makes a delegate too (0.2 part 2): no BIVE_ROLE, a worktree not named issue-<n>", () => {
    const odd = path.join(main, ".worktrees", "task-a")
    assert.equal(isDelegate(odd, undefined, undefined, "delegate"), true)
    assert.equal(isDelegate(odd, undefined, undefined, "coordinator"), false)
    assert.equal(isDelegate(odd, undefined, undefined, undefined), false)
    assert.equal(isDelegate(odd, undefined, undefined, "build"), false)
    // the old rules still hold whatever the agent says
    assert.equal(isDelegate(main, "delegate", undefined, "coordinator"), true)
    assert.equal(isDelegate(path.join(main, ".worktrees", "issue-12"), undefined, undefined, "coordinator"), true)
  })
  test("a delegate-agent guard refuses the inviolable files and outside paths in a worktree not named issue-<n>", () => {
    const d = makeGuard({ root: path.join(main, ".worktrees", "task-a"), delegate: true })
    refused(write(d, "AGENTS.md"), /inviolable/)
    refused(shell(d, "cat ../../a.py"), /outside/)
    passes(write(d, "src/a.py"))
  })
  test("a coordinator's session checks what lands in .worktrees/issue-<n>/ as that delegate's", () => {
    const c = makeGuard({ root: main, delegate: false })
    const nested = path.join(main, ".worktrees", "issue-12")
    // a subagent's write into its worktree's inviolable file, through the coordinator's plugin instance
    refused(write(c, ".worktrees/issue-12/AGENTS.md"), /inviolable/)
    refused(write(c, path.join(nested, ".bive/prompts/DELEGATE.md")), /inviolable/)
    refused(() => c("patch", { patchText: "*** Begin Patch\n*** Update File: .worktrees/issue-12/opencode.jsonc\n*** End Patch" }),
            /inviolable/)
    // a shell command run there gets the delegate's checks: no path outside that worktree, no inviolable file
    refused(shell(c, "cat ../../a.py", nested), /outside/)
    refused(shell(c, "sed -i 's/a/b/' AGENTS.md", nested), /inviolable/)
    passes(shell(c, "git status && node --test tests/a.test.ts", nested))
    passes(write(c, ".worktrees/issue-12/src/a.py"))
    passes(write(c, ".worktrees/issue-12/.bive/state/role"))   // the coordinator writes the role file
    passes(write(c, "AGENTS.md"))                                // its own checkout stays its own
  })
})

describe("advisor detection (legacy supervisor markers count as advisor)", () => {
  test("recognizes advisor and legacy supervisor via env, role file or agent", () => {
    assert.equal(isAdvisor("advisor", undefined), true)
    assert.equal(isAdvisor(undefined, "advisor\n"), true)
    assert.equal(isAdvisor(undefined, undefined, "advisor"), true)
    assert.equal(isAdvisor("supervisor", undefined), true)
    assert.equal(isAdvisor(undefined, "supervisor\n"), true)
    assert.equal(isAdvisor(undefined, undefined, "supervisor"), true)
  })
  test("negative for coordinator and delegate", () => {
    assert.equal(isAdvisor("coordinator", "coordinator", "coordinator"), false)
    assert.equal(isAdvisor("delegate", "delegate", "delegate"), false)
    assert.equal(isAdvisor(undefined, undefined), false)
  })
})

describe("author override and the advisor's commits (#197)", () => {
  const c = makeGuard({ root: main, delegate: false })
  const d = delegate
  test("no role overrides the commit author for one command", () => {
    for (const g of [c, d]) {
      refused(shell(g, "git -c user.name='delegate x/y' commit -m m"), /author-override/)
      refused(shell(g, 'git -c user.email="a@b.c" commit -m m'), /author-override/)
      refused(shell(g, "git commit --author='A <a@b.c>' -m m"), /author-override/)
      refused(shell(g, "git commit --author 'A <a@b.c>' -m m"), /author-override/)
      refused(shell(g, "GIT_AUTHOR_NAME=x git commit -m m"), /author-override/)
      refused(shell(g, "GIT_COMMITTER_EMAIL=x@y.z git commit -m m"), /author-override/)
    }
    refused(shell(c, "ssh host 'git -c user.name=\"delegate x\" commit -m m'"), /author-override/)
  })
  test("setting the worktree identity once is allowed, and so is an ordinary commit", () => {
    passes(shell(c, 'git -C .worktrees/issue-5 config --worktree user.name "delegate claude-agent/sonnet"'))
    passes(shell(c, "git config --worktree user.email delegate@bive.invalid"))
    passes(shell(c, "git commit -F msg.txt"))
    passes(shell(delegate, "git commit -F msg.txt"))
    passes(shell(c, "git log --format=%an -1"))
  })
  test("an advisor never commits or pushes (read-only), and a coordinator still commits", () => {
    refused(shell(advisor, "git commit -m m"), /read-only/)
    refused(shell(advisor, "git push origin bived"), /read-only/)
    refused(shell(advisor, "git -C other commit -am m"), /read-only/)
    refused(shell(advisor, "ssh machine-a 'cd repo && git commit -m fix && git push'"), /read-only/)
    refused(shell(advisor, 'ssh machine-a "git push origin x"'), /read-only/)
    refused(shell(advisor, "git status"), /read-only/)
    refused(shell(advisor, "git log --oneline -n 5"), /read-only/)
    refused(shell(advisor, "gh pr view 5"), /read-only/)
    refused(shell(advisor, "ssh machine-a 'git status'"), /read-only/)
    passes(shell(c, "git commit -m ok"))   // a coordinator still commits its own pull requests
  })
  test("who is an advisor: the variable, the role file or the agent", () => {
    // covered by advisor detection above; keep a quick check here for compatibility
    assert.equal(isAdvisor("advisor", undefined), true)
    assert.equal(isAdvisor("supervisor", undefined), true)
  })
})

describe("temporary-directory writes of a delegate (#224)", () => {
  test("a delegate writes no scratch outside its worktree", () => {
    for (const c of ["echo x > /tmp/a.txt", "echo x >> /var/tmp/a", "cp a.py /tmp/a.py", "mv a.py /tmp/", "touch /tmp/x",
      "mkdir -p /tmp/scratch", "tee /tmp/log < a.txt", "rm -f /tmp/x", "sed -i s/a/b/ /tmp/f", "dd if=a of=/private/tmp/b",
      "curl -sS https://e.com -o /tmp/x.json", "tar -xf a.tar -C /tmp/d", "git clone https://e.com/r /tmp/r"]) {
      refused(shell(delegate, c), /outside|temporary-directory/)
    }
  })
  test("variables and mktemp defaults are refused", () => {
    refused(shell(delegate, 'echo x > "$TMPDIR/a"'), /variable|temporary-directory/)
    refused(shell(delegate, "echo x > ${TMPDIR}/a"), /variable|temporary-directory/)
    refused(shell(delegate, "cp a.py $TMPDIR/a.py"), /temporary-directory/)
    refused(shell(delegate, "TMPDIR=/tmp mktemp -d"), /temporary-directory/)
    refused(shell(delegate, "mktemp"), /temporary-directory/)
    refused(shell(delegate, "mktemp -t scratch"), /temporary-directory/)
    refused(shell(delegate, "mktemp --tmpdir"), /temporary-directory/)
    refused(shell(delegate, "python3 -c \"open('/tmp/x','w').write('1')\""), /temporary-directory/)
  })
  test("scratch inside the worktree and system reads pass", () => {
    passes(shell(delegate, "echo x > .bive/state/scratch.txt"))
    passes(shell(delegate, "echo x > /dev/null"))
    passes(shell(delegate, "mkdir -p .bive/state/tmp && cp a.py .bive/state/tmp/a.py"))
    passes(shell(delegate, "mktemp -d .bive/state/scratch.XXXXXX"))
    passes(shell(delegate, "mktemp -p .bive/state -d"))
    passes(shell(delegate, "cat /tmp/x && ls /var && ls $TMPDIR && python3 -c 'print(1)'"))
    passes(shell(delegate, `echo x > ${wt}/out.txt`))
  })
  test("the coordinator writes no scratch in a temporary directory either (#345)", () => {
    for (const c of ["cp a.py /tmp/a.py", "curl -sS https://e.com -o /tmp/x.svg", 'echo x > "$TMPDIR/a"', "mktemp -d",
      "echo x > /tmp/a", "cmd 2> /tmp/err"]) {
      refused(shell(coordinator, c), /outside|variable|temporary-directory/)
    }
    passes(shell(coordinator, "curl -sS https://e.com -o .bive/state/x.svg"))
    passes(shell(coordinator, "cat /tmp/x && ls $TMPDIR"))
    passes(shell(coordinator, "cat /tmp/x > .bive/state/out.txt && ls 2>/dev/null"))
  })
})

describe("inert argument text versus real destinations (#225)", () => {
  test("quoted prose and non-writing patterns do not count as outside paths", () => {
    passes(shell(delegate, `git commit -m "fix ../x and /home/u/y in the path regex (#3)"`))
    passes(shell(delegate, `git commit -m 'uses a | b and $(x) and ../z'`))
    passes(shell(delegate, `grep -E "a|../b|/home/u/c" src/a.py`))
    passes(shell(delegate, `echo "see /home/u/notes and ../x"`))
    passes(shell(delegate, `python3 -c "import re; print(re.sub(r'../x|/home/u/y', '', 'a'))"`))
    passes(shell(delegate, `gh issue comment 5 --body "paths like ../x are refused; see /home/u/doc"`))
  })
  test("real quoted destinations, live substitutions and writing scripts stay refused", () => {
    refused(shell(delegate, `cp a.py "/home/u/other/a.py"`), /outside/)
    refused(shell(delegate, `git commit -m "x" && cp a.py /home/u/other/a.py`), /outside/)
    refused(shell(delegate, `python3 -c "open('/home/u/other/x','w').write('1')"`), /outside|temporary/)
    refused(shell(delegate, `git commit -m "$(cat /home/u/other/x)"`), /invalid-structure/)
    refused(shell(delegate, "git commit -m \"`cat /home/u/other/x`\""), /invalid-structure/)
    refused(shell(delegate, `echo "x" > /home/u/other/y`), /outside/)
    refused(shell(delegate, `sh -c "cp a.py /home/u/other/a.py"`), /outside/)
    refused(shell(delegate, `grep "x" /home/u/other/file`), /outside/)
  })
  test("inert text is not blanked for other roles' checks and plain output is unchanged", () => {
    assert.equal(withoutInertText("ls src"), "ls src")
    assert.equal(withoutInertText(`git commit -m "a ../b"`), `git commit -m ""`)
    assert.equal(withoutInertText(`git commit -m "a $(b)"`), `git commit -m "a $(b)"`)
  })
})

describe("violations", () => {
  test("every refusal above incremented exactly once", () => {
    // The per-call deltas were asserted in refused(); the counter is monotonic and positive.
    assert.ok(violations() > 0)
  })
})