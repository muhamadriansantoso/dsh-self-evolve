/**
 * Skill audit: the one place a model is asked whether a skill is still true.
 *
 * The curator is deterministic — age and references — so it can tell that a
 * skill was not used, never that its method is wrong. This pass reads a managed
 * skill and asks for one verdict: keep it, rewrite it (the whole file, so an
 * outdated procedure is replaced rather than appended to), or archive it when
 * another skill supersedes it.
 *
 * Boundaries: managed skills only, a small batch per run, never a delete, and a
 * rewrite that does not carry the same frontmatter name is refused. The old body
 * is snapshotted through the same history path every other write uses.
 */
import path from 'node:path'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { writeFileAtomic } from './fsx.mjs'
import { saveHistory } from './history.mjs'
import { splitFrontmatter } from './frontmatter.mjs'
import { isSkillName } from './names.mjs'
import { readStream } from './condense.mjs'
import { errorMessage } from './util.mjs'
import { archiveSkill, discoverSkills, loadSkillState, markManaged, saveSkillState } from './skillcurator.mjs'

/** Days without a write before a skill is worth auditing. */
export const DEFAULT_AUDIT_DAYS = 30
/** Skills one run may spend a model call on. */
export const DEFAULT_AUDIT_BATCH = 3
/** How much of a skill the prompt quotes. */
const MAX_AUDIT_BODY_CHARS = 8000
/** A rewrite bigger than this is treated as a mistake, not a skill. */
const MAX_AUDIT_WRITE_CHARS = 20000
const DAY = 86400000

/**
 * The instruction for one skill.
 * @param {{ name: string, body: string, ageDays: number, others: string[] }} input - skill facts.
 * @returns {string} prompt.
 */
export function auditInstruction({ name, body, ageDays, others }) {
  return [
    'You are auditing one skill in a shared library. Decide whether it is still correct and worth keeping.',
    '',
    'Rules:',
    '1. Answer with one <audit>…</audit> JSON object and nothing else.',
    '2. The object is {"verdict":"keep"|"rewrite"|"archive","reason":"one short sentence"} plus "content" only when the verdict is rewrite.',
    '3. keep — the procedure is still correct and useful. This is the default when you are unsure.',
    '4. rewrite — the method is outdated, wrong, or incomplete. "content" must be the COMPLETE new SKILL.md, frontmatter included, with the same "name" and a "description" that says when to use it. Replace the wrong steps; do not append a correction.',
    '5. archive — the skill is obsolete or another skill already covers it better. Name that skill in "reason" when one exists.',
    '6. Never invent paths, ports, commands, versions or identifiers that are not in the skill body.',
    '',
    `SKILL: ${name}`,
    `LAST WRITTEN: ${Math.floor(ageDays)} days ago`,
    '',
    'OTHER SKILLS (names only):',
    others.length === 0 ? '(none)' : others.slice(0, 120).join('\n'),
    '',
    'SKILL BODY:',
    body.length > MAX_AUDIT_BODY_CHARS ? `${body.slice(0, MAX_AUDIT_BODY_CHARS)}\n…` : body,
  ].join('\n')
}

/**
 * Read one verdict, tolerating the wrappers models add.
 * @param {string} text - model answer.
 * @returns {{ verdict: string, reason?: string, content?: string } | undefined} verdict.
 */
