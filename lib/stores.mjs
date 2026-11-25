// stores.mjs — maps the plugin configuration onto the files the tools edit.
//
// Persona, soul and the user profile live in ~/.dsh/AGENTS.md. When that file
// is managed by sync-agents.py the stores are its `SYNC:*` blocks; a plain
// AGENTS.md without markers is itself the persona. Memory is always its own
// file. Nothing here writes: tools call `readDocument` / `writeDocument`.

import path from 'node:path'
import { resolvePath } from './util.mjs'

import { readText, statInfo, sameStamp } from './fsx.mjs'

/** Default marker pairs of sync-agents.py. */
export const DEFAULT_MARKERS = {
  persona: ['<!-- SYNC:PERSONA_START -->', '<!-- SYNC:PERSONA_END -->'],
  soul: ['<!-- SYNC:SOUL_START -->', '<!-- SYNC:SOUL_END -->'],
  user: ['<!-- SYNC:USER_START -->', '<!-- SYNC:USER_END -->'],
}

/**
 * Resolve every configured path once.
 * @param {Record<string, any>} config - validated plugin config.
 * @returns {object} resolved paths and markers.
 */
export function resolvePaths(config) {
  const home = process.env.HOME ?? ''
  const dshHome = resolvePath(config.dshHome ?? process.env.DSH_HOME) ?? path.join(home, '.dsh')
  const pair = (start, end, fallback) => (start && end ? [start, end] : fallback)
  return {
    dshHome,
    agentsHome: resolvePath(process.env.DSH_AGENTS_HOME) ?? path.join(home, '.agents'),
    dataDir: resolvePath(config.dataDir, dshHome) ?? path.join(dshHome, 'self-evolve'),
    agentsMd: resolvePath(config.agentsMd, dshHome) ?? path.join(dshHome, 'AGENTS.md'),
    memoryFile: resolvePath(config.memoryFile, dshHome) ?? path.join(dshHome, 'MEMORY.md'),
    memoryMirrors: (config.memoryMirrors ?? []).map(item => resolvePath(item, dshHome)).filter(Boolean),
    userFile: resolvePath(config.userFile, dshHome),
    skillsDir: path.join(dshHome, 'skills'),
    markers: {
      persona: pair(config.personaStart, config.personaEnd, DEFAULT_MARKERS.persona),
      soul: pair(config.soulStart, config.soulEnd, DEFAULT_MARKERS.soul),
      user: pair(config.userStart, config.userEnd, DEFAULT_MARKERS.user),
    },
  }
}

/** Last resolved store table, valid while AGENTS.md keeps its version. */
let cache

/**
 * The stores, resolved against the current content of AGENTS.md.
 * @param {ReturnType<resolvePaths>} paths - resolved paths.
 * @param {{ memoryLimit?: number, userLimit?: number }} [limits] - char budgets.
 * @returns {Promise<Record<string, object>>} stores by target name; a store
 *   this profile cannot back (`soul` without markers, `user` without a block
 *   or a configured file) is absent.
 */
export async function resolveStores(paths, { memoryLimit = 0, userLimit = 0 } = {}) {
  const stamp = await statInfo(paths.agentsMd)
  // The table depends on every resolved path, not only on AGENTS.md's version.
  const key = JSON.stringify([paths.agentsMd, paths.memoryFile, paths.userFile, paths.memoryMirrors, paths.markers, memoryLimit, userLimit])
  if (cache !== undefined && cache.key === key && sameStamp(cache.stamp, stamp)) {
    return cache.stores
  }
  const agents = (await readText(paths.agentsMd)) ?? ''
  const has = pair => agents.includes(pair[0]) && agents.includes(pair[1])
  const block = pair => ({ path: paths.agentsMd, block: { start: pair[0], end: pair[1] }, label: `${path.basename(paths.agentsMd)} ${pair[0]} block` })
  const whole = file => ({ path: file, label: file })

  const stores = {
    memory: {
      type: 'entries',
      label: 'MEMORY.md (agent notes)',
      locations: [whole(paths.memoryFile)],
      mirrors: paths.memoryMirrors.map(whole),
      charLimit: memoryLimit,
      history: 'memory',
    },
    persona: {
      type: 'text',
      label: 'persona (identity and operating rules)',
      // Without PERSONA markers the whole file is the persona; the tools then
      // refuse a whole-file `replace` while other SYNC blocks exist.
      locations: [has(paths.markers.persona) ? block(paths.markers.persona) : { ...whole(paths.agentsMd), wholeFile: true }],
      history: 'persona',
    },
  }
  if (has(paths.markers.soul)) {
    stores.soul = { type: 'text', label: 'soul (tone and style)', locations: [block(paths.markers.soul)], history: 'soul' }
  }
  if (has(paths.markers.user)) {
    stores.user = { type: 'entries', label: 'USER profile (who the user is)', locations: [block(paths.markers.user)], mirrors: [], charLimit: userLimit, history: 'user' }
  } else if (paths.userFile !== undefined) {
    stores.user = { type: 'entries', label: 'USER profile (who the user is)', locations: [whole(paths.userFile)], mirrors: [], charLimit: userLimit, history: 'user' }
  }
  cache = { key, stamp, stores }
  return stores
}
