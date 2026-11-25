// util.mjs — small shared helpers: path expansion, error shaping, JSON hygiene.

import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Expand a leading `~` against the real home directory.
 * @param {unknown} value - candidate path.
 * @returns {string|undefined} the expanded path, or undefined for a non-string.
 */
export function expandHome(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve one configured path against a base directory.
 * @param {unknown} value - configured path.
 * @param {string} base - base directory for relative values.
 * @returns {string|undefined} an absolute path, or undefined when unset.
 */
export function resolvePath(value, base = process.cwd()) {
  const expanded = expandHome(value)
  return expanded === undefined ? undefined : path.resolve(base, expanded)
}

/**
 * Human-readable message of any thrown value.
 * @param {unknown} error - thrown value.
 * @returns {string} its message.
 */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message)
  return String(error)
}

/**
 * Build an error that carries a stable machine-readable code.
 * @param {string} code - plugin-owned code such as `NO_MATCH`.
 * @param {string} message - model-facing explanation.
 * @param {Record<string, unknown>} [extra] - additional own properties.
 * @returns {Error & { code: string }} the error to throw.
 */
export function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

/**
 * Strip `undefined` so a value is lossless JSON before output validation.
 * @param {unknown} value - tool result candidate.
 * @returns {unknown} a JSON-safe copy.
 */
export function toPlain(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value))
}

/**
 * Filesystem-safe timestamp for history and trash names.
 * @param {Date} [date] - time to stamp.
 * @returns {string} e.g. `20261125-070915-123`.
 */
export function timestamp(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    + `-${pad(date.getMilliseconds(), 3)}`
}

/**
 * Short random suffix so same-millisecond names never collide.
 * @returns {string} eight hex characters.
 */
export function randomSuffix() {
  return randomBytes(4).toString('hex')
}

/**
 * Truncate text for a bounded tool result.
 * @param {string} text - source text.
 * @param {number} maxChars - budget.
 * @returns {{ text: string, truncated: boolean }} the bounded text.
 */
export function truncate(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) return { text: text ?? '', truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}

/**
 * Count how often `needle` occurs in `text`, overlapping included.
 * @param {string} text - haystack.
 * @param {string} needle - non-empty span.
 * @returns {number} occurrence count.
 */
export function countOccurrences(text, needle) {
  if (needle.length === 0) return 0
  let count = 0
  for (let i = 0; i <= text.length - needle.length; i += 1) {
    if (text.startsWith(needle, i)) count += 1
  }
  return count
}
