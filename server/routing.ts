import { routeDistanceKm, type LatLngTuple } from "../src/lib/geo";
import type { HighwayMode } from "../src/shared/types";

export type RouteResult = {
  distanceKm: number;
  durationMin: number;
  line: LatLngTuple[];
  source: "osrm" | "fallback";
};

type OsrmResponse = {
  code: string;
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
let activeOsrmRequests = 0;
const osrmQueue: Array<() => void> = [];

export async function resolveRoute(points: LatLngTuple[], mode: HighwayMode): Promise<RouteResult> {
  if (points.length < 2) return approximateRoute(points, mode);
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
  const baseUrl = process.env.OSRM_BASE_URL || "https://router.project-osrm.org";
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
        return {
          distanceKm: route.distance / 1000,
          durationMin: route.duration / 60,
          line: route.geometry.coordinates.map(([lng, lat]) => [lat, lng] as LatLngTuple),
          source: "osrm" as const
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

async function withOsrmSlot<T>(task: () => Promise<T>): Promise<T> {
  const maxConcurrent = osrmMaxConcurrent();
  if (activeOsrmRequests >= maxConcurrent) {
    await new Promise<void>((resolve) => osrmQueue.push(resolve));
  }
  activeOsrmRequests += 1;
  try {
    return await task();
  } finally {
    activeOsrmRequests -= 1;
    osrmQueue.shift()?.();
  }
}

function osrmMaxConcurrent(): number {
  const parsed = Number(process.env.OSRM_MAX_CONCURRENT ?? 2);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 2;
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
}

export function speedForMode(mode: HighwayMode): number {
  switch (mode) {
    case "full":
      return 68;
    case "outbound_only":
      return 55;
    case "return_only":
      return 54;
    case "local_only_after_highway":
      return 58;
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
    case "outbound_only":
    case "return_only":
      return 1.2;
    case "local_only_after_highway":
      return 1.16;
  }
}
