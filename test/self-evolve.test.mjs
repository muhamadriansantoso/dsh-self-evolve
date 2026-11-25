// self-evolve.test.mjs — behaviour tests for the plugin core on a throwaway
// HOME (never touches the real ~/.dsh or ~/.hermes), plus a compile-and-run
// pass of the tool definitions against the real @deepseek-ai/dsh-tools when
// the installation is reachable.
//
//   node --test test/

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const HOME = await mkdtemp(path.join(tmpdir(), 'dsh-self-evolve-'))
/** The real home, captured before the test swaps HOME for a throwaway. */
const REAL_HOME = homedir()
process.env.HOME = HOME
process.env.DSH_HOME = path.join(HOME, '.dsh')
delete process.env.DSH_AGENTS_HOME
process.env.DSH_INSTALL_DIR = path.join(HOME, 'install')

const { resolvePaths, resolveStores } = await import('../lib/stores.mjs')
const { runMemory } = await import('../lib/memorytool.mjs')
const { runPersona } = await import('../lib/personatool.mjs')
const { applyBatch, charCount, parseEntries, renderEntries } = await import('../lib/entries.mjs')
const { anchorRetention, condenseEntries, condenseInstruction, condenseRoute, condenseWithLlm, parseCondensed, readStream } = await import('../lib/condense.mjs')
const { runSkillOps, locateSkill, skillRoots } = await import('../lib/skills.mjs')
const { splitFrontmatter, buildSkillText } = await import('../lib/frontmatter.mjs')
const { safeRelativeFile } = await import('../lib/names.mjs')
const tools = await import('../lib/tools.mjs')

const exists = file => stat(file).then(() => true, () => false)

/** Run skill ops as the tool does, for a session rooted at `cwd`. */
const runSkills = (rt, cwd, ops, lookup) => runSkillOps(rt, { ops, session: { cwd, known: true }, lookup })

/** A runtime like the plugin entry builds, with test-friendly defaults. */
function makeRt(config = {}) {
  const full = {
    memoryCharLimit: 12000,
    userCharLimit: 6000,
    maxContentBytes: 262144,
    viewMaxChars: 20000,
    historyMax: 20,
    skillsProjectDir: '.agents/skills',
    customSkillDirs: [],
    memoryMirrors: [],
    ...config,
  }
  return {
    config: { ...full, installDir: process.env.DSH_INSTALL_DIR },
    paths: resolvePaths(full),
    limits: { memoryLimit: full.memoryCharLimit, userLimit: full.userCharLimit },
  }
}

/** AGENTS.md in the canonical sync-agents.py layout. */
const SOUL = 'You are Hermes Agent, built by Nous Research. Be direct.'
const PERSONA = ['# Nimbus', '', '## IDENTITY', 'You are Nimbus, the operator\'s execution engine.', '', '## EXECUTION RULES', '1. Execute directly.', '2. Evidence-gated.'].join('\n')
const USER = 'User: Alex, ABAP developer, loves running.\n§\nPrefers terse answers.'
const PROTOCOL = '## Protokol Memori Jangka Panjang (Auto-Update)\n1. Baca MEMORY.md saat sesi dimulai.'

async function seedAgentsMd() {
  const text = [
    '<!-- Managed by ~/.config/agents/sync.py — edit the blocks, not the wrapper. -->',
    '',
    '<!-- SYNC:SOUL_START -->',
    SOUL,
    '<!-- SYNC:SOUL_END -->',
    '',
    '<!-- SYNC:PERSONA_START -->',
    PERSONA,
    '<!-- SYNC:PERSONA_END -->',
    '',
    '<!-- SYNC:USER_START -->',
    USER,
    '<!-- SYNC:USER_END -->',
    '',
    '<!-- SYNC:MEMORY_PROTOCOL_START -->',
    PROTOCOL,
    '<!-- SYNC:MEMORY_PROTOCOL_END -->',
    '',
  ].join('\n')
  await mkdir(path.dirname(resolvePaths({}).agentsMd), { recursive: true })
  await writeFile(resolvePaths({}).agentsMd, text)
  return text
}

// ----------------------------------------------------------------- entries

test('entries: add dedupes, patch keeps the rest of the entry, remove deletes one entry', () => {
  const base = ['Alpha entry about ports.', 'Beta entry about gateway.']
  let out = applyBatch(base, [{ action: 'add', content: 'Gamma.' }, { action: 'add', content: 'Alpha entry about ports.' }], 0)
  assert.equal(out.ok, true)
  assert.deepEqual(out.entries, [...base, 'Gamma.'])

  out = applyBatch(out.entries, [{ action: 'patch', old_text: 'gateway', content: 'nine-router' }], 0)
  assert.equal(out.ok, true)
  assert.equal(out.entries[1], 'Beta entry about nine-router.')
  assert.equal(out.patched_entries['1'], 'Beta entry about gateway.')

  out = applyBatch(out.entries, [{ action: 'remove', old_text: 'Alpha' }], 0)
  assert.equal(out.ok, true)
  assert.deepEqual(out.entries, ['Beta entry about nine-router.', 'Gamma.'])
  assert.deepEqual(out.removed_entries, { 1: 'Alpha entry about ports.' })
})

test('entries: matching is exact-entry first, then substring, then folded typography', () => {
  const entries = ['test', '...tests pass on main...']
  assert.deepEqual(applyBatch(entries, [{ action: 'remove', old_text: 'test' }], 0).entries, ['...tests pass on main...'])
  const curly = ['Prefer “quotes” and — dashes.', 'unrelated']
  let out = applyBatch(curly, [{ action: 'remove', old_text: '"quotes" and - dashes' }], 0)
  assert.equal(out.ok, true, 'a re-typed old_text still selects the entry')
  assert.deepEqual(out.entries, ['unrelated'])
  out = applyBatch(curly, [{ action: 'patch', old_text: '“quotes”', content: 'plain' }], 0)
  assert.equal(out.entries[0], 'Prefer plain and — dashes.', 'the span itself is spliced byte-exactly')
  out = applyBatch(curly, [{ action: 'patch', old_text: '"quotes"', content: 'plain' }], 0)
  assert.equal(out.failure, 'invalid_args', 'a span that only differs in typography is a no-op, as in Hermes')
})

test('entries: ambiguity, no-match hint, repeated span, budget and would-empty are rejected without changes', () => {
  const entries = ['deploy on friday', 'deploy on monday', 'keep me']
  let out = applyBatch(entries, [{ action: 'remove', old_text: 'deploy on' }], 0)
  assert.equal(out.ok, false)
  assert.equal(out.failure, 'ambiguous')

  out = applyBatch(entries, [{ action: 'remove', old_text: 'nothing like this' }], 0)
  assert.equal(out.ok, false)
  assert.equal(out.failure, 'no_match')

  out = applyBatch(['a b a b'], [{ action: 'patch', old_text: 'a', content: 'c' }], 0)
  assert.equal(out.failure, 'ambiguous')

  out = applyBatch(['aaaa', 'bbbb'], [{ action: 'add', content: 'cccc' }], 12)
  assert.equal(out.ok, false)
  assert.equal(out.failure, 'over_budget')
  assert.deepEqual(out.current_entries, ['aaaa', 'bbbb'])
  out = applyBatch(['aaaa', 'bbbb'], [{ action: 'remove', old_text: 'aaaa' }, { action: 'add', content: 'cccc' }], 12)
  assert.equal(out.ok, true, 'a batch may free space and add in one call')

  out = applyBatch(['one', 'two'], [{ action: 'remove', old_text: 'one' }, { action: 'remove', old_text: 'two' }], 0)
  assert.equal(out.failure, 'would_empty')
  assert.equal(applyBatch(['one'], [{ action: 'remove', old_text: 'one' }], 0).ok, true, 'a deliberate single remove is allowed')

  out = applyBatch(entries, [{ action: 'patch', old_text: 'keep', content: '' }], 0)
  assert.equal(out.failure, 'missing_content')
  assert.deepEqual(entries, ['deploy on friday', 'deploy on monday', 'keep me'])
})

test('entries: parser tolerates CRLF and blank lines around the delimiter', () => {
  assert.deepEqual(parseEntries('a\n§\nb\r\n§\r\n\n\nc\n'), ['a', 'b', 'c'])
})

// ------------------------------------------------------------------ memory

test('memory: add, patch, remove and view on MEMORY.md with mirror and history', async () => {
  const rt = makeRt({ memoryMirrors: ['~/hermes-mem/MEMORY.md'] })
  let result = await runMemory(rt, { target: 'memory', operations: [{ action: 'add', content: 'Alex prefers terse answers.' }] })
  assert.equal(result.success, true)
  assert.equal(result.done, true)
  const text = await readFile(rt.paths.memoryFile, 'utf8')
  assert.equal(text, 'Alex prefers terse answers.')
  assert.equal(await readFile(path.join(HOME, 'hermes-mem', 'MEMORY.md'), 'utf8'), text, 'mirror receives the same text')

  result = await runMemory(rt, { target: 'memory', operations: [{ action: 'add', content: 'Coach repo lives in ~/Project/running_coach_app.' }, { action: 'add', content: 'Alex prefers terse answers.' }] })
  assert.equal(result.entry_count, 2, 'an identical entry is not duplicated')
  assert.equal(await readFile(rt.paths.memoryFile, 'utf8'), 'Alex prefers terse answers.\n§\nCoach repo lives in ~/Project/running_coach_app.')

  result = await runMemory(rt, { target: 'memory', operations: [{ action: 'patch', old_text: 'terse', content: 'short' }] })
  assert.equal(result.success, true)
  assert.equal(result.patched_entries_after['1'], 'Alex prefers short answers.')

  result = await runMemory(rt, { target: 'memory', operations: [{ action: 'view' }] })
  assert.equal(result.success, true)
  assert.deepEqual(result.entries.map(entry => entry.text), ['Alex prefers short answers.', 'Coach repo lives in ~/Project/running_coach_app.'])

  result = await runMemory(rt, { target: 'memory', operations: [{ action: 'remove', old_text: 'running_coach_app' }] })
  assert.equal(result.success, true)
  assert.deepEqual(result.removed_entries, { 1: 'Coach repo lives in ~/Project/running_coach_app.' })
  assert.equal(await readFile(rt.paths.memoryFile, 'utf8'), 'Alex prefers short answers.')

  const history = await readdir(path.join(rt.paths.dataDir, 'history', 'memory'))
  assert.ok(history.length >= 4, 'one snapshot per write')
  const snapshots = await Promise.all(history.map(name => readFile(path.join(rt.paths.dataDir, 'history', 'memory', name), 'utf8')))
  assert.equal(snapshots[0], '', 'the first snapshot holds the empty store')
  assert.ok(snapshots.includes('Alex prefers terse answers.'), 'a later snapshot holds the state before the patch')

  result = await runMemory(rt, { target: 'memory', operations: [{ action: 'view' }, { action: 'add', content: 'x' }] })
  assert.equal(result.success, false, 'view must be alone')
  result = await runMemory(rt, { target: 'nope', operations: [{ action: 'add', content: 'x' }] })
  assert.equal(result.success, false)
})

test('memory: the user target edits only the USER block of AGENTS.md', async () => {
  const original = await seedAgentsMd()
  const rt = makeRt()
  const result = await runMemory(rt, { target: 'user', operations: [{ action: 'add', content: 'Phone: +62 857 8312 6998.' }, { action: 'patch', old_text: 'terse', content: 'compact' }] })
  assert.equal(result.success, true)
  const after = await readFile(rt.paths.agentsMd, 'utf8')
  assert.ok(after.includes('Prefers compact answers.\n§\nPhone: +62 857 8312 6998.'))
  assert.ok(after.includes(SOUL) && after.includes(PERSONA) && after.includes(PROTOCOL), 'other blocks untouched')
  const withoutUser = text => text.replace(/<!-- SYNC:USER_START -->[\s\S]*?<!-- SYNC:USER_END -->/, '')
  assert.equal(withoutUser(after), withoutUser(original), 'nothing outside the block changed')
})

// ----------------------------------------------------------------- persona

