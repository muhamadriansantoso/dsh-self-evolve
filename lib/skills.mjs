// skills.mjs — create, update and delete skills wherever DSH discovers them.
//
// Discovery mirrors @deepseek-ai/dsh-skill-filesystem: a skill is
// `<root>/<name>/SKILL.md` or a flat `<root>/<name>.md`, roots being the
// project's .dsh/skills and .agents/skills, the custom dirs, ~/.dsh/skills and
// ~/.agents/skills. A skill already in the session catalog is edited at the
// exact file the loader would read (the winning candidate); skills only the
// recursive Hermes scanner sees (`<root>/<category>/<name>/SKILL.md`) are
// found by a bounded directory search.
//
// A batch is all-or-nothing: every file is journaled before it is touched and
// a failure — or a cancellation — rolls the whole batch back. Deleted skills
// are moved to a trash directory under the plugin's data dir, never unlinked.
// A skill name is one or two kebab-case segments, so no operation can address
// a path outside the scanned roots.

import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { buildSkillText, splitFrontmatter, validateSkillText } from './frontmatter.mjs'
import { saveHistory } from './history.mjs'
import { ALLOWED_SUBDIRS, isSkillName, safeRelativeFile } from './names.mjs'
import { errorMessage, fail, randomSuffix, timestamp, truncate } from './util.mjs'
import { runSkillCurator, scanSkills, setSkillPin } from './skillcurator.mjs'

import { inside, listFiles, movePath, readBytes, realPath, removeFile, utf8, withLock, writeFileAtomic } from './fsx.mjs'

/**
 * Nearest ancestor of `cwd` holding one of the markers; `cwd` itself when
 * none does — the same rule the skill provider applies.
 * @param {string} cwd - starting directory.
 * @param {string[]} [markers] - directory or file names that mark a root.
 * @returns {Promise<string>} the project root.
 */
export async function findProjectRoot(cwd, markers = ['.git']) {
  let current = path.resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (await stat(path.join(current, marker)).then(() => true, () => false)) return current
    }
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(cwd)
    current = parent
  }
}

/**
 * Every root DSH scans for the given working directory, in provider order.
 * Relative `customSkillDirs` resolve against the host's working directory,
 * as the provider does.
 * @param {ReturnType<import('./stores.mjs').resolvePaths>} paths - resolved paths.
 * @param {Record<string, any>} config - plugin config.
 * @param {string} cwd - session working directory.
 * @returns {Promise<Array<{ path: string, kind: string, projectRoot: string }>>} roots.
 */
export async function skillRoots(paths, config, cwd) {
  const projectRoot = await findProjectRoot(cwd)
  const roots = [
    { path: path.join(projectRoot, '.dsh', 'skills'), kind: 'project-dsh' },
    { path: path.join(projectRoot, '.agents', 'skills'), kind: 'project-agents' },
    ...(config.customSkillDirs ?? []).map(dir => ({ path: path.resolve(process.cwd(), dir), kind: 'custom' })),
    { path: paths.skillsDir, kind: 'user-dsh' },
    { path: path.join(paths.agentsHome, 'skills'), kind: 'user-agents' },
  ]
  return roots.map(root => ({ ...root, projectRoot }))
}

/**
 * The directory a new skill is created in.
 * @param {ReturnType<import('./stores.mjs').resolvePaths>} paths - resolved paths.
 * @param {Record<string, any>} config - plugin config.
 * @param {{ cwd: string, known: boolean }} session - the session directory and
 *   whether it is the session's own (false falls back to the host's cwd).
 * @param {unknown} scope - `'user'` (default) or `'project'`.
 * @returns {Promise<{ path: string, kind: string }>} the creation root.
 * @throws {Error} INVALID_OP for any other scope, or for `project` without a
 *   known session directory.
 */
