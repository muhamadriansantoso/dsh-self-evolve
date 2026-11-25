// index.mjs — dsh-self-evolve plugin entry.
//
// Gives the agent the same self-editing tools Hermes Agent has, on the files
// DSH actually loads:
//
//   memory         add / patch / remove entries of MEMORY.md and the user
//                  profile block (Hermes-compatible operations batch)
//   persona_update view / replace / append / patch / section-edit the persona
//                  and soul blocks of ~/.dsh/AGENTS.md
//   skill_manage   create / patch / edit / write_file / remove_file / delete /
//                  view skills in every root DSH scans
//
// Plus a health route for the web UI (`GET <prefix>/health`) and an optional
// system-prompt note. A memory batch that would exceed its store's char limit
// is condensed first with one model call (lib/condense.mjs). Every Nth user
// turn, a store that is close to its limit is reviewed instead of waiting for
// the add that overflows it (lib/review.mjs).
//
// Only public host services are consumed: `tools` (hard dependency); `llm`,
// `skills`, `workingDirectory`, `systemPrompt` and `webServer` are optional
// and looked up per call, so a profile without them still gets the tools
// that do not need them (and an over-budget add is then simply rejected).

import { dirname } from 'node:path'
import { readFileSync } from 'node:fs'

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

import { parseEntries } from './lib/entries.mjs'
import { readDocument } from './lib/textstore.mjs'
import { backgroundRoute, readBackgroundStatus, runBackgroundReview, skillNames, turnEndReason, turnTranscript } from './lib/background.mjs'
import { condenseRoute, condenseWithLlm } from './lib/condense.mjs'
import { readText } from './lib/fsx.mjs'
import { isTrustedOrigin, sendJson } from './lib/http.mjs'
import { installNotices, queueNotice } from './lib/notice.mjs'
import { installReview, installSkillNudge, reviewDue, usageRows } from './lib/review.mjs'
import { applyConsolidation, consolidateSkills, consolidationRoute, curatorDue, loadSkillState, runSkillCurator, saveSkillState, scanSkills, DEFAULT_INTERVAL_HOURS, DEFAULT_MIN_IDLE_HOURS } from './lib/skillcurator.mjs'
import { discoverSkills } from './lib/skillcurator.mjs'
import { skillRoots } from './lib/skills.mjs'
import { resolvePaths, resolveStores } from './lib/stores.mjs'
import { memoryTool, personaTool, skillTool } from './lib/tools.mjs'

export const name = 'self-evolve'

// `tools` is the one service without which nothing here can exist.
export const inject = ['tools']

