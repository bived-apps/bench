// Smoke test of the lint setup: lints in-memory snippets with ESLint's API. The bad snippets are never executed.
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const here = dirname(fileURLToPath(import.meta.url));
const eslint = new ESLint({
  cwd: here,
  overrideConfigFile: `${here}/eslint.config.mjs`,
});

async function messagesOf(code) {
  const [result] = await eslint.lintText(code, { filePath: `${here}/snippet.mjs` });
  return result.messages;
}

const valid = `import { readFile } from "node:fs/promises";
export async function load(path) {
  return readFile(path, "utf8");
}
`;
const undefinedName = `export const total = missingValue + 1;
`;
const unusedBinding = `const unused = 1;
export const kept = 2;
`;

const validMessages = await messagesOf(valid);
assert.deepEqual(validMessages, [], "a valid Node module must be accepted");

const undefinedRules = (await messagesOf(undefinedName)).map((m) => m.ruleId);
assert.ok(undefinedRules.includes("no-undef"), `undefined identifier must give no-undef, got ${undefinedRules}`);

const unusedRules = (await messagesOf(unusedBinding)).map((m) => m.ruleId);
assert.ok(unusedRules.includes("no-unused-vars"), `unused binding must give no-unused-vars, got ${unusedRules}`);

console.log("lint-smoke: 3 snippets checked (valid accepted, no-undef and no-unused-vars reported)");
