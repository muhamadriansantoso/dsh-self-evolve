// condense.mjs — automatic condensation of an over-budget entry store.
//
// When a batch would push MEMORY.md (or the user profile) past its char
// limit, the store is condensed first: the biggest entries are shortened one
// model call at a time until the store fits, each call seeing a single entry
// with its own concrete tokens quoted back and a size it must reach. Rewriting
// one entry at a time keeps the facts that a whole-store summary loses, and
// keeps every answer small enough for a weak model to follow.
//
// The calls run outside the store lock (they take seconds), and the output is
// written only when it passes every check: one tagged entry, smaller than the
// one given, and most of its concrete tokens still present. Any failure falls
// back to the plain over-budget rejection, so a bad condensation never
// reaches the file.
//
// This module knows nothing about the Harness: the caller passes the LLM
// stream, so tests drive it with recorded chunks.

import { charCount } from './entries.mjs'

/** What each entries store holds, for the instruction. */
const KINDS = {
  memory: 'memory notes (environment, conventions, tool quirks, lessons)',
  user: 'user profile (who the user is, role, preferences)',
}

/** One rewritten entry, as the instruction asks for it. */
const ENTRY_TAG = /<entry>([\s\S]*?)<\/entry>/g

/** Boundaries between tokens; path, URL, version and assignment characters stay inside a token. */
const TOKEN_BOUNDARY = /[\s,;:!?()[\]{}<>"'“”‘’«»|]+/

/** Share of the concrete tokens a condensation must keep. */
export const MIN_ANCHOR_RETENTION = 0.75

/** Most of one entry a single call asks for, so a cut spreads over several entries. */
const PER_CALL_SHARE = 0.1

/** Most of one entry any single call may ask to cut, even when the store is far over. */
const MAX_ENTRY_CUT = 0.4

/** Model calls one condensation may spend, and content failures before giving up. */
const MAX_CALLS = 10
const MAX_CONTENT_FAILURES = 2

/** A rewrite may not lose more than three times the cut it was asked for, nor a fifth of the entry. */
const MAX_CUT_FACTOR = 3
const MIN_KEEP_SHARE = 0.8

/** Anchors quoted back to the model: how many, and how long the list may be. */
const ANCHOR_HINT_COUNT = 40
const ANCHOR_HINT_CHARS = 600

/** Stream failures that will not improve by trying another entry. */
const SYSTEMIC = /^(aborted|timeout|llm|max_tokens|finish:)/

/**
 * The instruction that shortens one entry.
 * @param {{ kind?: string, entry: string, size: number, goal: number, need: number }} input
 *   - store kind, the entry as it is, its size, the size to reach and how much
 *   the whole store must lose.
 * @returns {string} the complete instruction.
 */
export function condenseInstruction({ kind = 'memory', entry, size, goal, need }) {
  const keep = []
  let quoted = 0
  for (const anchor of anchorsOf([entry])) {
    if (keep.length >= ANCHOR_HINT_COUNT || quoted + anchor.length > ANCHOR_HINT_CHARS) break
    keep.push(anchor)
    quoted += anchor.length + 2
  }
  const hint = keep.length === 0 ? '' : `\n\nThese must all still appear in your answer: ${keep.join(', ')}.`
  return [
    `You are shortening one entry of the persistent store an AI agent re-reads at the start of every session:`
    + ` ${KINDS[kind] ?? KINDS.memory}.`,
    `The store is over its limit: it has to lose ${need} characters in all. This entry is ${size} characters; the answer`
    + ` must be at most ${goal} characters, at least ${size - goal} shorter. An answer that is not shorter is wrong.`,
    '',
    'The entry:',
    '',
    entry,
    '',
    'Rules:',
    '1. Answer with one <entry>…</entry> block and nothing else.',
    '2. Delete before you reword: drop history, examples, evidence and test logs, dates, duplicated statements and asides a'
    + ' future session can rediscover. Then tighten the wording. Keep the decisions, ports, paths, commands, versions and'
    + ' identifiers.',
    '3. Copy paths, hostnames, URLs, ports, commands, flags, versions, identifiers, keys, numbers, dates and quoted strings'
    + ' verbatim — never translate, shorten or round them.',
    "4. Keep the entry's own language (Indonesian and English mixed is normal) and its shape: a short note stays a short note.",
    '5. Add nothing: no new facts, no advice, no explanation before or after the block.',
  ].join('\n') + hint
}

/**
 * The entries of a model answer, in order.
 * @param {string} text - model output.
 * @returns {string[]} unique non-empty entries; empty when the answer used no tags.
 */
export function parseCondensed(text) {
  const entries = []
  for (const match of String(text ?? '').matchAll(ENTRY_TAG)) {
    const entry = match[1].trim()
    if (entry.length > 0 && !entries.includes(entry)) entries.push(entry)
  }
  return entries
}

/**
 * Whether a token names something concrete that a summary tends to lose: a
 * path, address or reference; a file or host name; a number; or a longer
 * identifier carrying several digits (a version, a hash). A word with a
 * single digit in it (`gateway`) is not counted on its own.
 * @param {string} token - one token.
 * @returns {boolean} true for an anchor.
 */
function isAnchor(token) {
  if (/[\/@#]/.test(token) || /\.[a-z]{2,9}$/i.test(token)) return true
  if (/^\d[\d.,:+_-]*$/.test(token)) return true
  return token.length >= 4 && (token.match(/\d/g) ?? []).length >= 2
}

/**
 * The concrete tokens of an entry list.
 * @param {string[]} entries - entries.
 * @returns {Set<string>} lowercase anchors.
 */
function anchorsOf(entries) {
  const found = new Set()
  for (const token of entries.join('\n').split(TOKEN_BOUNDARY)) {
    const cleaned = token.replace(/^\.+|\.+$/g, '')
    if (isAnchor(cleaned)) found.add(cleaned.toLowerCase())
  }
  return found
}

/**
 * How much of the concrete content survived a condensation.
 * @param {string[]} before - entries given to the model.
 * @param {string[]} after - entries returned.
 * @returns {{ ratio: number, dropped: string[] }} kept share (1 when the
 *   input names nothing concrete) and the anchors that vanished.
 */
export function anchorRetention(before, after) {
  const wanted = anchorsOf(before)
  const kept = anchorsOf(after)
  const dropped = []
  for (const anchor of wanted) {
    if (!kept.has(anchor)) dropped.push(anchor)
  }
  return { ratio: wanted.size === 0 ? 1 : (wanted.size - dropped.length) / wanted.size, dropped }
}

/**
 * Pick the model of a condensation: the pinned route when the profile sets
 * one, else the route the calling session's requests go to, else the agent's
 * own. A route counts only when it names both a provider and a model.
 * @param {{ pinned?: object, routed?: object, own?: object }} sources - route
 *   candidates, each `{ provider?, model? }`, most specific first.
 * @returns {{ provider: string, model: string } | undefined} the route.
 */
export function condenseRoute({ pinned, routed, own }) {
  const pair = source => {
    const provider = textOf(source?.provider)
    const model = textOf(source?.model)
    return provider === undefined || model === undefined ? undefined : { provider, model }
  }
  return pair(pinned) ?? pair(routed) ?? pair(own)
}

/**
 * Run one condensation through the host LLM service: one user message per
 * entry at the model's least reasoning effort, tagged with the session so the
 * request is accounted to it.
 * @param {{ resolveModelInfo: Function, stream: Function }} llm - the LLM service.
 * @param {object} input - what `condenseEntries` takes.
 * @param {{ provider: string, model: string, sessionId?: string }} route - the
 *   model route and the calling session.
 * @returns {Promise<object>} `condenseEntries`' outcome, extended by
 *   `provider` and `model` (in its report on success, beside the error otherwise).
 */
export async function condenseWithLlm(llm, input, route) {
  let effort
  try {
    // Least effort: shortening a passage is rewriting, not reasoning, and a
    // route may default to a slow maximum.
    effort = (await llm.resolveModelInfo(route.provider, route.model, input.signal))?.reasoning?.efforts?.[0]?.id
  } catch {
    // Without model metadata the call runs at the adapter's default effort.
  }
  const reasoningEffort = typeof effort === 'string' ? effort : undefined
  const outcome = await condenseEntries({
    ...input,
    stream: (signal, instruction) => llm.stream({
      provider: route.provider,
      model: route.model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      messages: [{ role: 'user', content: [{ type: 'text', text: instruction }] }],
      ...(typeof route.sessionId === 'string' ? { sessionId: route.sessionId } : {}),
      signal,
    }),
  })
  const named = { provider: route.provider, model: route.model }
  return outcome.ok === true
    ? {
      ...outcome,
      report: { ...named, ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }), ...outcome.report },
    }
    : { ...named, ...outcome }
}

/**
 * Turn one LLM stream into its text.
 * @param {AsyncIterable<object>} chunks - the adapter's chunk protocol.
 * @returns {Promise<{ text: string, finish?: string, failure?: { code: string, message: string }, usage?: object }>}
 *   the text blocks in order, the finish kind and the terminal failure.
 */
export async function readStream(chunks) {
  const types = new Map()
  const deltas = new Map()
  const assembled = new Map()
  let finish
  let failure
  let usage
  for await (const chunk of chunks) {
    if (chunk.type === 'block-start') types.set(chunk.index, chunk.blockType)
    else if (chunk.type === 'text-delta') deltas.set(chunk.index, (deltas.get(chunk.index) ?? '') + chunk.text)
    else if (chunk.type === 'block-end' && chunk.block?.type === 'text') assembled.set(chunk.index, chunk.block.text)
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') {
      finish = chunk.reason?.kind
      if (chunk.reason?.failure !== undefined) failure = chunk.reason.failure
    }
  }
  // A block contributes when it is declared text, or when no block-start
  // declared it and only text deltas or a text block arrived for it.
  const indexes = [...new Set([...types.keys(), ...deltas.keys(), ...assembled.keys()])]
    .filter(index => types.get(index) === 'text' || !types.has(index))
    .sort((a, b) => a - b)
  return {
    text: indexes.map(index => assembled.get(index) ?? deltas.get(index) ?? '').join(''),
    ...(finish === undefined ? {} : { finish }),
    ...(failure === undefined ? {} : { failure }),
    ...(usage === undefined ? {} : { usage }),
  }
}