test('persona: set_section appends a new section, replaces an existing body, remove, patch, append, view', async () => {
  await seedAgentsMd()
  const rt = makeRt()
  let result = await runPersona(rt, { operation: 'set_section', section: 'Language', content: 'Answer in Indonesian by default.' })
  assert.equal(result.success, true)
  assert.equal(result.created_section, true)
  let text = await readFile(rt.paths.agentsMd, 'utf8')
  assert.ok(text.includes('## Language\n\nAnswer in Indonesian by default.\n<!-- SYNC:PERSONA_END -->'))

  result = await runPersona(rt, { operation: 'set_section', section: 'execution rules', content: '1. Execute directly.\n2. Never lecture.' })
  assert.equal(result.created_section, false)
  text = await readFile(rt.paths.agentsMd, 'utf8')
  assert.ok(text.includes('## EXECUTION RULES\n\n1. Execute directly.\n2. Never lecture.\n\n## Language'), 'matched case-insensitively, heading kept, next section preserved')
  assert.ok(!text.includes('Evidence-gated'))

  result = await runPersona(rt, { operation: 'patch', old_text: 'Answer in Indonesian', content: 'Answer in Bahasa Indonesia' })
  assert.equal(result.success, true)
  result = await runPersona(rt, { operation: 'patch', old_text: 'e', content: 'X' })
  assert.equal(result.success, false, 'old_text must occur once')

  result = await runPersona(rt, { operation: 'append', content: '## BRAND\nTag deliverables Nimbus.' })
  assert.equal(result.success, true)
  result = await runPersona(rt, { operation: 'remove_section', section: 'Brand' })
  assert.equal(result.success, true)
  text = await readFile(rt.paths.agentsMd, 'utf8')
  assert.ok(!text.includes('Nimbus.'))

  result = await runPersona(rt, { operation: 'view' })
  assert.equal(result.success, true)
  assert.deepEqual(result.sections, ['# Nimbus', '## IDENTITY', '## EXECUTION RULES', '## Language'])
  result = await runPersona(rt, { operation: 'remove_section', section: 'Nope' })
  assert.equal(result.success, false)

  result = await runPersona(rt, { target: 'soul', operation: 'append', content: 'No filler.' })
  assert.equal(result.success, true)
  text = await readFile(rt.paths.agentsMd, 'utf8')
  assert.ok(text.includes(`${SOUL}\n\nNo filler.\n<!-- SYNC:SOUL_END -->`))
})

test('persona: replace rewrites the block and keeps the rest of the file; a plain AGENTS.md is the persona itself', async () => {
  const original = await seedAgentsMd()
  const rt = makeRt()
  await runPersona(rt, { operation: 'replace', content: '# NEW\n\nOnly rule.' })
  const text = await readFile(rt.paths.agentsMd, 'utf8')
  assert.ok(text.includes('<!-- SYNC:PERSONA_START -->\n# NEW\n\nOnly rule.\n<!-- SYNC:PERSONA_END -->'))
  const strip = value => value.replace(/<!-- SYNC:PERSONA_START -->[\s\S]*?<!-- SYNC:PERSONA_END -->/, '')
  assert.equal(strip(text), strip(original))

  const plain = path.join(HOME, 'plain')
  await mkdir(plain, { recursive: true })
  const rt2 = makeRt({ dshHome: plain, agentsMd: path.join(plain, 'AGENTS.md') })
  await writeFile(rt2.paths.agentsMd, 'Answer in English.\n')
  const result = await runPersona(rt2, { target: 'soul', operation: 'append', content: 'x' })
  assert.equal(result.success, false, 'no soul block without markers')
  await runPersona(rt2, { operation: 'append', content: 'Be terse.' })
  assert.equal(await readFile(rt2.paths.agentsMd, 'utf8'), 'Answer in English.\n\nBe terse.')
})

// ------------------------------------------------------------------ skills

test('skills: create, view, patch, write_file, remove_file, delete into trash', async () => {
  await seedAgentsMd()
  const rt = makeRt()
  const cwd = HOME
  let outcome = await runSkills(rt, cwd, [{ name: 'deploy-checklist', action: 'create', content: 'Run the test suite, then deploy.', description: 'Use when deploying the coach. Steps to verify before a deploy.' }])
  assert.equal(outcome.success, true)
  const file = path.join(rt.paths.skillsDir, 'deploy-checklist', 'SKILL.md')
  const created = await readFile(file, 'utf8')
  assert.equal(created, '---\nname: deploy-checklist\ndescription: Use when deploying the coach. Steps to verify before a deploy.\n---\n\nRun the test suite, then deploy.\n')
  assert.equal(splitFrontmatter(created).data.name, 'deploy-checklist')

  outcome = await runSkills(rt, cwd, [{ name: 'deploy-checklist', action: 'write_file', file_path: 'references/steps.md', file_content: '# Steps\n1. test\n' }, { name: 'deploy-checklist', action: 'patch', old_string: 'then deploy', new_string: 'then deploy with --dry-run first' }])
  assert.equal(outcome.success, true)
  assert.equal(outcome.results[0].file, 'references/steps.md')
  assert.ok((await readFile(file, 'utf8')).includes('--dry-run first'))

  outcome = await runSkills(rt, cwd, [{ name: 'deploy-checklist', action: 'view' }])
  assert.equal(outcome.results[0].content, await readFile(file, 'utf8'))
  assert.deepEqual(outcome.results[0].files, ['references/steps.md'])

  outcome = await runSkills(rt, cwd, [{ name: 'deploy-checklist', action: 'remove_file', file_path: 'references/steps.md' }])
  assert.equal(outcome.success, true)
  assert.equal(await exists(path.join(rt.paths.skillsDir, 'deploy-checklist', 'references', 'steps.md')), false)

  outcome = await runSkills(rt, cwd, [{ name: 'deploy-checklist', action: 'delete' }])
  assert.equal(outcome.success, true)
  assert.equal(await exists(path.join(rt.paths.skillsDir, 'deploy-checklist')), false)
  assert.ok(await exists(outcome.results[0].trash), 'deleted skill is in the trash')
  assert.ok((await readFile(path.join(outcome.results[0].trash, 'SKILL.md'), 'utf8')).includes('--dry-run'))
})

test('skills: a failed batch rolls back everything it touched', async () => {
  const rt = makeRt()
  const cwd = HOME
  await runSkills(rt, cwd, [{ name: 'rollback-probe', action: 'create', content: '---\nname: rollback-probe\ndescription: probe\n---\n\noriginal\n' }])
  const file = path.join(rt.paths.skillsDir, 'rollback-probe', 'SKILL.md')
  const outcome = await runSkills(rt, cwd, [
      { name: 'rollback-probe', action: 'patch', old_string: 'original', new_string: 'changed' },
      { name: 'brand-new-skill', action: 'create', content: 'brand new', description: 'desc' },
      { name: 'rollback-probe', action: 'patch', old_string: 'NOT PRESENT', new_string: 'x' },
    ],)
  assert.equal(outcome.success, false)
  assert.equal(outcome.code, 'NO_MATCH')
  assert.equal(outcome.rolled_back, true)
  assert.equal(await readFile(file, 'utf8'), '---\nname: rollback-probe\ndescription: probe\n---\n\noriginal\n', 'first patch undone')
  assert.equal(await exists(path.join(rt.paths.skillsDir, 'brand-new-skill')), false, 'created skill removed')
})

test('skills: guards — existing skill, protected installation path, traversal, bad names, edit must keep valid frontmatter', async () => {
  const rt = makeRt()
  const cwd = HOME
  await runSkills(rt, cwd, [{ name: 'guard-me', action: 'create', content: 'body', description: 'd' }])
  let outcome = await runSkills(rt, cwd, [{ name: 'guard-me', action: 'create', content: 'body', description: 'd' }])
  assert.equal(outcome.code, 'EXISTS')

  const bundledFile = path.join(HOME, 'install', 'skills', 'dsh-doc', 'SKILL.md')
  await mkdir(path.dirname(bundledFile), { recursive: true })
  await writeFile(bundledFile, '---\nname: dsh-doc\ndescription: docs\n---\nbody\n')
  outcome = await runSkills(rt, cwd, [{ name: 'dsh-doc', action: 'patch', old_string: 'body', new_string: 'x' }], async name => (name === 'dsh-doc' ? { path: bundledFile, source: 'bundled' } : undefined))
  assert.equal(outcome.code, 'PROTECTED')
  assert.equal(await readFile(bundledFile, 'utf8'), '---\nname: dsh-doc\ndescription: docs\n---\nbody\n')

  outcome = await runSkills(rt, cwd, [{ name: 'guard-me', action: 'write_file', file_path: '../escape.md', file_content: 'x' }])
  assert.equal(outcome.code, 'INVALID_OP')
  assert.equal(safeRelativeFile('/etc/passwd'), undefined)
  assert.equal(safeRelativeFile('references/ok.md'), 'references/ok.md')
  assert.equal(safeRelativeFile('SKILL.md'), undefined, 'SKILL.md is rewritten with edit, never with write_file')
  assert.equal(safeRelativeFile('docs/x.md'), undefined)

  outcome = await runSkills(rt, cwd, [{ name: 'Bad_Name', action: 'create', content: 'x', description: 'd' }])
  assert.equal(outcome.code, 'INVALID_OP')
  outcome = await runSkills(rt, cwd, [{ name: 'guard-me', action: 'create', content: 'no frontmatter and no description' }])
  assert.equal(outcome.code, 'INVALID_OP')

  outcome = await runSkills(rt, cwd, [{ name: 'guard-me', action: 'edit', content: '---\nname: other-name\ndescription: d\n---\nbody' }])
  assert.equal(outcome.code, 'INVALID_SKILL', 'a rewrite must keep the discoverable name')
  outcome = await runSkills(rt, cwd, [{ name: 'does-not-exist', action: 'patch', old_string: 'a', new_string: 'b' }])
  assert.equal(outcome.code, 'NOT_FOUND')
  outcome = await runSkills(rt, cwd, [{ name: 'guard-me', action: 'write_file', file_path: 'references/new.md', file_content: 'x' }, { name: 'guard-me', action: 'remove_file', file_path: 'references/missing.md' }])
  assert.equal(outcome.code, 'NOT_FOUND')
  assert.equal(await exists(path.join(rt.paths.skillsDir, 'guard-me', 'references', 'new.md')), false, 'write_file undone')
})

test('skills: project scope creates under <project root>/.agents/skills; nested hubs and the catalog are located', async () => {
  const rt = makeRt()
  const project = path.join(HOME, 'code', 'repo')
  await mkdir(path.join(project, '.git'), { recursive: true })
  const cwd = path.join(project, 'packages', 'app')
  await mkdir(cwd, { recursive: true })
  let outcome = await runSkills(rt, cwd, [{ name: 'repo-convention', action: 'create', content: 'Use pnpm.', description: 'd', scope: 'project' }])
  assert.equal(outcome.success, true)
  assert.ok(await exists(path.join(project, '.agents', 'skills', 'repo-convention', 'SKILL.md')))

  const nested = path.join(rt.paths.skillsDir, 'devops', 'nginx-tune')
  await mkdir(nested, { recursive: true })
  await writeFile(path.join(nested, 'SKILL.md'), '---\nname: nginx-tune\ndescription: d\n---\nworker_processes auto;\n')
  outcome = await runSkills(rt, cwd, [{ name: 'nginx-tune', action: 'patch', old_string: 'auto', new_string: '4' }])
  assert.equal(outcome.success, true)
  assert.equal(outcome.results[0].source, 'user-dsh')
  assert.ok((await readFile(path.join(nested, 'SKILL.md'), 'utf8')).includes('worker_processes 4;'))

  const roots = await skillRoots(rt.paths, rt.config, cwd)
  assert.equal(roots[0].projectRoot, project, 'project root is the nearest .git ancestor')
  const viaCatalog = await locateSkill({ name: 'anything', roots, lookup: async () => ({ path: '/from/catalog/SKILL.md', source: 'custom' }) })
  assert.deepEqual(viaCatalog, { path: '/from/catalog/SKILL.md', source: 'custom' }, 'the session catalog wins over the filesystem search')
})

// ------------------------------------------------- tool definitions (real DSH)