export const Config = Schema.object({
  dshHome: Schema.string().description('Harness home holding AGENTS.md, MEMORY.md and skills/. Default: $DSH_HOME or ~/.dsh.'),
  dataDir: Schema.string().description('Plugin data directory: history snapshots and the skill trash. Default: <dshHome>/self-evolve.'),
  agentsMd: Schema.string().description('User-global instruction file holding the persona, soul and user blocks. Default: <dshHome>/AGENTS.md.'),
  memoryFile: Schema.string().description('Entry store for the memory target. Default: <dshHome>/MEMORY.md.'),
  memoryMirrors: Schema.array(Schema.string()).default([]).description('Extra files written with the same memory text after each memory write.'),
  userFile: Schema.string().description('User-profile entry file used when AGENTS.md has no user block.'),
  personaStart: Schema.string().description('Opening marker of the persona block in AGENTS.md.'),
  personaEnd: Schema.string().description('Closing marker of the persona block in AGENTS.md.'),
  soulStart: Schema.string().description('Opening marker of the soul block in AGENTS.md.'),
  soulEnd: Schema.string().description('Closing marker of the soul block in AGENTS.md.'),
  userStart: Schema.string().description('Opening marker of the user-profile block in AGENTS.md.'),
  userEnd: Schema.string().description('Closing marker of the user-profile block in AGENTS.md.'),
  memoryCharLimit: Schema.number().default(12000).description('Maximum size of the memory store in characters, checked on the final result of a batch. 0 disables the limit.'),
  userCharLimit: Schema.number().default(6000).description('Maximum size of the user-profile store in characters. 0 disables the limit.'),
  autoCondense: Schema.boolean().default(true).description('When a batch would exceed a store\'s char limit, condense the store first with one model call through the host LLM service, then apply the batch, instead of rejecting the add.'),
  condenseProvider: Schema.string().description('Provider route of the condensation call. Default: the model of the session that made the store overflow.'),
  condenseModel: Schema.string().description('Model of the condensation call. Default: the model of the session that made the store overflow.'),
  condenseTimeoutMs: Schema.number().default(120000).description('Time budget of one condensation call. A slower one is abandoned and the batch is rejected as it would be without condensation.'),
  reviewEveryTurns: Schema.number().default(10).description('Periodic memory review: every N user turns, a store at or above reviewFillShare of its char limit is handed to the session with its live usage, so it can curate before a write overflows it. 0 disables the review.'),
  reviewFillShare: Schema.number().default(0.85).description('Usage share (0..1) of a store from which the periodic review speaks up. Below it the review stays silent.'),
  backgroundReview: Schema.boolean().default(false).description('After a completed user turn, ask the host model whether the turn produced a durable memory fact or skill and apply its guarded add/patch/create/edit operations through the same write paths. It cannot delete, wake the session, or edit the transcript.'),
  backgroundProvider: Schema.string().description('Provider route of the background review call. Default: the session\'s own model.'),
  backgroundModel: Schema.string().description('Model of the background review call. Default: the session\'s own model.'),
  backgroundTranscriptChars: Schema.number().default(12000).description('How much of the session tail the background pass reads. Earlier turns fall out of this window.'),
  backgroundEveryTurns: Schema.number().default(3).description('Run the background review at most once every N completed user turns. 0 disables it.'),
  backgroundTimeoutMs: Schema.number().default(30000).description('Time budget of one background review model call.'),
  curator: Schema.boolean().default(false).description('Stale-entry archiving: an entry whose text has not changed for curatorStaleDays is moved out of the store into a dated archive file once the store reaches curatorTriggerShare of its limit. It never deletes and never touches a pinned entry.'),
  curatorStaleDays: Schema.number().default(14).description('Age in days after which an unchanged, unpinned entry becomes an archive candidate.'),
  curatorDeepDays: Schema.number().default(30).description('Age in days after which an unchanged entry goes to the deep archive; for skills this is the age at which a stale skill is moved into the archive (Hermes archive_after_days).'),
  curatorTriggerShare: Schema.number().default(0.9).description('Store usage share (0..1) below which the automatic pass only records state and archives nothing. The memory action `curate` ignores it.'),
  skillCurator: Schema.boolean().default(false).description('Skill curator (Hermes parity): only curator-managed, unpinned skills are considered; a scheduled or explicit pass marks them stale, then moves them into the archive tree — never deletes.'),
  skillCuratorMaxSkills: Schema.number().default(0).description('Ceiling for the scheduled pass: it only runs while the managed library is larger than this. 0 = no ceiling. Only curator-managed skills are ever touched either way.'),
  skillCuratorBatch: Schema.number().default(10).description('Most skills one curator run may archive, so a single call never sweeps the library.'),
  skillCuratorIntervalHours: Schema.number().default(168).description('Hermes parity: a scheduled run waits this many hours between runs (default 7 days).'),
  skillCuratorMinIdleHours: Schema.number().default(2).description('Hermes parity: a scheduled run waits until the agent has been idle this many hours.'),
  skillCuratorScanLimit: Schema.number().default(20).description('Rows `skill_manage {action:"scan"}` returns; the total is always reported.'),
  skillCuratorProvider: Schema.string().description('Provider for the opt-in consolidation pass; falls back to condenseProvider, then to the session route.'),
  skillCuratorModel: Schema.string().description('Model for the opt-in consolidation pass; falls back to condenseModel, then to the session route.'),
  skillCuratorAudit: Schema.boolean().default(false).description('Ask a model whether a quiet managed skill is still correct, and let it rewrite or archive it.'),
  skillCuratorAuditDays: Schema.number().default(30).description('Days without a write before a skill is audited.'),
  skillCuratorAuditBatch: Schema.number().default(3).description('Skills one audit run may spend a model call on.'),
  skillCuratorAuditProvider: Schema.string().description('Provider for the audit; falls back to skillCuratorProvider, condenseProvider, then the session route.'),
  skillCuratorAuditModel: Schema.string().description('Model for the audit; same fallback chain as the provider.'),
  skillCuratorConsolidate: Schema.boolean().default(false).description('Hermes parity, OFF by default: the scheduled pass also asks the model to fold overlapping managed skills into one umbrella. Needs condenseProvider/condenseModel.'),
  notificationMode: Schema.string().default('on').description('Chat-visible summary of what the automatic passes changed: on (generic lines), verbose (with action detail), off.'),
  skillNudgeEveryTurns: Schema.number().default(10).description('Every N user turns, add one step-local notice asking whether this session produced a reusable procedure worth a skill. 0 disables it.'),
  memoryEnabled: Schema.boolean().default(true).description('Expose the memory target.'),
  userProfileEnabled: Schema.boolean().default(true).description('Expose the user target.'),
  skillsEnabled: Schema.boolean().default(true).description('Register skill_manage.'),
  personaEnabled: Schema.boolean().default(true).description('Register persona_update.'),
  skillsProjectDir: Schema.string().default('.agents/skills').description('Directory, relative to the project root, where skills are created with scope "project".'),
  customSkillDirs: Schema.array(Schema.string()).default([]).description('Additional skill roots searched for existing skills, relative to the project root or absolute.'),
  maxContentBytes: Schema.number().default(262144).description('Largest text a single write may produce, in bytes.'),
  viewMaxChars: Schema.number().default(20000).description('Characters returned by a view operation before truncation.'),
  historyMax: Schema.number().default(20).description('Snapshots kept per store and per skill. 0 disables snapshots.'),
  mirrorCommand: Schema.array(Schema.string()).default([]).description('Command run after each write (e.g. the Hermes mirror sync-agents.py); its last output line is reported in the tool result.'),
  mirrorTimeoutMs: Schema.number().default(8000).description('Time budget for the mirror command.'),
  promptNote: Schema.string().default('').description('Short text added to the system prompt telling the agent when to use these tools. Empty adds nothing.'),
  routePrefix: Schema.string().default('/api/self-evolve').description('HTTP path prefix of the health route.'),
})

