// skillcurator.mjs — the skill half of the curator, at parity with Hermes'
// curator.py:
//
//   - inactivity-triggered, no cron: a run happens when the agent has been idle
//     for `skillCuratorMinIdleHours` and the last run is older than
//     `skillCuratorIntervalHours` (default 7 days). The first observation only
//     seeds `last_run_at`, so a fresh install never mutates the library.
//   - only curator-managed skills are touched: a skill becomes managed the
//     moment `skill_manage` creates or edits it, and nothing else in the shared
//     hub is ever a candidate.
//   - never delete, only archive: a skill is MOVED (EXDEV-safe) into
//     `<dataDir>/archive/skills/<date>/` and named in that tree's INDEX.md.
//   - pinned skills bypass the age; `paused` stops the scheduler; consolidation
//     is an opt-in LLM pass that merges a cluster into an umbrella skill and
//     archives the sources.

import { appendFile, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { movePath, withLock, writeFileAtomic } from './fsx.mjs'
import { SKILL_NAME, isSkillName } from './names.mjs'
import { skillRoots } from './skills.mjs'
import { readText } from './fsx.mjs'
import { condenseRoute } from './condense.mjs'

/** Milliseconds in a day and an hour. */
const DAY = 86400000
const HOUR = 3600000

/** Hermes' defaults. */
export const DEFAULT_INTERVAL_HOURS = 24 * 7
export const DEFAULT_MIN_IDLE_HOURS = 2

/**
 * Where the skill curator keeps its state.
 * @param {{ paths: object }} rt - plugin runtime.
 * @returns {string} path.
 */
export function skillStatePath(rt) {
  return path.join(rt.paths.dataDir, 'curator-skills.json')
}

/**
 * A fresh state document.
 * @returns {object} state.
 */
export function emptySkillState() {
  return { version: 3, paused: false, last_run_at: null, run_count: 0, last_run_summary: null, last_report_path: null, last_run_duration_seconds: null, entries: {} }
}

/**
 * Read the state, tolerating a missing or corrupt file.
 * @param {{ paths: object }} rt - plugin runtime.
 * @returns {Promise<object>} state.
 */
export async function loadSkillState(rt) {
  const raw = await readText(skillStatePath(rt)).catch(() => undefined)
  if (raw === undefined) return emptySkillState()
  try {
    const value = JSON.parse(raw)
    if (value === null || typeof value !== 'object') return emptySkillState()
    // Always the current schema version: an older file is upgraded in memory and
    // rewritten on the next save, so a half-migrated file never persists.
    return { ...emptySkillState(), ...value, version: 3, entries: typeof value.entries === 'object' && value.entries !== null ? value.entries : {} }
  } catch {
    return emptySkillState()
  }
}

/**
 * Write the state atomically.
 * @param {{ paths: object }} rt - plugin runtime.
 * @param {object} state - state.
 * @returns {Promise<void>} completion.
 */
export async function saveSkillState(rt, state) {
  const file = skillStatePath(rt)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * Record that the agent owns this skill now.
 *
 * Called from the skill write path while it holds the skills lock, so it takes
 * no curator lock of its own: it is a best-effort merge-and-write, and a lost
 * race only means the skill is picked up on the next write.
 * @param {{ paths: object }} rt - plugin runtime.
 * @param {string[]} names - skill names the batch touched.
 * @param {{ now?: number }} [options] - clock.
 * @returns {Promise<void>} completion.
 */
export async function markManaged(rt, names, { now = Date.now() } = {}) {
  const list = [...new Set(names.filter(name => typeof name === 'string' && name.length > 0))]
  if (list.length === 0) return
  const state = await loadSkillState(rt)
  const stamp = new Date(now).toISOString()
  for (const name of list) {
    const previous = state.entries[name]
    // A write revives the skill: the marker exists so a pass can be undone
    // without moving a file, not to punish busy projects.
    state.entries[name] = { ...previous, managed: true, first: previous?.first ?? stamp, last: stamp, state: 'active' }
    delete state.entries[name].stale_since
  }
  await saveSkillState(rt, state).catch(() => {})
}

/**
 * Forget a skill the batch removed.
 * @param {{ paths: object }} rt - plugin runtime.
 * @param {string[]} names - skill names.
 * @returns {Promise<void>} completion.
 */
export async function forgetManaged(rt, names) {
  const list = names.filter(name => typeof name === 'string' && name.length > 0)
  if (list.length === 0) return
  const state = await loadSkillState(rt)
  let changed = false
  for (const name of list) {
    if (state.entries[name] !== undefined) {
      delete state.entries[name]
      changed = true
    }
  }
  if (changed) await saveSkillState(rt, state).catch(() => {})
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
 * The managed catalogue with pin and age attached, without touching anything.
 * Unmanaged skills are listed only as a count: they are never candidates.
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @param {{ cwd?: string, now?: number, limit?: number }} [options] - directory, clock, row limit.
 * @returns {Promise<object>} report.
 */
export async function scanSkills(rt, { cwd, now = Date.now(), limit } = {}) {
  const staleDays = rt.config.curatorStaleDays ?? 14
  const deepDays = rt.config.curatorDeepDays ?? 30
  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : (rt.config.skillCuratorScanLimit ?? 20)
  const [skills, state] = await Promise.all([discoverSkills(rt, { cwd }), loadSkillState(rt)])
  const rows = []
  for (const skill of skills) {
    const record = state.entries[skill.name]
    if (record?.managed !== true) continue
    const age = (now - skill.mtime) / DAY
    rows.push({
      name: skill.name,
      kind: skill.kind,
      path: skill.path,
      age_days: Number(age.toFixed(1)),
      state: record.state ?? 'active',
      stale_since: record.stale_since,
      archivable: age >= deepDays,
      stale: age >= staleDays && record.pinned !== true,
      archivable: age >= deepDays,
      pinned: record.pinned === true,
    })
  }
  const stale = rows.filter(row => row.age_days >= staleDays && row.pinned !== true).sort((a, b) => b.age_days - a.age_days)
  return {
    scanned: skills.length,
    managed: rows.length,
    unmanaged_ignored: skills.length - rows.length,
    stale_total: stale.length,
    archivable_total: stale.filter(row => row.archivable).length,
    stale: stale.slice(0, cap).map(({ path: skillPath, ...row }) => row),
    pinned: rows.filter(row => row.pinned).map(row => row.name),
    paused: state.paused === true,
    last_run_at: state.last_run_at,
    interval_hours: rt.config.skillCuratorIntervalHours ?? DEFAULT_INTERVAL_HOURS,
    stale_days: staleDays,
    deep_days: deepDays,
    limit: cap,
  }
}

/**
 * Whether a scheduled run is due.
 *
 * Mirrors Hermes: paused or disabled stops it, the first observation only
 * seeds `last_run_at` and defers one interval, and a run waits until the agent
 * has been idle for `minIdleHours`.
 * @param {{ state: object, now?: number, lastActivity?: number, intervalHours?: number, minIdleHours?: number }} input - state, clock, activity.
 * @returns {{ due: boolean, reason: string, seed?: boolean }} decision.
 */
export function curatorDue({ state, now = Date.now(), lastActivity, intervalHours = DEFAULT_INTERVAL_HOURS, minIdleHours = DEFAULT_MIN_IDLE_HOURS } = {}) {
  if (state?.paused === true) return { due: false, reason: 'paused' }
  if (state?.last_run_at === null || state?.last_run_at === undefined) return { due: false, reason: 'not_seeded', seed: true }
  const last = Date.parse(state.last_run_at)
  if (!Number.isFinite(last)) return { due: false, reason: 'not_seeded', seed: true }
  if (now - last < intervalHours * HOUR) return { due: false, reason: 'interval' }
  // No activity observed yet means the process just started: treat it as
  // active, so a fresh boot never looks like a week of silence.
  const idle = Number.isFinite(lastActivity) ? now - lastActivity : 0
  if (idle < minIdleHours * HOUR) return { due: false, reason: 'idle' }
  return { due: true, reason: 'due' }
}

/**
 * Pause or resume the scheduler.
 * @param {{ paths: object }} rt - plugin runtime.
 * @param {boolean} paused - desired state.
 * @returns {Promise<object>} result.
 */
export async function setSkillPaused(rt, paused) {
  return withLock('curator:skills', async () => {
    const state = await loadSkillState(rt)
    state.paused = paused === true
    await saveSkillState(rt, state)
    return { success: true, paused: state.paused, state: skillStatePath(rt), message: state.paused ? 'Skill curator paused.' : 'Skill curator resumed.' }
  })
}

/**
 * Pin or unpin one managed skill by name.
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
  return withLock('curator:skills', async () => {
    const state = await loadSkillState(rt)
    const stamp = new Date(now).toISOString()
    const previous = state.entries[key] ?? {}
    state.entries[key] = {
      ...previous,
      managed: true,
      first: previous.first ?? stamp,
      last: stamp,
      path: skill.path,
      state: 'active',
      ...(pinned ? { pinned: true } : {}),
    }
    delete state.entries[key].stale_since
    if (!pinned) delete state.entries[key].pinned
    await saveSkillState(rt, state)
    return {
      success: true,
      name: key,
      pinned,
      pinned_count: Object.values(state.entries).filter(record => record.pinned === true).length,
      state: skillStatePath(rt),
      message: pinned ? 'Skill pinned: the curator never archives it.' : 'Skill unpinned.',
    }
  })
}

/**
 * Archive stale, unpinned, MANAGED skills. Never deletes.
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @param {{ cwd?: string, now?: number, force?: boolean }} [options] - run options.
 * @returns {Promise<object>} report.
 */
export async function runSkillCurator(rt, { cwd, now = Date.now(), force = false } = {}) {
  const startedAt = Date.now()
  const staleDays = rt.config.curatorStaleDays ?? 14
  const archiveDays = rt.config.curatorDeepDays ?? 30
  const batch = Number.isSafeInteger(rt.config.skillCuratorBatch) && rt.config.skillCuratorBatch > 0 ? rt.config.skillCuratorBatch : 10
  const archiveRoot = path.join(rt.paths.dataDir, 'archive', 'skills')

  return withLock('curator:skills', async () => {
    const [skills, state] = await Promise.all([discoverSkills(rt, { cwd }), loadSkillState(rt)])
    const stamp = new Date(now).toISOString()
    const live = new Map(skills.map(skill => [skill.name, skill]))

    // Hermes' three states: active → stale (a marker, the file stays) → archived
    // (moved, never deleted). A write or a pin returns a skill to active.
    const markedStale = []
    const revived = []
    const archivable = []
    for (const [name, record] of Object.entries(state.entries)) {
      const skill = live.get(name)
      if (skill === undefined) {
        if (record.managed === true) delete state.entries[name]
        continue
      }
      if (record.managed !== true) continue
      const age = (now - skill.mtime) / DAY
      if (record.pinned === true) {
        if (record.state !== 'active' || record.stale_since !== undefined) {
          record.state = 'active'
          delete record.stale_since
          revived.push(name)
        }
        continue
      }
      if (age >= archiveDays) {
        archivable.push({ skill, record, age })
        continue
      }
      if (age >= staleDays) {
        if (record.state !== 'stale') {
          record.state = 'stale'
          record.stale_since = stamp
          markedStale.push({ name, age_days: Math.floor(age) })
        }
        continue
      }
      if (record.state !== 'active' || record.stale_since !== undefined) {
        record.state = 'active'
        delete record.stale_since
        revived.push(name)
      }
    }
    archivable.sort((a, b) => b.age - a.age)

    const planned = archivable.slice(0, batch)
    const archiveDir = path.join(archiveRoot, new Date(now).toISOString().slice(0, 10))
    const index = path.join(archiveRoot, 'INDEX.md')
    const archived = []
    if (planned.length > 0) {
      await mkdir(archiveDir, { recursive: true })
      for (const item of planned) {
        const target = path.join(archiveDir, `${item.skill.name}${item.skill.isDir ? '' : '.md'}`)
        await movePath(item.skill.path, target)
        await appendFile(index, `- ${stamp} · stale ${Math.floor(item.age)}d · ${item.skill.name} · ${item.skill.kind} · from ${item.skill.path} → ${target}\n`, 'utf8')
        delete state.entries[item.skill.name]
        archived.push({ name: item.skill.name, age_days: Math.floor(item.age), from: item.skill.path, to: target })
      }
    }

    state.last_run_at = stamp
    state.run_count = (state.run_count ?? 0) + 1
    const summary = `stale ${markedStale.length} · archived ${archived.length} · revived ${revived.length}`
    state.last_run_summary = summary
    const reason = archived.length > 0 ? 'archived' : markedStale.length > 0 ? 'marked_stale' : 'nothing_stale'
    const report = await writeRunReport(rt, {
      now,
      trigger: force ? 'curate' : 'run',
      durationMs: Date.now() - startedAt,
      summary,
      scanned: skills.length,
      managed: Object.keys(state.entries).length + archived.length,
      markedStale,
      revived,
      archived,
      archiveDir,
    })
    state.last_report_path = report
    state.last_run_duration_seconds = Number(((Date.now() - startedAt) / 1000).toFixed(2))
    await saveSkillState(rt, state)
    return {
      success: true,
      reason,
      scanned: skills.length,
      managed: Object.keys(state.entries).length,
      marked_stale: markedStale,
      revived,
      archived,
      archive: archived.length > 0 ? archiveDir : undefined,
      manifest: archived.length > 0 ? index : undefined,
      report,
      batch,
      capped: archivable.length > planned.length,
      remaining_candidates: archivable.length - planned.length,
      state: skillStatePath(rt),
      message: `Stale ${markedStale.length}, archived ${archived.length}, revived ${revived.length}; ${Object.keys(state.entries).length} managed left.`
        + (archivable.length > planned.length ? ` ${archivable.length - planned.length} more archivable wait for the next run.` : ''),
    }
  })
}

/**
 * Append one run report under `<dataDir>/reports/<date>.md`: the durable audit
 * trail Hermes keeps, so a run can be explained after the fact.
 * @param {{ paths: object }} rt - plugin runtime.
 * @param {object} run - what the run did.
 * @returns {Promise<string>} report path.
 */
export async function writeRunReport(rt, run) {
  const dir = path.join(rt.paths.dataDir, 'reports')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${new Date(run.now).toISOString().slice(0, 10)}.md`)
  const lines = [
    `## ${new Date(run.now).toISOString()} · ${run.trigger} · ${run.durationMs}ms`,
    `- scanned ${run.scanned}, managed ${run.managed}, ${run.summary}`,
    ...run.markedStale.map(item => `- stale ${item.name} (${item.age_days}d)`),
    ...run.revived.map(name => `- revived ${name}`),
    ...run.archived.map(item => `- archived ${item.name} (stale ${item.age_days}d) → ${item.to}`),
    '',
  ]
  const text = `${lines.join('\n')}\n`
  await appendFile(file, text, 'utf8')
  return file
}

/**
 * Move one skill into the archive whatever its age: the consolidation pass
 * replaces its sources with an umbrella, so they must leave the root even
 * though they are fresh.
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @param {{ name: string, cwd?: string, now?: number, reason?: string }} options - what to archive.
 * @returns {Promise<object | undefined>} the archived record.
 */
export async function archiveSkill(rt, { name, cwd, now = Date.now(), reason = 'consolidated' }) {
  const archiveRoot = path.join(rt.paths.dataDir, 'archive', 'skills')
  return withLock('curator:skills', async () => {
    const skills = await discoverSkills(rt, { cwd })
    const skill = skills.find(item => item.name === name)
    if (skill === undefined) return undefined
    const archiveDir = path.join(archiveRoot, new Date(now).toISOString().slice(0, 10))
    await mkdir(archiveDir, { recursive: true })
    const target = path.join(archiveDir, `${skill.name}${skill.isDir ? '' : '.md'}`)
    await movePath(skill.path, target)
    await appendFile(path.join(archiveRoot, 'INDEX.md'), `- ${new Date(now).toISOString()} · ${reason} · ${skill.name} · ${skill.kind} · from ${skill.path} → ${target}\n`, 'utf8')
    const state = await loadSkillState(rt)
    delete state.entries[skill.name]
    await saveSkillState(rt, state)
    return { name: skill.name, from: skill.path, to: target, reason }
  })
}

/**
 * Candidate clusters for the opt-in consolidation pass: managed skills whose
 * descriptions share most of their words.
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @param {{ cwd?: string, maxClusters?: number }} [options] - bounds.
 * @returns {Promise<Array<{ names: string[], path: string }>>} clusters.
 */
export async function consolidationClusters(rt, { cwd, maxClusters = 2 } = {}) {
  const [skills, state] = await Promise.all([discoverSkills(rt, { cwd }), loadSkillState(rt)])
  const rows = skills
    .filter(skill => state.entries[skill.name]?.managed === true && state.entries[skill.name]?.pinned !== true)
    .map(skill => ({ skill, words: new Set(tokenize(nameOf(skill))) }))
  const clusters = []
  const taken = new Set()
  for (let i = 0; i < rows.length; i += 1) {
    if (taken.has(i) || rows[i].words.size === 0) continue
    const group = [rows[i].skill]
    taken.add(i)
    for (let j = i + 1; j < rows.length; j += 1) {
      if (taken.has(j) || rows[j].words.size === 0) continue
      if (jaccard(rows[i].words, rows[j].words) >= 0.6) {
        group.push(rows[j].skill)
        taken.add(j)
      }
    }
    if (group.length >= 2) clusters.push({ names: group.map(skill => skill.name), path: group[0].path })
    if (clusters.length >= maxClusters) break
  }
  return clusters
}

/**
 * Run one consolidation pass: for each cluster, one model call proposes an
 * umbrella skill; the umbrella is written and the sources are archived.
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @param {object} options - run options.
 * @param {object} [options.llm] - host LLM service.
 * @param {{ provider: string, model: string }} [options.route] - model route.
 * @param {string} [options.cwd] - session directory.
 * @param {number} [options.now] - clock.
 * @param {number} [options.maxClusters] - clusters per run.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<object>} report.
 */
export async function consolidateSkills(rt, { llm, route, cwd, now = Date.now(), maxClusters = 2, signal } = {}) {
  if (llm === undefined || typeof llm.stream !== 'function' || route === undefined) {
    return { success: false, error: 'no model route for consolidation', consolidated: [] }
  }
  const clusters = await consolidationClusters(rt, { cwd, maxClusters })
  if (clusters.length === 0) return { success: true, reason: 'no_clusters', consolidated: [] }
  const merged = []
  for (const cluster of clusters) {
    const texts = await Promise.all(cluster.names.map(async name => {
      const skills = await discoverSkills(rt, { cwd })
      const skill = skills.find(item => item.name === name)
      if (skill === undefined) return undefined
      const file = path.join(skill.path, 'SKILL.md')
      return { name, text: await readText(file).catch(() => undefined) }
    }))
    const present = texts.filter(item => item !== undefined && typeof item.text === 'string')
    if (present.length < 2) continue
    const plan = await callModel(llm, route, consolidationInstruction(present), signal)
    if (plan === undefined) continue
    merged.push({ ...plan, sources: present.map(item => item.name), path: cluster.path })
  }
  return { success: true, clusters: clusters.length, proposed: merged.length, consolidated: merged }
}

/**
 * Merge one accepted consolidation proposal: write the umbrella, archive the
 * sources. Called by the tool after the model proposes.
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @param {{ name: string, content: string, description?: string, sources: string[], cwd?: string, now?: number }} proposal - accepted merge.
 * @returns {Promise<object>} result.
 */
export async function applyConsolidation(rt, { name, content, description, sources, cwd, now = Date.now() }) {
  const { runSkillOps } = await import('./skills.mjs')
  const write = await runSkillOps(rt, {
    ops: [{ action: 'create', name, content, ...(typeof description === 'string' ? { description } : {}), scope: 'user' }],
    session: { cwd: cwd ?? process.cwd(), known: false },
  })
  if (write.success !== true) return { success: false, error: 'the umbrella skill could not be written', write }
  const archived = []
  for (const source of sources) {
    if (source === name) continue
    const record = await archiveSkill(rt, { name: source, cwd, now, reason: `consolidated into ${name}` })
    if (record !== undefined) archived.push(record)
  }
  return { success: true, name, write, archived }
}

/**
 * The model route for consolidation: a pinned curator/condense pair first, then
 * the session's own route when the caller has one.
 * @param {Record<string, any>} config - plugin config.
 * @param {{ requestHeader?: () => any }} [session] - live session, when there is one.
 * @returns {{ provider: string, model: string } | undefined} route.
 */
export function consolidationRoute(config, session) {
  return condenseRoute({
    pinned: { provider: config.skillCuratorProvider ?? config.condenseProvider, model: config.skillCuratorModel ?? config.condenseModel },
    routed: session?.requestHeader?.()?.config,
  })
}

/**
 * The consolidation instruction for one cluster.
 * @param {Array<{ name: string, text: string }>} skills - the cluster.
 * @returns {string} prompt.
 */
export function consolidationInstruction(skills) {
  return [
    'You maintain a library of agent skills. Several of them overlap; fold them into ONE umbrella skill.',
    'Answer with one <plan>…</plan> JSON object and nothing else:',
    '{"name":"kebab-case-name","description":"Use when …","content":"full SKILL.md text including frontmatter"}',
    'Rules: keep every rule, path, command and pitfall from the sources; merge the duplication instead of choosing one;',
    'the description says when to use the skill; never invent facts the sources do not contain.',
    '',
    ...skills.map(skill => `--- SKILL: ${skill.name}\n${skill.text}`),
  ].join('\n')
}

/**
 * One model call for consolidation, bounded by the session.
 * @param {object} llm - host LLM service.
 * @param {{ provider: string, model: string }} route - route.
 * @param {string} instruction - prompt.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ name: string, description?: string, content: string } | undefined>} the proposal.
 */
async function callModel(llm, route, instruction, signal) {
  const { readStream } = await import('./condense.mjs')
  const chunks = llm.stream({
    provider: route.provider,
    model: route.model,
    reasoningEffort: 'low',
    messages: [{ role: 'user', content: [{ type: 'text', text: instruction }] }],
    ...(signal === undefined ? {} : { signal }),
  })
  const read = await readStream(chunks)
  if (read.failure !== undefined || read.finish !== 'stop') return undefined
  const match = [...String(read.text).matchAll(/<plan>([\s\S]*?)<\/plan>/g)].pop()
  if (match === undefined) return undefined
  try {
    const value = JSON.parse(match[1])
    if (typeof value?.name !== 'string' || !isSkillRefName(value.name) || typeof value.content !== 'string') return undefined
    return { name: value.name, ...(typeof value.description === 'string' ? { description: value.description } : {}), content: value.content }
  } catch {
    return undefined
  }
}

/**
 * The frontmatter name of a skill, for clustering.
 * @param {{ path: string }} skill - skill.
 * @returns {string} name plus a description-ish key.
 */
function nameOf(skill) {
  return path.basename(skill.path)
}

/**
 * Lowercase word set.
 * @param {string} text - text.
 * @returns {string[]} words.
 */
function tokenize(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2)
}

/**
 * Jaccard similarity of two word sets.
 * @param {Set<string>} a - first.
 * @param {Set<string>} b - second.
 * @returns {number} similarity 0..1.
 */
function jaccard(a, b) {
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / (a.size + b.size - shared)
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