const DSH_INSTALL = process.env.DSH_TEST_INSTALL_DIR ?? path.join(REAL_HOME, '.local/lib/node_modules/@deepseek-ai/dsh')
const defineTool = await import(pathToFileURL(path.join(DSH_INSTALL, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js')).href)
  .then(module => module.defineTool, () => undefined)
/** The installed LLM chunk assembler, for the condense stream reader. */
const blockAssembler = await import(pathToFileURL(path.join(DSH_INSTALL, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')).href)
  .then(module => module.BlockAssembler, () => undefined)

test('tool definitions compile against the installed @deepseek-ai/dsh-tools and validate calls', { skip: defineTool === undefined && 'dsh installation not reachable' }, async () => {
  await seedAgentsMd()
  const rt = makeRt()
  const fakeExec = { signal: new AbortController().signal, agent: undefined }
  const memory = tools.memoryTool(defineTool, rt, ['memory', 'user'])
  const persona = tools.personaTool(defineTool, rt, ['persona', 'soul'])
  const skill = tools.skillTool(defineTool, rt, { sessionOf: async () => ({ cwd: HOME, known: true }), catalogLookup: () => async () => undefined })

  assert.equal(memory.name, 'memory')
  assert.deepEqual(memory.parameters.required, ['target', 'operations'])
  assert.equal(skill.parameters.properties.operations.items.oneOf.length, 14, 'create, patch, edit, write_file, remove_file, delete, view, pin, unpin, curate, scan, pause, resume, consolidate')

  await assert.rejects(memory.execute({ operations: [{ action: 'add', content: 'x' }] }, fakeExec), error => error.code === 'INVALID_ARGS')
  assert.equal((await memory.execute({ target: 'memory', operations: [] }, fakeExec)).success, false, 'an empty batch is refused')

  let value = await memory.execute({ target: 'memory', operations: [{ action: 'add', content: 'from the real pipeline' }] }, fakeExec)
  assert.equal(value.success, true)

  value = await persona.execute({ operation: 'view' }, fakeExec)
  assert.equal(value.success, true)
  assert.ok(value.sections.includes('## EXECUTION RULES'))

  value = await skill.execute({ operations: [{ name: 'schema-probe', action: 'create', content: 'body', description: 'd' }] }, fakeExec)
  assert.equal(value.success, true)
  await assert.rejects(
    skill.execute({ operations: [{ name: 'schema-probe', action: 'delete', content: 'not part of the delete shape' }] }, fakeExec),
    error => error.code === 'INVALID_ARGS',
    'another action\'s text slot is invalid (oneOf exactness)',
  )
  value = await skill.execute({ operations: [{ name: 'schema-probe', action: 'delete' }] }, fakeExec)
  assert.equal(value.success, true)
  assert.deepEqual(memory.output.render({}, { a: 1 }), [{ type: 'text', text: '{"a":1}' }])
})

/** What the dsh-tools pipeline does to every call: `arguments: deepFreeze(snapshotJsonValue(...))`. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

test('tools: deep-frozen host arguments are accepted by every action (live calls failed with "read only property name")', { skip: defineTool === undefined && 'dsh installation not reachable' }, async () => {
  await seedAgentsMd()
  const rt = makeRt()
  const fakeExec = Object.freeze({ signal: new AbortController().signal, agent: undefined })
  const memory = tools.memoryTool(defineTool, rt, ['memory', 'user'])
  const persona = tools.personaTool(defineTool, rt, ['persona', 'soul'])
  const skill = tools.skillTool(defineTool, rt, { sessionOf: async () => ({ cwd: HOME, known: true }), catalogLookup: () => async () => undefined })
  const call = (tool, args) => tool.execute(deepFreeze(args), fakeExec)
  const ok = result => assert.equal(result.success, true, result.error)

  ok(await call(memory, { target: 'memory', operations: [{ action: 'add', content: 'frozen entry' }, { action: 'patch', old_text: 'frozen', content: 'thawed' }] }))
  ok(await call(memory, { target: 'user', operations: [{ action: 'add', content: 'Likes running.' }] }))
  ok(await call(memory, { target: 'memory', operations: [{ action: 'view' }] }))
  ok(await call(memory, { target: 'memory', operations: [{ action: 'remove', old_text: 'thawed' }] }))

  ok(await call(persona, { operation: 'view' }))
  ok(await call(persona, { operation: 'set_section', section: 'Rules', content: '1. Frozen input is read-only.' }))
  ok(await call(persona, { operation: 'patch', old_text: 'read-only', content: 'never written to' }))
  ok(await call(persona, { target: 'soul', operation: 'append', content: 'No filler.' }))
  ok(await call(persona, { operation: 'remove_section', section: 'Rules' }))
  ok(await call(persona, { operation: 'replace', content: '# NEW' }))

  ok(await call(skill, { operations: [{ name: 'frozen-probe', action: 'create', content: 'alpha beta', description: 'd' }] }))
  let outcome = await call(skill, { operations: [
    { name: 'frozen-probe', action: 'write_file', file_path: 'references/notes.md', file_content: 'one one two' },
    { name: 'frozen-probe', action: 'patch', old_string: 'one', new_string: 'zero', replace_all: true, file_path: 'references/notes.md' },
    { name: 'frozen-probe', action: 'patch', old_string: 'beta', new_string: 'gamma' },
    { name: 'frozen-probe', action: 'view' },
  ] })
  assert.equal(outcome.results[1].replacements, 2, 'the trimmed name reached the patch')
  assert.equal(outcome.results[3].content, '---\nname: frozen-probe\ndescription: d\n---\n\nalpha gamma\n')
  outcome = await call(skill, { operations: [
    { name: 'frozen-probe', action: 'edit', content: '---\nname: frozen-probe\ndescription: d\n---\n\nrewritten\n' },
    { name: 'frozen-probe', action: 'remove_file', file_path: 'references/notes.md' },
    { name: 'frozen-probe', action: 'delete' },
  ] })
  assert.ok(await exists(outcome.results[2].trash), 'the deleted skill is in the trash')
  assert.equal(await exists(path.join(rt.paths.skillsDir, 'frozen-probe')), false)

  outcome = await call(skill, { operations: [{ name: 'Bad_Name', action: 'create', content: 'x', description: 'd' }] })
  assert.equal(outcome.code, 'INVALID_OP', 'a malformed frozen op is refused as INVALID_OP, not a TypeError')
})

// --------------------------------------------------------------- frontmatter

test('frontmatter: builds and parses quoted descriptions and block scalars', () => {
  const text = buildSkillText('x-skill', 'Use when: deploying — "carefully"', 'body')
  const parsed = splitFrontmatter(text)
  assert.equal(parsed.data.name, 'x-skill')
  assert.equal(parsed.data.description, 'Use when: deploying — "carefully"')
  assert.equal(parsed.body, 'body\n')
  const block = splitFrontmatter('---\nname: a\ndescription: >-\n  line one\n  line two\nuser-invocable: false\n---\nbody')
  assert.equal(block.data.description, 'line one line two')
  assert.equal(block.data['user-invocable'], 'false')
  assert.equal(splitFrontmatter('no frontmatter').has, false)
})

// ------------------------------------------------ review regressions

test('skills: a skill name is never a path', async () => {
  const rt = makeRt()
  const cwd = HOME
  await seedAgentsMd()
  const before = await readFile(rt.paths.agentsMd, 'utf8')
  for (const name of ['../AGENTS', '../../outside/victim', '..', 'a/../../x', '/etc/passwd', 'ok/../../x', 'a/b/c']) {
    const outcome = await runSkills(rt, cwd, [{ name, action: 'view' }])
    assert.equal(outcome.success, false, `${name} must be refused`)
    assert.equal(outcome.code, 'INVALID_OP')
  }
  assert.equal(await readFile(rt.paths.agentsMd, 'utf8'), before)
  assert.equal(await exists(path.join(HOME, 'outside')), false)
})

test('skills: aborting mid-batch still rolls back', async () => {
  const rt = makeRt()
  const cwd = HOME
  await runSkills(rt, cwd, [{ name: 'abort-probe', action: 'create', content: '---\nname: abort-probe\ndescription: d\n---\n\noriginal\n' }])
  const controller = new AbortController()
  const lookup = async () => {
    controller.abort()
    return undefined
  }
  const outcome = await runSkillOps(rt, {
    ops: [
      { name: 'abort-probe', action: 'patch', old_string: 'original', new_string: 'changed' },
      { name: 'abort-probe', action: 'view' },
    ],
    session: { cwd, known: true },
    lookup,
    signal: controller.signal,
  })
  assert.equal(outcome.success, false)
  assert.equal(outcome.code, 'ABORTED')
  assert.equal(outcome.rolled_back, true)
  assert.equal(await readFile(path.join(rt.paths.skillsDir, 'abort-probe', 'SKILL.md'), 'utf8'), '---\nname: abort-probe\ndescription: d\n---\n\noriginal\n')
})

test('skills: binary supporting files survive rollback byte-for-byte; SKILL.md is only rewritten through edit', async () => {
  const rt = makeRt()
  const cwd = HOME
  await runSkills(rt, cwd, [{ name: 'binary-probe', action: 'create', content: 'body', description: 'd' }])
  const dir = path.join(rt.paths.skillsDir, 'binary-probe')
  const logo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x81])
  await mkdir(path.join(dir, 'assets'), { recursive: true })
  await writeFile(path.join(dir, 'assets', 'logo.png'), logo)
  let outcome = await runSkills(rt, cwd, [
    { name: 'binary-probe', action: 'remove_file', file_path: 'assets/logo.png' },
    { name: 'binary-probe', action: 'patch', old_string: 'NOT THERE', new_string: 'x' },
  ])
  assert.equal(outcome.rolled_back, true)
  assert.deepEqual(await readFile(path.join(dir, 'assets', 'logo.png')), logo)

  outcome = await runSkills(rt, cwd, [{ name: 'binary-probe', action: 'write_file', file_path: 'SKILL.md', file_content: 'no frontmatter' }])
  assert.equal(outcome.code, 'INVALID_OP')
  outcome = await runSkills(rt, cwd, [{ name: 'binary-probe', action: 'remove_file', file_path: 'SKILL.md' }])
  assert.equal(outcome.code, 'INVALID_OP')
  outcome = await runSkills(rt, cwd, [{ name: 'binary-probe', action: 'patch', old_string: 'body', new_string: 'x', file_path: 'assets/logo.png' }])
  assert.equal(outcome.code, 'INVALID_OP', 'binary files cannot be patched')
  outcome = await runSkills(rt, cwd, [{ name: 'binary-probe', action: 'patch', old_string: 'description: d', new_string: 'description: Use when: broken', file_path: 'SKILL.md' }])
  assert.equal(outcome.code, 'INVALID_SKILL', 'a patch that breaks discovery is refused')
})

test('skills: nested hub skills can be deleted; flat skills reject file_path patches', async () => {
  const rt = makeRt()
  const cwd = HOME
  const nested = path.join(rt.paths.skillsDir, 'cat', 'nested-skill')
  await mkdir(nested, { recursive: true })
  await writeFile(path.join(nested, 'SKILL.md'), '---\nname: nested-skill\ndescription: d\n---\nbody\n')
  let outcome = await runSkills(rt, cwd, [{ name: 'cat/nested-skill', action: 'delete' }])
  assert.equal(outcome.success, true)
  assert.equal(await exists(nested), false)
  assert.ok(await exists(path.join(outcome.results[0].trash, 'SKILL.md')))

  const flatRoot = path.join(HOME, '.agents', 'skills')
  await mkdir(flatRoot, { recursive: true })
  await writeFile(path.join(flatRoot, 'flat-one.md'), '---\nname: flat-one\ndescription: d\n---\nbody\n')
  await mkdir(path.join(flatRoot, 'references'), { recursive: true })
  await writeFile(path.join(flatRoot, 'references', 'other.md'), 'other')
  outcome = await runSkills(rt, cwd, [{ name: 'flat-one', action: 'patch', old_string: 'other', new_string: 'x', file_path: 'references/other.md' }])
  assert.equal(outcome.code, 'INVALID_OP')
  assert.equal(await readFile(path.join(flatRoot, 'references', 'other.md'), 'utf8'), 'other')
})

test('historyMax 0 disables snapshots; concurrent memory adds all survive', async () => {
  const rt0 = makeRt({ historyMax: 0, dataDir: path.join(HOME, 'no-history') })
  await runMemory(rt0, { target: 'memory', operations: [{ action: 'add', content: 'one' }] })
  assert.equal(await exists(path.join(rt0.paths.dataDir)), false)

  const rt = makeRt({ memoryFile: path.join(HOME, 'concurrent', 'MEMORY.md') })
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => runMemory(rt, { target: 'memory', operations: [{ action: 'add', content: `entry ${i}` }] })))
  assert.ok(results.every(result => result.success === true))
  assert.equal(parseEntries(await readFile(rt.paths.memoryFile, 'utf8')).length, 8)
})

test('persona: whole-file replace is refused while other SYNC blocks exist; patch may delete; duplicate titles and fences', async () => {
  const rt = makeRt()
  const agents = ['<!-- SYNC:SOUL_START -->', 'soul text', '<!-- SYNC:SOUL_END -->', '', 'Free persona text.'].join('\n')
  await writeFile(rt.paths.agentsMd, agents)
  let result = await runPersona(rt, { operation: 'replace', content: '# NEW' })
  assert.equal(result.success, false)
  assert.match(result.error, /SYNC blocks/)
  result = await runPersona(rt, { operation: 'append', content: 'More.' })
  assert.equal(result.success, true)
  assert.ok((await readFile(rt.paths.agentsMd, 'utf8')).includes('soul text'))

  await seedAgentsMd()
  result = await runPersona(rt, { operation: 'patch', old_text: '2. Evidence-gated.', content: '' })
  assert.equal(result.success, true)
  assert.ok(!(await readFile(rt.paths.agentsMd, 'utf8')).includes('Evidence-gated'))

  result = await runPersona(rt, { operation: 'set_section', section: 'Identity', content: 'A.' })
  assert.equal(result.created_section, false)
  result = await runPersona(rt, { operation: 'append', content: '## identity\nDuplicate.' })
  assert.equal(result.success, true)
  result = await runPersona(rt, { operation: 'set_section', section: 'identity', content: 'B.' })
  assert.equal(result.success, false, 'duplicate titles are ambiguous')
  assert.match(result.error, /more than one section/)

  const fenced = ['## Deploy', 'Run this:', '```bash', '# this is a shell comment', 'echo deploy', '```', 'After the fence.'].join('\n')
  const dir = path.join(HOME, 'fenced')
  await mkdir(dir, { recursive: true })
  const rt2 = makeRt({ dshHome: dir, agentsMd: path.join(dir, 'AGENTS.md') })
  await writeFile(rt2.paths.agentsMd, fenced)
  result = await runPersona(rt2, { operation: 'view' })
  assert.deepEqual(result.sections, ['## Deploy'])
  result = await runPersona(rt2, { operation: 'remove_section', section: 'Deploy' })
  assert.equal(result.success, true)
  assert.equal(await readFile(rt2.paths.agentsMd, 'utf8'), '')
})

// ----------------------------------------------------------------- condense

/**
 * An adapter stream that answers with one text block split over two deltas,
 * behind a reasoning block, then usage and a finish.
 * @param {string} text - the answer.
 * @param {{ reasoning?: boolean, finish?: object, failure?: object }} [options]
 *   - whether a reasoning block precedes the text, the finish reason and a
 *   terminal failure.
 */
async function* modelStream(text, { reasoning = true, finish = { kind: 'stop' }, failure } = {}) {
  if (reasoning) {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: 'thinking…' }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking…' } }
  }
  yield { type: 'block-start', index: 1, blockType: 'text' }
  const cut = Math.floor(text.length / 2)
  yield { type: 'text-delta', index: 1, text: text.slice(0, cut) }
  yield { type: 'text-delta', index: 1, text: text.slice(cut) }
  yield { type: 'block-end', index: 1, block: { type: 'text', text } }
  yield { type: 'usage', usage: { input: 3100, output: 900 } }
  yield { type: 'finish', reason: failure === undefined ? finish : { kind: 'error', failure } }
}

/** A hook shaped like the plugin entry's: the model answers through `stream`. */
const condenser = (stream, seen) => async input => {
  seen?.push(input)
  const outcome = await condenseEntries({ ...input, stream })
  return outcome.ok === true ? { ...outcome, report: { provider: 'nine-router', model: 'FreeModel', ...outcome.report } } : outcome
}

test('condense: the entry instruction states both sizes and the tokens to keep; output is parsed by tags', () => {
  const entry = 'Runs gateway at router.example.local with 600+ accounts, port 8443.'
  const size = charCount([entry])
  const instruction = condenseInstruction({ entry, size, goal: 40, need: 120 })
  assert.match(instruction, /has to lose 120 characters in all/)
  assert.match(instruction, new RegExp(`This entry is ${size} characters; the answer\\s+must be at most 40 characters, at least \\d+ shorter`))
  assert.match(instruction, /<entry>…<\/entry>/)
  assert.ok(instruction.includes(`The entry:\n\n${entry}\n\nRules:`), 'the entry itself is in the prompt')
  assert.match(instruction, /These must all still appear in your answer: router\.example\.local, 600\+, 8443\.$/)
  assert.doesNotMatch(condenseInstruction({ entry: 'prefers terse answers', size: 21, goal: 15, need: 6 }), /must all still appear/)
  assert.match(condenseInstruction({ kind: 'user', entry: 'x', size: 1, goal: 1, need: 1 }), /user profile/)

  assert.deepEqual(parseCondensed('Sure:\n<entry> A. </entry>\n<entry>A.</entry>\n<entry>  </entry><entry>B.</entry> tail'), ['A.', 'B.'])
  assert.deepEqual(parseCondensed('A.\n§\nB.'), [], 'untagged output is refused')

  const before = ['Host router.example.local with 600+ accounts on port 8443.', 'dsh v0.2.2-rc.5 lives in ~/.local/lib/node_modules.']
  let kept = anchorRetention(before, ['router.example.local (600+ accounts, port 8443)', 'dsh v0.2.2-rc.5 in ~/.local/lib/node_modules'])
  assert.equal(kept.ratio, 1)
  assert.deepEqual(kept.dropped, [])
  kept = anchorRetention(before, ['router.example.local has many accounts'])
  assert.equal(kept.ratio, 0.2, 'only the host survived of five anchors')
  assert.deepEqual(kept.dropped, ['600+', '8443', 'v0.2.2-rc.5', '~/.local/lib/node_modules'])
  assert.equal(anchorRetention(['prefers terse answers'], ['terse']).ratio, 1, 'nothing concrete to keep')
})

test('condense: the route prefers the pinned model, then the session route, then the agent default; the call is a plain request', async () => {
  const routed = { provider: 'nine-router', model: 'FreeModel' }
  assert.deepEqual(condenseRoute({ pinned: { provider: 'pinned', model: 'm1' }, routed, own: { provider: 'own', model: 'm0' } }), { provider: 'pinned', model: 'm1' })
  assert.deepEqual(condenseRoute({ pinned: { provider: 'pinned' }, routed, own: { provider: 'own', model: 'm0' } }), routed, 'a half-pinned route is ignored')
  assert.deepEqual(condenseRoute({ routed: undefined, own: { provider: 'own', model: 'm0' } }), { provider: 'own', model: 'm0' })
  assert.equal(condenseRoute({ own: { provider: 'own' } }), undefined, 'a route needs both a provider and a model')
  assert.equal(condenseRoute({}), undefined)

  const calls = []
  let resolved = 0
  const handler = text => ({
    resolveModelInfo: async (provider, model) => {
      resolved += 1
      assert.equal(provider, 'nine-router')
      assert.equal(model, 'FreeModel')
      return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } }
    },
    stream: options => {
      calls.push(options)
      return modelStream(text)
    },
  })
  const entry = 'Runs gateway at router.example.local with 600+ accounts, port 8443.'
  const input = { entries: [entry], kind: 'memory', target: 55 }
  let outcome = await condenseWithLlm(handler('<entry>Runs router.example.local with 600+ accounts on 8443.</entry>'), input, { ...routed, sessionId: 's1' })
  assert.equal(resolved, 1)
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.entries, ['Runs router.example.local with 600+ accounts on 8443.'])
  assert.equal(calls[0].provider, 'nine-router')
  assert.equal(calls[0].model, 'FreeModel')
  assert.equal(calls[0].reasoningEffort, 'low', 'the least reasoning effort')
  assert.equal(calls[0].sessionId, 's1')
  assert.equal(calls[0].messages.length, 1)
  assert.equal(calls[0].messages[0].role, 'user')
  assert.match(calls[0].messages[0].content[0].text, /the answer\s+must be at most \d+ characters/)
  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.equal(calls[0].maxTokens, undefined, 'the default token budget')
  assert.equal(calls[0].temperature, undefined)
  assert.equal(outcome.report.provider, 'nine-router')
  assert.equal(outcome.report.model, 'FreeModel')
  assert.equal(outcome.report.reasoning_effort, 'low')
  assert.equal(outcome.report.before.chars, charCount(input.entries))
  assert.equal(outcome.report.after.chars, charCount(outcome.entries))
  assert.equal(outcome.report.target_chars, 55)
  assert.equal(outcome.report.anchor_retention, 1)
  assert.equal(outcome.report.calls, 1)
  assert.deepEqual(outcome.report.trims, [{ before: charCount([entry]), after: charCount(['Runs router.example.local with 600+ accounts on 8443.']) }])
  assert.deepEqual(outcome.report.usage, { input: 3100, output: 900 })

  outcome = await condenseWithLlm(handler('<entry>Runs router.example.local with 600+ accounts on 8443.</entry>'), input, routed)
  assert.equal(calls.at(-1).sessionId, undefined, 'no session id without a session')
  assert.equal(outcome.ok, true)

  outcome = await condenseWithLlm({ stream: () => modelStream('', { failure: { code: 'RATE_LIMIT', message: 'busy' } }) }, input, routed)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error, 'llm:RATE_LIMIT')
  assert.equal(outcome.message, 'busy')
  assert.equal(outcome.provider, 'nine-router', 'a failed attempt still names the model it used')
  assert.equal(outcome.model, 'FreeModel')

  outcome = await condenseWithLlm(handler('no tags here'), input, routed)
  assert.equal(outcome.error, 'no_entries')

  const blind = { ...handler('<entry>Runs router.example.local with 600+ accounts on 8443.</entry>'), resolveModelInfo: async () => { throw new Error('unknown model') } }
  outcome = await condenseWithLlm(blind, input, routed)
  assert.equal(outcome.ok, true, 'a metadata failure does not stop the call')
  assert.equal(calls.at(-1).reasoningEffort, undefined, 'the adapter default')
  assert.equal(outcome.report.reasoning_effort, undefined)
})

test('memory: an over-budget add trims the store by one model call, then applies the batch in the same write', async () => {
  const rt = makeRt({ memoryCharLimit: 120, memoryMirrors: ['~/condense-mirror/MEMORY.md'] })
  const old = ['User: Alex, ABAP developer, loves running.', 'Runs gateway at router.example.local with 600+ accounts.']
  const seed = renderEntries(old)
  await writeFile(rt.paths.memoryFile, seed)
  const answer = '<entry>Runs gateway at router.example.local, 600+.</entry>'
  const trimmed = parseCondensed(answer)[0]
  const seen = []
  const result = await runMemory(rt, { target: 'memory', operations: [{ action: 'add', content: 'Prefers terse answers.' }] }, { condense: condenser(() => modelStream(answer), seen) })

  assert.equal(seen.length, 1, 'one model call')
  assert.deepEqual(seen[0].entries, old, 'the store as it is, before the add')
  assert.equal(seen[0].kind, 'memory')
  assert.equal(seen[0].target, 120 - 'Prefers terse answers.'.length - 3, 'the room the add needs')

  assert.equal(result.success, true)
  assert.equal(result.done, true)
  const condensed = [old[0], trimmed]
  assert.deepEqual(parseEntries(await readFile(rt.paths.memoryFile, 'utf8')), [...condensed, 'Prefers terse answers.'])
  assert.equal(await readFile(path.join(HOME, 'condense-mirror', 'MEMORY.md'), 'utf8'), await readFile(rt.paths.memoryFile, 'utf8'), 'the mirror receives the condensed store')
  assert.equal(result.entry_count, 3)
  assert.equal(result.condensed.before.entries, 2)
  assert.equal(result.condensed.before.chars, seed.length)
  assert.equal(result.condensed.after.entries, 2)
  assert.equal(result.condensed.after.chars, renderEntries(condensed).length)
  assert.equal(result.condensed.target_chars, 120 - 'Prefers terse answers.'.length - 3)
  assert.equal(result.condensed.provider, 'nine-router')
  assert.equal(result.condensed.model, 'FreeModel')
  assert.equal(result.condensed.anchor_retention, 1, 'router.example.local and 600+ survived')
  assert.deepEqual(result.condensed.trims, [{ before: charCount([old[1]]), after: charCount([trimmed]) }])
  assert.deepEqual(result.condensed.usage, { input: 3100, output: 900 })
  assert.match(result.message, /shortened 1 entry \(\d+ → \d+ chars\) with nine-router\/FreeModel, then applied 1 operation\(s\)/)

  assert.equal(await readFile(result.history, 'utf8'), seed, 'the snapshot holds the store before condensation')
  const transcript = JSON.parse(await readFile(result.condensed.transcript, 'utf8'))
  assert.deepEqual(transcript.before, old)
  assert.deepEqual(transcript.after, condensed)
  assert.match(transcript.instruction, /has to lose \d+ characters/)
  assert.equal(transcript.store, 'MEMORY.md (agent notes)')
})

test('memory: a failed, untagged, non-shrinking or fact-dropping condensation rejects the add and writes nothing', async () => {
  const rt = makeRt({ memoryCharLimit: 120 })
  const seed = renderEntries(['User: Alex, ABAP developer, loves running.', 'Runs gateway at router.example.local with 600+ accounts.'])
  const add = [{ action: 'add', content: 'Prefers terse answers.' }]
  const cases = [
    ['stream failure', () => modelStream('', { failure: { code: 'RATE_LIMIT', message: 'busy' } }), 'llm:RATE_LIMIT'],
    ['truncated', () => modelStream('<entry>cut', { finish: { kind: 'max-tokens' } }), 'max_tokens'],
    ['untagged', () => modelStream('A.\n§\nB.'), 'no_entries'],
    ['not smaller', () => modelStream(`<entry>${'x'.repeat(60)}</entry>`), 'no_reduction'],
    ['facts dropped', () => modelStream('<entry>router.example.local with a lot of accounts here.</entry>'), 'low_anchor_retention'],
  ]
  for (const [name, stream, error] of cases) {
    await writeFile(rt.paths.memoryFile, seed)
    const result = await runMemory(rt, { target: 'memory', operations: add }, { condense: condenser(stream) })
    assert.equal(result.success, false, name)
    assert.equal(result.failure, 'over_budget', name)
    assert.equal(result.condense.attempted, true, name)
    assert.equal(result.condense.error, error, name)
    assert.match(result.error, /Automatic condensation failed/, name)
    assert.deepEqual(result.current_entries, parseEntries(seed), `${name}: the agent is handed the store to condense itself`)
    assert.equal(await readFile(rt.paths.memoryFile, 'utf8'), seed, `${name}: nothing written`)
  }
})

test('memory: without the hook, with autoCondense off, or with no adds, an over-budget add is rejected as before', async () => {
  const seed = renderEntries(['User: Alex, ABAP developer, loves running.', 'Runs gateway at router.example.local with 600+ accounts.'])
  const add = [{ action: 'add', content: 'Prefers terse answers.' }]
  let called = 0
  const counting = { condense: async () => { called += 1; return { ok: true, entries: ['never'], instruction: '', report: {} } } }

  const off = makeRt({ memoryCharLimit: 120, autoCondense: false, memoryFile: path.join(HOME, 'off', 'MEMORY.md') })
  await mkdir(path.dirname(off.paths.memoryFile), { recursive: true })
  await writeFile(off.paths.memoryFile, seed)
  let result = await runMemory(off, { target: 'memory', operations: add }, counting)
  assert.equal(result.failure, 'over_budget')
  assert.equal(result.condense, undefined)
  assert.equal(await readFile(off.paths.memoryFile, 'utf8'), seed)

  const rt = makeRt({ memoryCharLimit: 120 })
  await writeFile(rt.paths.memoryFile, seed)
  result = await runMemory(rt, { target: 'memory', operations: add })
  assert.equal(result.failure, 'over_budget', 'no hook: the plain rejection')
  assert.equal(result.condense, undefined)

  result = await runMemory(rt, { target: 'memory', operations: [{ action: 'patch', old_text: 'loves running.', content: 'loves running, cycling and swimming in Jakarta every week.' }] }, counting)
  assert.equal(result.failure, 'over_budget', 'a growing patch addresses old text and cannot follow a condensation')
  assert.equal(result.condense, undefined)
  assert.equal(called, 0, 'the model is never asked')
})

test('memory: a batch that frees space and still overflows is trimmed first, then its adds are applied', async () => {
  const rt = makeRt({ memoryCharLimit: 120 })
  const A = 'A: old note here.'
  const B = 'B: Alex, ABAP developer, loves running; gateway has 600+ accounts on port 8443 (v0.2.2-rc.5).'
  const C = 'C: new fact.'
  const D = 'D: another fact.'
  assert.ok(charCount([A, B]) <= 120, 'the store fits before the batch')
  assert.ok(charCount([B, C, D]) > 120, 'even without A the adds would not fit')
  await writeFile(rt.paths.memoryFile, renderEntries([A, B]))
  const answer = '<entry>B: Alex, ABAP dev, runs; gateway has 600+ accounts on port 8443 (v0.2.2-rc.5).</entry>'
  const seen = []
  const result = await runMemory(rt, {
    target: 'memory',
    operations: [{ action: 'remove', old_text: 'A: old note' }, { action: 'add', content: C }, { action: 'add', content: D }],
  }, { condense: condenser(() => modelStream(answer), seen) })

  assert.equal(result.success, true)
  assert.deepEqual(seen[0].entries, [B], 'the removal is applied on the real store before the model sees it')
  assert.equal(seen[0].target, 120 - (C.length + 3) - (D.length + 3), 'only the room the adds need')
  assert.deepEqual(result.removed_entries, { 1: A })
  assert.deepEqual(parseEntries(await readFile(rt.paths.memoryFile, 'utf8')), [parseCondensed(answer)[0], C, D])
  assert.match(result.message, /then applied 3 operation\(s\)/)
})

test('memory: a store edited while it was being condensed is not overwritten', async () => {
  const rt = makeRt({ memoryCharLimit: 120 })
  const seed = renderEntries(['User: Alex, ABAP developer, loves running.', 'Runs gateway at router.example.local with 600+ accounts.'])
  const raced = `${seed}\n§\nAdded by another session meanwhile.`
  await writeFile(rt.paths.memoryFile, seed)
  const result = await runMemory(rt, { target: 'memory', operations: [{ action: 'add', content: 'Prefers terse answers.' }] }, {
    condense: async input => {
      await writeFile(rt.paths.memoryFile, raced)
      return condenser(() => modelStream('<entry>router.example.local: 600+ accounts.</entry>'))(input)
    },
  })
  assert.equal(result.success, false)
  assert.equal(result.condense.error, 'changed_while_condensing')
  assert.equal(await readFile(rt.paths.memoryFile, 'utf8'), raced)
})

test('memory: a condensation that leaves the store over budget after the adds rejects the write and keeps the store', async () => {
  const rt = makeRt({ memoryCharLimit: 120 })
  const seed = renderEntries(['User: Alex, ABAP developer, loves running.', 'Runs gateway at router.example.local with 600+ accounts.'])
  await writeFile(rt.paths.memoryFile, seed)
  // A condenser that reports success but hands back a store that still does not fit.
  const liar = async input => ({
    ok: true,
    entries: [...input.entries, 'y'.repeat(200)],
    instruction: 'x',
    report: { provider: 'nine-router', model: 'FreeModel', before: { entries: 2, chars: 103 }, after: { entries: 3, chars: 320 }, target_chars: input.target, trims: [{ before: 1, after: 1 }] },
  })
  const result = await runMemory(rt, { target: 'memory', operations: [{ action: 'add', content: 'x'.repeat(60) }] }, { condense: liar })
  assert.equal(result.success, false)
  assert.equal(result.condense.error, 'still_over_budget')
  assert.equal(result.condensed, undefined, 'a rejected write reports nothing as condensed')
  assert.deepEqual(result.current_entries, parseEntries(seed), 'the rejection lists the real store, not the condensed one')
  assert.equal(await readFile(rt.paths.memoryFile, 'utf8'), seed)
})

test('condense: a stream that never ends is abandoned at the time budget; a cancelled call reports aborted', async () => {
  const never = async function* () { await new Promise(() => {}) }
  const e1 = 'User: Alex, ABAP developer.'
  const e2 = 'Runs gateway at router.example.local with 600+ accounts.'
  const answer = 'router.example.local with 600+ accounts.'
  const entries = [e1, e2]
  const input = { entries, target: charCount(entries) - 8 }
  let outcome = await condenseEntries({ ...input, stream: never, timeoutMs: 20 })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error, 'timeout')
  assert.ok(outcome.duration_ms >= 15)

  const controller = new AbortController()
  controller.abort()
  outcome = await condenseEntries({ ...input, stream: never, signal: controller.signal })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error, 'aborted')

  outcome = await condenseEntries({ ...input, stream: () => modelStream(`<entry>${answer}</entry>`, { reasoning: false }) })
  assert.equal(outcome.ok, true, 'a plain text stream yields its entry')
  assert.deepEqual(outcome.entries, [e1, answer])
  assert.deepEqual(outcome.report.trims, [{ before: charCount([e2]), after: charCount([answer]) }], 'only the entry that had to shrink')
})