/**
 * Build the runtime shared by every tool call.
 * @param {Record<string, any>} config - validated plugin config.
 * @returns {{ config: Record<string, any>, paths: ReturnType<typeof resolvePaths>, limits: { memoryLimit: number, userLimit: number } }} runtime.
 */
export function createRuntime(config, ctx) {
  // The installation directory comes from the host's profile context (the
  // same anchor it exports to shells as DSH_INSTALL_DIR); the env var is only
  // a fallback for a host without that service.
  const anchor = ctx?.get?.('profileContext')?.installAnchor
  const installDir = typeof anchor === 'string' ? dirname(anchor) : process.env.DSH_INSTALL_DIR
  return {
    config: { ...config, installDir },
    limits: { memoryLimit: config.memoryCharLimit ?? 0, userLimit: config.userCharLimit ?? 0 },
    paths: resolvePaths(config),
  }
}

/**
 * The session's working directory of one tool execution.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ agent?: any, signal?: AbortSignal }} exec - tool execution context.
 * @returns {Promise<{ cwd: string, known: boolean }>} the directory and
 *   whether it is the session's own (false = the host's cwd, a fallback).
 */
async function cwdOf(ctx, exec) {
  const agent = exec?.agent
  if (agent !== undefined) {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory !== undefined) {
      try {
        return { cwd: await workingDirectory.ensure(agent, exec.signal), known: true }
      } catch {
        // A vanished directory must not break skill lookup; fall back to the header.
      }
    }
    if (typeof agent.session?.header?.cwd === 'string') return { cwd: agent.session.header.cwd, known: true }
  }
  return { cwd: process.cwd(), known: false }
}

/**
 * Catalog lookup for `skill_manage`: the file the loader itself would read.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ agent?: any, signal?: AbortSignal }} exec - tool execution context.
 * @param {string} cwd - working directory.
 * @returns {(name: string) => Promise<{ path: string, source?: string } | undefined>} lookup.
 */
function catalogLookup(ctx, exec, cwd) {
  return async (name) => {
    const skills = ctx.get('skills')
    if (skills === undefined || exec?.agent === undefined) return undefined
    const list = await skills.list({ cwd, signal: exec.signal, scope: exec.agent })
    const hit = list.find(skill => skill.name === name)
    return hit !== undefined && typeof hit.path === 'string' ? { path: hit.path, source: hit.source } : undefined
  }
}

