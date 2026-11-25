// curator.mjs — stale-entry archiving for the entry stores, Hermes'
// curator.py reduced to its safe half: it never deletes, it only moves an
// entry out of the active store into a dated archive file.
//
// Lite means deterministic and local: no model call, no consolidation pass.
// An entry is a candidate when its TEXT has not changed for `curatorStaleDays`
// (14) and it is not pinned; `curatorDeepDays` (30) sends it to the deep
// archive instead. Pins live in a state file beside the history, keyed by the
// entry text, so a `pin` outlives the run that set it.
//
// Archiving is tied to pressure: unless `curatorTriggerShare` is reached the
// pass only refreshes the state file and reports `below_share`, so a small,
// deliberately curated store is never touched. `memory` action `curate`
// forces the pass regardless.

import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { charCount, parseEntries, renderEntries } from './entries.mjs'
import { readText, withLock, writeFileAtomic } from './fsx.mjs'
import { saveHistory } from './history.mjs'
import { maybeMirror } from './hook.mjs'
import { resolveStores } from './stores.mjs'
import { describeLocation, readDocument, writeDocument } from './textstore.mjs'

/** Day in milliseconds. */
const DAY = 86400000

/**
 * Stable key for one entry: its exact text.
 * @param {string} text - entry text.
 * @returns {string} 16 hex chars.
 */
export function entryKey(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/**
 * Empty curator state.
 * @returns {{ version: number, entries: Record<string, { first: string, seen: string, pinned?: true }> }} state.
 */
export function emptyState() {
  return { version: 1, entries: {} }
}

/**
 * Read the curator state file, tolerating a missing or corrupt file.
 * @param {string} file - state path.
 * @returns {Promise<object>} state.
 */
export async function readState(file) {
  const raw = await readText(file).catch(() => undefined)
  if (raw === undefined) return emptyState()
  try {
    const value = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || typeof value.entries !== 'object' || value.entries === null) return emptyState()
    return { version: 1, entries: value.entries }
  } catch {
    return emptyState()
  }
}

/**
 * Write the state file atomically.
 * @param {string} file - state path.
 * @param {object} state - state.
 * @returns {Promise<void>} completion.
 */
export async function saveState(file, state) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * Bring the state in line with the store: an entry whose text is unchanged
 * keeps the timestamp it already had, a new text starts today, and keys that
 * no longer exist are dropped.
 * @param {object} state - previous state.
 * @param {string[]} entries - current store entries.
 * @param {number} now - timestamp.
 * @returns {object} new state (input untouched).
 */
export function syncState(state, entries, now) {
  const stamp = new Date(now).toISOString()
  const next = {}
  for (const text of entries) {
    const key = entryKey(text)
    const previous = state.entries?.[key]
    next[key] = previous === undefined
      ? { first: stamp, seen: stamp }
      : { first: previous.first ?? stamp, seen: previous.seen ?? stamp, ...(previous.pinned === true ? { pinned: true } : {}) }
  }
  return { version: 1, entries: next }
}

/**
 * Split the store by age and pins.
 * @param {{ entries: Record<string, object> }} state - synced state.
 * @param {string[]} entries - store entries.
 * @param {{ now: number, staleDays: number, deepDays: number }} options - thresholds.
 * @returns {{ fresh: string[], stale: Array<{ text: string, age: number }>, deep: Array<{ text: string, age: number }>, pinned: string[], unknown: string[] }} buckets.
 */
export function buckets(state, entries, { now, staleDays, deepDays }) {
  const fresh = []
  const stale = []
  const deep = []
  const pinned = []
  const unknown = []
  for (const text of entries) {
    const record = state.entries?.[entryKey(text)]
    if (record === undefined) {
      unknown.push(text)
      continue
    }
    if (record.pinned === true) {
      pinned.push(text)
      continue
    }
    const seen = Date.parse(record.seen)
    const age = Number.isFinite(seen) ? now - seen : 0
    const days = age / DAY
    if (days >= deepDays) deep.push({ text, age: days })
    else if (days >= staleDays) stale.push({ text, age: days })
    else fresh.push(text)
  }
  return { fresh, stale, deep, pinned, unknown }
}

/**
 * The archive block for one run: dated heading plus one section per entry.
 * @param {string} target - store name.
 * @param {Array<{ text: string, age: number, deep?: boolean }>} items - archived entries.
 * @param {number} now - timestamp.
 * @returns {string} markdown to append.
 */
