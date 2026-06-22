import { routeDistanceKm, type LatLngTuple } from "../src/lib/geo";
import type { HighwayMode } from "../src/shared/types";

export type RouteResult = {
  distanceKm: number;
  durationMin: number;
  line: LatLngTuple[];
  source: "osrm" | "fallback";
  maxWaypointSnapDistanceM?: number;
  waypointLineIndices?: number[];
};

type OsrmResponse = {
  code: string;
  waypoints?: Array<{ distance: number; location?: [number, number] }>;
  routes?: Array<{
    distance: number;
    duration: number;
    geometry: {
      type: "LineString";
      coordinates: Array<[number, number]>;
    };
  }>;
};

type OsrmCacheEntry = {
  expiresAt: number;
  request: Promise<RouteResult | null>;
};

const OSRM_CACHE_MAX_ENTRIES = 200;
const OSRM_CACHE_SUCCESS_TTL_MS = 5 * 60 * 1000;
const OSRM_CACHE_FAILURE_TTL_MS = 15 * 1000;
const osrmCache = new Map<string, OsrmCacheEntry>();
let remoteRoutingEnabled = true;
let activeOsrmRequests = 0;
let nextOsrmRequestAt = 0;
const osrmQueue: Array<() => void> = [];

export async function resolveRoute(points: LatLngTuple[], mode: HighwayMode): Promise<RouteResult> {
  if (points.length < 2 || !remoteRoutingEnabled) return approximateRoute(points, mode);
  const routed = await fetchOsrmRoute(points);
  return routed ?? approximateRoute(points, mode);
}

export function approximateRoute(points: LatLngTuple[], mode: HighwayMode): RouteResult {
  const distanceKm = routeDistanceKm(points) * detourMultiplier(mode);
  return {
    distanceKm,
    durationMin: (distanceKm / speedForMode(mode)) * 60,
    line: points,
    source: "fallback"
  };
}

async function fetchOsrmRoute(points: LatLngTuple[]): Promise<RouteResult | null> {
  const baseUrl = environmentValue("OSRM_BASE_URL") || "https://router.project-osrm.org";
  if (baseUrl === "off") return null;
  const coordinates = points.map(([lat, lng]) => `${lng},${lat}`).join(";");
  const url = `${baseUrl.replace(/\/$/, "")}/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`;
  const now = Date.now();
  const cached = osrmCache.get(url);
  if (cached && cached.expiresAt > now) return cached.request;
  if (cached) osrmCache.delete(url);

  const request = withOsrmSlot(async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4500);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "kyushu-touring-range-planner/0.1" }
        });
        if (!response.ok) return null;
        const data = (await response.json()) as OsrmResponse;
        const route = data.routes?.[0];
        if (data.code !== "Ok" || !route?.geometry?.coordinates?.length) return null;
        const line = route.geometry.coordinates.map(([lng, lat]) => [lat, lng] as LatLngTuple);
        return {
          distanceKm: route.distance / 1000,
          durationMin: route.duration / 60,
          line,
          source: "osrm" as const,
          maxWaypointSnapDistanceM: data.waypoints?.length
            ? Math.max(...data.waypoints.map((waypoint) => waypoint.distance))
            : undefined,
          waypointLineIndices: data.waypoints?.every((waypoint) => waypoint.location)
            ? locateWaypointsOnLine(
                line,
                data.waypoints.map((waypoint) => [waypoint.location![1], waypoint.location![0]] as LatLngTuple)
              )
            : undefined
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null;
    }
  }).then((result) => {
    const entry = osrmCache.get(url);
    if (entry?.request === request) {
      entry.expiresAt = Date.now() + (result ? OSRM_CACHE_SUCCESS_TTL_MS : OSRM_CACHE_FAILURE_TTL_MS);
    }
    return result;
  });

  osrmCache.set(url, {
    expiresAt: now + OSRM_CACHE_FAILURE_TTL_MS,
    request
  });
  trimRouteCache();
  return request;
}

function locateWaypointsOnLine(line: LatLngTuple[], waypoints: LatLngTuple[]): number[] {
  let searchStart = 0;
  return waypoints.map((waypoint) => {
    let nearestIndex = searchStart;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = searchStart; index < line.length; index += 1) {
      const distance = routeDistanceKm([line[index], waypoint]);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    searchStart = nearestIndex;
    return nearestIndex;
  });
}

async function withOsrmSlot<T>(task: () => Promise<T>): Promise<T> {
  const maxConcurrent = osrmMaxConcurrent();
  if (activeOsrmRequests >= maxConcurrent) {
    await new Promise<void>((resolve) => osrmQueue.push(resolve));
  }
  activeOsrmRequests += 1;
  try {
    await waitForOsrmRateLimit();
    return await task();
  } finally {
    activeOsrmRequests -= 1;
    osrmQueue.shift()?.();
  }
}

function osrmMaxConcurrent(): number {
  const parsed = Number(environmentValue("OSRM_MAX_CONCURRENT") ?? 1);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 1;
}

async function waitForOsrmRateLimit() {
  const intervalMs = osrmMinIntervalMs();
  const now = Date.now();
  const waitMs = Math.max(0, nextOsrmRequestAt - now);
  nextOsrmRequestAt = Math.max(now, nextOsrmRequestAt) + intervalMs;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

function osrmMinIntervalMs(): number {
  const parsed = Number(environmentValue("OSRM_MIN_INTERVAL_MS") ?? 1100);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 1100;
}

function environmentValue(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

function trimRouteCache() {
  while (osrmCache.size > OSRM_CACHE_MAX_ENTRIES) {
    const oldestKey = osrmCache.keys().next().value;
    if (!oldestKey) break;
    osrmCache.delete(oldestKey);
  }
}

export function clearRouteCache() {
  osrmCache.clear();
  nextOsrmRequestAt = 0;
}

export function setRemoteRoutingEnabled(enabled: boolean) {
  remoteRoutingEnabled = enabled;
}

export function speedForMode(mode: HighwayMode): number {
  switch (mode) {
    case "full":
      return 68;
    case "none":
    default:
      return 43;
  }
}

export function detourMultiplier(mode: HighwayMode): number {
  switch (mode) {
    case "none":
      return 1.3;
    case "full":
      return 1.1;
  }
}
