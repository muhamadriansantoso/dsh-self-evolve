// background.mjs — the post-turn self-evolution pass.
//
// Hermes forks a background reviewer after a turn and asks it whether anything
// durable belongs in memory or a skill. DSH has no second agent slot, so the
// same pass runs as the turn ends: it derives the finished turn's messages,
// asks the host LLM for a *small JSON operations list*, validates that list
// like a tool call, and applies it through the same write paths (`runMemory`,
// `runSkillOps`). A pass that wrote something queues one human-facing line
// (notice.mjs), delivered at the first step of the next turn; a failed call, an
// unparseable answer or a rejected operation changes nothing.
//
// Safety rules are deliberately narrow: memory `add`/`patch` and skill
// `create`/`edit` only — never a delete, never persona/soul/user, never a
// wake, never a transcript edit.

import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { condenseRoute, readStream } from './condense.mjs'
import { splitFrontmatter } from './frontmatter.mjs'
import { isSkillName, SKILL_NAME } from './names.mjs'
import { runMemory } from './memorytool.mjs'
import { runSkillOps, skillRoots } from './skills.mjs'
import { describeApplied, queueNotice } from './notice.mjs'
import { errorMessage } from './util.mjs'

/** Actions the background pass may propose. */
const ALLOWED_ACTIONS = new Set(['add', 'patch', 'create', 'edit'])

/** One JSON block, as the instruction asks for it. */
const PLAN_TAG = /<plan>([\s\S]*?)<\/plan>/g

/** How many operations one pass may propose, and how long one may be. */
const MAX_OPERATIONS = 5
const MAX_MEMORY_TEXT_CHARS = 1200
const MAX_SKILL_TEXT_CHARS = 8000

/** Characters of transcript the model sees, counting from the end. */
const TRANSCRIPT_CHARS = 12000

/**
 * The instruction for one turn.
 * @param {string} transcript - the turn's model-visible messages.
 * @param {{ memory: string, skills: string }} current - current durable state.
 * @returns {string} complete user prompt.
 */
export function backgroundInstruction(transcript, current) {
  return [
    'You are reviewing one finished agent turn for durable learning. Save only facts or procedures a future session needs.',
    '',
    'Rules:',
    '1. Answer with one <plan>…</plan> JSON object and nothing else.',
    '2. The object is {"operations":[...]}, with at most five operations. Use "add" or "patch" for memory, and "create" or "edit" for a skill.',
    '3. Never delete, remove, archive, rewrite persona/soul/user, or touch a protected installation path.',
    '4. A memory add is a durable environment fact or convention. A patch must copy old_text verbatim from CURRENT MEMORY. A skill create/edit carries the complete new SKILL.md text, frontmatter included.',
    '5. If nothing is durable, answer {"operations":[]}. Do not summarize the conversation.',
    '6. Copy paths, ports, hostnames, versions, commands, IDs and numbers verbatim.',
    '',
    'CURRENT MEMORY:',
    current.memory,
    '',
    'CURRENT SKILLS (names only):',
    current.skills,
    '',
    'TURN:',
    transcript,
  ].join('\n')
}

/**
 * Read the JSON plan from a model answer.
 * @param {string} text - model output.
 * @returns {{ operations: unknown[] } | undefined} the parsed object.
 */
export function parsePlan(text) {
  const match = [...String(text ?? '').matchAll(PLAN_TAG)].pop()
  if (match === undefined) return undefined
  let value
  try {
    value = JSON.parse(match[1])
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.operations)) return undefined
  return value
}

/**
 * Keep only operations with the narrow shape the write paths accept.
 * @param {unknown[]} operations - candidate operations.
 * @returns {Array<{ action: string, name?: string, content?: string, old_text?: string }>}
 */
