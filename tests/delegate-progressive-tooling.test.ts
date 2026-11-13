// node --test tests/*.test.ts — delegate-progressive lint tooling: the pins and the standalone config's shape.
// No npm install, no subprocess, no network, no skip: it reads the committed files and imports only the config.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import config from "../delegate-tests/progressive/eslint.config.mjs"

const read = (name: string) => readFileSync(new URL(`../delegate-tests/progressive/${name}`, import.meta.url), "utf8")

describe("package.json", () => {
  const pkg = JSON.parse(read("package.json"))

  test("private ESM package on Node 22 or later, with the two scripts", () => {
    assert.equal(pkg.private, true)
    assert.equal(pkg.type, "module")
    assert.equal(pkg.engines.node, ">=22")
    assert.equal(pkg.scripts.lint, "eslint --max-warnings 0 .")
    assert.equal(pkg.scripts["lint:smoke"], "node lint-smoke.mjs")
  })

  test("ESLint is the only dependency, pinned exactly to 9.39.1", () => {
    assert.deepEqual(pkg.devDependencies, { eslint: "9.39.1" })
    assert.equal(pkg.dependencies, undefined)
  })
})

describe("package-lock.json", () => {
  const lock = JSON.parse(read("package-lock.json"))

  test("the root entry and the installed eslint agree with the pin", () => {
    assert.ok(lock.lockfileVersion >= 3)
    assert.deepEqual(lock.packages[""].devDependencies, { eslint: "9.39.1" })
    assert.equal(lock.packages["node_modules/eslint"].version, "9.39.1")
    assert.match(lock.packages["node_modules/eslint"].resolved, /^https:\/\/registry\.npmjs\.org\//)
  })
})

describe(".gitignore", () => {
  test("excludes dependencies and the local npm cache", () => {
    const lines = read(".gitignore").split("\n")
    assert.ok(lines.includes("node_modules/"))
    assert.ok(lines.includes(".npm-cache/"))
  })
})

describe("eslint.config.mjs", () => {
  test("standalone: no import of an external config or package", () => {
    const source = read("eslint.config.mjs")
    assert.doesNotMatch(source, /^\s*import\s/m)
    assert.doesNotMatch(source, /\brequire\(/)
  })

  test("one block for the .mjs sources, module code, Node 22 globals", () => {
    assert.equal(config.length, 2)
    const block = config[1]
    assert.deepEqual(block.files, ["**/*.mjs"])
    assert.equal(block.languageOptions.sourceType, "module")
    assert.equal(block.languageOptions.ecmaVersion, 2024)
    for (const name of ["process", "Buffer", "console", "URL", "setTimeout", "fetch"]) {
      assert.equal(block.languageOptions.globals[name], "readonly", `global ${name}`)
    }
  })

  test("the rules, exactly, and unused disable comments reported as errors", () => {
    const block = config[1]
    assert.deepEqual(block.rules, {
      "no-undef": "error",
      "no-unused-vars": "error",
      "no-unreachable": "error",
      "valid-typeof": "error",
      "no-constant-condition": ["error", { checkLoops: "allExceptWhileTrue" }],
    })
    assert.equal(block.linterOptions.reportUnusedDisableDirectives, "error")
  })
})