export async function createRoot(paths, config, session, scope) {
  if (scope === undefined || scope === 'user') return { path: paths.skillsDir, kind: 'user-dsh' }
  if (scope === 'project') {
    if (!session.known) throw fail('INVALID_OP', "scope 'project' needs the session's working directory, which this call does not carry.")
    const projectRoot = await findProjectRoot(session.cwd)
    return { path: path.join(projectRoot, config.skillsProjectDir ?? '.agents/skills'), kind: 'project-agents' }
  }
  throw fail('INVALID_OP', `scope must be 'user' or 'project', not ${JSON.stringify(scope)}`)
}

/**
 * Whether a path belongs to the installation or a package and must stay
 * read-only: it would be lost on upgrade and may break the product.
 * @param {string} file - absolute path.
 * @param {string | undefined} installDir - the installation directory.
 * @returns {boolean} true when the path is protected.
 */
export function isProtectedPath(file, installDir) {
  const segments = file.split(path.sep)
  if (segments.includes('node_modules') || segments.includes('.system')) return true
  return typeof installDir === 'string' && installDir.length > 0 && inside(file, path.resolve(installDir))
}

/**
 * Whether a skill reference is `name` or `category/name`, both kebab-case.
 * @param {unknown} name - candidate.
 * @returns {boolean} validity.
 */
export function isSkillRef(name) {
  if (typeof name !== 'string') return false
  const parts = name.split('/')
  return parts.length <= 2 && parts.every(isSkillName)
}

/**
 * Find the instruction file of one skill.
 * @param {object} options
 * @param {string} options.name - skill name, or `category/name`.
 * @param {ReturnType<typeof skillRoots>} options.roots - scanned roots.
 * @param {(name: string) => Promise<{ path: string, source?: string } | undefined>} [options.lookup]
 *   catalog lookup supplied by the plugin entry.
 * @param {number} [options.maxDepth] - bounded search depth below each root.
 * @returns {Promise<{ path: string, source: string } | undefined>} the file.
 */
export async function locateSkill({ name, roots, lookup, maxDepth = 3 }) {
  if (!isSkillRef(name)) return undefined
  if (typeof lookup === 'function' && isSkillName(name)) {
    const hit = await lookup(name).catch(() => undefined)
    if (hit !== undefined && typeof hit.path === 'string') return { path: hit.path, source: hit.source ?? 'catalog' }
  }
  const parts = name.split('/')
  const candidates = parts.length === 2
    ? [`${parts[0]}/${parts[1]}/SKILL.md`, `${parts[0]}/${parts[1]}.md`]
    : [`${name}/SKILL.md`, `${name}.md`]
  for (const root of roots) {
    // The root itself may be a symlink (the shared skills hub); compare real
    // paths so a skill found here is provingly inside the root.
    const rootReal = await realPath(root.path)
    for (const relative of candidates) {
      const file = path.join(root.path, relative)
      if (await stat(file).then(() => true, () => false)) {
        if (!inside(await realPath(file), rootReal)) continue
        return { path: file, source: root.kind }
      }
    }
    if (parts.length === 2) continue
    // Nested category hubs (Hermes layout): <root>/<category>/<name>/SKILL.md.
    const nested = await findNested(rootReal, name, maxDepth)
    if (nested !== undefined) return { path: nested, source: root.kind }
  }
  return undefined
}

/**
 * Breadth-first search for `<name>/SKILL.md` below a root.
 * @param {string} root - root directory.
 * @param {string} name - skill directory name.
 * @param {number} maxDepth - depth bound.
 * @returns {Promise<string | undefined>} the file, or undefined.
 */
async function findNested(root, name, maxDepth) {
  let frontier = [root]
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next = []
    for (const dir of frontier) {
      const direct = path.join(dir, name, 'SKILL.md')
      if (await stat(direct).then(() => true, () => false)) return direct
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        // Resource directories of a skill are never skill containers.
        if (entry.isDirectory() && !entry.name.startsWith('.') && !ALLOWED_SUBDIRS.includes(entry.name)) {
          next.push(path.join(dir, entry.name))
        }
      }
    }
    frontier = next
  }
  return undefined
}

