// names.mjs — shared grammar of skill names and supporting-file directories.

/** Skill name grammar of `@deepseek-ai/dsh-skill` (kebab-case). */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Longest skill name accepted. */
export const MAX_NAME_LENGTH = 64

/**
 * Directories a supporting file may live under inside a skill.
 * @type {readonly string[]}
 */
export const ALLOWED_SUBDIRS = ['references', 'templates', 'scripts', 'assets']

/**
 * Whether a string is a valid, discoverable skill name.
 * @param {unknown} name - candidate.
 * @returns {boolean} validity.
 */
export function isSkillName(name) {
  return typeof name === 'string' && name.length <= MAX_NAME_LENGTH && SKILL_NAME.test(name)
}

/**
 * Validate a supporting-file path relative to a skill directory. SKILL.md
 * itself is not a supporting file: `edit` rewrites it and `delete` removes it.
 * @param {unknown} value - candidate path.
 * @returns {string | undefined} the normalized relative path, or undefined
 *   when the path is absolute, escapes the skill, or sits outside the
 *   allowed directories.
 */
export function safeRelativeFile(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) return undefined
  const segments = value.split(/[\\/]+/)
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return undefined
  return ALLOWED_SUBDIRS.includes(segments[0]) && segments.length > 1 ? segments.join('/') : undefined
}
