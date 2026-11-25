// review.mjs — the periodic memory review.
//
// Hermes Agent forks a background reviewer every N user turns and asks it
// whether anything in memory or the skills should be saved, updated or
// dropped. A DSH plugin has no second agent slot, so the review rides the
// turn the agent is already running: at the first step of every Nth user turn
// the plugin injects one user-role notice carrying the store's real usage, and
// the agent curates through the `memory` tool it already has. The notice is a
// step-local message (source kind `self-evolve-review`), so it never rewrites
// the transcript and disappears with the step.
//
// The notice opens the due turn only and stays silent until a store is
// genuinely close to its budget: a review of a half-empty store, or one
// repeated on every step, only burns tokens.

import { randomUUID } from 'node:crypto'

import { charCount, parseEntries } from './entries.mjs'
import { readDocument } from './textstore.mjs'

/** Source kind of the review notice; consumers fall through unknown kinds. */
export const REVIEW_KIND = 'self-evolve-review'
/** Source kind of the skill nudge, kept apart from the memory review. */
export const SKILL_NUDGE_KIND = 'self-evolve-skill-nudge'
/** Bound of a notice summary, matching the harness context-summary bound. */
export const NOTICE_SUMMARY_MAX_CHARS = 120

/**
 * Whether this user turn is a review turn.
 *
 * The first turn a session is seen at is always a review turn: a store that is
 * already close to its limit when the session starts should be curated now,
 * not ten turns later. After a review, the next one waits `every` turns.
 * @param {{ every?: number, count?: number, last?: number }} [input] - configured
 *   interval, the ordinal of this user turn in the session, and the turn
 *   ordinal of the previous review (absent when there has not been one).
 * @returns {boolean} true when the turn is due for a review.
 */
export function reviewDue({ every, count, last } = {}) {
  if (!Number.isSafeInteger(every) || every <= 0) return false
  if (!Number.isSafeInteger(count) || count <= 0) return false
  if (last === undefined) return true
  return Number.isSafeInteger(last) && count - last >= every
}

/**
 * The stores worth a review, biggest pressure first.
 * @param {Array<{ target: string, label: string, used: number, limit: number, entries: number }>} stores - live store usage.
 * @param {number} share - usage share (0..1) from which a store is worth a review.
 * @returns {object[]} the stores at or above that share.
 */
export function reviewPressures(stores, share) {
  if (!Array.isArray(stores)) return []
  const floor = Number.isFinite(share) && share > 0 ? share : 0
  return stores
    .filter(store => Number.isFinite(store?.used) && Number.isFinite(store?.limit) && store.limit > 0)
    .filter(store => store.used / store.limit >= floor)
    .sort((a, b) => b.used / b.limit - a.used / a.limit)
}

/**
 * One store's usage, as the notice states it.
 * @param {{ label: string, used: number, limit: number, entries: number }} store - store usage.
 * @returns {string} e.g. `MEMORY.md (agent notes): 11930/12000 chars (99%), 24 entries`.
 */
export function describePressure(store) {
  const percentage = Math.round((store.used / store.limit) * 100)
  const entries = store.entries === 1 ? '1 entry' : `${store.entries} entries`
  return `${store.label}: ${store.used}/${store.limit} chars (${percentage}%), ${entries}`
}

/**
 * Live usage of the entry stores a profile exposes.
 * @param {Record<string, object>} stores - resolved store table (`lib/stores.mjs`).
 * @param {string[]} targets - target names to look at.
 * @returns {Promise<object[]>} one row per store: target, label, used, limit, entries.
 */
export async function usageRows(stores, targets) {
  const rows = []
  for (const target of targets) {
    const store = stores?.[target]
    if (store === undefined || store.type !== 'entries' || !(store.charLimit > 0)) continue
    const document = await readDocument(store.locations)
    const entries = parseEntries(document.text)
    rows.push({ target, label: store.label, used: charCount(entries), limit: store.charLimit, entries: entries.length })
  }
  return rows
}

/**
 * The review notice, or undefined when no store needs one.
 * @param {{ pressures?: object[], turn?: number, every?: number }} [input] - stores from {@link reviewPressures}, the turn ordinal and the interval.
 * @returns {string|undefined} model-facing notice text.
 */
export function reviewText({ pressures, turn, every } = {}) {
  if (!Array.isArray(pressures) || pressures.length === 0) return undefined
  const heading = Number.isSafeInteger(turn) && Number.isSafeInteger(every) && every > 1
    ? `(periodic memory review, every ${every} user turns — a plugin notice, not a user request)`
    : '(periodic memory review — a plugin notice, not a user request)'
  return [
    heading,
    '',
    pressures.map(describePressure).join('\n'),
    '',
    'That is close enough to the limit that the next write will be shortened automatically, and a trim loses detail. Before the task in this turn, curate the store with ONE `memory` batch: drop entries that are stale, superseded or duplicated, merge entries that restate each other, and tighten wording that repeats itself. Keep paths, ports, hostnames, versions, IDs and numbers verbatim. Add an entry only when this session produced a durable fact that is not stored yet — procedures belong in a skill, not in memory.',
    'If the store is already as small as it should be, continue the task without writing.',
  ].join('\n')
}

/**
 * One-line account of the notice, for its source summary.
 * @param {string} text - notice text.
 * @returns {string} its first line, bounded.
 */
