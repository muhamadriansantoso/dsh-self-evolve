// personatool.mjs — the `persona_update` tool's core: whole-document and
// heading-section edits of the persona / soul text stores, serialized per
// file like the memory tool.

import { withLock } from './fsx.mjs'
import { saveHistory } from './history.mjs'
import { listSections, removeSection, setSection } from './sections.mjs'
import { resolveStores } from './stores.mjs'
import { countOccurrences, fail, truncate } from './util.mjs'

import { maybeMirror } from './hook.mjs'
import { describeLocation, readDocument, writeDocument } from './textstore.mjs'

/** Operations the tool accepts. */
export const OPERATIONS = ['view', 'replace', 'append', 'patch', 'set_section', 'remove_section']

/** Any sync-agents.py managed block. */
const ANY_SYNC_MARKER = /<!-- SYNC:[A-Z_]+ -->/

/**
 * Section titles as outline lines.
 * @param {string} text - document text.
 * @returns {string[]} e.g. `## Execution rules`.
 */
function outline(text) {
  return listSections(text).map(section => `${'#'.repeat(section.level)} ${section.title}`)
}

/**
 * Run one `persona_update` call.
 * @param {{ paths: object, config: Record<string, any>, limits: object }} rt - plugin runtime.
 * @param {object} args
 * @param {string} [args.target] - `persona` (default) or `soul`.
 * @param {string} args.operation - one of {@link OPERATIONS}.
 * @param {string} [args.content] - new text; empty for `patch` deletes the span.
 * @param {string} [args.old_text] - patch target.
 * @param {string} [args.section] - section title.
 * @param {AbortSignal} [args.signal] - cancellation.
 * @returns {Promise<object>} the tool result.
 */
export async function runPersona(rt, { target = 'persona', operation, content, old_text, section, signal }) {
  const stores = await resolveStores(rt.paths, rt.limits)
  const store = stores[target]
  const available = Object.entries(stores).filter(([, item]) => item.type === 'text').map(([name]) => name)
  if (store === undefined) {
    return {
      success: false,
      error: `target '${target}' is not available in this profile (no marked block for it). Available targets: ${available.join(', ')}.`,
      available,
    }
  }
  if (!OPERATIONS.includes(operation)) {
    return { success: false, error: `operation must be one of: ${OPERATIONS.join(', ')}.` }
  }
  const provided = typeof content === 'string'
  if (operation !== 'view' && operation !== 'remove_section' && operation !== 'patch' && (!provided || content.trim().length === 0)) {
    return { success: false, error: `content is required for ${operation}.` }
  }

  return withLock(`persona:${store.locations[0].path}`, async () => {
    signal?.throwIfAborted()
    const document = await readDocument(store.locations)
    const text = document.text
    const path = describeLocation(document.location)
    const result = { target, path }

    if (operation === 'view') {
      const bounded = truncate(text, rt.config.viewMaxChars ?? 20000)
      return { success: true, ...result, chars: text.length, sections: outline(text), content: bounded.text, truncated: bounded.truncated }
    }

    let next = text
    let created
    let ambiguous = false
    switch (operation) {
      case 'replace':
        if (document.location.wholeFile === true && ANY_SYNC_MARKER.test(text)) {
          return {
            success: false,
            ...result,
            error: `${path} holds other managed SYNC blocks but no persona block, so replacing the whole file would delete them.`
              + ' Use patch, append or set_section, or add a persona block (personaStart/personaEnd markers) first.',
          }
        }
        next = content.trim()
        break
      case 'append':
        next = text.trimEnd().length === 0 ? content.trim() : `${text.trimEnd()}\n\n${content.trim()}`
        break
      case 'patch': {
        if (typeof old_text !== 'string' || old_text.trim().length === 0) {
          return { success: false, ...result, error: 'old_text is required for patch: the exact text to replace.' }
        }
        if (!provided) return { success: false, ...result, error: 'content is required for patch (an empty string deletes the span).' }
        const count = countOccurrences(text, old_text)
        if (count === 0) return { success: false, ...result, error: 'old_text was not found. View the target and copy the text verbatim.' }
        if (count > 1) return { success: false, ...result, error: `old_text occurs ${count} times; include more surrounding text so it matches once.` }
        next = text.replace(old_text, () => content)
        break
      }
      case 'set_section': {
        if (typeof section !== 'string' || section.trim().length === 0) {
          return { success: false, ...result, error: 'section (the heading text) is required for set_section.' }
        }
        const outcome = setSection(text, section, content)
        if (outcome?.ambiguous === true) ambiguous = true
        else {
          next = outcome.text
          created = outcome.created
        }
        break
      }
      case 'remove_section': {
        if (typeof section !== 'string' || section.trim().length === 0) {
          return { success: false, ...result, error: 'section (the heading text) is required for remove_section.' }
        }
        const outcome = removeSection(text, section)
        if (outcome?.ambiguous === true) ambiguous = true
        else if (outcome === undefined) {
          return { success: false, ...result, error: `No section titled "${section}".`, sections: outline(text) }
        } else {
          next = outcome
        }
        break
      }
      default:
        throw fail('INVALID_OP', `Unsupported operation "${operation}".`)
    }
    if (ambiguous) {
      return { success: false, ...result, error: `The title "${section}" is used by more than one section; rename one first or patch its text directly.`, sections: outline(text) }
    }

    if (next === text) return { success: true, ...result, operation, changed: false, message: 'Nothing changed: the result is identical to the current text.' }
    const limit = rt.config.maxContentBytes ?? 262144
    if (Buffer.byteLength(next) > limit) {
      return { success: false, ...result, error: `The result would be ${Buffer.byteLength(next)} bytes; the limit is ${limit}.` }
    }
    const history = await saveHistory(rt.paths.dataDir, store.history, text, { keep: rt.config.historyMax ?? 20 })
    const files = await writeDocument(document, next)
    return {
      success: true,
      ...result,
      operation,
      ...(section === undefined ? {} : { section }),
      ...(created === undefined ? {} : { created_section: created }),
      files,
      chars: next.length,
      sections: outline(next),
      ...(history === undefined ? {} : { history }),
      message: 'Saved. The updated instructions enter the next step of this session and every new session.',
      ...(await maybeMirror(rt, files, signal)),
    }
  })
}
