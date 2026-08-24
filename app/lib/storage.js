/**
 * File storage for flyers and photos.
 *
 * Local disk in development, R2 when deployed. Both return the same shape so
 * the upload routes never branch on which one is in use.
 */

/** @param {string} directory absolute path to write into */
export async function diskStorage(directory) {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  await fs.mkdir(directory, { recursive: true })

  return {
    kind: 'disk',

    async put(name, bytes, contentType) {
      await fs.writeFile(path.join(directory, name), Buffer.from(bytes))
      return { name, contentType }
    },

    async get(name) {
      try {
        const body = await fs.readFile(path.join(directory, name))
        return { body: new Uint8Array(body), contentType: contentTypeFor(name) }
      } catch {
        return null
      }
    },

    async delete(name) {
      await fs.rm(path.join(directory, name), { force: true })
    },
  }
}

/** @param {R2Bucket} bucket the binding from the Worker environment */
export function r2Storage(bucket) {
  return {
    kind: 'r2',

    async put(name, bytes, contentType) {
      await bucket.put(name, bytes, { httpMetadata: { contentType } })
      return { name, contentType }
    },

    async get(name) {
      const object = await bucket.get(name)
      if (!object) return null
      return {
        body: new Uint8Array(await object.arrayBuffer()),
        contentType: object.httpMetadata?.contentType || contentTypeFor(name),
      }
    },

    async delete(name) {
      await bucket.delete(name)
    },
  }
}

const CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export function contentTypeFor(name) {
  const dot = name.lastIndexOf('.')
  return (dot === -1 ? null : CONTENT_TYPES[name.slice(dot).toLowerCase()]) || 'application/octet-stream'
}

export const EXTENSIONS = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

/** Base64 without Buffer, so the same helper works in both runtimes. */
export function toBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}
