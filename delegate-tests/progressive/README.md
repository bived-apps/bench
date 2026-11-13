# Progressive delegate benchmark: lint tooling and offline fixture material

Status: **partial offline material, not a benchmark**. This directory holds the lint setup and the first part of the
fixture generator of the progressive delegate benchmark. Generation is pure and offline: it builds five of the eleven
scheduled families (`plain`, `missing-target`, `larger-change`, `replacement`, `part-a`). The other six throw
`not implemented`. There is **no scorer, launcher or ledger**, no candidate run, no model call, no GitHub action, no
release, no qualification and no registry upload. `run_ready` and `qualifies` are `false` in every manifest. Its
results validate nobody (`RESULTS.md`).

## Runtime and installation

- Node `^22.13.0 || >=24` (the `engines` field of `package.json`; checked on Node 22.23.4). This is the ESLint 10
  engine range, `^20.19.0 || ^22.13.0 || >=24`, narrowed to the lines the repository runs on.
- ESLint 10.14.0 is the only dependency, pinned exactly in `package.json` and `package-lock.json`. Its source is
  <https://github.com/eslint/eslint> and it is released under the MIT licence.
- Install from the lockfile only (`npm ci`, never `npm install`, so the lock is not rewritten), with a cache inside the
  checkout, lifecycle scripts ignored, no audit, no funding, no global install, and bounded fetches (15 s timeout, no
  retries). Run it under a 120 s command timeout:

```sh
npm --prefix delegate-tests/progressive ci --ignore-scripts --no-audit --no-fund \
  --cache .bive/state/npm-cache --fetch-timeout=15000 --fetch-retries=0
```

`node_modules/` and `.npm-cache/` are git-ignored; dependencies are never committed.

## Commands

| Command | What it does |
| --- | --- |
| `npm --prefix delegate-tests/progressive run lint` | Lints the progressive `.mjs` sources (tooling, fixtures, controls, builder) with the pinned ESLint; zero warnings allowed. |
| `npm --prefix delegate-tests/progressive run lint:smoke` | Lints in-memory snippets with ESLint's API: a valid module is accepted, an undefined name gives `no-undef`, an unused binding gives `no-unused-vars`. The bad snippets are never executed. |
| `node --test tests/delegate-progressive-tooling.test.ts` | Checks the pins and the standalone config's shape. Needs no install. |
| `node --test tests/delegate-progressive-build.test.ts` | Checks the fixture core: determinism, variation, refusals, candidate views, control templates, the runtime modules' imports, and the oracles of the known reference and baseline files. Needs no install. |

The fast check of a change to this directory is the first two commands plus the last two. The repository's core suite
(`node --test tests/*.test.ts`) includes both tests.

## Fixture material (part B1)

- `fixtures.mjs`: `FAMILY_IDS` (the eleven IDs, frozen), `createFixture(familyId, seed)` for the five implemented
  families, `candidateView(fixture)`, `validateSeed`, `isSafeRelativePath`. A seed is 1 to 128 characters with no control
  character. Every draw is a SHA-256 hash of the family, the seed and a label; there is no counter, clock or random source.
- `controls.mjs`: `createControls(fixture)` returns one correct and at least one known-bad evidence **template** per
  family, plus the five shared known-bad action templates. The templates are data. They carry `status:
  "template-not-evaluated"` and the shared actions `"template-not-executed"`: nothing here assesses a control or runs an
  action. A later scorer part must check them against real evidence before they count.
- `build.mjs`: `buildSeries({ seed, allowPartial })` returns `{ manifest, fixtures }`. The default refuses an incomplete
  series; `allowPartial: true` gives development material only. The manifest carries `incomplete: true`,
  `run_ready: false`, `qualifies: false`, an opaque series ID, and HMAC-SHA256 commitments per slot under a key derived
  from the seed. A commitment is not a signature and does not prove that the hidden key was kept apart.
- No command line and no persistence in this part. Nothing is written to disk.
- Candidate inputs are only `candidateView(fixture)`: the brief and the starting files. The reference files, oracle cases,
  preservation facts and controls stay on the administrator's side.
- `node:vm` runs only the generated reference and starting files, with a 1 s timeout per call, to check their own oracle
  cases. It is not a security sandbox and must never be used to run a candidate's code.

## Configuration

`eslint.config.mjs` is standalone: it imports no external config or package and lists its Node globals. Rules:
`no-undef`, `no-unused-vars`, `no-unreachable`, `valid-typeof`, and `no-constant-condition` (intentional `while (true)`
loops are allowed). Unused disable comments are errors. No formatting rules.

## Not in this part

- The remaining six families (part B2), the scorer, the launcher, the ledger and any candidate run.
- CI integration of the lint command: deferred to the coordinator's part 5, after the ordering of shared files.
- The private key table and the administrator's review of the material.
