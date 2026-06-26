import { routeDistanceKm, type LatLngTuple } from "../src/lib/geo";
import type { HighwayMode } from "../src/shared/types";

export type RouteResult = {
  distanceKm: number;
  durationMin: number;
  line: LatLngTuple[];
  source: "valhalla" | "fallback";
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

type RoutingBudget = {
  requestsLeft: number;
  deadline: number;
};

const OSRM_CACHE_MAX_ENTRIES = 200;
const OSRM_CACHE_SUCCESS_TTL_MS = 5 * 60 * 1000;
const OSRM_CACHE_FAILURE_TTL_MS = 15 * 1000;
const OSRM_BROWSER_LOCK_NAME = "kyushu-touring-osrm-demo";
const OSRM_BROWSER_NEXT_REQUEST_KEY = "kyushu-touring-osrm-next-request-at";
const PUBLIC_VALHALLA_BASE_URL = "https://valhalla1.openstreetmap.de";
const osrmCache = new Map<string, OsrmCacheEntry>();
let activeOsrmRequests = 0;
let nextOsrmRequestAt = 0;
let routingBudget: RoutingBudget | null = null;
const osrmQueue: Array<() => void> = [];

export async function resolveRoute(points: LatLngTuple[], mode: HighwayMode): Promise<RouteResult> {
  if (points.length < 2) return approximateRoute(points, mode);
  const routed = await fetchOsrmRoute(points, mode);
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

async function fetchOsrmRoute(points: LatLngTuple[], mode: HighwayMode): Promise<RouteResult | null> {
  const legacyRoutingSetting = environmentValue("OSRM_BASE_URL");
  // Runtime environment values are available to the Node server, but are not exposed by the Vite browser build.
  const baseUrl = environmentValue("VALHALLA_BASE_URL") || (legacyRoutingSetting === "off" ? "off" : PUBLIC_VALHALLA_BASE_URL);
  if (baseUrl === "off") return null;
  if (isBrowserPublicDemo(baseUrl) && !canCoordinateBrowserRequests()) return null;
  const routeRequest = {
    locations: points.map(([lat, lng]) => ({ lat, lon: lng })),
    costing: "motorcycle",
    costing_options: {
      motorcycle: {
        use_highways: mode === "full" ? 1 : 0.5,
        use_tolls: mode === "full" ? 1 : 0,
        exclude_tolls: mode === "none"
      }
    },
    units: "kilometers",
    format: "osrm",
    shape_format: "geojson",
    directions_type: "none"
  };
  const url = `${baseUrl.replace(/\/$/, "")}/route?json=${encodeURIComponent(JSON.stringify(routeRequest))}`;
  const now = Date.now();
  const cached = osrmCache.get(url);
  if (cached && cached.expiresAt > now) return cached.request;
  if (cached) osrmCache.delete(url);
  if (!consumeRoutingBudget()) return null;

  const request = withOsrmSlot(async () => {
    try {
      const budgetTimeLeft = routingBudget ? routingBudget.deadline - Date.now() : Number.POSITIVE_INFINITY;
      if (budgetTimeLeft <= 0) return null;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(4500, budgetTimeLeft));
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
          source: "valhalla" as const,
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
  })
    .catch(() => null)
    .then((result) => {
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
    return await runWithOsrmRateLimit(task);
  } finally {
    activeOsrmRequests -= 1;
    osrmQueue.shift()?.();
  }
}

function osrmMaxConcurrent(): number {
  const parsed = Number(environmentValue("OSRM_MAX_CONCURRENT") ?? 1);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 1;
}

async function runWithOsrmRateLimit<T>(task: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(OSRM_BROWSER_LOCK_NAME, async () => {
      await waitForOsrmRateLimit(true);
      return task();
    });
  }
  await waitForOsrmRateLimit(false);
  return task();
}

function isBrowserPublicDemo(baseUrl: string) {
  return typeof window !== "undefined" && baseUrl.replace(/\/$/, "") === PUBLIC_VALHALLA_BASE_URL;
}

function canCoordinateBrowserRequests() {
  if (typeof navigator === "undefined" || !navigator.locks) return false;
  const probeKey = `${OSRM_BROWSER_NEXT_REQUEST_KEY}-probe`;
  try {
    localStorage.getItem(OSRM_BROWSER_NEXT_REQUEST_KEY);
    localStorage.setItem(probeKey, "1");
    if (localStorage.getItem(probeKey) !== "1") return false;
    localStorage.removeItem(probeKey);
    return true;
  } catch {
    try {
      localStorage.removeItem(probeKey);
    } catch {
      // Storage is unavailable; public routing remains disabled.
    }
    return false;
  }
}

function consumeRoutingBudget() {
  if (!routingBudget) return true;
  if (routingBudget.requestsLeft <= 0 || Date.now() >= routingBudget.deadline) return false;
  routingBudget.requestsLeft -= 1;
  return true;
}

async function waitForOsrmRateLimit(useBrowserStorage: boolean) {
  const intervalMs = osrmMinIntervalMs();
  const now = Date.now();
  if (useBrowserStorage) {
    try {
      const sharedNextRequestAt = Number(localStorage.getItem(OSRM_BROWSER_NEXT_REQUEST_KEY) ?? 0);
      if (Number.isFinite(sharedNextRequestAt)) nextOsrmRequestAt = Math.max(nextOsrmRequestAt, sharedNextRequestAt);
    } catch {
      // Private browsing may make localStorage unavailable; the in-memory limiter still applies.
    }
  }
  const waitMs = Math.max(0, nextOsrmRequestAt - now);
  nextOsrmRequestAt = Math.max(now, nextOsrmRequestAt) + intervalMs;
  if (useBrowserStorage) {
    try {
      localStorage.setItem(OSRM_BROWSER_NEXT_REQUEST_KEY, String(nextOsrmRequestAt));
    } catch {
      throw new Error("Cross-tab OSRM rate-limit storage is unavailable");
    }
  }
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

export function isRoadRoutingEnabled() {
  return environmentValue("VALHALLA_BASE_URL") !== "off" && environmentValue("OSRM_BASE_URL") !== "off";
}

export function beginRoutingBudget(maxRequests: number, timeoutMs: number) {
  const budget = {
    requestsLeft: Math.max(0, Math.floor(maxRequests)),
    deadline: Date.now() + Math.max(0, timeoutMs)
  };
  routingBudget = budget;
  return () => {
    if (routingBudget === budget) routingBudget = null;
  };
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