export function sanitizeOperations(operations) {
  if (!Array.isArray(operations)) return []
  return operations.slice(0, MAX_OPERATIONS).flatMap(op => {
    if (op === null || typeof op !== 'object') return []
    const action = typeof op.action === 'string' ? op.action : ''
    if (!ALLOWED_ACTIONS.has(action)) return []
    const text = value => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined)
    const content = text(op.content)
    if (action === 'add' || action === 'patch') {
      const oldText = action === 'patch' ? text(op.old_text) : undefined
      if (content === undefined || (action === 'patch' && oldText === undefined)) return []
      if (content.length > MAX_MEMORY_TEXT_CHARS || (oldText ?? '').length > MAX_MEMORY_TEXT_CHARS) return []
      return [{ action, ...(oldText === undefined ? {} : { old_text: oldText }), content }]
    }
    const name = text(op.name)
    if (name === undefined || !isSkillName(name)) return []
    if (content === undefined || content.length > MAX_SKILL_TEXT_CHARS) return []
    // A skill write must be discoverable as this very skill, or the batch
    // would fail inside runSkillOps anyway; refuse it here instead.
    const frontmatter = splitFrontmatter(content)
    if (!frontmatter.has || frontmatter.data.name !== name) return []
    return [{ action, name, content }]
  })
}

/**
 * Run one background review; every failure is a report, never a write.
 * @param {{ paths: object, config: Record<string, any>, limits: object }} rt - plugin runtime.
 * @param {object} input
 * @param {any} input.session - the live session whose turn ended.
 * @param {(session: any) => Promise<string>} input.transcript - derive the turn's messages.
 * @param {() => Promise<{ memory: string, skills: string }>} input.current - durable state for the prompt.
 * @param {object} input.llm - host LLM service.
 * @param {{ provider: string, model: string }} input.route - model route.
 * @param {AbortSignal} [input.signal] - cancellation.
 * @returns {Promise<object>} outcome with `applied`, `skipped` and `duration_ms`.
 */
export async function runBackgroundReview(rt, { session, transcript, current, llm, route, signal }) {
  const started = Date.now()
  const outcome = { applied: [], skipped: [] }
  try {
    if (llm === undefined || typeof llm.stream !== 'function') return report(outcome, 'no_llm', started)
    if (route === undefined) return report(outcome, 'no_model', started)
    const text = await transcript(session)
    if (text.trim().length === 0) return report(outcome, 'empty_transcript', started)
    const state = await current()
    const answer = await callModel(llm, route, backgroundInstruction(text, state), rt.config.backgroundTimeoutMs ?? 30000, signal, session?.id)
    const plan = parsePlan(answer.text)
    if (plan === undefined) return report(outcome, 'invalid_plan', started)
    const operations = sanitizeOperations(plan.operations)
    if (operations.length === 0) return report(outcome, 'no_operations', started)

    const memoryOps = operations.filter(op => op.action === 'add' || op.action === 'patch')
    const skillOps = operations.filter(op => op.action === 'create' || op.action === 'edit')
    if (memoryOps.length > 0) {
      const result = await runMemory(rt, { target: 'memory', operations: memoryOps, signal, exec: { agent: { session } } })
      outcome[memorySuccess(result) ? 'applied' : 'skipped'].push({ target: 'memory', result })
    }
    if (skillOps.length > 0) {
      const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : process.cwd()
      const result = await runSkillOps(rt, { ops: skillOps, session: { cwd, known: typeof session?.header?.cwd === 'string' }, signal })
      outcome[result.success === true ? 'applied' : 'skipped'].push({ target: 'skills', result })
    }
    const lines = describeApplied(outcome.applied, rt.config.notificationMode ?? 'on')
    for (const line of lines) await queueNotice(rt, line)
    return report(outcome, undefined, started)
  } catch (error) {
    return report(outcome, errorMessage(error), started)
  }
}

/**
 * Finish one pass with its duration and normalized reason.
 * @param {object} outcome - collected result.
 * @param {string | undefined} error - failure reason.
 * @param {number} started - start timestamp.
 * @returns {object} JSON-safe report.
 */
function report(outcome, error, started) {
  return { ...outcome, duration_ms: Date.now() - started, ...(error === undefined ? {} : { error }) }
}

/**
 * Whether a memory write succeeded.
 * @param {object} result - runMemory result.
 * @returns {boolean} success.
 */
function memorySuccess(result) {
  return result?.success === true
}