test('condense: readStream returns the text and usage the installed BlockAssembler assembles', { skip: blockAssembler === undefined && 'dsh installation not reachable' }, async () => {
  for (const chunks of [
    [{ type: 'block-start', index: 0, blockType: 'reasoning' }, { type: 'reasoning-delta', index: 0, text: 'think' }, { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } }, { type: 'block-start', index: 1, blockType: 'text' }, { type: 'text-delta', index: 1, text: 'al' }, { type: 'text-delta', index: 1, text: 'pha' }, { type: 'block-end', index: 1, block: { type: 'text', text: 'alpha' } }, { type: 'usage', usage: { input: 12, output: 3 } }, { type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'one' }, { type: 'block-end', index: 0, block: { type: 'text', text: 'one' } }, { type: 'block-start', index: 1, blockType: 'text' }, { type: 'text-delta', index: 1, text: 'two' }, { type: 'block-end', index: 1, block: { type: 'text', text: 'two' } }, { type: 'finish', reason: { kind: 'stop' } }],
  ]) {
    const assembler = new blockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    const read = await readStream(chunks)
    assert.equal(read.text, assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join(''))
    assert.deepEqual(read.usage, assembler.usage)
    assert.equal(read.finish, assembler.finish.kind)
  }
})

// --------------------------------------- skill curator + separate skill nudge


