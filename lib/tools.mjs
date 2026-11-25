// tools.mjs — the three model-facing tool definitions.
//
// `defineTool` is injected so this module stays loadable without the Harness
// (tests compile the definitions against the real @deepseek-ai/dsh-tools),
// and the two host lookups the skill tool needs (working directory and skill
// catalog) are passed in as functions by the plugin entry.

import { runMemory } from './memorytool.mjs'
import { runPersona } from './personatool.mjs'
import { runSkillOps } from './skills.mjs'
import { toPlain } from './util.mjs'

/** Every tool returns a JSON object rendered as one compact text block. */
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

/**
 * Render any tool value as compact JSON, the shape Hermes tools return.
 * @param {unknown} _args - call arguments.
 * @param {unknown} value - canonical output.
 * @returns {Array<{ type: 'text', text: string }>} one text block.
 */
function render(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * The `memory` tool.
 * @param {Function} defineTool - `@deepseek-ai/dsh-tools` defineTool.
 * @param {object} rt - plugin runtime.
 * @param {string[]} targets - enabled targets.
 * @param {{ condense?: Function }} [deps] - host hooks; `condense` shortens an
 *   over-budget store with a model call.
 * @returns {object} tool definition.
 */
export function memoryTool(defineTool, rt, targets, deps = {}) {
  const single = targets.length === 1
  const description = [
    'Save durable facts to the persistent stores the agent reads at the start of every session (MEMORY.md and the user profile).',
    'HOW: make all changes to one target in ONE call — `operations` applies atomically and the char limit is checked only on the final result, so one call can remove or shorten stale entries and add new ones. The result reports current/limit chars and confirms completion; a successful call finishes the update, so do not repeat it.',
    'WHEN: only facts that apply to every session regardless of task — who the user is, stable environment facts, standing conventions with no task home. Procedures, pitfalls and task-specific preferences belong in a skill (skill_manage), which loads only when relevant. Skip trivial or easily re-discovered facts, raw dumps, task progress and completed-work logs.',
    'IF FULL: a batch that would exceed the limit goes through first: the tool shortens the store\'s biggest entries with the model (paths, commands, ports and numbers kept verbatim) until the batch fits, then applies it; the result\'s `condensed` field reports before and after. When the result carries `condense.error` instead, condense it yourself: reissue as one batch that removes or shortens enough stale entries and adds the new one.',
    'PERIODIC REVIEW: the plugin also puts a store at or near its limit in front of you with its live usage (a notice, not a user request) — on the first turn of a session that has such a store, then at most once every few turns. Treat it as the prompt to do that curating pass now, one batch of removes/patches, rather than waiting for a write to be trimmed.',
    single
      ? (targets[0] === 'user'
        ? "TARGET: 'user' is the user profile (name, role, preferences, style)."
        : "TARGET: 'memory' is your personal notes (environment, conventions, tool quirks, lessons).")
      : "TARGETS: 'user' = who the user is (name, role, preferences, style). 'memory' = your notes (environment, conventions, tool quirks, lessons).",
  ].join('\n\n')
  return defineTool({
    name: 'memory',
    description,
    parameters: {
      target: { type: 'string', enum: targets, required: true, description: 'Which store to read or write.' },
      operations: {
        type: 'array',
        required: true,
        description: 'Changes applied in order and atomically; a single change is a one-item list.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['add', 'patch', 'remove', 'view', 'pin', 'unpin', 'curate'], required: true, description: 'add appends content as a new entry; patch replaces exactly the old_text span inside one entry; remove deletes the whole entry containing old_text; view (alone) returns the entries without writing; pin / unpin (alone, with old_text) protect an entry from the curator or release it; curate (alone) runs the stale-entry archive pass now.' },
            content: { type: 'string', description: 'Required for add and patch: the new entry, or the replacement for old_text.' },
            old_text: { type: 'string', description: 'Required for patch and remove: text copied from ONE entry. Omit for add.' },
          },
        },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args, exec) {
      return toPlain(await runMemory(rt, { ...args, signal: exec.signal, exec }, deps))
    },
  })
}

/**
 * The `persona_update` tool.
 * @param {Function} defineTool - `@deepseek-ai/dsh-tools` defineTool.
 * @param {object} rt - plugin runtime.
 * @param {string[]} targets - enabled targets.
 * @returns {object} tool definition.
 */
