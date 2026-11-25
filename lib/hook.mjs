// hook.mjs — post-write hook shared by the tools: run the configured mirror
// command after a file changed, and fold its verdict into the tool result.

import { runMirror } from './mirror.mjs'

/**
 * Run the mirror after a write when one is configured.
 * @param {{ config: Record<string, any> }} rt - plugin runtime.
 * @param {string[]} files - files just written.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<Record<string, unknown>>} `{ mirror }` when it ran.
 */
export async function maybeMirror(rt, files, signal) {
  const command = rt.config.mirrorCommand
  if (!Array.isArray(command) || command.length === 0 || files.length === 0) return {}
  const outcome = await runMirror(command, { timeoutMs: rt.config.mirrorTimeoutMs ?? 8000, signal })
  return outcome === undefined ? {} : { mirror: outcome }
}