export function noticeSummary(text) {
  const line = String(text ?? '').split('\n').find(part => part.trim().length > 0)?.trim() ?? ''
  if (line.length <= NOTICE_SUMMARY_MAX_CHARS) return line
  return `${line.slice(0, NOTICE_SUMMARY_MAX_CHARS - 1)}…`
}

/**
 * The user-role message carrying the notice.
 * @param {string} text - notice text from {@link reviewText}.
 * @returns {{ id: string, role: 'user', content: object[], source: object }} an immutable-shaped message for `agent/pre-step`.
 */
export function reviewMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: REVIEW_KIND, form: 'notice', summary: noticeSummary(text) },
  }
}


/**
 * The text of the skill nudge.
 *
 * Hermes reminds the agent every `skills.creation_nudge_interval` turns to turn
 * a reusable procedure into a skill; the DSH nudge says the same thing in one
 * step-local notice, without a forked agent.
 * @param {{ turn: number, every: number, skills: number }} input - the turn
 *   ordinal, the interval, and how many skills exist.
 * @returns {string} the notice text.
 */
export function skillNudgeText({ turn, every, skills } = {}) {
  const library = Number.isSafeInteger(skills) && skills > 0
    ? `${skills} skills exist`
    : 'no skills exist yet'
  return [
    `Skill check (turn ${turn}, every ${every}; ${library}).`,
    'If this session produced a reusable procedure — an order of steps, a pitfall, a way to verify — save it now with `skill_manage` (create, or patch the skill it belongs to).',
    'Write the lesson, not the log: one rule with its why, and a description that says when to use it. Durable facts still belong in `memory`.',
  ].join(' ')
}

/**
 * The user-role message carrying the skill nudge.
 * @param {string} text - notice text from {@link skillNudgeText}.
 * @returns {{ id: string, role: 'user', content: object[], source: object }} the message.
 */
export function skillNudgeMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SKILL_NUDGE_KIND, form: 'notice', summary: noticeSummary(text) },
  }
}

/**
 * Register the skill nudge on the agent's pre-step chain.
 *
 * It rides the same step-1 slot as the memory review but keeps its own
 * interval, so a session can be reminded about skills at a different cadence
 * than it reviews memory. Subagent sessions and turns with nothing claimed are
 * skipped, exactly as in {@link installReview}.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ every: number, count: () => Promise<number> }} options - interval
 *   and the live skill count.
 * @returns {boolean} whether a listener was registered.
 */
export function installSkillNudge(ctx, { every, count }) {
  if (!Number.isSafeInteger(every) || every <= 0) return false
  const seen = new WeakMap()
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject') return decision
    const { agent, turn, step, signal } = payload ?? {}
    const session = agent?.session
    if (session === undefined) return decision
    if (step !== 1) return decision
    if ((session.header?.delegationDepth ?? 0) > 0) return decision
    const previous = seen.get(session) ?? { turn: undefined, count: 0, last: undefined }
    if (previous.turn !== turn) {
      previous.turn = turn
      previous.count += 1
      seen.set(session, previous)
    }
    if (!reviewDue({ every, count: previous.count, last: previous.last })) return decision
    if (signal?.aborted === true) return decision
    if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision
    let skills = 0
    try {
      skills = await count()
    } catch {
      skills = 0
    }
    previous.last = previous.count
    const text = skillNudgeText({ turn: previous.count, every, skills })
    return { ...decision, messages: [...decision.messages, skillNudgeMessage(text)] }
  })
  return true
}

/**
 * Register the review on the agent's pre-step chain.
 *
 * The turn ordinal comes from the chain itself (one step-1 claim per turn), so
 * a session resumed at turn 137 starts its own count instead of firing on the
 * spot. Subagent sessions are skipped: they must not edit the parent's store.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ every: number, share: number, load: () => Promise<object[]> }} options - interval, usage share and the live store reader.
 * @returns {boolean} whether a listener was registered.
 */
export function installReview(ctx, { every, share, load }) {
  if (!Number.isSafeInteger(every) || every <= 0) return false
  const seen = new WeakMap()
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject') return decision
    const { agent, turn, step, signal } = payload ?? {}
    const session = agent?.session
    if (session === undefined) return decision
    // One notice per due turn, opened before the task: repeating it on every
    // later step buys tokens and buries the task the turn is actually for.
    if (step !== 1) return decision
    if ((session.header?.delegationDepth ?? 0) > 0) return decision
    const previous = seen.get(session) ?? { turn: undefined, count: 0, last: undefined }
    if (previous.turn !== turn) {
      previous.turn = turn
      previous.count += 1
      seen.set(session, previous)
    }
    if (!reviewDue({ every, count: previous.count, last: previous.last })) return decision
    if (signal?.aborted === true) return decision
    // A turn with nothing claimed is a wake with no input; injecting there
    // would buy a model call the session did not ask for.
    if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision
    let stores
    try {
      stores = await load()
    } catch {
      return decision
    }
    const pressures = reviewPressures(stores, share)
    if (pressures.length === 0) return decision
    previous.last = previous.count
    return {
      ...decision,
      messages: [...decision.messages, reviewMessage(reviewText({ pressures, turn: previous.count, every }))],
    }
  })
  return true
}
