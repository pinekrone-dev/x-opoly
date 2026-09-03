/**
 * A streaming CSV reader.
 *
 * NPPES's monthly file is nine gigabytes uncompressed, so the file is never
 * held in memory: rows are yielded as they complete. RFC 4180 rules — quoted
 * fields, doubled quotes inside them, and newlines inside quotes — are all
 * honoured, because CMS uses every one of them.
 */

/**
 * @param {AsyncIterable<Buffer | string>} source
 * @returns {AsyncGenerator<string[]>} one array of fields per row
 */
export async function* parseCsv(source) {
  let field = ''
  let row = []
  let quoted = false
  let afterQuote = false
  let sawCr = false
  let any = false

  for await (const chunk of source) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    for (let i = 0; i < text.length; i++) {
      const char = text[i]

      if (quoted) {
        if (afterQuote) {
          afterQuote = false
          if (char === '"') {
            field += '"'
            continue
          }
          quoted = false
          // Fall through: this character closes the field.
        } else if (char === '"') {
          afterQuote = true
          continue
        } else {
          field += char
          continue
        }
      }

      if (char === '"' && field === '' && !any) {
        quoted = true
        any = true
        continue
      }
      if (char === ',') {
        row.push(field)
        field = ''
        any = false
        sawCr = false
        continue
      }
      if (char === '\r') {
        sawCr = true
        continue
      }
      if (char === '\n') {
        row.push(field)
        yield row
        row = []
        field = ''
        any = false
        sawCr = false
        continue
      }
      if (sawCr) {
        // A bare carriage return inside a field: keep it.
        field += '\r'
        sawCr = false
      }
      field += char
      any = true
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field)
    yield row
  }
}

/** Rows as objects keyed by the header line. */
export async function* parseCsvRecords(source) {
  let header = null
  for await (const row of parseCsv(source)) {
    if (!header) {
      header = row.map((name) => name.trim())
      continue
    }
    if (row.length === 1 && row[0] === '') continue
    const record = {}
    for (let i = 0; i < header.length; i++) record[header[i]] = row[i] ?? ''
    yield record
  }
}

/** One CSV line, quoted wherever the value needs it. */
export function csvLine(values) {
  return values
    .map((value) => {
      const text = value == null ? '' : String(value)
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    })
    .join(',')
}
