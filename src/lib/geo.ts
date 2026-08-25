/**
 * The one place geospatial constants live on the frontend.
 *
 * Every circle drawn on the map converts miles to metres with this exact
 * figure — the international mile — so a 5-mile non-compete ring on screen
 * is the same 5 miles the backend measures with its haversine.
 */
export const METERS_PER_MILE = 1609.344