/**
 * One model call: send the instruction, read the stream, keep the text.
 * @param {{ stream: Function, instruction: string, timeoutMs: number, signal?: AbortSignal }} input
 *   - the stream factory, the instruction, the call's time budget and the
 *   caller's cancellation.
 * @returns {Promise<object>} `{ ok: true, text, finish, usage?, duration_ms }` or
 *   `{ ok: false, error, message?, duration_ms }`.
 */
async function runOnce({ stream, instruction, timeoutMs, signal }) {
  const started = Date.now()
  const controller = new AbortController()
  let halt
  const halted = new Promise(resolve => {
    halt = resolve
  })
  let reason = 'aborted'
  const abort = (why, cause) => {
    reason = why
    const error = cause instanceof Error ? cause : new Error(`condensation ${why}`)
    controller.abort(error)
    halt(error)
  }
  const onAbort = () => abort('aborted', signal.reason)
  if (signal?.aborted) abort('aborted', signal.reason)
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timer = timeoutMs > 0 ? setTimeout(() => abort('timeout'), timeoutMs) : undefined
  timer?.unref?.()

  const settled = readStream(stream(controller.signal, instruction)).then(value => ({ value }), error => ({ error }))
  const outcome = await Promise.race([settled, halted])
  clearTimeout(timer)
  signal?.removeEventListener('abort', onAbort)
  const duration = Date.now() - started
  // `abort()` settles the race first, so an Error here is the caller's
  // cancellation or the time budget; anything else is the stream's own crash.
  if (outcome instanceof Error) return { ok: false, error: reason, duration_ms: duration }
  if ('error' in outcome) {
    return {
      ok: false,
      error: signal?.aborted ? 'aborted' : 'llm',
      message: String(outcome.error?.message ?? outcome.error),
      duration_ms: duration,
    }
  }
  const read = outcome.value
  if (read.failure !== undefined) {
    return {
      ok: false,
      error: read.finish === 'aborted' ? 'aborted' : `llm:${read.failure.code ?? 'error'}`,
      message: read.failure.message,
      duration_ms: duration,
    }
  }
  if (read.finish !== 'stop') {
    return {
      ok: false,
      error: read.finish === 'max-tokens' ? 'max_tokens' : `finish:${String(read.finish)}`,
      duration_ms: duration,
    }
  }
  return {
    ok: true,
    text: read.text,
    ...(read.usage === undefined ? {} : { usage: read.usage }),
    duration_ms: duration,
  }
}

