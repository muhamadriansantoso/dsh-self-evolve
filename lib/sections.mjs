// sections.mjs — markdown heading sections of a persona document.
//
// A section is a heading line (`## Title`) plus every line up to the next
// heading of the same or a higher level. Titles are compared case-insensitively
// with punctuation folded, so "Execution rules", "execution rules:" and
// "EXECUTION RULES" address the same section. Lines inside ``` or ~~~ fences
// are never headings, so shell comments in an example block cannot split a
// section; a title that appears twice is reported as ambiguous.

/** Heading line: level, title, trailing hashes. */
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
/** Opening or closing fence: three or more backticks or tildes. */
const FENCE = /^([`~]{3,})/

/**
 * Fold a title for comparison.
 * @param {string} title - heading text.
 * @returns {string} normalized title.
 */
export function normTitle(title) {
  return String(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/**
 * List the headings of a document, skipping fenced code.
 * @param {string} text - document text.
 * @returns {Array<{ level: number, title: string, line: number }>} headings,
 *   with 1-based line numbers.
 */
export function listSections(text) {
  return headingsOf(text.split('\n')).map(match => ({ level: match.level, title: match.title, line: match.index + 1 }))
}

/**
 * Heading matches outside fences.
 * @param {string[]} lines - document lines.
 * @returns {Array<{ index: number, level: number, title: string }>} matches.
 */
function headingsOf(lines) {
  const out = []
  let fence = undefined
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, '')
    const marker = FENCE.exec(line.trimStart())
    if (fence === undefined) {
      if (marker !== null) fence = marker[1]
    } else if (marker !== null && marker[1][0] === fence[0] && marker[1].length >= fence.length) {
      fence = undefined
    }
    if (fence !== undefined) continue
    const match = HEADING.exec(line)
    if (match !== null) out.push({ index: i, level: match[1].length, title: match[2].trim() })
  }
  return out
}

/**
 * Every section whose title matches, with exclusive end indexes.
 * @param {string[]} lines - document lines.
 * @param {string[]} titles - headings outside fences.
 * @param {string} title - requested title.
 * @returns {Array<{ start: number, end: number }>} matches.
 */
function rangesOf(lines, titles, title) {
  const wanted = normTitle(title)
  const ranges = []
  for (const heading of titles.filter(item => normTitle(item.title) === wanted)) {
    let end = lines.length
    for (const next of titles) {
      if (next.index > heading.index && next.level <= heading.level) {
        end = next.index
        break
      }
    }
    ranges.push({ start: heading.index, end })
  }
  return ranges
}

/** Drop trailing blank lines of a line array (mutates and returns it). */
function trimTrailingBlank(lines) {
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines
}

/**
 * Resolve the single section named `title`.
 * @param {string[]} lines - document lines.
 * @param {string} title - requested title.
 * @returns {{ start: number, end: number } | { ambiguous: true } | undefined}
 */
function resolve(lines, title) {
  const ranges = rangesOf(lines, headingsOf(lines), title)
  if (ranges.length > 1) return { ambiguous: true }
  return ranges[0]
}

/**
 * Replace a section's body, or append the section when it does not exist.
 * The heading line is kept verbatim on replace.
 * @param {string} text - document text.
 * @param {string} title - section title.
 * @param {string} content - new section body.
 * @returns {{ text: string, created: boolean } | { ambiguous: true }} the
 *   document and whether the section was appended, or an ambiguity verdict.
 */
export function setSection(text, title, content) {
  const lines = text.split('\n')
  const body = content.trim().split('\n')
  const range = resolve(lines, title)
  if (range?.ambiguous === true) return range
  if (range === undefined) {
    const head = trimTrailingBlank(lines)
    const heading = `## ${title.trim()}`
    return { text: [...head, ...(head.length > 0 ? [''] : []), heading, '', ...body, ''].join('\n'), created: true }
  }
  const before = trimTrailingBlank(lines.slice(0, range.start))
  const after = lines.slice(range.end)
  return {
    text: [...before, ...(before.length > 0 ? [''] : []), lines[range.start], '', ...body, ...(after.length > 0 ? [''] : []), ...after].join('\n'),
    created: false,
  }
}

/**
 * Remove a section, heading included.
 * @param {string} text - document text.
 * @param {string} title - section title.
 * @returns {string | { ambiguous: true } | undefined} the document without the
 *   section, an ambiguity verdict, or undefined when no such section exists.
 */
export function removeSection(text, title) {
  const lines = text.split('\n')
  const range = resolve(lines, title)
  if (range === undefined || range.ambiguous === true) return range
  const before = trimTrailingBlank(lines.slice(0, range.start))
  const after = lines.slice(range.end)
  return [...before, ...(before.length > 0 && after.length > 0 ? [''] : []), ...after].join('\n')
}
