// entries.mjs — the §-delimited entry store behind MEMORY.md / USER.md, a port
// of Hermes Agent's `memory` tool semantics so the two agents read and write
// the same files with the same rules:
//
//   - entries are separated by a line holding `§`;
//   - `add` appends (an identical entry is skipped, never duplicated);
//   - `patch` replaces exactly one span inside ONE entry, the rest is kept;
//   - `remove` deletes the whole entry that contains old_text;
//   - a batch is all-or-nothing and the char budget is checked on the FINAL
//     result, so one call can free space and add entries together;
//   - old_text is matched by whole-entry equality first, then by substring,
//     then by a quote/dash/whitespace-folded comparison (models re-type
//     curly quotes and em dashes differently from the stored entry).

import { countOccurrences } from './util.mjs'

/** Text separating two entries in a store file. */
export const ENTRY_DELIMITER = '\n§\n'

const SPLIT_DELIMITER = /\r?\n§\r?\n/
const QUOTES = new Set(['"', '`', '\u2018', '\u2019', '\u201a', '\u201b', '\u201c', '\u201d', '\u201e', '\u201f'])
const DASHES = new Set(['\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015', '\u2212'])

/**
 * Split a store file into its non-empty, trimmed entries.
 * @param {string} raw - file text.
 * @returns {string[]} entries in file order.
 */
export function parseEntries(raw) {
  return raw.split(SPLIT_DELIMITER).map(entry => entry.trim()).filter(entry => entry.length > 0)
}

/**
 * Render entries back to file text.
 * @param {string[]} entries - entries in order.
 * @returns {string} file text.
 */
export function renderEntries(entries) {
  return entries.join(ENTRY_DELIMITER)
}

/**
 * Characters the budget counts: the joined entries, delimiters included.
 * @param {string[]} entries - entries in order.
 * @returns {number} character count.
 */
export function charCount(entries) {
  return renderEntries(entries).length
}

/**
 * Quote/dash/whitespace-folded form used for tolerant matching.
 * @param {string} text - source text.
 * @returns {string} normalized text.
 */
export function normalizeForMatch(text) {
  let out = ''
  for (const char of String(text).replace(/\\n/g, ' ')) {
    out += QUOTES.has(char) ? "'" : DASHES.has(char) ? '-' : char
  }
  return out.split(/\s+/).join(' ').trim()
}

/**
 * Indices of entries containing `oldText`: byte-exact first, else folded.
 * @param {string[]} entries - store entries.
 * @param {string} oldText - selection text.
 * @returns {number[]} matching indices.
 */
function substringMatches(entries, oldText) {
  const direct = entries.flatMap((entry, index) => (entry.includes(oldText) ? [index] : []))
  if (direct.length > 0) return direct
  const needle = normalizeForMatch(oldText)
  if (!/[\p{L}\p{N}]/u.test(needle)) return []
  return entries.flatMap((entry, index) => (normalizeForMatch(entry).includes(needle) ? [index] : []))
}

/**
 * Locate the one entry `oldText` selects.
 * @param {string[]} entries - store entries.
 * @param {string} oldText - selection text.
 * @returns {{ index: number } | { ambiguous: string[] } | { none: true }} the
 *   located index, the 80-character previews of distinct matches, or no match.
 */
export function findUniqueMatch(entries, oldText) {
  const whole = entries.flatMap((entry, index) => (entry === oldText ? [index] : []))
  const matches = whole.length > 0 ? whole : substringMatches(entries, oldText)
  const distinct = new Set(matches.map(index => entries[index]))
  if (distinct.size > 1) {
    return { ambiguous: matches.map(index => preview(entries[index])) }
  }
  return matches.length > 0 ? { index: matches[0] } : { none: true }
}

/**
 * Short one-line preview of an entry for error listings.
 * @param {string} entry - entry text.
 * @returns {string} at most 80 characters plus an ellipsis.
 */
export function preview(entry) {
  const line = entry.replace(/\s+/g, ' ')
  return line.length > 80 ? `${line.slice(0, 80)}...` : line
}

/**
 * The entries sharing the most words with `oldText`, for a zero-match hint.
 * @param {string[]} entries - store entries.
 * @param {string} oldText - selection text.
 * @returns {string[]} up to three close entries.
 */
export function closestEntries(entries, oldText) {
  const words = new Set((oldText.toLowerCase().match(/\w+/g)) ?? [])
  if (words.size === 0) return []
  return entries
    .map((entry, index) => {
      const entryWords = new Set((entry.toLowerCase().match(/\w+/g)) ?? [])
      let shared = 0
      for (const word of words) if (entryWords.has(word)) shared += 1
      return { score: shared / words.size, index }
    })
    .filter(item => item.score >= 0.3)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .map(item => entries[item.index])
}

