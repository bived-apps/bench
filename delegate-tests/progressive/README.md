# Progressive delegate benchmark: lint tooling

Status: **tooling only**. This directory holds the Node 22 lint setup of the progressive delegate benchmark. It has no
fixture, scorer, launcher or ledger yet, runs no candidate model, and is not a release, a qualification or a registry
upload. Its results validate nobody (`RESULTS.md`).

## Runtime and installation

- Node 22 or later (the repository's runtime, see `AGENTS.md` › Project rules).
- ESLint 9.39.1 is the only dependency, pinned exactly in `package.json` and `package-lock.json`. Its source is
  <https://github.com/eslint/eslint> and it is released under the MIT licence.
- Install from the lockfile, with a cache inside the checkout and lifecycle scripts ignored:

```sh
npm --prefix delegate-tests/progressive install --ignore-scripts --no-audit --no-fund \
  --cache .bive/state/npm-cache --fetch-timeout=15000 --fetch-retries=0
```

`node_modules/` and `.npm-cache/` are git-ignored; dependencies are never committed.

## Commands

| Command | What it does |
| --- | --- |
| `npm --prefix delegate-tests/progressive run lint` | Lints the progressive `.mjs` sources with the pinned ESLint; zero warnings allowed. |
| `npm --prefix delegate-tests/progressive run lint:smoke` | Lints in-memory snippets with ESLint's API: a valid module is accepted, an undefined name gives `no-undef`, an unused binding gives `no-unused-vars`. The bad snippets are never executed. |
| `node --test tests/delegate-progressive-tooling.test.ts` | Checks the pins and the standalone config's shape. Needs no install. |

The fast check of a change to this directory is the first two commands plus the third. The repository's core suite
(`node --test tests/*.test.ts`) includes the third.

## Configuration

`eslint.config.mjs` is standalone: it imports no external config or package and lists its Node globals. Rules:
`no-undef`, `no-unused-vars`, `no-unreachable`, `valid-typeof`, and `no-constant-condition` (intentional `while (true)`
loops are allowed). Unused disable comments are errors. No formatting rules.

## Not in this part

- CI integration of the lint command: deferred to the coordinator's part 5, after the ordering of shared files.
- Builder, fixtures, controls, scorer, launcher, ledger and any candidate run: later parts of #73 and of the benchmark.