/**
 * A runtime with its own DSH home AND its own agents home, so skill roots from
 * earlier tests in this file cannot leak into a skill-curator assertion.
 */
function isolatedRt(tag, config = {}) {
  const previous = process.env.DSH_AGENTS_HOME
  process.env.DSH_AGENTS_HOME = path.join(HOME, `agents-${tag}`)
  try {
    return makeRt({ dshHome: path.join(HOME, `dsh-${tag}`), ...config })
  } finally {
    if (previous === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previous
  }
}

/** Create a skill directory with a backdated SKILL.md. */
async function seedSkill(rt, name, { ageDays = 0, pinned = false, managed = false } = {}) {
  const dir = path.join(rt.paths.skillsDir, name)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'SKILL.md')
  await writeFile(file, `---\nname: ${name}\ndescription: Use when testing. Steps.\n---\n\nBody.\n`)
  if (ageDays > 0) {
    const when = new Date(Date.now() - ageDays * DAY)
    await utimes(file, when, when)
  }
  if (managed) {
    const state = await loadSkillState(rt)
    const stamp = new Date().toISOString()
    state.entries[name] = { managed: true, first: stamp, last: stamp }
    await saveSkillState(rt, state)
  }
  if (pinned) await setSkillPin(rt, { name, pinned: true })
  return dir
}

test('skill curator: managed-only, then active → stale → archived, never deleted', async () => {
  const rt = isolatedRt('skills-a', { skillCurator: true })
  const oldSkill = await seedSkill(rt, 'old-skill', { ageDays: 20, managed: true })
  const fresh = await seedSkill(rt, 'new-skill', { managed: true })
  const foreign = await seedSkill(rt, 'reference-skill', { ageDays: 90 })

  const scan = await scanSkills(rt)
  assert.equal(scan.scanned, 3)
  assert.equal(scan.managed, 2, 'a skill the agent never wrote is not managed')
  assert.equal(scan.unmanaged_ignored, 1, 'the shared hub is reported, never touched')
  assert.deepEqual(scan.stale.map(row => row.name), ['old-skill'])
  assert.equal(scan.archivable_total, 0, '20 days is stale, not yet archivable')

  // First pass only marks: the file stays exactly where it is.
  const marked = await runSkillCurator(rt, { force: true })
  assert.equal(marked.reason, 'marked_stale')
  assert.deepEqual(marked.marked_stale, [{ name: 'old-skill', age_days: 20 }])
  assert.equal(marked.archived.length, 0)
  assert.ok((await readFile(path.join(oldSkill, 'SKILL.md'), 'utf8')).includes('old-skill'), 'a stale marker never moves a file')

  // Editing it revives it: the marker is a marker, not a punishment.
  const now = new Date()
  await utimes(path.join(oldSkill, 'SKILL.md'), now, now)
  const revived = await runSkillCurator(rt, { force: true })
  assert.deepEqual(revived.revived, ['old-skill'])
  assert.equal((await loadSkillState(rt)).entries['old-skill'].state, 'active')

  // Past the archive age it is moved, and the file is recoverable.
  const old = new Date(Date.now() - 40 * DAY)
  await utimes(path.join(oldSkill, 'SKILL.md'), old, old)
  const report = await runSkillCurator(rt, { force: true })
  assert.equal(report.reason, 'archived')
  assert.equal(report.archived.length, 1)
  await assert.rejects(readFile(path.join(oldSkill, 'SKILL.md')), 'the skill left its root')
  assert.ok((await readFile(path.join(fresh, 'SKILL.md'), 'utf8')).includes('new-skill'), 'the fresh skill stayed')
  assert.ok((await readFile(path.join(foreign, 'SKILL.md'), 'utf8')).includes('reference-skill'), 'the unmanaged skill is untouched even at 90 days')
  assert.match(await readFile(path.join(report.archive, 'old-skill', 'SKILL.md'), 'utf8'), /name: old-skill/)
  assert.match(await readFile(report.manifest, 'utf8'), /stale 40d · old-skill/)

  // Every run leaves an audit report.
  const reportFile = await readFile(report.report, 'utf8')
  assert.match(reportFile, /· curate · \d+ms/)
  assert.match(reportFile, /archived old-skill \(stale 40d\)/)
  assert.match(reportFile, /revived old-skill/)
  assert.equal((await loadSkillState(rt)).last_report_path, report.report)
})

test('skill curator: pin bypasses archiving, unpin releases it, scan changes nothing', async () => {
  const rt = isolatedRt('skills-b', { skillCurator: true })
  await seedSkill(rt, 'kept-skill', { ageDays: 40, managed: true, pinned: true })
  await seedSkill(rt, 'other-skill', { ageDays: 1, managed: true })

  const scan = await scanSkills(rt)
  assert.deepEqual(scan.stale, [], 'the pinned skill is not a candidate')
  assert.deepEqual(scan.pinned, ['kept-skill'])
  assert.equal((await discoverSkills(rt)).length, 2, 'scan is read-only')

  const first = await runSkillCurator(rt, { force: true })
  assert.equal(first.archived.length, 0, 'nothing to archive while pinned')

  await setSkillPin(rt, { name: 'kept-skill', pinned: false })
  const second = await runSkillCurator(rt, { force: true })
  assert.equal(second.archived.length, 1, 'unpinned, past the archive age')
  assert.match(second.archived[0].to, /kept-skill/)
})

