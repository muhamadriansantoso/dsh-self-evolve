// memorytool.mjs — the `memory` tool's core: Hermes-compatible add / patch /
// remove / view operations on the §-delimited MEMORY.md and user-profile
// stores, with an atomic batch, a budget on the final result and a snapshot
// of the previous content before anything is written.
//
// A batch that would exceed the budget goes to automatic condensation first
// (condense.mjs): the model shortens the store, the batch's adds are applied
// to the shortened entries, and the whole result is written in one step.
// When condensation is unavailable or fails, the add is rejected exactly as
// it would have been without it.
//
// The whole read-modify-write runs under a per-file lock: one host process
// serves many sessions, and two of them editing the same store at once would
// otherwise both pass the version check and silently drop each other's entry.
// The model call runs before the lock, so a slow condensation never holds up
// another session; the locked write then checks that the store is still the
// text that was condensed.

import { withLock } from './fsx.mjs'
import { ENTRY_DELIMITER, applyBatch, charCount, parseEntries, renderEntries } from './entries.mjs'
import { saveHistory, saveSidecar } from './history.mjs'
import { resolveStores } from './stores.mjs'
import { describeLocation, readDocument, writeDocument } from './textstore.mjs'

import { maybeMirror } from './hook.mjs'

/**
 * Usage line for a store.
 * @param {string[]} entries - store entries.
 * @param {number} limit - char budget (0 = none).
 * @returns {string} e.g. `42% — 1,200/2,200 chars`.
 */
function usage(entries, limit) {
  const current = charCount(entries).toLocaleString('en-US')
  if (!(limit > 0)) return `${current} chars (no limit)`
  const percent = Math.min(100, Math.floor((charCount(entries) / limit) * 100))
  return `${percent}% — ${current}/${limit.toLocaleString('en-US')} chars`
}

/**
 * Run one `memory` call.
 * @param {{ paths: object, config: Record<string, any>, limits: object }} rt - plugin runtime.
 * @param {object} args
 * @param {string} args.target - `memory` or `user`.
 * @param {Array<{ action: string, content?: string, old_text?: string }>} args.operations
 * @param {AbortSignal} [args.signal] - cancellation.
 * @param {{ agent?: object }} [args.exec] - the tool execution; its agent names
 *   the session whose model a condensation uses.
 * @param {{ condense?: Function }} [deps] - host hooks; `condense` shortens an
 *   over-budget entry list with a model call (see condense.mjs).
 * @returns {Promise<object>} the tool result.
 */