export function parseAudit(text) {
  const raw = String(text ?? '')
  const candidates = []
  const tagged = [...raw.matchAll(/<audit>([\s\S]*?)<\/audit>/g)].pop()
  if (tagged !== undefined) candidates.push(tagged[1])
  for (const fence of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(fence[1])
  const bare = raw.match(/\{[\s\S]*"verdict"[\s\S]*\}/)
  if (bare !== null) candidates.push(bare[0])
  for (const candidate of candidates) {
    let value
    try {
      value = JSON.parse(candidate.trim())
    } catch {
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    if (typeof value.verdict !== 'string') continue
    const verdict = value.verdict.trim().toLowerCase()
    if (!['keep', 'rewrite', 'archive'].includes(verdict)) continue
    return {
      verdict,
      ...(typeof value.reason === 'string' ? { reason: value.reason.trim().slice(0, 200) } : {}),
      ...(typeof value.content === 'string' ? { content: value.content } : {}),
    }
  }
  return undefined
}

/**
 * The route the audit asks: the curator's pinned pair, else the condenser's,
 * else the session's own.
 * @param {Record<string, any>} config - plugin config.
 * @param {any} [session] - live session.
 * @returns {{ provider: string, model: string } | undefined} route.
 */
export function auditRoute(config, session) {
  const header = session?.header ?? {}
  const pairs = [
    [config.skillCuratorAuditProvider ?? config.skillCuratorProvider, config.skillCuratorAuditModel ?? config.skillCuratorModel],
    [config.condenseProvider, config.condenseModel],
    [header.provider, header.model],
  ]
  for (const [provider, model] of pairs) {
    if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) return { provider, model }
  }
  return undefined
}

/**
 * One model call for one verdict, retried once without a reasoning effort the
 * route rejects.
 * @param {object} llm - host LLM service.
 * @param {{ provider: string, model: string }} route - route.
 * @param {string} instruction - prompt.
 * @param {number} timeoutMs - budget.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<string>} answer text.
 */
async function askModel(llm, route, instruction, timeoutMs, signal) {
  const ask = async effort => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('skill audit timeout')), timeoutMs)
    timer.unref?.()
    try {
      const chunks = llm.stream({
        provider: route.provider,
        model: route.model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        messages: [{ role: 'user', content: [{ type: 'text', text: instruction }] }],
        signal: signal ?? controller.signal,
      })
      const read = await readStream(chunks)
      if (read.failure !== undefined || read.finish !== 'stop') {
        const error = new Error(`skill audit ${String(read.failure?.code ?? read.finish ?? 'stream')}`)
        error.code = 'AUDIT_STREAM'
        throw error
      }
      return read.text
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    return await ask('low')
  } catch (error) {
    if (!/UNSUPPORTED_REASONING_EFFORT/i.test(String(error?.message ?? error))) throw error
    return await ask(undefined)
  }
}

/**
 * Apply one verdict to one skill.
 * @param {{ paths: object, config: Record<string, any> }} rt - plugin runtime.
 * @param {{ name: string, file: string, body: string }} skill - target.
 * @param {{ verdict: string, reason?: string, content?: string }} verdict - model verdict.
 * @param {{ cwd?: string, now: number }} options - run context.
 * @returns {Promise<{ name: string, verdict: string, applied: string, reason?: string }>} outcome.
 */
async function applyVerdict(rt, skill, verdict, { cwd, now }) {
  if (verdict.verdict === 'archive') {
    const archived = await archiveSkill(rt, { name: skill.name, cwd, now, reason: 'audit: obsolete' })
    return { name: skill.name, verdict: 'archive', applied: archived === undefined ? 'missing' : 'archived', ...(verdict.reason === undefined ? {} : { reason: verdict.reason }) }
  }
  if (verdict.verdict === 'rewrite') {
    const content = typeof verdict.content === 'string' ? verdict.content.trim() : ''
    const frontmatter = splitFrontmatter(content)
    const refused = content.length === 0
      ? 'empty_rewrite'
      : content.length > MAX_AUDIT_WRITE_CHARS
        ? 'too_large'
        : frontmatter.has !== true || frontmatter.data.name !== skill.name
          ? 'frontmatter_name_mismatch'
          : undefined
    if (refused !== undefined) {
      await touchAudited(rt, skill.name, now)
      return { name: skill.name, verdict: 'keep', applied: 'kept', reason: `rewrite refused: ${refused}` }
    }
    await saveHistory(rt.paths.dataDir, `skills/${skill.name}`, skill.body, { ext: 'md', keep: rt.config.historyMax ?? 20 })
    await writeFileAtomic(skill.file, `${content}\n`)
    await markManaged(rt, [skill.name])
    await touchAudited(rt, skill.name, now)
    return { name: skill.name, verdict: 'rewrite', applied: 'rewritten', ...(verdict.reason === undefined ? {} : { reason: verdict.reason }) }
  }
  await touchAudited(rt, skill.name, now)
  return { name: skill.name, verdict: 'keep', applied: 'kept', ...(verdict.reason === undefined ? {} : { reason: verdict.reason }) }
}

/**
 * Remember that a skill was audited, so the next run does not ask again.
 * @param {{ paths: object }} rt - plugin runtime.
 * @param {string} name - skill name.
 * @param {number} now - timestamp.
 * @returns {Promise<void>} resolves when saved.
 */
