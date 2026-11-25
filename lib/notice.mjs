// notice.mjs — the chat-visible counterpart of Hermes' `notification_mode`.
//
// Hermes reports what a background pass changed ("Memory updated", "Skill
// created: x") straight into the conversation. DSH has no system-notice
// channel, but a step-local message IS rendered in the transcript — the same
// mechanism the memory review and the skill nudge already use — so the writes
// are queued as they happen and delivered at the first step of the next turn.

import { readText, writeFileAtomic } from './fsx.mjs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Source kind of a delivered notice; the client groups and styles by it. */
export const NOTICE_KIND = 'self-evolve-notice'

/** How many undelivered notices are kept; older ones fall off the queue. */
const MAX_PENDING = 20

/**
 * Where the queue lives.
 * @param {{ paths: object }} rt - plugin runtime.
 * @returns {string} path.
 */
export function noticesPath(rt) {
  return path.join(rt.paths.dataDir, 'notices.json')
}

/**
 * Append one line to the pending queue.
 * @param {{ paths: object }} rt - plugin runtime.
 * @param {string} text - one line, already human-facing.
 * @param {{ now?: number }} [options] - clock.
 * @returns {Promise<void>} completion.
 */
export async function queueNotice(rt, text, { now = Date.now() } = {}) {
  const line = String(text ?? '').trim()
  if (line.length === 0) return
  const pending = await readPending(rt)
  pending.push({ at: new Date(now).toISOString(), text: line })
  const kept = pending.slice(-MAX_PENDING)
  await writeFileAtomic(noticesPath(rt), `${JSON.stringify(kept, null, 2)}\n`).catch(() => {})
}

/**
 * Read and clear the queue.
 * @param {{ paths: object }} rt - plugin runtime.
 * @returns {Promise<Array<{ at: string, text: string }>>} the notices taken.
 */
export async function drainNotices(rt) {
  const pending = await readPending(rt)
  if (pending.length === 0) return []
  await writeFileAtomic(noticesPath(rt), '[]\n').catch(() => {})
  return pending
}

/**
 * The queued notices, tolerating a missing or corrupt file.
 * @param {{ paths: object }} rt - plugin runtime.
 * @returns {Promise<Array<{ at: string, text: string }>>} pending notices.
 */
async function readPending(rt) {
  const raw = await readText(noticesPath(rt)).catch(() => undefined)
  if (raw === undefined) return []
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter(item => item !== null && typeof item === 'object' && typeof item.text === 'string')
  } catch {
    return []
  }
}

/**
 * Turn the operations a background pass applied into Hermes-style lines.
 * @param {Array<{ target: string, result: object }>} applied - applied ops.
 * @param {string} [mode] - `on` (generic) or `verbose` (with action detail).
 * @returns {string[]} lines.
 */
export function describeApplied(applied, mode = 'on') {
  const verbose = String(mode).toLowerCase() === 'verbose'
  const lines = []
  const memory = applied.filter(item => item?.target === 'memory')
  if (memory.length > 0) {
    lines.push(verbose
      ? `memory ${memory.map(item => item.result?.action ?? 'updated').join(', ')}`
      : memory.length === 1 ? 'Memory updated' : `Memory updated (${memory.length} entries)`)
  }
  for (const item of applied.filter(entry => entry?.target === 'skills')) {
    const action = item.result?.action ?? 'updated'
    const name = typeof item.result?.name === 'string' ? item.result.name : undefined
    lines.push(`Skill ${action}${name === undefined ? '' : `: ${name}`}`)
  }
  return lines
}

/**
 * Render a batch of queued notices as one message body.
 * @param {Array<{ at: string, text: string }>} pending - notices.
 * @returns {string} text.
 */
export function noticeText(pending) {
  const lines = pending.map(item => `- ${item.text}`)
  // DSH appends a step-local message to the user's turn, so the first line has
  // to say plainly that this is not the user speaking.
  return ['⚙️ self-evolve · writes since the last turn (not from you):', ...lines].join('\n')
}

/**
 * Wrap notice text as a step-local message.
 * @param {string} text - body.
 * @returns {object} message.
 */
export function noticeMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: NOTICE_KIND, form: 'notice', summary: text.split('\n')[0] },
  }
}

/**
 * Deliver pending notices at the first step of a turn.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @returns {boolean} whether a listener was registered.
 */
export function installNotices(ctx, rt) {
  const mode = String(rt.config.notificationMode ?? 'on').toLowerCase()
  if (mode === 'off') return false
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject') return decision
    const { agent, step, signal } = payload ?? {}
    const session = agent?.session
    if (session === undefined || step !== 1) return decision
    if ((session.header?.delegationDepth ?? 0) > 0) return decision
    if (signal?.aborted === true) return decision
    if (!Array.isArray(decision?.messages) || decision.messages.length === 0) return decision
    const pending = await drainNotices(rt)
    if (pending.length === 0) return decision
    return { ...decision, messages: [...decision.messages, noticeMessage(noticeText(pending))] }
  })
  return true
}