export async function runMemory(rt, { target, operations, signal, exec }, deps = {}) {
  const stores = await resolveStores(rt.paths, rt.limits)
  const store = stores[target]
  const available = Object.entries(stores).filter(([, item]) => item.type === 'entries').map(([name]) => name)
  if (store === undefined) {
    return {
      success: false,
      error: `target '${target}' is not available in this profile. Available targets: ${available.join(', ')}.`,
      available,
    }
  }
  if (!Array.isArray(operations) || operations.length === 0) {
    return { success: false, error: "operations must be a non-empty list of {action, content?, old_text?}; a single change is a one-item list." }
  }
  const views = operations.filter(op => op?.action === 'view').length
  if (views > 0 && operations.length > 1) {
    return { success: false, error: 'view must be the only operation in its call.' }
  }

  /**
   * The locked read-modify-write. `plan` carries a condensation prepared
   * outside the lock: the entries it produced, the operations still to apply,
   * what the operations already applied there reported, and the store text
   * it was derived from.
   */
  const commit = plan => withLock(`memory:${store.locations[0].path}`, async () => {
    signal?.throwIfAborted()
    const document = await readDocument(store.locations)
    const entries = parseEntries(document.text)
    const path = describeLocation(document.location)

    if (views === 1) {
      return {
        success: true,
        target,
        path,
        usage: usage(entries, store.charLimit),
        entry_count: entries.length,
        entries: entries.map((text, index) => ({ index: index + 1, chars: text.length, text })),
      }
    }

    if (plan !== undefined && document.text !== plan.text) {
      return {
        success: false,
        target,
        failure: 'over_budget',
        error: 'The store changed while it was being condensed; nothing was written. Retry the batch.',
        usage: usage(entries, store.charLimit),
        condense: { attempted: true, error: 'changed_while_condensing' },
      }
    }

    const outcome = applyBatch(plan?.entries ?? entries, plan?.operations ?? operations, store.charLimit)
    if (outcome.ok !== true) {
      if (plan === undefined) return { success: false, target, usage: usage(entries, store.charLimit), ...outcome }
      return {
        success: false,
        target,
        usage: usage(entries, store.charLimit),
        ...outcome,
        current_entries: entries,
        error: `Automatic condensation did not free enough space (${plan.summary}). ${outcome.error}`,
        condense: { attempted: true, error: 'still_over_budget', ...plan.report },
      }
    }

    const text = renderEntries(outcome.entries)
    const history = await saveHistory(rt.paths.dataDir, store.history, document.text, { keep: rt.config.historyMax ?? 20 })
    const transcript = plan === undefined ? undefined : await saveSidecar(history, plan.record)
    const files = await writeDocument(document, text, { locations: store.mirrors })
    return {
      success: true,
      done: true,
      target,
      path,
      files,
      usage: usage(outcome.entries, store.charLimit),
      entry_count: outcome.entries.length,
      message: plan?.message ?? outcome.message,
      ...(plan === undefined ? {} : { condensed: { ...plan.report, ...(transcript === undefined ? {} : { transcript }) } }),
      ...Object.fromEntries(plan?.carried ?? []),
      ...Object.fromEntries(Object.entries(outcome).filter(([key]) => key !== 'ok' && key !== 'entries' && key !== 'message')),
      ...(history === undefined ? {} : { history }),
      note: 'Write saved. This update is complete — do not repeat it.',
      ...(await maybeMirror(rt, files, signal)),
    }
  })

  // Automatic condensation is decided on an unlocked read, so only a batch
  // that really overflows pays for the model call.
  if (deps.condense !== undefined && views !== 1 && store.charLimit > 0 && rt.config.autoCondense !== false) {
    const snapshot = await readDocument(store.locations)
    const current = parseEntries(snapshot.text)
    const direct = applyBatch(current, operations, store.charLimit)
    if (direct.ok !== true && direct.failure === 'over_budget') {
      // Removes and patches address the store as it is and free space there;
      // only the adds, which reference no old text, are applied afterwards.
      const adds = operations.filter(op => op?.action === 'add')
      const rest = operations.filter(op => op?.action !== 'add')
      const base = rest.length === 0 ? { ok: true, entries: current } : applyBatch(current, rest, store.charLimit)
      // The condensation must leave room for exactly what is still to be
      // added: the entry's text plus one delimiter each. Trimming only what
      // the batch needs is the least lossy target it can aim at.
      const incoming = adds.reduce((total, op) => {
        const content = typeof op?.content === 'string' ? op.content.trim() : ''
        const skip = content.length === 0 || base.ok !== true || base.entries.includes(content)
        return skip ? total : total + content.length + ENTRY_DELIMITER.length
      }, 0)
      const allowed = store.charLimit - incoming
      if (adds.length > 0 && base.ok === true && base.entries.length > 0 && allowed > 0) {
        const attempt = await deps.condense({
          entries: base.entries,
          kind: target,
          target: allowed,
          signal,
        }, exec)
        if (attempt.ok !== true) {
          return {
            success: false,
            target,
            usage: usage(current, store.charLimit),
            ...direct,
            error: `Automatic condensation failed (${attempt.error}). ${direct.error}`,
            condense: { attempted: true, ...Object.fromEntries(Object.entries(attempt).filter(([key]) => key !== 'ok')) },
          }
        }
        const { before, after } = attempt.report
        const shortened = attempt.report.trims?.length ?? 0
        const carried = ['removed_entries', 'patched_entries', 'patched_entries_after']
          .filter(key => base[key] !== undefined)
          .map(key => [key, base[key]])
        return commit({
          text: snapshot.text,
          entries: attempt.entries,
          operations: adds,
          carried,
          report: attempt.report,
          summary: `${shortened} ${shortened === 1 ? 'entry' : 'entries'} shortened, ${before.chars} → ${after.chars} chars`,
          message: `Store was over its limit: shortened ${shortened} ${shortened === 1 ? 'entry' : 'entries'} (${before.chars} → ${after.chars} chars)`
            + ` with ${attempt.report.provider}/${attempt.report.model}, then applied ${operations.length} operation(s).`,
          record: {
            store: store.label,
            target,
            instruction: attempt.instruction,
            before: base.entries,
            after: attempt.entries,
            report: attempt.report,
          },
        })
      }
    }
  }
  return commit()
}