async function touchAudited(rt, name, now) {
  const state = await loadSkillState(rt)
  const record = state.entries[name]
  if (record === undefined) return
  record.audited_at = new Date(now).toISOString()
  await saveSkillState(rt, state)
}

/**
 * Audit the managed skills that have gone quiet.
 * @param {{ paths: object, config: Record<string, any>, limits?: object }} rt - plugin runtime.
 * @param {{ cwd?: string, llm?: object, session?: any, now?: number, signal?: AbortSignal }} [options] - run context.
 * @returns {Promise<{ skipped?: string, audited: object[], rewritten: number, archived: number, kept: number, error?: string }>} result.
 */
export async function runSkillAudit(rt, { cwd, llm, session, now = Date.now(), signal } = {}) {
  const empty = { audited: [], rewritten: 0, archived: 0, kept: 0 }
  if ((rt.config.skillCuratorAudit ?? false) !== true) return { ...empty, skipped: 'disabled' }
  if (llm === undefined || typeof llm.stream !== 'function') return { ...empty, skipped: 'no_llm' }
  const route = auditRoute(rt.config, session)
  if (route === undefined) return { ...empty, skipped: 'no_model' }
  const days = rt.config.skillCuratorAuditDays ?? DEFAULT_AUDIT_DAYS
  const batch = Number.isSafeInteger(rt.config.skillCuratorAuditBatch) && rt.config.skillCuratorAuditBatch > 0
    ? rt.config.skillCuratorAuditBatch
    : DEFAULT_AUDIT_BATCH
  const timeoutMs = rt.config.backgroundTimeoutMs ?? 30000

  const [skills, state] = await Promise.all([discoverSkills(rt, { cwd }), loadSkillState(rt)])
  const live = new Map(skills.map(skill => [skill.name, skill]))
  const others = skills.map(skill => skill.name)
  const candidates = []
  for (const [name, record] of Object.entries(state.entries)) {
    if (record.managed !== true) continue
    const skill = live.get(name)
    if (skill === undefined) continue
    const ageDays = (now - skill.mtime) / DAY
    if (ageDays < days) continue
    const auditedAt = record.audited_at === undefined ? 0 : Date.parse(record.audited_at)
    if (Number.isFinite(auditedAt) && now - auditedAt < days * DAY) continue
    candidates.push({ name, skill, ageDays })
  }
  candidates.sort((a, b) => b.ageDays - a.ageDays)

  const audited = []
  let error
  for (const candidate of candidates.slice(0, batch)) {
    const file = candidate.skill.isDir === true ? path.join(candidate.skill.path, 'SKILL.md') : candidate.skill.path
    const body = await readFile(file, 'utf8').catch(() => '')
    if (body.trim().length === 0) continue
    try {
      const answer = await askModel(llm, route, auditInstruction({
        name: candidate.name,
        body,
        ageDays: candidate.ageDays,
        others: others.filter(name => name !== candidate.name),
      }), timeoutMs, signal)
      const verdict = parseAudit(answer)
      if (verdict === undefined) {
        audited.push({ name: candidate.name, verdict: 'keep', applied: 'kept', reason: 'unreadable answer' })
        await touchAudited(rt, candidate.name, now)
        continue
      }
      audited.push(await applyVerdict(rt, { name: candidate.name, file, body }, verdict, { cwd, now }))
    } catch (failure) {
      error = errorMessage(failure)
      break
    }
  }

  const rewritten = audited.filter(item => item.applied === 'rewritten').length
  const archived = audited.filter(item => item.applied === 'archived').length
  const kept = audited.filter(item => item.applied === 'kept').length
  if (audited.length > 0) {
    const lines = [
      `## ${new Date(now).toISOString()} · audit · ${audited.length} skill(s)`,
      ...audited.map(item => `- ${item.verdict} ${item.name}${item.reason === undefined ? '' : ` — ${item.reason}`}`),
      '',
    ]
    const dir = path.join(rt.paths.dataDir, 'reports')
    await mkdir(dir, { recursive: true }).catch(() => {})
    await appendFile(path.join(dir, `${new Date(now).toISOString().slice(0, 10)}.md`), `${lines.join('\n')}\n`, 'utf8').catch(() => {})
  }
  return { audited, rewritten, archived, kept, ...(error === undefined ? {} : { error }) }
}
