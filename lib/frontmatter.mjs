// frontmatter.mjs — the slice of YAML a SKILL.md header needs.
//
// DSH discovers a skill only when its frontmatter carries a kebab-case `name`
// and a non-empty `description`, so this module reads exactly those flat
// `key: value` pairs (plus quoted strings and block scalars) to validate a file
// BEFORE it is written, and serializes description text as a safe YAML scalar.

import { SKILL_NAME } from './names.mjs'

/**
 * Split a SKILL.md into its frontmatter data and body.
 * @param {string} raw - file text.
 * @returns {{ has: boolean, data: Record<string, string>, body: string }} the
 *   parsed header (flat string values only) and the markdown body.
 */
export function splitFrontmatter(raw) {
  const normalized = raw.replace(/\r\n/g, '\n')
  const firstEnd = normalized.indexOf('\n')
  if (firstEnd < 0 || normalized.slice(0, firstEnd).trim() !== '---') return { has: false, data: {}, body: raw }
  const lines = normalized.slice(firstEnd + 1).split('\n')
  let closing = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      closing = i
      break
    }
  }
  if (closing < 0) return { has: false, data: {}, body: raw }
  return { has: true, data: parseFlatYaml(lines.slice(0, closing)), body: lines.slice(closing + 1).join('\n').replace(/^\n+/, '') }
}

/**
 * Parse flat `key: value` pairs; nested structures are skipped.
 * @param {string[]} lines - YAML lines between the markers.
 * @returns {Record<string, string>} string values by key.
 */
function parseFlatYaml(lines) {
  const data = {}
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i])
    if (match === null) continue
    const value = match[2]
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const block = []
      let j = i + 1
      while (j < lines.length && /^[ \t]+/.test(lines[j])) {
        block.push(lines[j].trim())
        j += 1
      }
      data[match[1]] = block.join(value.startsWith('>') ? ' ' : '\n')
      i = j - 1
      continue
    }
    data[match[1]] = unquote(value)
  }
  return data
}

/**
 * Unquote a YAML scalar.
 * @param {string} value - raw scalar text.
 * @returns {string} the unquoted value.
 */
function unquote(value) {
  const text = value.trim()
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/g, "'")
  return text.replace(/\s+#.*$/, '').trim()
}

/**
 * Serialize text as a YAML scalar: plain when safe, JSON-quoted otherwise
 * (a JSON string is a valid YAML double-quoted scalar).
 * @param {string} text - value to serialize.
 * @returns {string} the scalar.
 */
export function yamlScalar(text) {
  const value = String(text).trim()
  const plain = /^[^\s"'#|>&*!%@`[\]{},?][^#\n]*$/.test(value)
    && !/:\s/.test(value) && !/\s$/.test(value) && value !== 'true' && value !== 'false' && value !== 'null'
    && !/^[~\-.0-9]/.test(value)
  return plain ? value : JSON.stringify(value)
}

/**
 * Validate a SKILL.md text for DSH discovery.
 * @param {string} raw - file text.
 * @param {string} name - the skill name the file must declare.
 * @returns {string | undefined} a model-facing problem, or undefined when valid.
 */
export function validateSkillText(raw, name) {
  if (!SKILL_NAME.test(name)) {
    return `skill name "${name}" must be kebab-case (lowercase letters, digits and single hyphens) to be discoverable`
  }
  const { has, data } = splitFrontmatter(raw)
  if (!has) return 'SKILL.md must start with YAML frontmatter (--- delimited) carrying name and description'
  if (data.name !== name) return `frontmatter name must be "${name}" (found ${data.name === undefined ? 'none' : `"${data.name}"`})`
  if (typeof data.description !== 'string' || data.description.trim().length === 0) return 'frontmatter requires a non-empty description'
  if (data.description.length > 1024) return 'description exceeds 1024 characters'
  return strictScalarProblem(raw, 'description') ?? strictScalarProblem(raw, 'name')
}

/**
 * Catch a plain YAML scalar the strict parser of the host would reject
 * (`description: Use when: X`), which the lenient reader above accepts.
 * @param {string} raw - file text.
 * @param {string} key - frontmatter key.
 * @returns {string | undefined} a problem, or undefined.
 */
function strictScalarProblem(raw, key) {
  const line = raw.split('\n').find(text => new RegExp(`^${key}:`).test(text))
  if (line === undefined) return undefined
  const value = line.slice(key.length + 1).trim()
  const quoted = value.startsWith('"') || value.startsWith("'") || value.startsWith('[') || value.startsWith('{') || /^[>|][-+]?$/.test(value)
  if (!quoted && (/:\s/.test(value) || /\s#/.test(value))) {
    return `frontmatter ${key} contains ": " or " #" and must be quoted, or the skill is ignored at discovery`
  }
  return undefined
}

/**
 * Build a complete SKILL.md when the caller supplies only a body.
 * @param {string} name - skill name.
 * @param {string} description - catalog description.
 * @param {string} body - markdown body.
 * @returns {string} the file text.
 */
export function buildSkillText(name, description, body) {
  return `---\nname: ${name}\ndescription: ${yamlScalar(description)}\n---\n\n${body.trim()}\n`
}
