/**
 * One CSV field.
 *
 * Quoted when it holds a comma, quote or line break. A text field that opens
 * with = + - @ or a tab is prefixed with an apostrophe: spreadsheets run such
 * a cell as a formula, and an owner's name is whatever the county recorded.
 * Numbers pass through, so a negative value stays a number.
 */
export function csvCell(value: unknown): string {
  if (value == null) return ''
  let text = String(value)
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