/**
 * Make the one model call at the route's least reasoning effort, inside a
 * budget, and keep only a clean stop.
 * @param {object} llm - host LLM service.
 * @param {{ provider: string, model: string }} route - model route.
 * @param {string} instruction - prompt.
 * @param {number} timeoutMs - time budget.
 * @param {AbortSignal} [signal] - cancellation.
 * @param {string | undefined} sessionId - the session the call is tagged with.
 * @returns {Promise<{ text: string }>} the answer.
 */
async function callModel(llm, route, instruction, timeoutMs, signal, sessionId) {
  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason ?? new Error('background review aborted'))
  if (signal?.aborted === true) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('background review timeout')), timeoutMs)
  timer.unref?.()
  try {
    const chunks = llm.stream({
      provider: route.provider,
      model: route.model,
      reasoningEffort: 'low',
      messages: [{ role: 'user', content: [{ type: 'text', text: instruction }] }],
      ...(typeof sessionId === 'string' ? { sessionId } : {}),
      signal: controller.signal,
    })
    const read = await readStream(chunks)
    if (read.failure !== undefined || read.finish !== 'stop') {
      throw failPlan(read)
    }
    return { text: read.text }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

/**
 * The error a non-stopping stream raises.
 * @param {{ finish?: string, failure?: object }} read - stream outcome.
 * @returns {Error} the error.
 */
function failPlan(read) {
  const reason = read.failure !== undefined ? String(read.failure.code ?? read.failure.message ?? 'llm') : String(read.finish ?? 'stop')
  const error = new Error(`background review ${reason}`)
  error.code = 'BACKGROUND_STREAM'
  return error
}

/**
 * The model route: the pinned one, else the session's own.
 * @param {Record<string, any>} config - plugin config.
 * @param {any} session - live session.
 * @returns {{ provider: string, model: string } | undefined} route.
 */
export function backgroundRoute(config, session) {
  return condenseRoute({
    pinned: { provider: config.backgroundProvider, model: config.backgroundModel },
    routed: session?.requestHeader?.()?.config,
  })
}

/**
 * A bounded transcript: the session's derived messages as text. When the whole
 * history is too long, the END survives — the finished turn is the part the
 * review is about — with a marker that the head was dropped.
 * @param {any} session - live session.
 * @returns {Promise<string>} excerpt, or '' when there is nothing to review.
 */
export async function turnTranscript(session) {
  const messages = session?.deriveMessages?.() ?? []
  const parts = []
  for (const message of messages) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue
    const text = message.content?.map(block => (typeof block?.text === 'string' ? block.text : '')).join('') ?? ''
    if (text.trim().length === 0) continue
    parts.push(`${message.role === 'user' ? 'User' : 'Agent'}: ${text.trim()}`)
  }
  const joined = parts.join('\n\n')
  if (joined.length <= TRANSCRIPT_CHARS) return joined
  return `…${joined.slice(joined.length - TRANSCRIPT_CHARS + 1)}`
}

/**
 * The skill names the prompt lists, from every root this session scans.
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @param {string} cwd - session working directory.
 * @returns {Promise<string>} one name per line, or a placeholder.
 */
export async function skillNames(rt, cwd) {
  const roots = await skillRoots(rt.paths, rt.config, cwd)
  const names = new Set()
  for (const root of roots) {
    let entries
    try {
      entries = await readdir(root.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKILL_NAME.test(entry.name) && await isSkill(path.join(root.path, entry.name))) names.add(entry.name)
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'SKILL.md') {
        const name = entry.name.slice(0, -'.md'.length)
        if (SKILL_NAME.test(name)) names.add(name)
      }
    }
  }
  return names.size === 0 ? '(none yet)' : [...names].sort().join('\n')
}

/**
 * Whether a directory holds a discoverable SKILL.md.
 * @param {string} dir - skill directory.
 * @returns {Promise<boolean>} discovery.
 */
async function isSkill(dir) {
  try {
    const info = await stat(path.join(dir, 'SKILL.md'))
    return info.isFile()
  } catch {
    return false
  }
}
