// skillcurator.mjs — the skill half of the curator.
//
// Hermes' curator.py manages skills on a schedule: stale ones are archived,
// pinned ones are skipped, and nothing is ever deleted. This is the same
// policy without a scheduler or a model call:
//
//   - the age signal is the skill's own mtime, so a file nobody has touched is
//     the one that goes, and editing a skill resets its clock;
//   - a skill is MOVED (`rename`, EXDEV-safe) into
//     `<dataDir>/archive/skills/<date>/<name>` and named in an INDEX.md, so it
//     stays recoverable — the plugin never unlinks a skill;
//   - an archived skill leaves the shared hub, so the same skill disappears
//     from Hermes there. That is the point of archiving, and why it is
//     explicit: the automatic pass only runs above `skillCuratorMaxSkills`
//     (default 0 = never), while `skill_manage { action: 'curate' }` runs it
//     now.
//
// Pins live in `curator-skills.json` beside the memory curator's state and are
// keyed by skill name.

import { appendFile, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { readState, saveState } from './curator.mjs'
import { movePath, withLock } from './fsx.mjs'
import { SKILL_NAME, isSkillName } from './names.mjs'
import { skillRoots } from './skills.mjs'

/** Day in milliseconds. */
const DAY = 86400000

/**
 * Where the skill curator keeps its state.
 * @param {{ paths: object }} rt - plugin runtime.
 * @returns {string} path.
 */
export function skillStatePath(rt) {
  return path.join(rt.paths.dataDir, 'curator-skills.json')
}

/**
 * Every skill the curator may touch, with its age signal.
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @param {{ cwd?: string }} [options] - session directory for the project roots.
 * @returns {Promise<Array<{ name: string, path: string, kind: string, mtime: number, isDir: boolean }>>} skills.
 */
export async function discoverSkills(rt, { cwd } = {}) {
  const roots = await skillRoots(rt.paths, rt.config, cwd ?? process.cwd())
  const found = new Map()
  for (const root of roots) {
    let entries
    try {
      entries = await readdir(root.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKILL_NAME.test(entry.name)) continue
        const file = path.join(root.path, entry.name, 'SKILL.md')
        const info = await stat(file).catch(() => undefined)
        if (info?.isFile() !== true) continue
        if (!found.has(entry.name)) {
          found.set(entry.name, { name: entry.name, path: path.join(root.path, entry.name), kind: root.kind, mtime: info.mtimeMs, isDir: true })
        }
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'SKILL.md') continue
      const name = entry.name.slice(0, -'.md'.length)
      if (!isSkillName(name) || found.has(name)) continue
      const file = path.join(root.path, entry.name)
      const info = await stat(file).catch(() => undefined)
      if (info?.isFile() !== true) continue
      found.set(name, { name, path: file, kind: root.kind, mtime: info.mtimeMs, isDir: false })
    }
  }
  return [...found.values()]
}

/**
 * The catalogue with pin and age attached, without touching anything.
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @param {{ cwd?: string, now?: number }} [options] - directory and clock.
 * @returns {Promise<object>} report.
 */
export async function scanSkills(rt, { cwd, now = Date.now() } = {}) {
  const skills = await discoverSkills(rt, { cwd })
  const state = await readState(skillStatePath(rt))
  const staleDays = rt.config.curatorStaleDays ?? 14
  const rows = skills.map(skill => {
    const age = (now - skill.mtime) / DAY
    const record = state.entries?.[skill.name]
    return {
      name: skill.name,
      kind: skill.kind,
      path: skill.path,
      age_days: Number(age.toFixed(1)),
      stale: age >= staleDays && record?.pinned !== true,
      pinned: record?.pinned === true,
    }
  })
  return { total: rows.length, stale: rows.filter(row => row.stale), pinned: rows.filter(row => row.pinned), rows }
}

/**
 * Archive stale, unpinned skills. Never deletes: every skill is moved into the
 * archive tree and named in its INDEX.md.
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @param {object} [options] - run options.
 * @param {string} [options.cwd] - session directory for the project roots.
 * @param {number} [options.now] - clock, for tests.
 * @param {boolean} [options.force] - archive every stale skill, ignoring the
 *   `skillCuratorMaxSkills` ceiling.
 * @returns {Promise<object>} report.
 */
