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
import { readText, writeFileAtomic } from './fsx.mjs'
import { errorMessage } from './util.mjs'

/**
 * The reason a turn ended, from the real `turn/end` payload.
 *
 * dsh-session emits `data: { turn, reason: { kind } }` (repair.js does the same),
 * so reading `data.kind` silently matched nothing and every turn returned before
 * the pass ran. The flat shape is still accepted for older/other emitters.
 * @param {{ data?: object }} event - session event.
 * @returns {string | undefined} reason kind.
 */
export function turnEndReason(event) {
  const data = event?.data
  if (data === null || typeof data !== 'object') return undefined
  const nested = data.reason?.kind
  return typeof nested === 'string' ? nested : (typeof data.kind === 'string' ? data.kind : undefined)
}

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
  return parsePlanDetail(text).plan
}

/**
 * Parse the answer, keeping why it failed. Gateways differ: some wrap the plan
 * in a fence, some drop the tag entirely, some answer prose — reading only one
 * exact shape turns a working model into a permanent `invalid_plan`.
 * @param {string} text - model answer.
 * @returns {{ plan: object } | { plan?: undefined, malformed: 'no_tag' | 'bad_json' | 'bad_shape', snippet: string }} result.
 */
export function parsePlanDetail(text) {
  const raw = String(text ?? '')
  const candidates = []
  const tagged = [...raw.matchAll(PLAN_TAG)].pop()
  if (tagged !== undefined) candidates.push(tagged[1])
  for (const fence of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(fence[1])
  const bare = raw.match(/\{[\s\S]*"operations"[\s\S]*\}/)
  if (bare !== null) candidates.push(bare[0])
  const snippet = raw.trim().slice(0, 160)
  if (candidates.length === 0) return { malformed: 'no_tag', snippet }
  let sawJson = false
  for (const candidate of candidates) {
    let value
    try {
      value = JSON.parse(candidate.trim())
    } catch {
      continue
    }
    sawJson = true
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.operations)) continue
    return { plan: value }
  }
  return { malformed: sawJson ? 'bad_shape' : 'bad_json', snippet }
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
async function runBackgroundReviewOnce(rt, { session, transcript, current, llm, route, signal }) {
  const started = Date.now()
  const outcome = { applied: [], skipped: [] }
  try {
    if (llm === undefined || typeof llm.stream !== 'function') return report(outcome, 'no_llm', started)
    if (route === undefined) return report(outcome, 'no_model', started)
    const text = await transcript(session)
    if (text.trim().length === 0) return report(outcome, 'empty_transcript', started)
    const state = await current()
    const instruction = backgroundInstruction(text, state)
    const first = await callModel(llm, route, instruction, rt.config.backgroundTimeoutMs ?? 30000, signal, session?.id)
    let parsed = parsePlanDetail(first.text)
    if (parsed.plan === undefined) {
      // One strict retry: cheaper than losing the turn, and it tells us whether
      // the model can follow the format at all.
      const stricter = `${instruction}\n\nYour previous answer could not be read (${parsed.malformed}). Answer again with ONLY <plan>{...}</plan> — no prose, no code fence.`
      const second = await callModel(llm, route, stricter, rt.config.backgroundTimeoutMs ?? 30000, signal, session?.id)
      const retried = parsePlanDetail(second.text)
      if (retried.plan === undefined) {
        return report(outcome, 'invalid_plan', started, { malformed: retried.malformed, snippet: retried.snippet })
      }
      parsed = retried
    }
    const plan = parsed.plan
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
function report(outcome, error, started, detail) {
  return {
    ...outcome,
    duration_ms: Date.now() - started,
    ...(error === undefined ? {} : { error }),
    ...(detail === undefined ? {} : { detail }),
  }
}

/**
 * Run one pass and persist its verdict, so `health` can show that the pass runs
 * at all. A pass that never fires used to be indistinguishable from one that
 * found nothing to save — that is how a wrong payload shape stayed hidden.
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @param {object} input - pass input.
 * @returns {Promise<object>} outcome with `applied`, `skipped` and `duration_ms`.
 */
export async function runBackgroundReview(rt, input) {
  const outcome = await runBackgroundReviewOnce(rt, input)
  const applied = Array.isArray(outcome.applied) ? outcome.applied.length : 0
  const skipped = Array.isArray(outcome.skipped) ? outcome.skipped.length : 0
  const status = {
    at: new Date().toISOString(),
    applied,
    skipped,
    duration_ms: outcome.duration_ms,
    // `result` is the pass verdict, not a fault report: 'no_operations' means the
    // model had nothing worth saving, which is the common, healthy outcome.
    result: outcome.error ?? (applied === 0 ? 'no_changes' : 'applied'),
  }
  await writeFileAtomic(backgroundStatusPath(rt), `${JSON.stringify(status, null, 2)}\n`).catch(() => {})
  return outcome
}

/**
 * Where the last pass's verdict is kept, so health can show that the pass runs
 * at all — a pass that silently never fires is indistinguishable from one that
 * found nothing to save.
 * @param {{ paths: object }} rt - plugin runtime.
 * @returns {string} path.
 */
export function backgroundStatusPath(rt) {
  return path.join(rt.paths.dataDir, 'background-last.json')
}

/**
 * Read the last pass verdict.
 * @param {{ paths: object }} rt - plugin runtime.
 * @returns {Promise<object | undefined>} verdict.
 */
export async function readBackgroundStatus(rt) {
  const raw = await readText(backgroundStatusPath(rt)).catch(() => undefined)
  if (raw === undefined) return undefined
  try {
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
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
  try {
    return await streamOnce(llm, route, instruction, timeoutMs, signal, sessionId, 'low')
  } catch (error) {
    // Some routes (a plain gateway model, for one) reject any reasoning effort.
    // Retrying without the field is cheaper than failing the whole pass.
    if (!/UNSUPPORTED_REASONING_EFFORT/i.test(String(error?.message ?? error))) throw error
    return await streamOnce(llm, route, instruction, timeoutMs, signal, sessionId, undefined)
  }
}

/**
 * One model call, optionally with a reasoning effort.
 * @param {object} llm - host LLM service.
 * @param {{ provider: string, model: string }} route - route.
 * @param {string} instruction - prompt.
 * @param {number} timeoutMs - time budget.
 * @param {AbortSignal} [signal] - cancellation.
 * @param {string | undefined} sessionId - session tag.
 * @param {string | undefined} effort - reasoning effort, or undefined to omit it.
 * @returns {Promise<{ text: string }>} the answer.
 */
async function streamOnce(llm, route, instruction, timeoutMs, signal, sessionId, effort) {
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
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
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
