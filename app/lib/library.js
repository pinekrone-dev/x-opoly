/**
 * The Library: the pieces of an offering memorandum, kept per parcel.
 *
 * An offering memorandum is put together in the broker's own template. What
 * this product has that the template does not is the exhibits: the parcel on
 * the map, the location with its rings and landmarks, the retail around it,
 * the demographics, the county's record. So a parcel sent to the Library
 * collects those as separate pieces, each made when it is asked for and kept
 * until it is made again, to be downloaded or linked one at a time.
 *
 * A parcel here is a CRM place; a piece is a file the map drew (its path
 * under /api/map-exports) with what it is. Data pieces (tables) are made in
 * the browser from the same sources and are not stored.
 */
import { newId, nowIso } from './ids.js'

/** The pieces the Library draws and keeps, in the order they are shown. */
export const PIECES = {
  'parcel-map': { title: 'Parcel map', group: 'Maps' },
  'location-map': { title: 'Location map', group: 'Maps' },
  'retail-map': { title: 'Retail map', group: 'Maps' },
}

const camelPlace = (r) => ({
  id: r.id, name: r.name, address: r.address, city: r.city, state: r.state,
  lat: r.lat, lng: r.lng, acreage: r.acreage, market: r.market, parcelId: r.parcel_id,
})

/** Every parcel in the team's library, newest first, each with its pieces. */
export async function listLibrary(db, teamId) {
  const rows = await db.all(
    `SELECT l.added_at, p.id, p.name, p.address, p.city, p.state, p.lat, p.lng, p.acreage, p.market, p.parcel_id
       FROM library_items l JOIN places p ON p.id = l.place_id AND p.team_id = l.team_id
      WHERE l.team_id = ?
      ORDER BY l.added_at DESC
      LIMIT 500`,
    [teamId],
  )
  const pieces = await db.all(
    'SELECT place_id, kind, path, width, height, created_at FROM library_pieces WHERE team_id = ? ORDER BY created_at',
    [teamId],
  )
  const byPlace = new Map()
  for (const piece of pieces) {
    if (!PIECES[piece.kind]) continue
    const list = byPlace.get(piece.place_id) ?? []
    list.push({ kind: piece.kind, title: PIECES[piece.kind].title, path: piece.path, width: piece.width, height: piece.height, createdAt: piece.created_at })
    byPlace.set(piece.place_id, list)
  }
  return rows.map((r) => ({ place: camelPlace(r), addedAt: r.added_at, pieces: byPlace.get(r.id) ?? [] }))
}

/** The place, when it is the team's and in the library. */
export async function libraryPlace(db, teamId, placeId) {
  const row = await db.get(
    `SELECT p.id, p.name, p.address, p.city, p.state, p.lat, p.lng, p.acreage, p.market, p.parcel_id
       FROM library_items l JOIN places p ON p.id = l.place_id AND p.team_id = l.team_id
      WHERE l.team_id = ? AND l.place_id = ?`,
    [teamId, String(placeId)],
  )
  return row ? camelPlace(row) : null
}

export async function inLibrary(db, teamId, placeId) {
  return Boolean(await db.get('SELECT 1 AS yes FROM library_items WHERE team_id = ? AND place_id = ?', [teamId, String(placeId)]))
}

/** Adds a place to the library. Adding it twice is adding it once. */
export async function addToLibrary(db, teamId, placeId, userId = null) {
  const place = await db.get('SELECT id FROM places WHERE id = ? AND team_id = ?', [String(placeId), teamId])
  if (!place) return { error: 'That parcel could not be found.' }
  await db.run(
    `INSERT INTO library_items (team_id, place_id, added_by, added_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(team_id, place_id) DO NOTHING`,
    [teamId, place.id, userId, nowIso()],
  )
  return { ok: true }
}

/** Takes a place out of the library, with the pieces kept for it. */
export async function removeFromLibrary(db, teamId, placeId) {
  await db.batch([
    ['DELETE FROM library_pieces WHERE team_id = ? AND place_id = ?', [teamId, String(placeId)]],
    ['DELETE FROM library_items WHERE team_id = ? AND place_id = ?', [teamId, String(placeId)]],
  ])
  return { ok: true }
}

/** Keeps a drawn piece for a place, in place of the one of its kind before it. */
export async function savePiece(db, teamId, placeId, { kind, path, width, height }, userId = null) {
  if (!PIECES[kind]) return { error: 'That is not a piece the library keeps.' }
  const now = nowIso()
  await db.batch([
    ['DELETE FROM library_pieces WHERE team_id = ? AND place_id = ? AND kind = ?', [teamId, String(placeId), kind]],
    [
      'INSERT INTO library_pieces (id, team_id, place_id, kind, path, width, height, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [newId(), teamId, String(placeId), kind, path, width ?? null, height ?? null, userId, now],
    ],
  ])
  return { kind, title: PIECES[kind].title, path, width, height, createdAt: now }
}

/** Whether a drawn file is one a library keeps, and so does not age out. */
export async function isLibraryPiece(db, path) {
  return Boolean(await db.get('SELECT 1 AS yes FROM library_pieces WHERE path = ? LIMIT 1', [path]))
}