export async function runSkillCurator(rt, { cwd, now = Date.now(), force = false } = {}) {
  const staleDays = rt.config.curatorStaleDays ?? 14
  const deepDays = rt.config.curatorDeepDays ?? 30
  const ceiling = force ? 0 : (rt.config.skillCuratorMaxSkills ?? 0)
  // One run never sweeps the library: a hub of reference skills is mostly
  // untouched by nature, so archiving is bounded and reported as capped.
  const batch = Number.isSafeInteger(rt.config.skillCuratorBatch) && rt.config.skillCuratorBatch > 0 ? rt.config.skillCuratorBatch : 10
  const archiveRoot = path.join(rt.paths.dataDir, 'archive', 'skills')
  const statePath = skillStatePath(rt)

  return withLock('curator:skills', async () => {
    const skills = await discoverSkills(rt, { cwd })
    const state = await readState(statePath)
    const stamp = new Date(now).toISOString()
    const next = { version: 1, entries: {} }
    for (const skill of skills) {
      const previous = state.entries?.[skill.name]
      next.entries[skill.name] = {
        first: previous?.first ?? stamp,
        last: stamp,
        path: skill.path,
        ...(previous?.pinned === true ? { pinned: true } : {}),
      }
    }
    await saveState(statePath, next)

    if (ceiling > 0 && skills.length <= ceiling) {
      return { success: true, reason: 'under_ceiling', total: skills.length, ceiling, archived: [] }
    }

    const candidates = skills
      .map(skill => ({ skill, record: next.entries[skill.name], age: (now - skill.mtime) / DAY }))
      .filter(item => item.record.pinned !== true && item.age >= staleDays)
      .sort((a, b) => b.age - a.age)
    if (candidates.length === 0) {
      return { success: true, reason: 'nothing_stale', total: skills.length, pinned: Object.values(next.entries).filter(record => record.pinned === true).length, archived: [] }
    }

    const planned = candidates.slice(0, batch)
    const archiveDir = path.join(archiveRoot, new Date(now).toISOString().slice(0, 10))
    await mkdir(archiveDir, { recursive: true })
    const index = path.join(archiveRoot, 'INDEX.md')
    const archived = []
    for (const item of planned) {
      const deep = item.age >= deepDays
      const target = path.join(archiveDir, `${deep ? 'deep-' : ''}${item.skill.name}${item.skill.isDir ? '' : '.md'}`)
      await movePath(item.skill.path, target)
      const line = `- ${stamp} · ${deep ? 'deep ' : ''}stale ${Math.floor(item.age)}d · ${item.skill.name} · ${item.skill.kind} · from ${item.skill.path} → ${target}\n`
      await appendFile(index, line, 'utf8')
      archived.push({ name: item.skill.name, age_days: Math.floor(item.age), deep, from: item.skill.path, to: target })
    }
    return {
      success: true,
      total: skills.length - archived.length,
      scanned: skills.length,
      pinned: Object.values(next.entries).filter(record => record.pinned === true).length,
      archived,
      archive: archiveDir,
      manifest: index,
      state: statePath,
      batch,
      capped: candidates.length > planned.length,
      remaining_candidates: candidates.length - planned.length,
      message: `Archived ${archived.length} skills (moved, never deleted); ${skills.length - archived.length} left.`
        + (candidates.length > planned.length ? ` ${candidates.length - planned.length} more candidates wait for the next run.` : ''),
    }
  })
}

/**
 * Pin or unpin one skill by name.
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @param {{ name: string, pinned?: boolean, cwd?: string, now?: number }} options - pin options.
 * @returns {Promise<object>} result.
 */
export async function setSkillPin(rt, { name, pinned = true, cwd, now = Date.now() } = {}) {
  const key = typeof name === 'string' ? name.trim() : ''
  if (!isSkillRefName(key)) return { success: false, error: `'${name}' is not a skill name.` }
  const skills = await discoverSkills(rt, { cwd })
  const skill = skills.find(item => item.name === key)
  if (skill === undefined) return { success: false, error: `no skill named '${key}' was found in the scanned roots.`, available: skills.slice(0, 10).map(item => item.name) }
  const statePath = skillStatePath(rt)
  return withLock('curator:skills', async () => {
    const state = await readState(statePath)
    const stamp = new Date(now).toISOString()
    const previous = state.entries?.[key]
    state.entries = {
      ...state.entries,
      [key]: {
        first: previous?.first ?? stamp,
        last: stamp,
        path: skill.path,
        ...(pinned ? { pinned: true } : {}),
      },
    }
    if (!pinned) delete state.entries[key].pinned
    await saveState(statePath, state)
    return {
      success: true,
      name: key,
      pinned,
      pinned_count: Object.values(state.entries).filter(record => record.pinned === true).length,
      state: statePath,
      message: pinned ? 'Skill pinned: the curator never archives it.' : 'Skill unpinned.',
    }
  })
}

/**
 * Whether a string is a skill name, nested or flat.
 * @param {string} value - candidate.
 * @returns {boolean} valid.
 */
function isSkillRefName(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  const parts = value.split('/')
  return parts.length <= 2 && parts.every(part => isSkillName(part))
}