/**
 * Validate the shape of one operation beyond what the schema guarantees.
 *
 * The host hands `execute` deep-frozen arguments (the dsh-tools pipeline runs
 * `deepFreeze` over the parsed call), so an operation object is never written
 * to: normalization returns a copy.
 *
 * @param {any} op - one operations item.
 * @param {number} index - 1-based position in the batch.
 * @returns {any} a copy of the op with `name` trimmed.
 * @throws {Error} INVALID_OP for a malformed op.
 */
function validateOp(op, index) {
  const position = `Operation ${index}`
  if (typeof op?.action !== 'string') throw fail('INVALID_OP', `${position}: action is required.`)
  if (typeof op.name !== 'string' || op.name.trim().length === 0) throw fail('INVALID_OP', `${position}: name is required.`)
  const name = op.name.trim()
  if (!isSkillRef(name)) {
    throw fail('INVALID_OP', `${position}: name must be lowercase kebab-case, optionally "category/name" (two kebab-case segments); got "${name}".`)
  }
  if (op.action === 'create' && !isSkillName(name)) {
    throw fail('INVALID_OP', `${position}: create needs a plain kebab-case name, not "${name}".`)
  }
  switch (op.action) {
    case 'create':
      if (typeof op.content !== 'string' || op.content.trim().length === 0) throw fail('INVALID_OP', `${position}: content is required.`)
      if (splitFrontmatter(op.content).has === false && (typeof op.description !== 'string' || op.description.trim().length === 0)) {
        throw fail('INVALID_OP', `${position}: content has no frontmatter, so description is required.`)
      }
      break
    case 'patch':
      if (typeof op.old_string !== 'string' || op.old_string.length === 0) throw fail('INVALID_OP', `${position}: old_string is required.`)
      if (typeof op.new_string !== 'string') throw fail('INVALID_OP', `${position}: new_string is required (an empty string deletes the match).`)
      break
    case 'edit':
      if (typeof op.content !== 'string' || op.content.trim().length === 0) throw fail('INVALID_OP', `${position}: content is required.`)
      break
    case 'write_file':
      if (safeRelativeFile(op.file_path) === undefined) throw fail('INVALID_OP', `${position}: file_path must be a relative path under ${ALLOWED_SUBDIRS.join('/')} (use edit to rewrite SKILL.md).`)
      if (typeof op.file_content !== 'string') throw fail('INVALID_OP', `${position}: file_content is required.`)
      break
    case 'remove_file':
      if (safeRelativeFile(op.file_path) === undefined) throw fail('INVALID_OP', `${position}: file_path must be a relative path under ${ALLOWED_SUBDIRS.join('/')} (use delete to remove the skill).`)
      break
    case 'delete':
    case 'view':
      break
    default:
      throw fail('INVALID_OP', `${position}: unknown action "${op.action}". Use create, patch, edit, write_file, remove_file, delete, view.`)
  }
  return { ...op, name }
}

/**
 * Run a batch of skill operations atomically.
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @param {object} options
 * @param {any[]} options.ops - operations in order.
 * @param {{ cwd: string, known: boolean }} options.session - session directory.
 * @param {(name: string) => Promise<{ path: string, source?: string } | undefined>} [options.lookup]
 *   catalog lookup.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<{ success: boolean, applied?: number, results?: object[], error?: string, code?: string, rolled_back?: boolean }>}
 */
