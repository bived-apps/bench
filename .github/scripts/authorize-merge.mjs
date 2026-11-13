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
        redirect: "error",
      })
    } catch (error) {
      if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new Error(`GitHub API request timed out after ${TIMEOUT_MS} ms`)
      }
      throw new Error(redactToken(error?.message || "GitHub API request failed", token))
    }

    if (!response.ok) {
      const error = new Error(`GitHub API ${method} ${requestPath} failed with status ${response.status}`)
      error.status = response.status
      throw error
    }

    if (!response.body) {
      const text = await response.text()
      if (text.length > MAX_RESPONSE_BYTES) throw new Error(`GitHub API response exceeded ${MAX_RESPONSE_BYTES} bytes`)
      if (text === "") return null
      try {
        return JSON.parse(text)
      } catch {
        const parseError = new Error(`GitHub API returned invalid JSON for ${method} ${requestPath}`)
        parseError.status = response.status
        throw parseError
      }
    }

    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel()
          throw new Error(`GitHub API response exceeded ${MAX_RESPONSE_BYTES} bytes`)
        }
        chunks.push(value)
      }
    } catch (error) {
      if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new Error(`GitHub API request timed out after ${TIMEOUT_MS} ms`)
      }
      throw error
    }

    const buffer = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      buffer.set(chunk, offset)
      offset += chunk.byteLength
    }
    const text = new TextDecoder().decode(buffer)
    if (text === "") return null
    try {
      return JSON.parse(text)
    } catch {
      const parseError = new Error(`GitHub API returned invalid JSON for ${method} ${requestPath}`)
      parseError.status = response.status
      throw parseError
    }
  }
}

function redactToken(message, token) {
  if (!token) return message
  return String(message).split(token).join("[redacted]")
}

// Only the canonical transport factory is exported.

export function parsePrNumber(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error("BIVE_PR_NUMBER must be a canonical positive integer string")
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("BIVE_PR_NUMBER must be a positive safe integer")
  }
  return number
}

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

  const number = parsePrNumber(env.BIVE_PR_NUMBER)

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
    now: Date.now,
  })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`authorize-merge: ${error.message}`)
    process.exitCode = 1
  })
}