/**
 * The model condensation behind an over-budget store, through the host LLM
 * service: the calling session's own model at its least reasoning effort,
 * unless the profile pins `condenseProvider` / `condenseModel`. The service
 * is looked up per call, because this row can start before the service does.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, any>} config - validated plugin config.
 * @returns {(input: object, exec: { agent?: any }) => Promise<object>} the hook
 *   `memorytool.mjs` calls.
 */
function condenserFor(ctx, config) {
  return async (input, exec) => {
    const llm = ctx.get('llm')
    if (llm === undefined) return { ok: false, error: 'no_llm' }
    const session = exec?.agent?.session
    const route = condenseRoute({
      pinned: { provider: config.condenseProvider, model: config.condenseModel },
      routed: session?.requestHeader?.()?.config,
      own: exec?.agent?.options,
    })
    if (route === undefined) return { ok: false, error: 'no_model' }
    return condenseWithLlm(llm, { ...input, timeoutMs: config.condenseTimeoutMs ?? 120000 }, { ...route, sessionId: session?.id })
  }
}

/**
 * Whether a file holds both markers of a block.
 * @param {string} file - path to inspect.
 * @param {[string, string]} markers - opening and closing marker.
 * @returns {boolean} true when both markers are present.
 */
function hasBlock(file, markers) {
  try {
    const text = readFileSync(file, 'utf8')
    return text.includes(markers[0]) && text.includes(markers[1])
  } catch {
    return false
  }
}

/**
 * The post-turn learning pass. It listens to the durable `turn/end` session
 * event — never the step chain, so the user's turn is never delayed or steered
 * — and at most once every N completed turns derives the finished turn, asks
 * the host model for a small operations list, and applies it through the same
 * write paths the tools use. A failed call, an unparseable answer or a
 * rejected operation is dropped; nothing here can delete or wake.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {ReturnType<typeof createRuntime>} rt - runtime.
 * @returns {boolean} whether a listener was registered.
 */
function installBackgroundReview(ctx, rt) {
  const every = rt.config.backgroundEveryTurns ?? 3
  if (!Number.isSafeInteger(every) || every <= 0) return false
  const seen = new WeakMap()
  ctx.on('session/event', async (session, event) => {
    if (event?.type !== 'turn/end') return
    // Only a turn that really finished is worth learning from. The reason lives
    // at data.reason.kind in this DSH; the accessor tolerates both shapes.
    const reason = turnEndReason(event)
    if (reason !== 'completed' && reason !== 'max-tokens') return
    if ((session.header?.delegationDepth ?? 0) > 0) return
    const turn = event.data?.turn
    if (!Number.isSafeInteger(turn)) return
    const state = seen.get(session) ?? { count: 0, last: undefined }
    state.count += 1
    seen.set(session, state)
    if (!reviewDue({ every, count: state.count, last: state.last })) return
    const route = backgroundRoute(rt.config, session)
    if (route === undefined) return
    state.last = state.count
    const llm = ctx.get('llm')
    const stores = await resolveStores(rt.paths, rt.limits)
    void runBackgroundReview(rt, {
      session,
      transcript: session => turnTranscript(session, rt.config.backgroundTranscriptChars ?? 12000),
      current: async () => ({
        memory: parseEntries((await readDocument(stores.memory.locations)).text).join('\n'),
        skills: await skillNames(rt, session.header?.cwd ?? process.cwd()),
      }),
      llm,
      route,
    }).catch(() => {})
  })
  return true
}

/**
 * The skill curator on a schedule, the way Hermes runs it: no cron daemon, no
 * wake — the pass is observed at the start of a turn, after the agent has been
 * idle long enough, at most once per `skillCuratorIntervalHours`. The first
 * observation only seeds `last_run_at`, so an install never mutates the library
 * on its first tick. A run is bounded by `skillCuratorBatch` and can only touch
 * curator-managed, unpinned skills.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {ReturnType<typeof createRuntime>} rt - runtime.
 * @returns {boolean} whether a listener was registered.
 */
