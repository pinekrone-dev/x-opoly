/** Identifier and timestamp helpers, shared by both runtimes. */

export function newId() {
  return crypto.randomUUID().slice(0, 12)
}

export function newShareToken() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function nowIso() {
  return new Date().toISOString()
}

/** SQLite has no booleans; normalize on the way out. */
export function toBool(value) {
  return value === 1 || value === true
}
