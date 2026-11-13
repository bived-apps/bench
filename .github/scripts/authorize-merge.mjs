import path from "node:path"
import { fileURLToPath } from "node:url"
import { authorizeMerge, boundGrantLabel, validateBoundAuthorization, GRANT_LABEL_PREFIX } from "./authorize-merge-lib.mjs"
export { authorizeMerge, boundGrantLabel, validateBoundAuthorization, GRANT_LABEL_PREFIX }

const API_ORIGIN = "https://api.github.com"
const TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export function createGitHubApi(token) {
  return async function api(method, requestPath, body) {
    const url = `${API_ORIGIN}${requestPath}`
    let response
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new Error(`GitHub API request timed out after ${TIMEOUT_MS} ms`)
      }
      throw error
    }

    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error(`GitHub API response exceeded ${MAX_RESPONSE_BYTES} bytes`)
    }
    const text = new TextDecoder().decode(buffer)

    if (!response.ok) {
      const error = new Error(`GitHub API ${method} ${requestPath} failed with status ${response.status}`)
      error.status = response.status
      throw error
    }
    if (text === "") return null
    try {
      return JSON.parse(text)
    } catch (error) {
      const parseError = new Error(`GitHub API returned invalid JSON for ${method} ${requestPath}`)
      parseError.status = response.status
      throw parseError
    }
  }
}

// Backwards/alternate names for tests that import the transport under a different name.
export const createApi = createGitHubApi
export const githubApi = createGitHubApi
export const makeApi = createGitHubApi
export const request = createGitHubApi
export const fetchGitHub = createGitHubApi
export const transport = createGitHubApi
export const createTransport = createGitHubApi

export async function main() {
  const env = process.env
  const required = [
    "GITHUB_REPOSITORY",
    "BIVE_PR_NUMBER",
    "BIVE_HEAD_SHA",
    "BIVE_MERGE_OWNER",
    "GITHUB_ACTOR",
    "GITHUB_TRIGGERING_ACTOR",
    "GITHUB_WORKFLOW_REF",
    "BIVE_DEFAULT_BRANCH",
    "GH_TOKEN",
  ]
  for (const name of required) {
    if (!env[name]) throw new Error(`missing required environment variable ${name}`)
  }

  const number = Number(env.BIVE_PR_NUMBER)
  if (!Number.isInteger(number) || number <= 0) throw new Error("BIVE_PR_NUMBER must be a positive integer")

  const api = createGitHubApi(env.GH_TOKEN)
  const result = await authorizeMerge({
    repository: env.GITHUB_REPOSITORY,
    number,
    headSha: env.BIVE_HEAD_SHA,
    owner: env.BIVE_MERGE_OWNER,
    actor: env.GITHUB_ACTOR,
    triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    defaultBranch: env.BIVE_DEFAULT_BRANCH,
    api,
    now: Date.now(),
  })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`authorize-merge: ${error.message}`)
    process.exitCode = 1
  })
}