function installSkillCuratorScheduler(ctx, rt) {
  const intervalHours = rt.config.skillCuratorIntervalHours ?? DEFAULT_INTERVAL_HOURS
  const minIdleHours = rt.config.skillCuratorMinIdleHours ?? DEFAULT_MIN_IDLE_HOURS
  let lastActivity = undefined
  let running = false
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/end' && (session.header?.delegationDepth ?? 0) === 0) lastActivity = Date.now()
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject') return decision
    const { agent, step, signal } = payload ?? {}
    const session = agent?.session
    if (session === undefined || step !== 1) return decision
    if (running || (session.header?.delegationDepth ?? 0) > 0) return decision
    if (signal?.aborted === true) return decision
    if (Array.isArray(decision?.messages) && decision.messages.length === 0) return decision
    const now = Date.now()
    const state = await loadSkillState(rt)
    if (state.paused === true) return decision
    const due = curatorDue({ state, now, lastActivity, intervalHours, minIdleHours })
    if (due.seed === true) {
      state.last_run_at = new Date(now).toISOString()
      await saveSkillState(rt, state).catch(() => {})
      return decision
    }
    if (!due.due) return decision
    // Fire and forget: the user's turn is never delayed by curation.
    running = true
    const cwd = session.header?.cwd ?? process.cwd()
    void (async () => {
      try {
        if ((rt.config.skillCuratorMaxSkills ?? 0) > 0) {
          const scan = await scanSkills(rt, { cwd })
          if (scan.managed <= rt.config.skillCuratorMaxSkills) return
        }
        await runSkillCurator(rt, { cwd, now })
        if (rt.config.skillCuratorAudit === true) {
          const audited = await runSkillAudit(rt, { cwd, now, llm: ctx.get('llm'), session })
          if (audited.rewritten + audited.archived > 0) {
            await queueNotice(rt, `Skill audit: ${audited.rewritten} rewritten, ${audited.archived} archived, ${audited.kept} kept`)
          }
        }
        if (rt.config.skillCuratorConsolidate === true) {
          const llm = ctx.get('llm')
          const route = consolidationRoute(rt.config, session)
          const proposals = await consolidateSkills(rt, { llm, route, cwd })
          for (const proposal of proposals.consolidated ?? []) await applyConsolidation(rt, { ...proposal, cwd })
        }
      } catch {
        // A failed scheduled pass must never surface in the user's turn.
      } finally {
        running = false
      }
    })()
    return decision
  })
  return true
}

/**
 * Plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, any>} config - validated config.
 */
export function apply(ctx, config = {}) {
  const rt = createRuntime(config, ctx)

  // The user profile needs a marked block or a configured file; offer that
  // target only when one exists at activation.
  const userAvailable = hasBlock(rt.paths.agentsMd, rt.paths.markers.user) || typeof config.userFile === 'string'
  const memoryTargets = [config.memoryEnabled !== false && 'memory', config.userProfileEnabled !== false && userAvailable && 'user'].filter(Boolean)
  if (memoryTargets.length > 0) ctx.tools.register(memoryTool(defineTool, rt, memoryTargets, { condense: condenserFor(ctx, config) }))
  if (memoryTargets.length > 0) {
    // The review is a nudge, not a writer: it hands the session its own store
    // usage and the session curates with the same `memory` tool.
    installReview(ctx, {
      every: config.reviewEveryTurns ?? 10,
      share: config.reviewFillShare ?? 0.85,
      load: async () => usageRows(await resolveStores(rt.paths, rt.limits), memoryTargets),
    })
  }
  if (config.backgroundReview === true && memoryTargets.includes('memory')) {
    installBackgroundReview(ctx, rt)
  }
  // Hermes' notification_mode: the automatic passes queue a line and this
  // delivers it at the next turn, so a write is never silent.
  installNotices(ctx, rt)
  if (config.skillsEnabled !== false) {
    // Hermes' separate skill nudge: its own interval, its own notice, so skills
    // can be reminded at a cadence independent of the memory review.
    installSkillNudge(ctx, {
      every: config.skillNudgeEveryTurns ?? 10,
      count: async () => (await discoverSkills(rt, {})).length,
    })
  }
  if (config.skillsEnabled !== false) {
    ctx.tools.register(skillTool(defineTool, rt, {
      sessionOf: exec => cwdOf(ctx, exec),
      catalogLookup: (exec, cwd) => catalogLookup(ctx, exec, cwd),
      curatorLlm: () => ctx.get('llm'),
    }))
    if (config.skillCurator === true) installSkillCuratorScheduler(ctx, rt)
  }
  if (config.personaEnabled !== false) {
    // The soul block exists only in a marker-managed AGENTS.md; offer that
    // target only when the markers are present at activation.
    const soul = hasBlock(rt.paths.agentsMd, rt.paths.markers.soul)
    ctx.tools.register(personaTool(defineTool, rt, soul ? ['persona', 'soul'] : ['persona']))
  }

  if (typeof config.promptNote === 'string' && config.promptNote.trim().length > 0) {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      ctx.effect(() => systemPrompt.section({
        name: 'self-evolve:guidance',
        order: 10400,
        text: config.promptNote,
        interpolate: false,
      }), 'self-evolve.guidance()')
    }
  }

  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    const prefix = `/${String(config.routePrefix ?? '/api/self-evolve').replace(/^\/+|\/+$/g, '')}`
    scoped.effect(() => webServer.register({
      kind: 'exact',
      path: `${prefix}/health`,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!isTrustedOrigin(req)) {
          sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          return
        }
        sendJson(res, 200, await health(rt))
      },
    }), 'self-evolve.health()')
  })
}