test('skill curator: the scheduler seeds one interval, honours idle and pause, and one run is capped', async () => {
  const now = CURATOR_NOW
  assert.deepEqual(curatorDue({ state: { last_run_at: null }, now }), { due: false, reason: 'not_seeded', seed: true }, 'a fresh state only seeds')
  assert.equal(curatorDue({ state: { last_run_at: new Date(now - 8 * DAY).toISOString() }, now, lastActivity: now - 3 * 3600000 }).due, true, 'a week plus three idle hours is due')
  assert.equal(curatorDue({ state: { last_run_at: new Date(now - 8 * DAY).toISOString() }, now }).reason, 'idle', 'an active session waits for the idle window')
  assert.equal(curatorDue({ state: { last_run_at: new Date(now - DAY).toISOString() }, now, lastActivity: 0 }).reason, 'interval', 'inside the interval nothing runs')
  assert.equal(curatorDue({ state: { last_run_at: null, paused: true }, now }).reason, 'paused', 'paused wins over everything')

  const rt = isolatedRt('skills-c', { skillCurator: true, skillCuratorBatch: 2, skillCuratorScanLimit: 1 })
  for (const name of ['a-skill', 'b-skill', 'c-skill']) await seedSkill(rt, name, { ageDays: 30, managed: true })

  const paused = await runSkills(rt, HOME, [{ action: 'pause' }])
  assert.equal(paused.success, true)
  assert.equal(paused.paused, true)
  assert.equal((await loadSkillState(rt)).paused, true)
  assert.equal((await runSkills(rt, HOME, [{ action: 'resume' }])).paused, false)

  const scan = await scanSkills(rt)
  assert.equal(scan.stale_total, 3, 'the total is always reported')
  assert.equal(scan.stale.length, 1, 'rows are limited by skillCuratorScanLimit')

  const run = await runSkills(rt, HOME, [{ action: 'curate' }])
  assert.equal(run.success, true)
  assert.equal(run.archived.length, 2, 'one run never exceeds skillCuratorBatch')
  assert.equal(run.capped, true)
  assert.equal(run.remaining_candidates, 1)

  await setSkillPaused(rt, true)
  const stillRuns = await runSkills(rt, HOME, [{ action: 'curate' }])
  assert.equal(stillRuns.archived.length, 1, 'an explicit curate overrides a pause, like Hermes run')

  const off = await runSkills(makeRt(), HOME, [{ action: 'curate' }])
  assert.equal(off.success, false, 'a disabled skill curator refuses instead of archiving')
})

test('skill curator: consolidation folds a cluster into an umbrella and archives the sources', async () => {
  const rt = isolatedRt('skills-d', { skillCurator: true, condenseProvider: 'p', condenseModel: 'm' })
  await seedSkill(rt, 'deploy-a', { managed: true })
  await seedSkill(rt, 'deploy-b', { managed: true })

  const content = '---\nname: deploy\ndescription: Use when deploying either target.\n---\n\nSteps for both.\n'
  const llm = { stream: () => modelStream(`<plan>${JSON.stringify({ name: 'deploy', description: 'Use when deploying.', content })}</plan>`) }
  const proposals = await consolidateSkills(rt, { llm, route: { provider: 'p', model: 'm' } })
  assert.equal(proposals.success, true)
  assert.equal(proposals.consolidated.length, 1)
  assert.deepEqual(proposals.consolidated[0].sources.sort(), ['deploy-a', 'deploy-b'])

  const applied = await applyConsolidation(rt, { ...proposals.consolidated[0], cwd: HOME })
  assert.equal(applied.success, true)
  const names = (await discoverSkills(rt)).map(skill => skill.name).sort()
  assert.ok(names.includes('deploy'), 'the umbrella exists')
  assert.ok(!names.includes('deploy-a') && !names.includes('deploy-b'), 'the sources left the root')
  assert.ok(names.includes('deploy-a') === false)

  const none = await consolidateSkills(rt, { llm, route: { provider: 'p', model: 'm' } })
  assert.equal(none.reason, 'no_clusters')
  assert.equal((await consolidateSkills(rt, {})).success, false, 'without a route consolidation refuses')
})

test('notice: applied operations become Hermes-style lines, and delivery happens once at step one', async () => {
  assert.deepEqual(describeApplied([{ target: 'memory', result: { action: 'add' } }]), ['Memory updated'])
  assert.deepEqual(describeApplied([{ target: 'memory', result: { action: 'add' } }, { target: 'memory', result: { action: 'patch' } }]), ['Memory updated (2 entries)'])
  assert.deepEqual(describeApplied([{ target: 'memory', result: { action: 'add' } }], 'verbose'), ['memory add'])
  assert.deepEqual(describeApplied([{ target: 'skills', result: { action: 'create', name: 'x-skill' } }]), ['Skill create: x-skill'])

  const rt = makeRt({ memoryFile: path.join(HOME, 'notice', 'MEMORY.md'), dataDir: path.join(HOME, 'notice-data') })
  await queueNotice(rt, 'Memory updated')
  await queueNotice(rt, 'Skill create: x-skill')
  const pending = await drainNotices(rt)
  assert.equal(pending.length, 2)
  assert.match(noticeText(pending), /^⚙️ self-evolve · writes since the last turn \(not from you\):\n- Memory updated\n- Skill create: x-skill$/)

  await queueNotice(rt, 'Memory updated')
  const handler = preStep((() => {
    const ctx = fakeCtx()
    installNotices(ctx, rt)
    return ctx
  })())
  const session = { id: 'n-1', header: {} }
  let decision = await preStepCall(handler, { turn: 1, session })
  const delivered = decision.messages.filter(message => message?.source?.kind === NOTICE_KIND)
  assert.equal(delivered.length, 1, 'the notice is visible in the transcript')
  assert.match(delivered[0].content[0].text, /Memory updated/)
  decision = await preStepCall(handler, { turn: 2, session })
  assert.equal(decision.messages.filter(message => message?.source?.kind === NOTICE_KIND).length, 0, 'nothing is delivered twice')
  decision = await preStepCall(handler, { turn: 3, step: 2, session })
  assert.equal(decision.messages.filter(message => message?.source?.kind === NOTICE_KIND).length, 0, 'only the first step of a turn')
  assert.equal(installNotices(fakeCtx(), { ...rt, config: { ...rt.config, notificationMode: 'off' } }), false, 'off registers nothing')
  assert.equal(await readFile(noticesPath(rt), 'utf8').then(text => text.trim()), '[]', 'the queue is cleared after delivery')
})

test('skill nudge: its own interval, its own notice kind, silent on subagents and empty turns', () => {
  const handler = preStep((() => {
    const ctx = fakeCtx()
    installSkillNudge(ctx, { every: 2, count: async () => 11 })
    return ctx
  })())
  const session = { id: 'n1', header: {} }
  const nudges = decision => decision.messages.filter(message => message?.source?.kind === SKILL_NUDGE_KIND)

  return (async () => {
    let decision = await preStepCall(handler, { turn: 1, session })
    assert.equal(nudges(decision).length, 1, 'the first turn a session is seen at nudges')
    assert.match(nudges(decision)[0].content[0].text, /Skill check \(turn 1, every 2; 11 skills exist\)/)
    decision = await preStepCall(handler, { turn: 2, session })
    assert.equal(nudges(decision).length, 0, 'not before the interval')
    decision = await preStepCall(handler, { turn: 3, step: 2, session })
    assert.equal(nudges(decision).length, 0, 'only the first step of a turn')
    decision = await preStepCall(handler, { turn: 3, session })
    assert.equal(nudges(decision).length, 1, 'due again after the interval')
    decision = await preStepCall(handler, { turn: 4, session: { id: 'sub', header: { delegationDepth: 1 } } })
    assert.equal(nudges(decision).length, 0, 'a subagent session never gets the nudge')
    decision = await preStepCall(handler, { turn: 5, session, messages: [] })
    assert.equal(nudges(decision).length, 0, 'a wake with nothing claimed gets no notice')
    assert.equal(installSkillNudge(fakeCtx(), { every: 0, count: async () => 0 }), false, 'interval 0 registers nothing')
    assert.match(skillNudgeText({ turn: 2, every: 10, skills: 0 }), /no skills exist yet/)
  })()
})

// --------------------------------------------- curator (archive, never delete)

const DAY = 86400000
const CURATOR_NOW = Date.parse('2026-11-25T00:00:00Z')
const older = (text, days) => ({ first: new Date(CURATOR_NOW - days * DAY).toISOString(), seen: new Date(CURATOR_NOW - days * DAY).toISOString() })

/** Seed the memory store and a curator state that already knows its entries. */
async function seedCurator(rt, entries, ages) {
  await mkdir(path.dirname(rt.paths.memoryFile), { recursive: true })
  await writeFile(rt.paths.memoryFile, renderEntries(entries))
  const state = { version: 1, entries: {} }
  entries.forEach((text, index) => { state.entries[entryKey(text)] = older(text, ages[index]) })
  await saveState(curatorStatePath(rt, 'memory'), state)
}