/**
 * Sum two token usages, key by key.
 * @param {object | undefined} total - accumulated usage.
 * @param {object} usage - the next call's usage.
 * @returns {object} the sum.
 */
function addUsage(total, usage) {
  if (total === undefined) return { ...usage }
  const sum = { ...total }
  for (const [key, value] of Object.entries(usage)) {
    sum[key] = typeof value === 'number' && typeof sum[key] === 'number' ? sum[key] + value : value
  }
  return sum
}

/**
 * Condense one entry list until it fits `target`, one entry per model call.
 * @param {object} input
 * @param {(signal: AbortSignal, instruction: string) => AsyncIterable<object>} input.stream -
 *   produces the LLM stream answering one instruction, for a signal.
 * @param {string[]} input.entries - the store as it is now.
 * @param {string} [input.kind] - store kind, `memory` or `user`.
 * @param {number} input.target - size in characters the store must fit in.
 * @param {number} [input.timeoutMs] - time budget for the whole condensation; 0 disables it.
 * @param {AbortSignal} [input.signal] - the caller's cancellation.
 * @returns {Promise<object>} `{ ok: true, entries, instruction, report }` or
 *   `{ ok: false, error, duration_ms }`; nothing here touches disk.
 */
export async function condenseEntries({ stream, entries, kind = 'memory', target, timeoutMs = 120000, signal }) {
  const started = Date.now()
  const before = { entries: entries.length, chars: charCount(entries) }
  const list = [...entries]
  const trims = []
  const used = new Set()
  let usage
  let calls = 0
  let contentFailures = 0
  let failure
  let systemic = false
  let instruction
  const deadline = timeoutMs > 0 ? started + timeoutMs : undefined

  while (calls < MAX_CALLS && contentFailures < MAX_CONTENT_FAILURES) {
    const total = charCount(list)
    const need = total - target
    if (need <= 0) break
    const candidate = list
      .map((entry, index) => ({ index, size: charCount([entry]) }))
      .filter(item => !used.has(item.index) && Math.min(need, Math.floor(item.size * MAX_ENTRY_CUT)) >= 1)
      .sort((a, b) => b.size - a.size)[0]
    if (candidate === undefined) break
    const size = candidate.size
    const cut = Math.min(need, Math.floor(size * MAX_ENTRY_CUT), Math.max(1, Math.ceil(size * PER_CALL_SHARE)))
    const goal = size - cut
    const prompt = condenseInstruction({ kind, entry: list[candidate.index], size, goal, need })
    instruction ??= prompt
    const budget = deadline === undefined ? timeoutMs : Math.max(1, deadline - Date.now())
    const outcome = await runOnce({ stream, instruction: prompt, timeoutMs: budget, signal })
    calls += 1
    if (outcome.ok !== true) {
      failure ??= outcome
      // A stream failure will not improve on another entry; a content failure
      // gets one more entry before the attempt is given up.
      if (SYSTEMIC.test(outcome.error)) {
        systemic = true
        break
      }
      contentFailures += 1
      used.add(candidate.index)
      continue
    }
    if (outcome.usage !== undefined) usage = addUsage(usage, outcome.usage)
    const trimmed = parseCondensed(outcome.text)
    const next = trimmed.length === 1 ? trimmed[0] : undefined
    const kept = next === undefined ? undefined : charCount([next])
    const retention = next === undefined ? { ratio: 0, dropped: [] } : anchorRetention([list[candidate.index]], [next])
    const error = next === undefined
      ? (trimmed.length === 0 ? 'no_entries' : 'many_entries')
      : kept >= size
        ? 'no_reduction'
        : kept < size - Math.max(MAX_CUT_FACTOR * cut, Math.ceil(size * (1 - MIN_KEEP_SHARE)))
          ? 'over_cut'
          : retention.ratio < MIN_ANCHOR_RETENTION ? 'low_anchor_retention' : undefined
    if (error !== undefined) {
      failure ??= {
        ok: false,
        error,
        duration_ms: Date.now() - started,
        target_chars: target,
        ...(kept === undefined ? {} : { after: kept }),
        ...(error === 'low_anchor_retention'
          ? { anchor_retention: Math.round(retention.ratio * 100) / 100, dropped_anchors: retention.dropped.length }
          : {}),
      }
      contentFailures += 1
      used.add(candidate.index)
      continue
    }
    list[candidate.index] = next
    used.add(candidate.index)
    trims.push({ before: size, after: kept })
  }

  const after = { entries: list.length, chars: charCount(list) }
  const duration = Date.now() - started
  const report = {
    before,
    after,
    target_chars: target,
    duration_ms: duration,
    calls,
    trims,
  }
  if (systemic && failure !== undefined) return { ...failure, ok: false, target_chars: target, duration_ms: duration, calls }
  if (after.chars > target) {
    if (trims.length === 0 && failure !== undefined) return { ...failure, ok: false, target_chars: target, duration_ms: duration, calls }
    return {
      ok: false,
      error: 'not_enough',
      ...(failure === undefined ? {} : { cause: failure.error }),
      duration_ms: duration,
      target_chars: target,
      before: before.chars,
      after: after.chars,
      need: after.chars - target,
      calls,
    }
  }
  if (trims.length === 0) {
    // Nothing had to shrink: the store already fits the room the batch needs.
    if (failure === undefined) {
      return { ok: true, entries: list, instruction: '', report: { ...report, anchor_retention: 1, dropped_anchors: 0 } }
    }
    return { ...failure, ok: false, target_chars: target, duration_ms: duration, calls }
  }
  const { ratio, dropped } = anchorRetention(entries, list)
  return {
    ok: true,
    entries: list,
    instruction: instruction ?? '',
    report: {
      ...report,
      anchor_retention: Math.round(ratio * 100) / 100,
      dropped_anchors: dropped.length,
      ...(usage === undefined ? {} : { usage }),
    },
  }
}

/**
 * A non-empty string, or undefined for anything else.
 * @param {unknown} value - candidate.
 * @returns {string | undefined} the string.
 */
function textOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
