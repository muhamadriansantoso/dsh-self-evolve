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
import { backgroundRoute, runBackgroundReview, skillNames, turnTranscript } from './lib/background.mjs'
import { condenseRoute, condenseWithLlm } from './lib/condense.mjs'
import { readText } from './lib/fsx.mjs'
import { isTrustedOrigin, sendJson } from './lib/http.mjs'
import { installReview, reviewDue, usageRows } from './lib/review.mjs'
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
    // Only a turn that really finished is worth learning from.
    if (event.data?.kind !== 'completed' && event.data?.kind !== 'max-tokens') return
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
      transcript: turnTranscript,
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
  if (config.skillsEnabled !== false) {
    ctx.tools.register(skillTool(defineTool, rt, {
      sessionOf: exec => cwdOf(ctx, exec),
      catalogLookup: (exec, cwd) => catalogLookup(ctx, exec, cwd),
    }))
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
  return {
    ok: true,
    plugin: name,
    stores: report,
    skills: { roots: roots.map(root => ({ path: root.path, kind: root.kind })) },
    mirror: Array.isArray(rt.config.mirrorCommand) && rt.config.mirrorCommand.length > 0 ? rt.config.mirrorCommand.join(' ') : 'disabled',
    review: { everyTurns: rt.config.reviewEveryTurns ?? 10, fillShare: rt.config.reviewFillShare ?? 0.85 },
    backgroundReview: rt.config.backgroundReview === true ? { everyTurns: rt.config.backgroundEveryTurns ?? 3, timeoutMs: rt.config.backgroundTimeoutMs ?? 30000 } : false,
    dataDir: rt.paths.dataDir,
  }
}