test('curator: state sync, bucketing and the archive block are pure and age-based', () => {
  const old = 'Old fact about ports.'
  const fresh = 'Fresh fact.'
  const synced = syncState({ version: 1, entries: {} }, [old, fresh], CURATOR_NOW - 20 * DAY)
  assert.equal(Object.keys(synced.entries).length, 2, 'syncState stamps every entry it has not seen before')
  const seen = days => ({ first: new Date(CURATOR_NOW - days * DAY).toISOString(), seen: new Date(CURATOR_NOW - days * DAY).toISOString() })
  const state = { version: 1, entries: { [entryKey(old)]: seen(20), [entryKey(fresh)]: seen(1) } }
  const split = buckets(state, [old, fresh], { now: CURATOR_NOW, staleDays: 14, deepDays: 30 })
  assert.deepEqual(split.stale.map(item => item.text), [old], 'an unchanged entry past the stale age is a candidate')
  assert.deepEqual(split.fresh, [fresh], 'a young entry is untouched')
  assert.deepEqual(split.deep, [])
  assert.equal(split.stale[0].age, 20)

  const pinnedState = { version: 1, entries: { ...state.entries } }
  pinnedState.entries[entryKey(old)].pinned = true
  const pinned = buckets(pinnedState, [old], { now: CURATOR_NOW, staleDays: 14, deepDays: 30 })
  assert.deepEqual(pinned.pinned, [old], 'a pin bypasses the age entirely')
  assert.deepEqual(pinned.stale, [])

  const deep = buckets(syncState({ version: 1, entries: {} }, [old], CURATOR_NOW - 40 * DAY), [old], { now: CURATOR_NOW, staleDays: 14, deepDays: 30 })
  assert.deepEqual(deep.deep.map(item => item.text), [old], 'past the deep age it goes to the deep archive')
  assert.deepEqual(deep.stale, [])

  assert.match(archiveBlock('memory', [{ text: old, age: 20 }], CURATOR_NOW), /# memory — archived 2026-11-25/)
  assert.match(archiveBlock('memory', [{ text: old, age: 40, deep: true }], CURATOR_NOW), /## deep stale 40d/)
})

test('curator: a stale entry is moved to the archive file and the store keeps the rest', async () => {
  const rt = makeRt()
  const entries = ['Old fact about ports.', 'Fresh fact.']
  await seedCurator(rt, entries, [20, 1])
  const report = await runCurator(rt, { target: 'memory', now: CURATOR_NOW, force: true })
  assert.equal(report.success, true)
  assert.equal(report.archived, 1)
  assert.equal(report.kept, 1)
  assert.deepEqual(parseEntries(await readFile(rt.paths.memoryFile, 'utf8')), ['Fresh fact.'], 'only the stale entry left the store')
  const archived = await readFile(report.archive[0], 'utf8')
  assert.match(archived, /Old fact about ports\./, 'the entry text is preserved in the archive')
  assert.match(report.message, /never deleted/)
  assert.ok(report.history !== undefined, 'a snapshot holds the store before the archive')
})

test('curator: below the trigger share the pass only records state; the curate action forces it', async () => {
  const rt = makeRt({ curator: true })
  await seedCurator(rt, ['Old fact about ports.'], [20])
  const calm = await runCurator(rt, { target: 'memory', now: CURATOR_NOW })
  assert.equal(calm.archived, 0)
  assert.equal(calm.reason, 'below_share')
  assert.deepEqual(parseEntries(await readFile(rt.paths.memoryFile, 'utf8')), ['Old fact about ports.'], 'nothing left the store')

  const forced = await runMemory(rt, { target: 'memory', operations: [{ action: 'curate' }] })
  assert.equal(forced.success, true)
  assert.equal(forced.archived, 1)
  assert.deepEqual(parseEntries(await readFile(rt.paths.memoryFile, 'utf8')), [])

  const off = await runMemory(makeRt(), { target: 'memory', operations: [{ action: 'curate' }] })
  assert.equal(off.success, false, 'a disabled curator refuses the pass instead of archiving silently')
  assert.match(off.error, /disabled/)
})

test('curator: pin protects an entry from archiving and unpin releases it', async () => {
  const rt = makeRt()
  await seedCurator(rt, ['Old fact about ports.', 'Fresh fact.'], [20, 1])

  const pinned = await runMemory(rt, { target: 'memory', operations: [{ action: 'pin', old_text: 'Old fact' }] })
  assert.equal(pinned.success, true)
  assert.equal(pinned.pinned_count, 1)
  assert.equal((await runCurator(rt, { target: 'memory', now: CURATOR_NOW, force: true })).archived, 0, 'the pinned entry survives')
  assert.deepEqual(parseEntries(await readFile(rt.paths.memoryFile, 'utf8')), ['Old fact about ports.', 'Fresh fact.'])

  const unpinned = await runMemory(rt, { target: 'memory', operations: [{ action: 'unpin', old_text: 'Old fact' }] })
  assert.equal(unpinned.success, true)
  assert.equal((await runCurator(rt, { target: 'memory', now: CURATOR_NOW, force: true })).archived, 1)
})

test('curator: a pin or curate call may not be mixed with a store write, and an unknown match is refused', async () => {
  const rt = makeRt()
  await seedCurator(rt, ['Old fact about ports.'], [20])
  const mixed = await runMemory(rt, { target: 'memory', operations: [{ action: 'pin', old_text: 'Old fact' }, { action: 'add', content: 'New fact.' }] })
  assert.equal(mixed.success, false)
  assert.equal(mixed.entry, undefined)
  const missing = await runMemory(rt, { target: 'memory', operations: [{ action: 'pin', old_text: 'nothing like this' }] })
  assert.equal(missing.success, false)
  assert.match(missing.error, /no entry matched/)
  const direct = await setPin(rt, { target: 'memory', old_text: 'Old fact', now: CURATOR_NOW })
  assert.equal(direct.success, true)
})

// ------------------------------------------------ background post-turn review

test('background: the plan parser keeps only the last tagged JSON object, and the sanitizer enforces the action, shape and size limits', () => {
  assert.deepEqual(parsePlan('<plan>{"operations":[]}</plan>'), { operations: [] })
  assert.equal(parsePlan('no tags here'), undefined)
  assert.equal(parsePlan('<plan>{"operations":}</plan>'), undefined)
  assert.equal(parsePlan('<plan>{"ops":[]}</plan>'), undefined)
  assert.deepEqual(parsePlan('<plan>{"operations":[]}</plan>noise<plan>{"operations":[{"action":"add","content":"x"}]}</plan>'), { operations: [{ action: 'add', content: 'x' }] })

  const keep = sanitizeOperations([
    { action: 'add', content: 'Durable fact.' },
    { action: 'patch', old_text: 'old', content: 'new' },
    { action: 'create', name: 'good-skill', content: '---\nname: good-skill\ndescription: d\n---\nbody\n' },
    { action: 'edit', name: 'good-skill', content: '---\nname: good-skill\ndescription: d\n---\nbody\n' },
    { action: 'remove', old_text: 'seed' },
    { action: 'delete' },
    { action: 'add', content: '' },
    { action: 'patch', content: 'no old_text' },
    { action: 'add', content: 'x'.repeat(1201) },
    { action: 'patch', old_text: 'y'.repeat(1201), content: 'z' },
    { action: 'create', name: 'Bad_Name', content: '---\nname: Bad_Name\ndescription: d\n---\nbody\n' },
    { action: 'create', name: 'mismatch', content: '---\nname: other\ndescription: d\n---\nbody\n' },
    { action: 'create', name: 'nofm', content: 'no frontmatter' },
    null,
    'string',
  ])
  assert.deepEqual(keep, [
    { action: 'add', content: 'Durable fact.' },
    { action: 'patch', old_text: 'old', content: 'new' },
    { action: 'create', name: 'good-skill', content: '---\nname: good-skill\ndescription: d\n---\nbody' },
    { action: 'edit', name: 'good-skill', content: '---\nname: good-skill\ndescription: d\n---\nbody' },
  ], 'the first five candidates are kept; every delete, bad name, mismatched frontmatter and oversized text is dropped')
  assert.equal(sanitizeOperations([1, 2, 3, 4, 5, 6].map(i => ({ action: 'add', content: `e${i}` }))).length, 5, 'the op cap holds')
  assert.deepEqual(sanitizeOperations(undefined), [])
})

test('background: the route prefers the pinned pair, then the session header, and needs both halves', () => {
  const routed = { requestHeader: () => ({ config: { provider: 'nine-router', model: 'FreeModel' } }) }
  assert.deepEqual(backgroundRoute({ backgroundProvider: 'p', backgroundModel: 'm' }, routed), { provider: 'p', model: 'm' })
  assert.deepEqual(backgroundRoute({}, routed), { provider: 'nine-router', model: 'FreeModel' })
  assert.equal(backgroundRoute({}, { requestHeader: () => ({}) }), undefined)
  assert.equal(backgroundRoute({}, {}), undefined)
  assert.equal(backgroundRoute({}, undefined), undefined)
})

test('background: the transcript keeps user and assistant text only, bounded at the end', async () => {
  const session = { deriveMessages: () => [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'text', text: ' more' }] },
    { role: 'tool', content: [{ type: 'text', text: 'tool result' }] },
    { role: 'user', content: [{ type: 'text', text: '' }] },
  ] }
  assert.equal(await turnTranscript(session), 'User: question\n\nAgent: answer more')
  const long = { deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(20000) }] }] }
  const out = await turnTranscript(long)
  assert.equal(out.length, 12000)
  assert.ok(out.startsWith('…'), 'the head is dropped, the end survives')
  assert.ok(out.endsWith('x'.repeat(100)))
})

test('background: the turn/end reason is read from data.reason.kind, the shape dsh-session emits', () => {
  // The real event, as dsh-session/lib/index.js builds it.
  assert.equal(turnEndReason({ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }), 'completed')
  assert.equal(turnEndReason({ type: 'turn/end', data: { turn: 3, reason: { kind: 'max-tokens' } } }), 'max-tokens')
  assert.equal(turnEndReason({ type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted' } } }), 'aborted')
  // Tolerated shapes: older flat payload and nothing at all.
  assert.equal(turnEndReason({ type: 'turn/end', data: { turn: 3, kind: 'completed' } }), 'completed')
  assert.equal(turnEndReason({ type: 'turn/end', data: { turn: 3 } }), undefined)
  assert.equal(turnEndReason({ type: 'turn/end' }), undefined)
  assert.equal(turnEndReason(undefined), undefined)
})

test('background: a route that rejects reasoning effort is retried without it', async () => {
  const rt = makeRt({ memoryFile: path.join(HOME, 'bg-retry', 'MEMORY.md'), dataDir: path.join(HOME, 'bg-retry-data') })
  await mkdir(path.dirname(rt.paths.memoryFile), { recursive: true })
  await writeFile(rt.paths.memoryFile, 'Seed.')
  const calls = []
  const llm = {
    stream: options => {
      calls.push(options)
      if (calls.length === 1) return modelStream('', { failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'not supported' } })
      return modelStream('<plan>{"operations":[{"action":"add","content":"Port demo 4567."}]}</plan>')
    },
  }
  const outcome = await runBackgroundReview(rt, {
    session: {
      id: 'retry',
      header: { cwd: HOME },
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: 'Port demo layanan ini 4567.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'dicatat' }] },
      ],
    },
    transcript: turnTranscript,
    current: async () => ({ memory: 'Seed.', skills: '(none)' }),
    llm,
    route: { provider: 'nine-router', model: 'RianModel' },
  })
  assert.equal(outcome.error, undefined, 'the retry hides the unsupported effort')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].reasoningEffort, 'low')
  assert.equal(calls[1].reasoningEffort, undefined, 'the retry omits the field entirely')
  assert.match(await readFile(rt.paths.memoryFile, 'utf8'), /Port demo 4567/)
})

test('background: a plan wrapped in a fence or bare JSON is still read, and a strict retry rescues junk', async () => {
  const { parsePlanDetail } = await import('../lib/background.mjs')
  const plan = { operations: [{ action: 'add', content: 'Port demo 4567.' }] }
  // Gateways that drop the tag: fenced JSON, then a bare object.
  assert.deepEqual(parsePlanDetail('```json\n' + JSON.stringify(plan) + '\n```').plan, plan)
  assert.deepEqual(parsePlanDetail('catatan: ' + JSON.stringify(plan) + ' selesai').plan, plan)
  // Unreadable answers say why, and keep a snippet for the operator.
  const noTag = parsePlanDetail('tidak ada yang perlu disimpan')
  assert.equal(noTag.malformed, 'no_tag')
  assert.match(noTag.snippet, /tidak ada/)
  assert.equal(parsePlanDetail('<plan>{oops}</plan>').malformed, 'bad_json')
  assert.equal(parsePlanDetail('<plan>{"operations":3}</plan>').malformed, 'bad_shape')

  // The pass retries once with a stricter instruction, then succeeds.
  const rt = makeRt({ memoryFile: path.join(HOME, 'bg-retry-plan', 'MEMORY.md'), dataDir: path.join(HOME, 'bg-retry-plan-data') })
  await mkdir(path.dirname(rt.paths.memoryFile), { recursive: true })
  await writeFile(rt.paths.memoryFile, 'Seed.')
  const calls = []
  const llm = {
    stream: options => {
      calls.push(options.messages[0].content[0].text)
      return modelStream(calls.length === 1 ? 'maaf, tidak ada tag' : '<plan>' + JSON.stringify(plan) + '</plan>')
    },
  }
  const outcome = await runBackgroundReview(rt, {
    session: {
      id: 'retry-plan',
      header: { cwd: HOME },
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: 'Port demo 4567.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'dicatat' }] },
      ],
    },
    transcript: turnTranscript,
    current: async () => ({ memory: 'Seed.', skills: '(none)' }),
    llm,
    route: { provider: 'nine-router', model: 'RianModel' },
  })
  assert.equal(outcome.error, undefined)
  assert.equal(calls.length, 2)
  assert.match(calls[1], /ONLY <plan>/)
  assert.match(await readFile(rt.paths.memoryFile, 'utf8'), /Port demo 4567/)
})

test('background: a guarded memory add lands through the real write path while a delete in the same answer is refused', async () => {
  const rt = makeRt({ memoryFile: path.join(HOME, 'bg', 'MEMORY.md'), dataDir: path.join(HOME, 'bg-data') })
  await drainNotices(rt)
  await mkdir(path.dirname(rt.paths.memoryFile), { recursive: true })
  await writeFile(rt.paths.memoryFile, 'Seed entry about ports.')
  const session = {
    id: 'bg-1',
    header: { cwd: HOME },
    requestHeader: () => ({ config: { provider: 'nine-router', model: 'FreeModel' } }),
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: 'The watchdog lives at /home/ubuntu/gateway_watchdog.py.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] },
    ],
  }
  const calls = []
  const llm = { stream: options => { calls.push(options); return modelStream('<plan>{"operations":[{"action":"add","content":"Watchdog script at /home/ubuntu/gateway_watchdog.py."},{"action":"remove","old_text":"Seed entry"}]}</plan>') } }
  const outcome = await runBackgroundReview(rt, {
    session,
    transcript: turnTranscript,
    current: async () => ({ memory: 'Seed entry about ports.', skills: '(none yet)' }),
    llm,
    route: { provider: 'nine-router', model: 'FreeModel' },
  })
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.applied.length, 1)
  assert.equal(outcome.applied[0].target, 'memory')
  const written = await readFile(rt.paths.memoryFile, 'utf8')
  assert.match(written, /Watchdog script at \/home\/ubuntu\/gateway_watchdog\.py\./)
  assert.ok(written.includes('Seed entry about ports.'), 'the remove op was refused, not applied')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'nine-router')
  const status = JSON.parse(await readFile(backgroundStatusPath(rt), 'utf8'))
  assert.equal(status.applied, 1, 'the pass records that it ran')
  assert.equal(status.result, 'applied', 'a benign outcome is a result, not an error')
  const queued = await drainNotices(rt)
  assert.deepEqual(queued.map(item => item.text), ['Memory updated'], 'the pass leaves a human-facing line')
  assert.deepEqual(await drainNotices(rt), [], 'draining is one-shot')
  assert.equal(calls[0].model, 'FreeModel')
  assert.equal(calls[0].reasoningEffort, 'low')
  assert.equal(calls[0].sessionId, 'bg-1')
  assert.match(calls[0].messages[0].content[0].text, /CURRENT MEMORY:\nSeed entry about ports\./)
  assert.match(calls[0].messages[0].content[0].text, /Never delete, remove, archive/)
})