export function personaTool(defineTool, rt, targets) {
  return defineTool({
    name: 'persona_update',
    description: [
      "Update the agent's own standing instructions when the user states a durable preference about how you should behave, respond, format or communicate (e.g. 'always answer in Indonesian', 'never ask before deploys'), or corrects a standing rule.",
      "TARGETS: 'persona' is identity and operating rules; 'soul' is tone and style.",
      'Changes enter the next step and every new session. Keep one rule per line, and rewrite or remove the rules a new preference makes obsolete instead of appending a contradiction.',
    ].join('\n\n'),
    parameters: {
      target: { type: 'string', enum: targets, description: "Defaults to 'persona'." },
      operation: {
        type: 'string',
        enum: ['view', 'replace', 'append', 'patch', 'set_section', 'remove_section'],
        required: true,
        description: 'view returns the text and its section outline; replace rewrites the whole text; append adds text at the end; patch replaces old_text; set_section replaces the body of the named section or appends it; remove_section deletes the named section.',
      },
      content: { type: 'string', description: 'The new text: whole text (replace), addition (append), replacement for old_text (patch; an empty string deletes the span) or section body (set_section).' },
      old_text: { type: 'string', description: 'patch: the exact text to replace; it must occur once.' },
      section: { type: 'string', description: 'set_section / remove_section: the heading text, e.g. "Execution rules"; matched case-insensitively.' },
    },
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args, exec) {
      return toPlain(await runPersona(rt, { ...args, signal: exec.signal }))
    },
  })
}

const FILE_PATH = {
  type: 'string',
  description: "Path relative to the skill directory, e.g. 'references/api.md' — never absolute; first segment references/, templates/, scripts/ or assets/. SKILL.md itself is rewritten with edit and removed with delete.",
}

/**
 * One operations branch of `skill_manage`.
 * @param {string} action - action name.
 * @param {Record<string, object>} properties - action-specific parameters.
 * @returns {object} object schema with name and action.
 */
function opSchema(action, properties) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', required: true, description: 'Skill name in lowercase kebab-case, or "category/name" (two kebab-case segments) for a nested hub. Never a path.' },
      action: { type: 'string', enum: [action], required: true, description: `Must be "${action}".` },
      ...properties,
    },
  }
}

/**
 * The `skill_manage` tool.
 * @param {Function} defineTool - `@deepseek-ai/dsh-tools` defineTool.
 * @param {object} rt - plugin runtime.
 * @param {{ sessionOf: Function, catalogLookup: Function }} deps - host lookups:
 *   `sessionOf(exec)` for the session directory and `catalogLookup(exec, cwd)`
 *   returning `(name) => summary` from the session's skill catalog.
 * @returns {object} tool definition.
 */
export function skillTool(defineTool, rt, deps) {
  return defineTool({
    name: 'skill_manage',
    description: [
      'Create, update or delete skills: reusable procedural memory for recurring tasks, loaded by the `skill` tool when relevant. `operations` apply in order and atomically — any failure rolls back every skill the batch touched.',
      'ACTIONS: create (new SKILL.md; `content` is the full file, or the body when `description` is given), patch (targeted old_string/new_string — preferred), edit (full SKILL.md rewrite; view it first), write_file / remove_file (supporting files), delete (moves the skill to a recoverable trash), view (raw SKILL.md and its file list).',
      'Existing skills are modified where they live; skills inside the installation are read-only. Write lessons, not logs: one rule per lesson with its why, no dates or incident narration; the description says when to use the skill.',
    ].join('\n\n'),
    parameters: {
      operations: {
        type: 'array',
        required: true,
        description: 'Ordered operations; a single change is a list of one.',
        items: {
          oneOf: [
            opSchema('create', {
              content: { type: 'string', required: true, description: 'Full SKILL.md text (YAML frontmatter with name and description, then the body), or just the body when description is given.' },
              description: { type: 'string', description: 'Builds the frontmatter when content is only a body (ignored when content has frontmatter): "Use when <trigger>. <what it does>.".' },
              scope: { type: 'string', enum: ['user', 'project'], description: 'Where to create it: user (~/.dsh/skills, default) or project (<project root>/.agents/skills).' },
            }),
            opSchema('patch', {
              old_string: { type: 'string', required: true, description: 'Text to find, copied verbatim from a view of the file.' },
              new_string: { type: 'string', required: true, description: 'Replacement; an empty string deletes the match.' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence (default: only when old_string occurs once).' },
              file_path: { ...FILE_PATH, description: `${FILE_PATH.description} Omit, or pass "SKILL.md", to patch SKILL.md itself.` },
            }),
            opSchema('edit', {
              content: { type: 'string', required: true, description: 'Complete new SKILL.md, frontmatter included; replaces the whole file.' },
            }),
            opSchema('write_file', {
              file_path: FILE_PATH,
              file_content: { type: 'string', required: true, description: 'Full text of the supporting file.' },
            }),
            opSchema('remove_file', {
              file_path: { type: 'string', required: true, description: 'Supporting file to remove, relative to the skill directory.' },
            }),
            opSchema('delete', {}),
            opSchema('view', {}),
          ],
        },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args, exec) {
      const session = await deps.sessionOf(exec)
      const outcome = await runSkillOps(rt, {
        ops: args.operations ?? [],
        session,
        lookup: deps.catalogLookup(exec, session.cwd),
        signal: exec.signal,
      })
      return toPlain(outcome)
    },
  })
}
