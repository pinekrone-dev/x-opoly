/**
 * Property images.
 *
 * A flyer is a PDF, and the photographs a broker actually wants are inside it
 * — a building elevation on page one, a site plan on page two. Rather than
 * asking anyone to screenshot and crop by hand, the viewer lets them draw a
 * box on the rendered page and the crop is stored here.
 *
 * A property keeps several: the tour book wants a hero shot per stop and
 * usually a second or third. One of them is the cover, and if none is chosen
 * the first is used, so a property always has something to show.
 */

import { newId, nowIso } from './ids.js'

/** Enough for a tour-book page; far past that is a sign something is wrong. */
export const MAX_IMAGES = 24

function mapImage(row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    url: `/api/files/${row.path}`,
    path: row.path,
    caption: row.caption,
    position: row.position,
    // 'flyer-crop' or 'upload' — the tour book credits a crop to its flyer.
    source: row.source,
    createdAt: row.created_at,
  }
}

export async function listImages(db, propertyId) {
  const rows = await db.all(
    'SELECT * FROM property_images WHERE property_id = ? ORDER BY position, created_at',
    [propertyId],
  )
  return rows.map(mapImage)
}

/**
 * Images for every property in a survey, grouped by property id.
 *
 * One query rather than one per property — on D1 each round trip crosses the
 * network, and a tour book asks for all of them at once.
 */
export async function imagesBySurvey(db, surveyId) {
  const rows = await db.all(
    `SELECT i.* FROM property_images i
     JOIN properties p ON p.id = i.property_id
     WHERE p.survey_id = ?
     ORDER BY i.position, i.created_at`,
    [surveyId],
  )
  const grouped = new Map()
  for (const row of rows) {
    if (!grouped.has(row.property_id)) grouped.set(row.property_id, [])
    grouped.get(row.property_id).push(mapImage(row))
  }
  return grouped
}

export async function addImage(db, propertyId, { path, caption = null, source = 'upload' } = {}) {
  if (!path) return { error: 'That image was not stored.' }

  const existing = await listImages(db, propertyId)
  if (existing.length >= MAX_IMAGES) {
    return { error: `A property can hold ${MAX_IMAGES} images. Remove one to add another.` }
  }

  const id = newId()
  await db.run(
    'INSERT INTO property_images (id, property_id, path, caption, position, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      propertyId,
      path,
      caption ? String(caption).slice(0, 200) : null,
      existing.length,
      source,
      nowIso(),
    ],
  )

  const row = await db.get('SELECT * FROM property_images WHERE id = ?', [id])
  return { image: mapImage(row) }
}

export async function updateImage(db, imageId, { caption } = {}) {
  if (caption !== undefined) {
    await db.run('UPDATE property_images SET caption = ? WHERE id = ?', [
      caption ? String(caption).slice(0, 200) : null,
      imageId,
    ])
  }
  const row = await db.get('SELECT * FROM property_images WHERE id = ?', [imageId])
  return row ? { image: mapImage(row) } : { error: 'That image no longer exists.' }
}

/**
 * Removes an image, and clears the cover if this was it.
 *
 * Leaving a dangling cover_image_id would make the tour book fall back to
 * nothing rather than to the next image, which reads as a missing photo.
 */
export async function deleteImage(db, imageId, storage = null) {
  const row = await db.get('SELECT * FROM property_images WHERE id = ?', [imageId])
  if (!row) return false

  await db.batch([
    ['DELETE FROM property_images WHERE id = ?', [imageId]],
    ['UPDATE properties SET cover_image_id = NULL WHERE cover_image_id = ?', [imageId]],
  ])

  // Best effort: an orphaned object costs storage, but failing to delete it
  // should not fail the request the user made.
  if (storage) await storage.delete(row.path).catch(() => undefined)
  return true
}

export async function reorderImages(db, propertyId, orderedIds) {
  await db.batch(
    orderedIds.map((id, index) => [
      'UPDATE property_images SET position = ? WHERE id = ? AND property_id = ?',
      [index, id, propertyId],
    ]),
  )
  return listImages(db, propertyId)
}

/**
 * The image a tour book should lead with.
 *
 * Falls back to the first rather than returning nothing, so a property with
 * photos always shows one even if no cover was ever chosen.
 */
export function coverOf(images, coverImageId) {
  if (images.length === 0) return null
  return images.find((image) => image.id === coverImageId) ?? images[0]
}
