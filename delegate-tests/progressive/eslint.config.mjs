// Standalone ESLint flat config for the progressive benchmark's Node 22 ES modules.
// No external config is imported: the rules and the Node globals are listed here.
// Deliberately small: correctness rules only, no formatting.

const nodeGlobals = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Blob: "readonly",
  Buffer: "readonly",
  FormData: "readonly",
  Headers: "readonly",
  Request: "readonly",
  Response: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  atob: "readonly",
  btoa: "readonly",
  clearImmediate: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  crypto: "readonly",
  fetch: "readonly",
  globalThis: "readonly",
  performance: "readonly",
  process: "readonly",
  queueMicrotask: "readonly",
  setImmediate: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  structuredClone: "readonly",
};

export default [
  {
    ignores: ["node_modules/**", ".npm-cache/**"],
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: nodeGlobals,
    },
    // An unused disable comment is a finding: it would hide a rule that no longer applies.
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "error",
      "no-unreachable": "error",
      "valid-typeof": "error",
      // Intentional `while (true)` loops are allowed (they exit with break or return); other constant conditions are not.
      "no-constant-condition": ["error", { checkLoops: "allExceptWhileTrue" }],
    },
  },
];