/**
 * Build a structured failure.
 * @param {string} failure - failure class.
 * @param {string} error - model-facing message.
 * @param {Record<string, unknown>} [extra] - additional fields.
 * @returns {{ ok: false, failure: string, error: string }} the failure.
 */
function rejected(failure, error, extra = {}) {
  return { ok: false, failure, error, ...extra }
}

/**
 * Apply a batch of operations to an entry list without touching disk.
 * @param {string[]} entries - current entries.
 * @param {Array<{ action: string, content?: string, old_text?: string }>} ops - operations.
 * @param {number} limit - character budget on the final result; 0 disables it.
 * @returns {object} `{ ok: true, entries, message, removed, patched, patchedAfter }`
 *   on success, or `{ ok: false, failure, error, ... }` leaving `entries` untouched.
 */
export function applyBatch(entries, ops, limit) {
  const working = [...entries]
  const removed = {}
  const patched = {}
  const patchedAfter = {}
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i] ?? {}
    const act = op.action
    const position = `Operation ${i + 1} (${act ?? 'unknown'})`
    let content = typeof op.content === 'string' ? op.content : ''
    let oldText = typeof op.old_text === 'string' ? op.old_text : ''
    if (act !== 'patch') {
      content = content.trim()
      oldText = oldText.trim()
    }
    if (act === 'add') {
      if (content.length === 0) return rejected('missing_content', `${position}: content is required.`)
      if (SPLIT_DELIMITER.test(content)) {
        return rejected('invalid_args', `${position}: content must be ONE entry and may not contain a "§" delimiter line.`)
      }
      if (!working.includes(content)) working.push(content)
      continue
    }
    if (act !== 'remove' && act !== 'patch') {
      return rejected('invalid_args', `${position}: unknown action. Use add, patch, or remove.`)
    }
    if (oldText.trim().length === 0) return rejected('missing_old_text', `${position}: old_text is required.`)
    if (act === 'patch' && content.trim().length === 0) {
      return rejected('missing_content', `${position}: content (the new text for the old_text span) is required.`
        + " To drop text inside an entry, patch a longer span that contains it; 'remove' deletes the whole entry.")
    }
    const match = findUniqueMatch(working, oldText)
    if ('ambiguous' in match) {
      return rejected('ambiguous', `${position}: '${preview(oldText)}' matched multiple distinct entries -- be more specific.`, { matches: match.ambiguous })
    }
    if ('none' in match) {
      return rejected('no_match', `${position}: no entry matched '${preview(oldText)}'. Retry with old_text copied verbatim from the intended entry.`, { closest_entries: closestEntries(working, oldText) })
    }
    const before = working[match.index]
    if (act === 'remove') {
      working.splice(match.index, 1)
      removed[i + 1] = before
      continue
    }
    const occurrences = countOccurrences(before, oldText)
    if (occurrences > 1) {
      return rejected('ambiguous', `${position}: '${preview(oldText)}' appears ${occurrences} times in the matched entry, and patch edits one span.`
        + ' Include more surrounding text so old_text occurs once.')
    }
    const after = before.replace(oldText, () => content)
    if (after === before) {
      return rejected('invalid_args', `${position}: patch is a no-op: the replacement leaves the entry unchanged.`)
    }
    working[match.index] = after
    patched[i + 1] = before
    patchedAfter[i + 1] = after
  }

  if (entries.length > 0 && working.length === 0 && !(ops.length === 1 && ops[0].action === 'remove')) {
    return rejected('would_empty', 'This batch would remove every entry from a previously non-empty store. Keep at least one entry,'
      + ' or remove the final entry alone in a one-item batch. No operations were applied.')
  }

  const total = charCount(working)
  const grows = !(ops.every(op => op.action === 'remove') || (ops.length === 1 && working.join('\u0000') === entries.join('\u0000')))
  if (limit > 0 && grows && total > limit) {
    const usage = `${charCount(entries)}/${limit}`
    if (ops.length === 1 && ops[0].action === 'add') {
      const content = ops[0].content ?? ''
      return rejected('over_budget', `Memory at ${usage} chars; adding this entry (${content.length} chars) would exceed the limit by`
        + ` ${total - limit} chars. Retry as ONE batch that removes or shortens (patch) stale entries from current_entries below to free at`
        + ` least ${total - limit} chars AND adds this entry -- the limit is checked only on the batch result.`, { current_entries: entries, usage })
    }
    return rejected('over_budget', `Applying all ${ops.length} operations would put memory at ${total}/${limit} chars. Add removes or`
      + ' shortening patches of other stale entries to the same batch, then retry. No operations were applied.', { usage })
  }

  const extra = {}
  if (Object.keys(removed).length > 0) extra.removed_entries = removed
  if (Object.keys(patched).length > 0) {
    extra.patched_entries = patched
    extra.patched_entries_after = patchedAfter
  }
  return { ok: true, entries: working, message: `Applied ${ops.length} operation(s).`, ...extra }
}