export function archiveBlock(target, items, now) {
  const date = new Date(now).toISOString()
  const lines = [`# ${target} — archived ${date}`, '']
  for (const item of items) {
    lines.push(`## ${item.deep === true ? 'deep ' : ''}stale ${Math.floor(item.age)}d · ${date}`)
    lines.push('')
    lines.push(item.text)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

/**
 * Run the curator on one store.
 * @param {{ paths: object, config: Record<string, any>, limits: object }} rt - plugin runtime.
 * @param {object} options - run options.
 * @param {string} options.target - store name (`memory` or `user`).
 * @param {number} [options.now] - timestamp, for tests.
 * @param {boolean} [options.force] - ignore the trigger share.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<object>} report.
 */
export async function runCurator(rt, { target = 'memory', now = Date.now(), force = false, signal } = {}) {
  const stores = await resolveStores(rt.paths, rt.limits)
  const store = stores[target]
  if (store === undefined || store.type !== 'entries') {
    return { success: false, error: `target '${target}' is not an entries store; the curator only archives entries.` }
  }
  const staleDays = rt.config.curatorStaleDays ?? 14
  const deepDays = rt.config.curatorDeepDays ?? 30
  const share = force ? 0 : (rt.config.curatorTriggerShare ?? 0.9)
  const statePath = curatorStatePath(rt, target)
  const archiveDir = path.join(rt.paths.dataDir, 'archive')

  return withLock(`curator:${store.locations[0].path}`, async () => {
    signal?.throwIfAborted()
    const document = await readDocument(store.locations)
    const entries = parseEntries(document.text)
    const state = syncState(await readState(statePath), entries, now)
    await saveState(statePath, state)
    const usageShare = store.charLimit > 0 ? charCount(entries) / store.charLimit : 0
    const report = {
      target,
      state: statePath,
      usage: { chars: charCount(entries), limit: store.charLimit, share: Number(usageShare.toFixed(3)) },
      stale_days: staleDays,
      deep_days: deepDays,
    }
    if (share > 0 && usageShare < share) {
      return { success: true, ...report, archived: 0, reason: 'below_share', threshold: share }
    }

    const split = buckets(state, entries, { now, staleDays, deepDays })
    const staleItems = split.stale.map(item => ({ ...item, deep: false }))
    const deepItems = split.deep.map(item => ({ ...item, deep: true }))
    if (staleItems.length === 0 && deepItems.length === 0) {
      return { success: true, ...report, archived: 0, reason: 'nothing_stale', pinned: split.pinned.length }
    }

    await mkdir(archiveDir, { recursive: true })
    const written = []
    for (const [kind, items] of [['', staleItems], ['-deep', deepItems]]) {
      if (items.length === 0) continue
      const file = path.join(archiveDir, `${target}${kind}-${new Date(now).toISOString().slice(0, 10)}.md`)
      await appendFile(file, archiveBlock(target, items, now), 'utf8')
      written.push(file)
    }

    const drop = new Set([...staleItems, ...deepItems].map(item => item.text))
    const kept = entries.filter(text => !drop.has(text))
    const text = renderEntries(kept)
    const history = await saveHistory(rt.paths.dataDir, store.history, document.text, { keep: rt.config.historyMax ?? 20 })
    const files = await writeDocument(document, text, { locations: store.mirrors })
    return {
      success: true,
      ...report,
      archived: staleItems.length + deepItems.length,
      stale: staleItems.map(item => ({ age_days: Math.floor(item.age), text: preview(item.text) })),
      deep: deepItems.map(item => ({ age_days: Math.floor(item.age), text: preview(item.text) })),
      pinned: split.pinned.length,
      kept: kept.length,
      archive: written,
      path: describeLocation(document.location),
      files,
      usage_after: { chars: charCount(kept), limit: store.charLimit },
      ...(history === undefined ? {} : { history }),
      message: `Archived ${staleItems.length + deepItems.length} entries (never deleted); ${kept.length} kept, ${split.pinned.length} pinned.`,
      ...(await maybeMirror(rt, files, signal)),
    }
  })
}

/**
 * Pin or unpin one entry, matched by a unique substring.
 * @param {{ paths: object, config: Record<string, any>, limits: object }} rt - plugin runtime.
 * @param {object} options - pin options.
 * @param {string} options.target - store name.
 * @param {string} options.old_text - substring identifying one entry.
 * @param {boolean} options.pinned - pin when true, unpin when false.
 * @param {number} [options.now] - timestamp.
 * @returns {Promise<object>} result.
 */
export async function setPin(rt, { target = 'memory', old_text, pinned = true, now = Date.now() } = {}) {
  const stores = await resolveStores(rt.paths, rt.limits)
  const store = stores[target]
  if (store === undefined || store.type !== 'entries') {
    return { success: false, error: `target '${target}' is not an entries store.` }
  }
  const needle = typeof old_text === 'string' ? old_text.trim() : ''
  if (needle.length === 0) return { success: false, error: 'old_text is required: the text of the entry to pin.' }
  const statePath = curatorStatePath(rt, target)
  return withLock(`curator:${store.locations[0].path}`, async () => {
    const document = await readDocument(store.locations)
    const entries = parseEntries(document.text)
    const matches = entries.filter(text => text.includes(needle))
    if (matches.length === 0) return { success: false, error: `no entry matched '${preview(needle)}'.`, closest_entries: entries.slice(0, 5).map(preview) }
    if (new Set(matches).size > 1) return { success: false, error: `'${preview(needle)}' matched ${matches.length} entries -- be more specific.`, matches: matches.map(preview) }
    const state = syncState(await readState(statePath), entries, now)
    const key = entryKey(matches[0])
    state.entries[key] = { ...state.entries[key], ...(pinned ? { pinned: true } : {}) }
    if (!pinned) delete state.entries[key].pinned
    await saveState(statePath, state)
    return {
      success: true,
      target,
      pinned,
      entry: preview(matches[0]),
      pinned_count: Object.values(state.entries).filter(record => record.pinned === true).length,
      state: statePath,
      message: pinned ? 'Entry pinned: the curator never archives it.' : 'Entry unpinned.',
    }
  })
}

/**
 * Where the state file for a store lives.
 * @param {{ paths: object }} rt - plugin runtime.
 * @param {string} target - store name.
 * @returns {string} path.
 */
export function curatorStatePath(rt, target) {
  return path.join(rt.paths.dataDir, `curator-${target}.json`)
}

/**
 * One-line preview of an entry.
 * @param {string} text - entry text.
 * @returns {string} at most 80 chars.
 */
function preview(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`
}