export async function runSkillOps(rt, { ops, session, lookup, signal }) {
  // Curator actions address the skill library, not one skill's files, so they
  // run alone: pin/unpin protect a skill from archiving, curate runs the pass.
  const single = ops.length === 1 ? ops[0] : undefined
  const curatorAction = single?.action
  if (curatorAction === 'pin' || curatorAction === 'unpin') {
    return setSkillPin(rt, { name: single.name, pinned: curatorAction === 'pin', cwd: session?.cwd })
  }
  if (curatorAction === 'curate') {
    if (rt.config.skillCurator !== true) {
      return { success: false, error: 'The skill curator is disabled: set `skillCurator: true` in the plugin config first.' }
    }
    return runSkillCurator(rt, { cwd: session?.cwd, force: true })
  }
  if (curatorAction === 'scan') {
    return scanSkills(rt, { cwd: session?.cwd })
  }
  const roots = await skillRoots(rt.paths, rt.config, session.cwd)
  let plan
  try {
    plan = ops.map((op, index) => validateOp(op ?? {}, index + 1))
  } catch (error) {
    // A malformed operation is refused before anything is touched.
    return { success: false, error: errorMessage(error), code: error?.code ?? 'INVALID_OP', applied: [] }
  }
  // One batch at a time per host: sessions share the skill roots.
  return withLock('skills', async () => {
    const journal = []
    const results = []
    try {
      for (const op of plan) {
        signal?.throwIfAborted()
        results.push(await executeOp(rt, op, { roots, session, lookup, journal }))
      }
    } catch (error) {
      for (const undo of journal.reverse()) {
        try {
          await undo()
        } catch {
          // Best effort: the error below names what failed; trash and history keep the data.
        }
      }
      // A cancelled call reports what was rolled back instead of throwing the
      // abort: the host replaces the result with ABORTED either way.
      return {
        success: false,
        error: signal?.aborted === true ? 'Cancelled; every operation of this batch was rolled back.' : errorMessage(error),
        code: signal?.aborted === true ? 'ABORTED' : (error?.code ?? 'SKILL_OP_FAILED'),
        applied: results,
        rolled_back: journal.length > 0,
      }
    }
    return { success: true, applied: results.length, results }
  })
}

/**
 * Read a file for a journal entry: bytes when it exists, undefined otherwise.
 * @param {string} file - path.
 * @returns {Promise<Buffer | undefined>} bytes.
 */
async function snapshot(file) {
  return readBytes(file)
}

/**
 * Restore a journaled file.
 * @param {string} file - path.
 * @param {Buffer | undefined} before - previous bytes.
 * @returns {Promise<void>}
 */
async function restore(file, before) {
  if (before === undefined) await removeFile(file)
  else await writeFileAtomic(file, before)
}

/**
 * Execute one validated operation.
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @param {any} op - validated op.
 * @param {{ roots: object[], session: { cwd: string, known: boolean }, lookup: Function, journal: Array<() => Promise<void>> }} ctx
 *   execution context with the rollback journal.
 * @returns {Promise<object>} the op result.
 */
