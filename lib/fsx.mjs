// fsx.mjs — bounded, atomic filesystem primitives shared by every store.
//
// Every write goes through `writeFileAtomic` (temp file + rename) so a reader
// never observes a half-written memory or persona file, and so the external
// Hermes mirror (which watches these paths) sees one complete modification.
// A regular file that is a symlink is written through its target, so a
// dotfiles-managed MEMORY.md stays a link.

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * One-file identity used for optimistic concurrency between read and write.
 * @typedef {object} Stamp
 * @property {number} mtimeMs
 * @property {number} size
 */

/**
 * Stat a file without throwing when it is simply absent.
 * @param {string} file - absolute path.
 * @returns {Promise<Stamp & { isDirectory: boolean, isFile: boolean, mode: number } | undefined>}
 */
export async function statInfo(file) {
  try {
    const info = await stat(file)
    return {
      mtimeMs: info.mtimeMs,
      size: info.size,
      mode: info.mode,
      isDirectory: info.isDirectory(),
      isFile: info.isFile(),
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Whether two stamps describe the same file version; two absent files match.
 * @param {Stamp} a - first stamp.
 * @param {Stamp} b - second stamp.
 * @returns {boolean} true when both are absent or both describe identical
 *   mtime and size.
 */
export function sameStamp(a, b) {
  if (a === undefined || b === undefined) return a === b
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/**
 * Read a file as bytes; a missing file reads as undefined.
 * @param {string} file - absolute path.
 * @returns {Promise<Buffer | undefined>} the bytes, or undefined when absent.
 * @throws for every error other than ENOENT.
 */
export async function readBytes(file) {
  try {
    return await readFile(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Decode bytes as strict UTF-8.
 * @param {Buffer} bytes - file bytes.
 * @returns {string | undefined} the text, or undefined for invalid UTF-8.
 */
export function utf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * Read a UTF-8 text file; a missing file reads as undefined.
 * @param {string} file - absolute path.
 * @returns {Promise<string | undefined>} the content, or undefined when absent.
 * @throws for every error other than ENOENT (an unreadable file must not look empty).
 */
export async function readText(file) {
  const bytes = await readBytes(file)
  return bytes === undefined ? undefined : utf8(bytes)
}

/**
 * Replace a file atomically, creating parent directories and keeping the
 * mode. A symlinked regular file is replaced through its target.
 * @param {string} file - absolute path.
 * @param {string | Buffer} data - full new content.
 * @returns {Promise<void>}
 */
export async function writeFileAtomic(file, data) {
  let target = file
  try {
    const info = await stat(file)
    if (info.isFile()) target = await realpath(file)
  } catch {
    // Absent or unreadable: write the path itself.
  }
  const dir = path.dirname(target)
  await mkdir(dir, { recursive: true })
  const before = await statInfo(target)
  const mode = before?.isFile === true ? before.mode & 0o777 : 0o644
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, data, { mode })
    await rename(tmp, target)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

/**
 * Remove a file, tolerating one that is already gone.
 * @param {string} file - absolute path.
 * @returns {Promise<void>}
 */
export async function removeFile(file) {
  try {
    await unlink(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/**
 * Canonical absolute path, falling back to a lexical resolve when the target
 * does not exist yet.
 * @param {string} file - path.
 * @returns {Promise<string>} the real path.
 */
export async function realPath(file) {
  try {
    return await realpath(file)
  } catch {
    return path.resolve(file)
  }
}

/**
 * Whether `child` equals or lies below `parent`.
 * @param {string} child - candidate path.
 * @param {string} parent - directory path.
 * @returns {boolean} containment verdict.
 */
export function inside(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Move a file or directory, copying across filesystems when rename refuses.
 * @param {string} from - source path.
 * @param {string} to - destination path (must not exist).
 * @returns {Promise<void>}
 */
export async function movePath(from, to) {
  await mkdir(path.dirname(to), { recursive: true })
  try {
    await rename(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
}

async function cp(from, to, options) {
  const { cp: copy } = await import('node:fs/promises')
  return copy(from, to, options)
}

/**
 * List files below a directory, breadth-first, bounded in depth and count.
 * Symlinked directories are not descended.
 * @param {string} dir - start directory.
 * @param {{ maxDepth?: number, maxFiles?: number }} [options] - bounds.
 * @returns {Promise<string[]>} absolute file paths.
 */
export async function listFiles(dir, { maxDepth = 3, maxFiles = 5000 } = {}) {
  const found = []
  let queue = [{ dir, depth: 0 }]
  while (queue.length > 0 && found.length < maxFiles) {
    const next = []
    for (const item of queue) {
      let entries
      try {
        entries = await readdir(item.dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = path.join(item.dir, entry.name)
        if (entry.isFile()) {
          found.push(full)
          if (found.length >= maxFiles) return found
        } else if (item.depth + 1 < maxDepth && entry.isDirectory()) {
          next.push({ dir: full, depth: item.depth + 1 })
        }
      }
    }
    queue = next
  }
  return found
}

/**
 * Remove a directory tree, tolerating an absent one.
 * @param {string} dir - absolute path.
 * @returns {Promise<void>}
 */
export async function removeDir(dir) {
  await rm(dir, { recursive: true, force: true })
}

/** Chains of exclusive sections per key; the map only holds live chains. */
const locks = new Map()

/**
 * Run `critical` exclusively for `key` within this process: every read-
 * modify-write of one store file is serialized so two sessions cannot both
 * pass the stamp check and drop each other's entries.
 * @template T
 * @param {string} key - lock name.
 * @param {() => Promise<T>} critical - section to serialize.
 * @returns {Promise<T>} its result.
 */
export async function withLock(key, critical) {
  const previous = locks.get(key) ?? Promise.resolve()
  let release
  const held = new Promise(resolve => {
    release = resolve
  })
  const entry = previous.then(() => held)
  locks.set(key, entry)
  await previous.catch(() => {})
  try {
    return await critical()
  } finally {
    release()
    if (locks.get(key) === entry) locks.delete(key)
  }
}
