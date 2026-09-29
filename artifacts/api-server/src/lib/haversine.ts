const EARTH_RADIUS_M = 6_371_000;

/**
 * Calculates the great-circle distance in metres between two GPS coordinates
 * using the Haversine formula.
 *
 * @param lat1 - Latitude of point A in decimal degrees.
 * @param lon1 - Longitude of point A in decimal degrees.
 * @param lat2 - Latitude of point B in decimal degrees.
 * @param lon2 - Longitude of point B in decimal degrees.
 * @returns Distance in metres.
 */
export function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * Returns true if the given GPS point is within the geofence radius of the
 * reference point.
 */
export function isInsideGeofence(
  refLat: number,
  refLon: number,
  pointLat: number,
  pointLon: number,
  radiusMeters: number,
): boolean {
  return distanceMeters(refLat, refLon, pointLat, pointLon) <= radiusMeters;
}
