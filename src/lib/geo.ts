export type LatLngTuple = [number, number];

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: LatLngTuple, b: LatLngTuple): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function destinationPoint(center: LatLngTuple, bearingDeg: number, distanceKm: number): LatLngTuple {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const toDeg = (value: number) => (value * 180) / Math.PI;
  const bearing = toRad(bearingDeg);
  const lat1 = toRad(center[0]);
  const lng1 = toRad(center[1]);
  const angular = distanceKm / EARTH_RADIUS_KM;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2)
    );
  return [Number(toDeg(lat2).toFixed(6)), Number(toDeg(lng2).toFixed(6))];
}

export function circlePolygon(center: LatLngTuple, radiusKm: number, steps = 72): LatLngTuple[] {
  const coordinates = Array.from({ length: steps }, (_, index) =>
    destinationPoint(center, (360 / steps) * index, radiusKm)
  );
  coordinates.push(coordinates[0]);
  return coordinates;
}

export function routeDistanceKm(points: LatLngTuple[]): number {
  return points.slice(1).reduce((total, point, index) => total + haversineKm(points[index], point), 0);
}
