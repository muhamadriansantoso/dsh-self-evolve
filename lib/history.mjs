// history.mjs — rolling snapshots of every file this plugin overwrites, so a
// mis-judged memory edit or persona rewrite is recoverable from disk.
//
// Snapshots are best-effort: a failed backup never blocks the write itself,
// the caller only reports that no snapshot exists.

import path from 'node:path'
import { randomSuffix, timestamp } from './util.mjs'

import { listFiles, removeFile, writeFileAtomic } from './fsx.mjs'

/** Extension of the record `saveSidecar` keeps beside a snapshot. */
const SIDECAR = '.condense.json'

/**
 * Save one snapshot under `<dataDir>/history/<kind>/` and prune old ones.
 * @param {string} dataDir - plugin-owned data directory.
 * @param {string} kind - snapshot group, e.g. `memory` or `skills/my-skill`.
 * @param {string} text - previous file content.
 * @param {{ ext?: string, keep?: number }} [options] - file extension and
 *   how many snapshots of this kind to keep.
 * @returns {Promise<string | undefined>} the snapshot path, or undefined when
 *   the backup could not be written.
 */
export async function saveHistory(dataDir, kind, text, { ext = 'md', keep = 20 } = {}) {
  if (!(keep > 0)) return undefined
  const dir = path.join(dataDir, 'history', kind)
  const file = path.join(dir, `${timestamp()}-${randomSuffix()}.${ext}`)
  try {
    await writeFileAtomic(file, text)
    await prune(dir, keep)
    return file
  } catch {
    return undefined
  }
}

/**
 * Keep the record of an automatic rewrite beside its snapshot, as
 * `<snapshot stem>.condense.json`, so what the model saw and returned stays
 * reconstructable after the store itself has moved on.
 * @param {string | undefined} snapshot - the path `saveHistory` returned.
 * @param {Record<string, unknown>} record - the transcript.
 * @returns {Promise<string | undefined>} the record path; undefined when
 *   there is no snapshot to attach it to.
 */
export async function saveSidecar(snapshot, record) {
  if (snapshot === undefined) return undefined
  const file = snapshot.replace(/\.[^.]+$/, '') + SIDECAR
  try {
    await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`)
    return file
  } catch {
    return undefined
  }
}

/**
 * Delete the oldest snapshots beyond `keep`, each with its sidecar record.
 * @param {string} dir - snapshot directory.
 * @param {number} keep - snapshots to keep.
 * @returns {Promise<void>}
 */
async function prune(dir, keep) {
  const files = (await listFiles(dir, { maxDepth: 1, maxFiles: 1000 }))
    .filter(file => !path.basename(file).startsWith('.') && !file.endsWith(SIDECAR))
    .sort()
  for (const stale of files.slice(0, Math.max(0, files.length - keep))) {
    await removeFile(stale).catch(() => {})
    await removeFile(stale.replace(/\.[^.]+$/, '') + SIDECAR).catch(() => {})
  }
}