test('background: a guarded skill create lands through the real skill write path', async () => {
  const rt = makeRt()
  const session = { id: 'bg-3', header: { cwd: HOME }, deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'Make a skill for deploying.' }] }] }
  const content = '---\nname: bg-deploy\ndescription: Use when deploying. Steps to verify.\n---\nRun the tests, then deploy.\n'
  const llm = { stream: () => modelStream(`<plan>{"operations":[{"action":"create","name":"bg-deploy","content":${JSON.stringify(content)}}]}</plan>`) }
  const outcome = await runBackgroundReview(rt, {
    session,
    transcript: turnTranscript,
    current: async () => ({ memory: '', skills: '(none yet)' }),
    llm,
    route: { provider: 'p', model: 'm' },
  })
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.applied.length, 1)
  assert.equal(outcome.applied[0].target, 'skills')
  assert.equal(await readFile(path.join(rt.paths.skillsDir, 'bg-deploy', 'SKILL.md'), 'utf8'), content)
})

test('background: an unparseable answer, an empty turn, a missing LLM and a missing route all report without writing', async () => {
  const rt = makeRt({ memoryFile: path.join(HOME, 'bg2', 'MEMORY.md') })
  await mkdir(path.dirname(rt.paths.memoryFile), { recursive: true })
  await writeFile(rt.paths.memoryFile, 'Seed.')
  const session = { id: 'bg-2', header: { cwd: HOME }, deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  const run = (llm, route, derive) => runBackgroundReview(rt, {
    session: derive === undefined ? session : { ...session, deriveMessages: derive },
    transcript: turnTranscript,
    current: async () => ({ memory: 'Seed.', skills: '(none yet)' }),
    llm,
    route,
  })
  const garbage = { stream: () => modelStream('<plan>{"operations":') }
  assert.equal((await run(garbage, { provider: 'p', model: 'm' })).error, 'invalid_plan')
  assert.equal((await run(garbage, { provider: 'p', model: 'm' }, () => [])).error, 'empty_transcript')
  assert.equal((await run(undefined, { provider: 'p', model: 'm' })).error, 'no_llm')
  assert.equal((await run(garbage, undefined)).error, 'no_model')
  assert.equal((await run({ stream: () => modelStream('<plan>{"operations":[]}</plan>') }, { provider: 'p', model: 'm' })).error, 'no_operations')
  assert.equal(await readFile(rt.paths.memoryFile, 'utf8'), 'Seed.', 'nothing was written in any case')
})

test('background: the instruction quotes the current state and the turn, and the skill list comes from the scanned roots', async () => {
  const text = backgroundInstruction('User: q\n\nAgent: a', { memory: 'entry one', skills: 'skill-a' })
  assert.match(text, /CURRENT MEMORY:\nentry one/)
  assert.match(text, /CURRENT SKILLS \(names only\):\nskill-a/)
  assert.match(text, /TURN:\nUser: q/)
  assert.match(text, /Never delete, remove, archive/)

  const rt = makeRt()
  await mkdir(path.join(rt.paths.skillsDir, 'bg-listed'), { recursive: true })
  await writeFile(path.join(rt.paths.skillsDir, 'bg-listed', 'SKILL.md'), '---\nname: bg-listed\ndescription: d\n---\nbody\n')
  await writeFile(path.join(rt.paths.skillsDir, 'bg-flat.md'), '---\nname: bg-flat\ndescription: d\n---\nbody\n')
  await mkdir(path.join(rt.paths.skillsDir, 'not-a-skill'), { recursive: true })
  const names = await skillNames(rt, HOME)
  assert.ok(names.includes('bg-listed'))
  assert.ok(names.includes('bg-flat'))
  assert.ok(!names.includes('not-a-skill'))
})

// Registered after every test on purpose: under `--test-name-pattern` a root
// `after` hook registered before the tests starts while the matching test is
// still running, and removed HOME from under it.
after(async () => {
  await rm(HOME, { recursive: true, force: true })
})

// --- periodic memory review (lib/review.mjs) -------------------------------

const { REVIEW_KIND, SKILL_NUDGE_KIND, describePressure, installReview, installSkillNudge, noticeSummary, reviewDue, reviewMessage, reviewPressures, reviewText, skillNudgeText, usageRows } = await import('../lib/review.mjs')

const { backgroundInstruction, backgroundRoute, backgroundStatusPath, parsePlan, runBackgroundReview, sanitizeOperations, skillNames, turnEndReason, turnTranscript } = await import('../lib/background.mjs')

const { archiveBlock, buckets, curatorStatePath, entryKey, runCurator, saveState, setPin, syncState } = await import('../lib/curator.mjs')

const { applyConsolidation, consolidateSkills, curatorDue, discoverSkills, loadSkillState, runSkillCurator, saveSkillState, scanSkills, setSkillPin, setSkillPaused, skillStatePath } = await import('../lib/skillcurator.mjs')
const { NOTICE_KIND, describeApplied, drainNotices, installNotices, noticeText, noticesPath, queueNotice } = await import('../lib/notice.mjs')

/** A plugin context that records the listeners the plugin registers. */
function fakeCtx() {
  const listeners = []
  return { listeners, on(name, handler) { listeners.push({ name, handler }) } }
}

/** The single `agent/pre-step` listener of a fake context. */
function preStep(ctx) {
  const entry = ctx.listeners.find(listener => listener.name === 'agent/pre-step')
  assert.ok(entry, 'a pre-step listener is registered')
  return entry.handler
}

/** One `agent/pre-step` invocation, as the loop dispatches it. */
const preStepCall = (handler, { turn, step = 1, session, messages = [{ id: 'input' }], signal } = {}) =>
  handler({ agent: session === undefined ? undefined : { session }, turn, step, signal }, async () => ({ kind: 'enter', messages }))

/** The injected review message of one decision, when there is one. */
const injected = decision => decision.messages.filter(message => message?.source?.kind === REVIEW_KIND)

test('review: the notice fires on every Nth user turn, only while a store is near its limit', async () => {
  const handler = preStep((() => {
    const ctx = fakeCtx()
    installReview(ctx, { every: 2, share: 0.85, load: async () => [{ target: 'memory', label: 'MEMORY.md (agent notes)', used: 193, limit: 200, entries: 3 }] })
    return ctx
  })())
  const session = { id: 's1', header: {} }

  const note = injected(await preStepCall(handler, { turn: 1, session }))
  assert.equal(note.length, 1, 'a store already full when the session starts is reviewed on its first turn')
  assert.equal(note[0].role, 'user')
  assert.equal(note[0].source.form, 'notice')
  assert.ok(note[0].source.summary.length <= 120)
  const text = note[0].content.map(part => part.text).join('')
  assert.match(text, /periodic memory review, every 2 user turns/)
  assert.match(text, /MEMORY\.md \(agent notes\): 193\/200 chars \(97%\), 3 entries/)
  assert.match(text, /ONE `memory` batch/)
  assert.deepEqual(injected(await preStepCall(handler, { turn: 2, session })), [], 'the turn after a review waits')
  assert.equal(injected(await preStepCall(handler, { turn: 3, session })).length, 1, 'turn 3 is the next review turn')
})

test('review: a turn counts once, subagent sessions and quiet stores stay silent, no wake is bought', async () => {
  const rows = [{ target: 'memory', label: 'MEMORY.md (agent notes)', used: 193, limit: 200, entries: 3 }]
  const handler = preStep((() => {
    const ctx = fakeCtx()
    installReview(ctx, { every: 2, share: 0.85, load: async () => rows })
    return ctx
  })())
  const session = { id: 's2', header: {} }

  // The first observed turn opens with the notice; later steps of it do not.
  // Turn 2 is too soon (every = 2), turn 3 is due — and the repeated step of
  // turn 1 must not have counted twice.
  assert.equal(injected(await preStepCall(handler, { turn: 1, step: 1, session })).length, 1, 'the first observed turn is reviewed')
  assert.deepEqual(injected(await preStepCall(handler, { turn: 1, step: 2, session })), [], 'a later step of the same turn is not reopened')
  assert.deepEqual(injected(await preStepCall(handler, { turn: 2, step: 1, session })), [], 'turn 2 waits for the interval')
  assert.equal(injected(await preStepCall(handler, { turn: 3, step: 1, session })).length, 1, 'turn 3 is due again')

  const child = { id: 'c1', header: { delegationDepth: 1 } }
  assert.deepEqual(injected(await preStepCall(handler, { turn: 1, session: child })), [], 'a subagent session never reviews the parent store')
  assert.deepEqual(injected(await preStepCall(handler, { turn: 2, session: child })), [], 'not even when it would be due')

  const quiet = preStep((() => {
    const ctx = fakeCtx()
    installReview(ctx, { every: 2, share: 0.85, load: async () => [{ target: 'memory', label: 'MEMORY.md (agent notes)', used: 50, limit: 200, entries: 1 }] })
    return ctx
  })())
  assert.deepEqual(injected(await preStepCall(quiet, { turn: 1, session })), [], 'a store below the share stays silent')
  assert.deepEqual(injected(await preStepCall(quiet, { turn: 2, session })), [], 'and stays silent on later turns too')

  const aborted = new AbortController()
  aborted.abort()
  assert.deepEqual(injected(await preStepCall(handler, { turn: 4, session, signal: aborted.signal })), [], 'an aborted step gets no notice')

  assert.deepEqual(injected(await preStepCall(handler, { turn: 4, session, messages: [] })), [], 'an empty claimed turn is not woken for a review')
})

test('review: interval 0 registers nothing; usageRows reads the live store against its budget', async () => {
  const off = fakeCtx()
  assert.equal(installReview(off, { every: 0, share: 0.85, load: async () => [] }), false)
  assert.deepEqual(off.listeners, [])

  const home = path.join(HOME, 'review-home')
  await mkdir(home, { recursive: true })
  const text = renderEntries(['first entry', 'second entry'])
  await writeFile(path.join(home, 'MEMORY.md'), text)
  const paths = resolvePaths({ dshHome: home, memoryCharLimit: 200 })
  const stores = await resolveStores(paths, { memoryLimit: 200 })
  const rows = await usageRows(stores, ['memory', 'user'])
  assert.equal(rows.length, 1, 'only stores this profile can back are listed')
  assert.equal(rows[0].target, 'memory')
  assert.equal(rows[0].limit, 200)
  assert.equal(rows[0].entries, 2)
  assert.equal(rows[0].used, charCount(parseEntries(text)))
  assert.equal(rows[0].used, 'first entry'.length + 'second entry'.length + 3)
})

test('review: text, summary and pressure selection are pure and bounded', () => {
  assert.equal(reviewDue({ every: 10, count: 1 }), true, 'the first observed turn is due')
  assert.equal(reviewDue({ every: 10, count: 10, last: 1 }), false)
  assert.equal(reviewDue({ every: 10, count: 11, last: 1 }), true)
  assert.equal(reviewDue({ every: 10, count: 9, last: 1 }), false)
  assert.equal(reviewDue({ every: 0, count: 1 }), false)
  assert.equal(reviewDue({ every: 10, count: 0 }), false)
  assert.equal(reviewDue({ every: 10 }), false)

  const stores = [
    { target: 'memory', label: 'MEMORY.md (agent notes)', used: 100, limit: 200, entries: 2 },
    { target: 'user', label: 'USER profile (who the user is)', used: 170, limit: 200, entries: 4 },
    { target: 'other', label: 'unbounded', used: 5, limit: 0, entries: 1 },
  ]
  assert.deepEqual(reviewPressures(stores, 0.85).map(store => store.target), ['user'], 'a store exactly at the share is already worth a review')
  assert.deepEqual(reviewPressures(stores, 0.86).map(store => store.target), [], 'above every store: nothing')
  assert.deepEqual(reviewPressures(stores, 0.5).map(store => store.target), ['user', 'memory'], 'largest pressure first')
  assert.deepEqual(reviewPressures(stores, 0).map(store => store.target), ['user', 'memory'], 'a zero share reviews bounded stores only')
  assert.equal(describePressure(stores[0]), 'MEMORY.md (agent notes): 100/200 chars (50%), 2 entries')
  assert.equal(describePressure({ ...stores[0], entries: 1 }), 'MEMORY.md (agent notes): 100/200 chars (50%), 1 entry')

  const text = reviewText({ pressures: reviewPressures(stores, 0.5), turn: 20, every: 10 })
  assert.match(text, /every 10 user turns — a plugin notice, not a user request/)
  assert.match(reviewText({ pressures: reviewPressures(stores, 0.5), turn: 1, every: 1 }), /^\(periodic memory review — a plugin notice, not a user request\)$/m, 'interval 1 reads as a plain heading')
  assert.match(text, /keep paths, ports, hostnames, versions, IDs and numbers verbatim/i)
  assert.match(text, /drop entries that are stale, superseded or duplicated/)
  assert.equal(reviewText({ pressures: [] }), undefined)
  assert.equal(reviewText({}), undefined)

  assert.equal(noticeSummary('first\nsecond'), 'first')
  const bounded = noticeSummary('x'.repeat(300))
  assert.equal(bounded.length, 120)
  assert.ok(bounded.endsWith('…'))

  const message = reviewMessage('(notice)')
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, REVIEW_KIND)
  assert.equal(message.source.form, 'notice')
  assert.equal(message.source.summary, '(notice)')
  assert.deepEqual(message.content, [{ type: 'text', text: '(notice)' }])
  assert.notEqual(reviewMessage('(notice)').id, message.id, 'every notice is a fresh message')
})
