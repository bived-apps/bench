import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"

// Issue #251: a line at column 0 inside a `run: |` block (a multi-line shell string) ends the block and makes the
// workflow file invalid; GitHub then fails every run with no job. A block may end only where YAML can go on: a key or
// a list item at or above the `run:` key's indentation, or one of a workflow's top-level keys at column 0.
const ROOT = path.resolve(import.meta.dirname, "..")
const DIR = path.join(ROOT, ".github/workflows")
const TOP = new Set(["name", "run-name", "on", "permissions", "env", "defaults", "concurrency", "jobs"])
const indent = (line: string) => line.length - line.trimStart().length

export function badRunBlockLines(text: string): string[] {
  const lines = text.split("\n")
  const bad: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run: [|>][-+]?\s*$/.exec(lines[i])
    if (!m) continue
    const keyIndent = m[1].length
    let j = i + 1
    while (j < lines.length && lines[j].trim() === "") j++
    if (j >= lines.length) break
    const body = indent(lines[j])
    for (; j < lines.length; j++) {
      const line = lines[j]
      if (line.trim() === "" || indent(line) >= body) continue
      const t = line.trimStart()
      const key = /^(?:- )?([A-Za-z0-9_-]+):(?: |$)/.exec(t)
      const ok = indent(line) === 0 ? !!key && TOP.has(key[1]) : indent(line) <= keyIndent && (!!key || t.startsWith("- "))
      if (!ok) bad.push(`line ${j + 1}: ${t.slice(0, 60)}`)
      break
    }
  }
  return bad
}

test("every run block of every workflow keeps its indentation (#251)", () => {
  for (const f of fs.readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n))) {
    assert.deepEqual(badRunBlockLines(fs.readFileSync(path.join(DIR, f), "utf8")), [], f)
  }
})

test("the check catches the #251 defect and accepts a block that ends at the next step", () => {
  const broken = "jobs:\n  a:\n    steps:\n      - run: |\n          body=\"one\n\nRun: x\"\n          echo\n"
  assert.equal(badRunBlockLines(broken).length, 1)
  const fine = "jobs:\n  a:\n    steps:\n      - run: |\n          echo one\n\n          echo two\n      - name: next\n        run: |\n          echo\npermissions:\n  issues: write\n"
  assert.deepEqual(badRunBlockLines(fine), [])
})
