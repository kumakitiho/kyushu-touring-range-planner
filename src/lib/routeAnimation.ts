import { haversineKm, type LatLngTuple } from "./geo";

export function routeAtProgress(points: LatLngTuple[], progress: number): LatLngTuple[] {
  if (points.length <= 1) return points;
  const clamped = Math.min(1, Math.max(0, progress));
  if (clamped === 0) return [points[0]];
  if (clamped === 1) return points;

  const segmentLengths = points.slice(1).map((point, index) => haversineKm(points[index], point));
  const totalLength = segmentLengths.reduce((sum, length) => sum + length, 0);
  const targetLength = totalLength * clamped;
  const visible: LatLngTuple[] = [points[0]];
  let walked = 0;

  for (let index = 0; index < segmentLengths.length; index += 1) {
    const nextLength = segmentLengths[index];
    const start = points[index];
    const end = points[index + 1];
    if (walked + nextLength <= targetLength) {
      visible.push(end);
      walked += nextLength;
      continue;
    }
    const ratio = nextLength === 0 ? 0 : (targetLength - walked) / nextLength;
    visible.push([
      Number((start[0] + (end[0] - start[0]) * ratio).toFixed(6)),
      Number((start[1] + (end[1] - start[1]) * ratio).toFixed(6))
    ]);
    break;
  }

  return visible;
}

export function routeHead(points: LatLngTuple[]): LatLngTuple | undefined {
  return points.at(-1);
}
