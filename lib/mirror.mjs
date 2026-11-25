// mirror.mjs — optional post-write hook that runs the Hermes ⇄ DSH mirror
// (sync-agents.py) right away, so a tool result can say whether the other
// agent has the change instead of leaving that to a path unit's timing.

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

/** Output kept from the mirror, in bytes. */
const MAX_OUTPUT_BYTES = 16 * 1024

/**
 * Run the configured mirror command and summarize its outcome.
 * @param {string[]} command - argv; `~` in the program path is expanded.
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - budget
 *   and cancellation.
 * @returns {Promise<{ command: string, exitCode: number, timedOut: boolean, summary: string } | undefined>}
 *   the outcome, or undefined when no command is configured.
 */
export function runMirror(command, { timeoutMs = 8000, signal } = {}) {
  if (!Array.isArray(command) || command.length === 0 || typeof command[0] !== 'string') return Promise.resolve(undefined)
  const program = expand(command[0])
  const args = command.slice(1).map(arg => (typeof arg === 'string' ? expand(arg) : String(arg)))
  return new Promise(resolve => {
    execFile(program, args, {
      timeout: timeoutMs,
      signal,
      maxBuffer: MAX_OUTPUT_BYTES,
      cwd: homedir(),
      env: { ...process.env, HOME: process.env.HOME ?? homedir() },
    }, (error, stdout, stderr) => {
      const lines = `${stdout ?? ''}\n${stderr ?? ''}`.split('\n').map(line => line.trim()).filter(Boolean)
      resolve({
        command: [program, ...args].join(' '),
        exitCode: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1),
        timedOut: error?.killed === true || error?.signal === 'SIGTERM',
        summary: lines.at(-1) ?? '',
      })
    })
  })
}

/**
 * Expand a leading `~` in a path.
 * @param {string} value - path.
 * @returns {string} expanded path.
 */
function expand(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2))
  return value
}
