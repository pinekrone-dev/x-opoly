import type { Property } from '../types'
import { fullAddress } from './format'

/**
 * Turn-by-turn directions to a site.
 *
 * One definition used by both audiences. On paper a client cannot click, so
 * the tour book prints this as a QR code they photograph from the passenger
 * seat. On a shared link they can click, so it is a link and the QR would be
 * pointless furniture.
 *
 * The `dir/?api=1` form starts from wherever the person is, which is the
 * question actually being asked — "how do I get there from here" — rather than
 * from a fixed origin.
 */

const MAPS_BASE = 'https://www.google.com/maps/dir/'

/**
 * Coordinates are the destination of record, because two different suites can
 * share a street address and a dropped pin cannot be misread. The address goes
 * along as the label so the destination is legible before you set off.
 */
export function directionsUrl(property: Property): string | null {
  const params = new URLSearchParams({ api: '1' })

  if (property.lat != null && property.lng != null) {
    params.set('destination', `${property.lat},${property.lng}`)
  } else {
    const address = fullAddress(property)
    if (!address) return null
    params.set('destination', address)
  }

  return `${MAPS_BASE}?${params.toString()}`
}

/** A QR code as a PNG data URL, or null if it could not be built. */
export async function directionsQr(property: Property, size = 220): Promise<string | null> {
  const url = directionsUrl(property)
  if (!url) return null

  try {
    // Loaded on demand — only the tour book export needs it.
    const QRCode = (await import('qrcode')).default
    return await QRCode.toDataURL(url, {
      width: size,
      margin: 1,
      // Medium correction: a printed page can be creased or smudged, and the
      // payload is short enough that the extra redundancy costs nothing.
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172a', light: '#ffffff' },
    })
  } catch {
    return null
  }
}
