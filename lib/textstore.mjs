// textstore.mjs — one document that may live in several places: a whole file,
// or a marker-delimited block inside a shared file (the `SYNC:*` blocks of
// ~/.dsh/AGENTS.md), optionally mirrored to further files.
//
// A read captures the file's stamp; a write re-checks it so an external writer
// that touched the file in between (the Hermes mirror, an editor) makes the
// write fail with CONFLICT instead of silently losing its change.

import path from 'node:path'
import { fail } from './util.mjs'

import { readText, statInfo, sameStamp, writeFileAtomic } from './fsx.mjs'

/**
 * Where one store's text lives.
 * @typedef {object} Location
 * @property {string} path - absolute file path.
 * @property {{ start: string, end: string }} [block] - line markers that
 *   enclose the store's text inside the file; omit for the whole file.
 * @property {string} label - human-readable description for results.
 */

/**
 * A document read: the store text plus the version it was read from.
 * @typedef {object} Document
 * @property {string} text - store text (block interior or whole file).
 * @property {import('./fsx.mjs').Stamp} [stamp] - file version at read time;
 *   undefined when the file does not exist yet.
 * @property {Location} location - the location that was read.
 */

/** Marker text expected in a file but not found. */
export const MISSING_BLOCK = 'MISSING_BLOCK'
/** The file changed between read and write. */
export const CONFLICT = 'CONFLICT'

/**
 * Describe a location for model-facing results.
 * @param {Location} location - a store location.
 * @returns {string} path plus block markers when it is a block.
 */
export function describeLocation(location) {
  return location.block === undefined
    ? location.path
    : `${location.path} [${location.block.start} … ${location.block.end}]`
}

/**
 * Read the first existing location of a document.
 * @param {Location[]} locations - candidate locations in priority order.
 * @returns {Promise<Document>} the document; text is '' when no file exists.
 * @throws {Error} MISSING_BLOCK when the file exists without the markers.
 */
export async function readDocument(locations) {
  for (const location of locations) {
    const file = await readText(location.path)
    const stamp = await statInfo(location.path)
    if (file === undefined) continue
    if (location.block === undefined) return { text: file, stamp, location }
    const inner = blockInner(file, location.block)
    if (inner === undefined) {
      throw fail(MISSING_BLOCK, `markers ${location.block.start} / ${location.block.end} not found in ${location.path}`)
    }
    return { text: inner, stamp, location }
  }
  return { text: '', stamp: undefined, location: locations[0] }
}

/**
 * The text between two markers, or undefined when either marker is absent.
 * @param {string} file - whole file text.
 * @param {{ start: string, end: string }} block - markers.
 * @returns {string | undefined} interior text.
 */
function blockInner(file, block) {
  const start = file.indexOf(block.start)
  if (start < 0) return undefined
  const end = file.indexOf(block.end, start + block.start.length)
  if (end < 0) return undefined
  return file.slice(start + block.start.length, end).replace(/^\r?\n/, '').replace(/\r?\n$/, '')
}

/**
 * Replace a block's interior, keeping the markers and their line layout.
 * @param {string} file - whole file text.
 * @param {{ start: string, end: string }} block - markers.
 * @param {string} text - new interior.
 * @returns {string} the rewritten file.
 * @throws {Error} MISSING_BLOCK when a marker is absent.
 */
function replaceBlock(file, block, text) {
  const start = file.indexOf(block.start)
  if (start < 0) throw fail(MISSING_BLOCK, `marker ${block.start} not found`)
  const end = file.indexOf(block.end, start + block.start.length)
  if (end < 0) throw fail(MISSING_BLOCK, `marker ${block.end} not found`)
  const interior = text.trim().length === 0 ? '' : `\n${text.trim()}\n`
  return file.slice(0, start + block.start.length) + interior + file.slice(end)
}

/**
 * Write the document to the location it was read from, then to every mirror.
 * @param {Document} document - the document returned by `readDocument`.
 * @param {string} text - new store text.
 * @param {{ locations?: Location[], expectedStamp?: import('./fsx.mjs').Stamp }} [options]
 *   - additional whole-file mirrors and the stamp to compare against.
 * @returns {Promise<string[]>} the files written.
 * @throws {Error} CONFLICT when the file changed since it was read, or
 *   MISSING_BLOCK when the markers vanished in between.
 */
export async function writeDocument(document, text, { locations = [], expectedStamp } = {}) {
  if (document.location.block !== undefined) {
    const now = await statInfo(document.location.path)
    if (!sameStamp(expectedStamp ?? document.stamp, now)) {
      throw fail(CONFLICT, `${document.location.path} changed while it was being edited; re-read and retry`)
    }
    const file = await readText(document.location.path)
    await writeFileAtomic(document.location.path, replaceBlock(file ?? '', document.location.block, text))
  } else {
    const now = await statInfo(document.location.path)
    if (!sameStamp(expectedStamp ?? document.stamp, now)) {
      throw fail(CONFLICT, `${document.location.path} changed while it was being edited; re-read and retry`)
    }
    await writeFileAtomic(document.location.path, text)
  }
  const written = [document.location.path]
  for (const mirror of locations) {
    await writeFileAtomic(path.resolve(mirror.path ?? mirror), text)
    written.push(path.resolve(mirror.path ?? mirror))
  }
  return written
}