async function executeOp(rt, op, { roots, session, lookup, journal }) {
  const maxBytes = rt.config.maxContentBytes ?? 262144
  const oversized = (label, text) => fail('TOO_LARGE', `${label} is ${Buffer.byteLength(text)} bytes; the limit is ${maxBytes}.`)

  if (op.action === 'create') {
    const existing = await locateSkill({ name: op.name, roots, lookup })
    if (existing !== undefined) throw fail('EXISTS', `Skill "${op.name}" already exists at ${existing.path}; use patch or edit.`)
    const root = await createRoot(rt.paths, rt.config, session, op.scope)
    const dir = path.join(root.path, op.name)
    const file = path.join(dir, 'SKILL.md')
    const text = splitFrontmatter(op.content).has ? op.content : buildSkillText(op.name, op.description, op.content)
    const problem = validateSkillText(text, op.name)
    if (problem !== undefined) throw fail('INVALID_SKILL', problem)
    if (Buffer.byteLength(text) > maxBytes) throw oversized('SKILL.md', text)
    const dirExisted = await stat(dir).then(() => true, () => false)
    await mkdir(dir, { recursive: true })
    if (!dirExisted) journal.push(() => rm(dir, { recursive: true, force: true }))
    const previous = await snapshot(file)
    journal.push(() => restore(file, previous))
    await writeFileAtomic(file, text.endsWith('\n') ? text : `${text}\n`)
    return { action: 'create', name: op.name, path: file, source: root.kind, message: `Skill "${op.name}" created.` }
  }

  const found = await locateSkill({ name: op.name, roots, lookup })
  if (found === undefined) {
    throw fail('NOT_FOUND', `Skill "${op.name}" was not found in the session catalog or under ${roots.map(root => root.path).join(', ')}.`)
  }
  const skillFile = await realPath(found.path)
  const flat = path.basename(skillFile) !== 'SKILL.md'
  const skillDir = path.dirname(skillFile)
  const result = { action: op.action, name: op.name, path: skillFile, source: found.source }
  if (op.action !== 'view' && isProtectedPath(skillFile, rt.config.installDir)) {
    throw fail('PROTECTED', `"${op.name}" lives inside the installation (${skillFile}) and is read-only: edits there are lost on upgrade. Create a user skill that shadows it instead (scope 'user').`)
  }

  switch (op.action) {
    case 'view': {
      const bytes = await readBytes(skillFile)
      const text = bytes === undefined ? '' : (utf8(bytes) ?? '')
      const files = flat ? [] : (await listFiles(skillDir, { maxDepth: 3, maxFiles: 200 }))
        .filter(file => file !== skillFile)
        .map(file => path.relative(skillDir, file))
      const bounded = truncate(text, rt.config.viewMaxChars ?? 20000)
      return { ...result, content: bounded.text, truncated: bounded.truncated, files, protected: isProtectedPath(skillFile, rt.config.installDir) }
    }
    case 'patch': {
      if (flat && op.file_path != null) throw fail('INVALID_OP', `"${op.name}" is a flat single-file skill; patch it without file_path.`)
      const target = await resolveTarget(skillDir, skillFile, op.file_path)
      const bytes = await readBytes(target)
      if (bytes === undefined) throw fail('NOT_FOUND', `${op.file_path ?? 'SKILL.md'} does not exist in skill "${op.name}".`)
      const before = utf8(bytes)
      if (before === undefined) throw fail('INVALID_OP', `${path.relative(skillDir, target)} is not UTF-8 text and cannot be patched.`)
      const count = before.split(op.old_string).length - 1
      if (count === 0) throw fail('NO_MATCH', `old_string was not found in ${path.relative(skillDir, target)}. View the file and copy the text verbatim.`)
      if (count > 1 && op.replace_all !== true) {
        throw fail('AMBIGUOUS', `old_string occurs ${count} times in ${path.relative(skillDir, target)}; include more surrounding text or set replace_all.`)
      }
      const after = op.replace_all === true ? before.split(op.old_string).join(op.new_string) : before.replace(op.old_string, () => op.new_string)
      if (path.basename(target) === 'SKILL.md') {
        const problem = validateSkillText(after, splitFrontmatter(before).data.name ?? op.name)
        if (problem !== undefined) throw fail('INVALID_SKILL', problem)
      }
      await backup(rt, op.name, target, before)
      journal.push(() => restore(target, bytes))
      await writeFileAtomic(target, after)
      return { ...result, file: path.relative(skillDir, target), replacements: op.replace_all === true ? count : 1, message: 'Patched.' }
    }
    case 'edit': {
      if (flat) throw fail('INVALID_OP', `"${op.name}" is a flat single-file skill; patch it or recreate it as a directory.`)
      const bytes = await readBytes(skillFile)
      const before = bytes === undefined ? '' : (utf8(bytes) ?? '')
      const currentName = splitFrontmatter(before).data.name ?? op.name
      const problem = validateSkillText(op.content, currentName)
      if (problem !== undefined) throw fail('INVALID_SKILL', problem)
      if (Buffer.byteLength(op.content) > maxBytes) throw oversized('SKILL.md', op.content)
      await backup(rt, op.name, skillFile, before)
      journal.push(() => restore(skillFile, bytes))
      await writeFileAtomic(skillFile, op.content.endsWith('\n') ? op.content : `${op.content}\n`)
      return { ...result, message: 'SKILL.md rewritten.' }
    }
    case 'write_file': {
      if (flat) throw fail('INVALID_OP', `"${op.name}" is a flat single-file skill without supporting files.`)
      const target = path.join(skillDir, safeRelativeFile(op.file_path))
      if (Buffer.byteLength(op.file_content) > maxBytes) throw oversized(op.file_path, op.file_content)
      const bytes = await snapshot(target)
      if (bytes !== undefined) await backup(rt, op.name, target, utf8(bytes))
      journal.push(() => restore(target, bytes))
      await writeFileAtomic(target, op.file_content)
      return { ...result, file: op.file_path, path: target, message: `File "${op.file_path}" written.` }
    }
    case 'remove_file': {
      if (flat) throw fail('INVALID_OP', `"${op.name}" is a flat single-file skill without supporting files.`)
      const target = path.join(skillDir, safeRelativeFile(op.file_path))
      const bytes = await snapshot(target)
      if (bytes === undefined) {
        const available = (await listFiles(skillDir, { maxDepth: 3, maxFiles: 200 })).map(file => path.relative(skillDir, file))
        throw fail('NOT_FOUND', `File "${op.file_path}" not found in skill "${op.name}".`, { available })
      }
      await backup(rt, op.name, target, utf8(bytes))
      journal.push(() => restore(target, bytes))
      await removeFile(target)
      return { ...result, file: op.file_path, message: `File "${op.file_path}" removed.` }
    }
    case 'delete': {
      const container = flat ? skillFile : skillDir
      const parent = await realPath(path.dirname(container))
      const grandparent = await realPath(path.dirname(path.dirname(container)))
      const allowed = await Promise.all(roots.map(root => realPath(root.path)))
      // A skill sits directly in a root, or one category below it (Hermes hubs).
      if (!allowed.includes(parent) && !allowed.includes(grandparent)) {
        throw fail('PROTECTED', `Refusing to delete "${op.name}": ${container} is not a skill directly inside a scanned root or a category folder of one.`)
      }
      const trash = path.join(rt.paths.dataDir, 'trash', 'skills', `${timestamp()}-${randomSuffix()}-${op.name.replace('/', '--')}`)
      await movePath(container, trash)
      journal.push(() => movePath(trash, container))
      return { ...result, trash, message: `Skill "${op.name}" moved to trash (${trash}).` }
    }
    default:
      throw fail('INVALID_OP', `Unsupported action "${op.action}".`)
  }
}

/**
 * Resolve the file a patch targets.
 * @param {string} skillDir - skill directory.
 * @param {string} skillFile - the SKILL.md path.
 * @param {unknown} filePath - optional relative file path.
 * @returns {Promise<string>} absolute target.
 */
async function resolveTarget(skillDir, skillFile, filePath) {
  if (filePath === undefined || filePath === null || filePath === 'SKILL.md') return skillFile
  const relative = safeRelativeFile(filePath)
  if (relative === undefined) throw fail('INVALID_OP', `file_path must be a relative path under ${ALLOWED_SUBDIRS.join('/')}.`)
  return path.join(skillDir, relative)
}

/**
 * Snapshot a text file before it is overwritten (binary files are skipped).
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @param {string} name - validated skill name.
 * @param {string} file - file about to change.
 * @param {string | undefined} text - its current content, when UTF-8.
 * @returns {Promise<string | undefined>} snapshot path.
 */
function backup(rt, name, file, text) {
  if (text === undefined) return Promise.resolve(undefined)
  return saveHistory(rt.paths.dataDir, `skills/${name.replace('/', '--')}`, text, { ext: 'md', keep: rt.config.historyMax ?? 20 })
}