/**
 * Health payload: what is registered and where the stores live.
 * @param {ReturnType<createRuntime>} rt - runtime.
 * @returns {Promise<object>} health report.
 */
async function health(rt) {
  const stores = await resolveStores(rt.paths, rt.limits)
  const roots = await skillRoots(rt.paths, rt.config, process.cwd())
  const report = {}
  for (const [name, store] of Object.entries(stores)) {
    report[name] = {
      type: store.type,
      label: store.label,
      files: [...store.locations, ...(store.mirrors ?? [])].map(location => location.path),
      exists: await readText(store.locations[0].path).then(text => text !== undefined, () => false),
      ...(store.charLimit === undefined ? {} : { charLimit: store.charLimit }),
    }
  }
  const skillState = await loadSkillState(rt)
  return {
    ok: true,
    plugin: name,
    stores: report,
    skills: { roots: roots.map(root => ({ path: root.path, kind: root.kind })) },
    mirror: Array.isArray(rt.config.mirrorCommand) && rt.config.mirrorCommand.length > 0 ? rt.config.mirrorCommand.join(' ') : 'disabled',
    review: { everyTurns: rt.config.reviewEveryTurns ?? 10, fillShare: rt.config.reviewFillShare ?? 0.85 },
    backgroundReview: rt.config.backgroundReview === true
      ? { everyTurns: rt.config.backgroundEveryTurns ?? 3, timeoutMs: rt.config.backgroundTimeoutMs ?? 30000, last: await readBackgroundStatus(rt) ?? null }
      : false,
    curator: rt.config.curator === true ? { staleDays: rt.config.curatorStaleDays ?? 14, deepDays: rt.config.curatorDeepDays ?? 30, triggerShare: rt.config.curatorTriggerShare ?? 0.9 } : false,
    skillCurator: rt.config.skillCurator === true
      ? {
          staleDays: rt.config.curatorStaleDays ?? 14,
          deepDays: rt.config.curatorDeepDays ?? 30,
          batch: rt.config.skillCuratorBatch ?? 10,
          intervalHours: rt.config.skillCuratorIntervalHours ?? DEFAULT_INTERVAL_HOURS,
          minIdleHours: rt.config.skillCuratorMinIdleHours ?? DEFAULT_MIN_IDLE_HOURS,
          consolidate: rt.config.skillCuratorConsolidate === true,
      audit: { enabled: rt.config.skillCuratorAudit === true, days: rt.config.skillCuratorAuditDays ?? 30, batch: rt.config.skillCuratorAuditBatch ?? 3 },
          paused: skillState.paused === true,
          lastRunAt: skillState.last_run_at,
          runCount: skillState.run_count ?? 0,
          lastRunSummary: skillState.last_run_summary ?? null,
          lastReportPath: skillState.last_report_path ?? null,
          managed: Object.keys(skillState.entries).length,
        }
      : false,
    skillNudge: { everyTurns: rt.config.skillNudgeEveryTurns ?? 10 },
    notifications: { mode: String(rt.config.notificationMode ?? 'on').toLowerCase() },
    dataDir: rt.paths.dataDir,
  }
}
