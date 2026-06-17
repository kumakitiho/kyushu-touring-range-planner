import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFallbackPlans, filterCandidates, orderStopsForOutAndBack, radiusFromConstraint, scoreSpot } from "../server/planner";
import { clearRouteCache } from "../server/routing";
import { routeAtProgress } from "../src/lib/routeAnimation";
import { haversineKm } from "../src/lib/geo";
import { PlanRequestSchema, PlanResponseSchema, type Plan, type Spot } from "../src/shared/types";

const baseRequest = PlanRequestSchema.parse({
  origin: { label: "Kumamoto", lat: 32.7907, lng: 130.6889, source: "preset" },
  constraint: { type: "duration", value: 240, unit: "min" },
  routeOptions: { highwayMode: "none" },
  preferences: { gourmet: 4, scenic: 4, road: 5, relaxed: 2 },
  tripStyle: "day_trip",
  count: 3
});

describe("planner fallback", () => {
  beforeEach(() => {
    clearRouteCache();
    vi.stubEnv("OSRM_BASE_URL", "off");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns schema-valid fallback plans without API keys", async () => {
    const response = await buildFallbackPlans(baseRequest);
    expect(() => PlanResponseSchema.parse(response)).not.toThrow();
    expect(response.mode).toBe("fallback");
    expect(response.plans[0].routeSource).toBe("fallback");
    expect(response.plans.length).toBeGreaterThan(0);
    expect(response.plans[0].routeLine[0]).toEqual([baseRequest.origin.lat, baseRequest.origin.lng]);
  });

  it("expands reachable radius when highway mode allows faster travel", () => {
    const noHighway = radiusFromConstraint(baseRequest);
    const fullHighway = radiusFromConstraint({
      ...baseRequest,
      routeOptions: { highwayMode: "full" }
    });
    expect(fullHighway).toBeGreaterThan(noHighway);
  });

  it("keeps duration-constrained fallback plans near the requested budget", async () => {
    const response = await buildFallbackPlans({
      ...baseRequest,
      origin: { label: "Fukuoka", lat: 33.5902, lng: 130.4017, source: "preset" },
      routeOptions: { highwayMode: "local_only_after_highway" }
    });
    expect(response.plans[0].estimatedDurationMin).toBeLessThanOrEqual(baseRequest.constraint.value * 1.2);
  });

  it("drops excess stops after routed duration is resolved", async () => {
    const response = await buildFallbackPlans({
      ...baseRequest,
      origin: { label: "Fukuoka", lat: 33.5902, lng: 130.4017, source: "preset" },
      constraint: { type: "duration", value: 120, unit: "min" },
      routeOptions: { highwayMode: "local_only_after_highway" }
    });
    expect(response.plans[0].estimatedDurationMin).toBeLessThanOrEqual(144);
  });

  it("varies stop composition across multiple plans", async () => {
    const response = await buildFallbackPlans({
      ...baseRequest,
      origin: { label: "Fukuoka", lat: 33.5902, lng: 130.4017, source: "preset" },
      routeOptions: { highwayMode: "local_only_after_highway" }
    });
    const signatures = new Set(response.plans.map((plan) => plan.stops.map((stop) => stop.spotId).join(">")));
    expect(signatures.size).toBeGreaterThan(1);
  });

  it("keeps each plan in one practical direction from the origin", async () => {
    const response = await buildFallbackPlans(baseRequest);
    for (const plan of response.plans) {
      expect(maxBearingSpreadFromOrigin([baseRequest.origin.lat, baseRequest.origin.lng], plan)).toBeLessThanOrEqual(55);
    }
  });

  it("continues exploring candidates until requested plan count is filled when possible", async () => {
    const response = await buildFallbackPlans(baseRequest);
    expect(response.candidates.length).toBeGreaterThanOrEqual(baseRequest.count);
    expect(response.plans).toHaveLength(baseRequest.count);
  });

  it("returns no plans instead of schema-invalid empty-stop plans when no candidate exists", async () => {
    const response = await buildFallbackPlans({
      ...baseRequest,
      origin: { label: "Sapporo", lat: 43.0618, lng: 141.3545, source: "manual" }
    });

    expect(() => PlanResponseSchema.parse(response)).not.toThrow();
    expect(response.candidates).toHaveLength(0);
    expect(response.plans).toHaveLength(0);
  });

  it("does not keep a single stop when resolved OSRM duration exceeds the budget", async () => {
    vi.stubEnv("OSRM_BASE_URL", "http://mock-osrm");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            code: "Ok",
            routes: [
              {
                distance: 999_000,
                duration: 999_000,
                geometry: {
                  type: "LineString",
                  coordinates: [
                    [130.4017, 33.5902],
                    [130.188, 33.6372]
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const response = await buildFallbackPlans({
      ...baseRequest,
      origin: { label: "Fukuoka", lat: 33.5902, lng: 130.4017, source: "preset" },
      constraint: { type: "duration", value: 120, unit: "min" },
      routeOptions: { highwayMode: "local_only_after_highway" }
    });

    expect(() => PlanResponseSchema.parse(response)).not.toThrow();
    expect(response.plans).toHaveLength(0);
    expect(response.plans.every((plan) => plan.estimatedDurationMin <= 144)).toBe(true);
  });

  it("orders same-corridor stops from near to far before returning", () => {
    const origin: [number, number] = [33.5902, 130.4017];
    const near: Spot = {
      id: "near-west",
      name: "Near west",
      category: "road",
      lat: 33.58,
      lng: 130.05,
      area: "test",
      tags: [],
      description: "test",
      images: []
    };
    const far: Spot = {
      id: "far-west",
      name: "Far west",
      category: "scenic",
      lat: 33.52,
      lng: 129.65,
      area: "test",
      tags: [],
      description: "test",
      images: []
    };

    expect(orderStopsForOutAndBack(origin, [far, near]).map((spot) => spot.id)).toEqual(["near-west", "far-west"]);
  });

  it("prefers at least two stops for day-trip detour plans when budget allows", async () => {
    const response = await buildFallbackPlans({
      ...baseRequest,
      origin: { label: "Fukuoka", lat: 33.5902, lng: 130.4017, source: "preset" },
      constraint: { type: "duration", value: 300, unit: "min" },
      routeOptions: { highwayMode: "return_only" }
    });

    expect(response.plans[1].stops.length).toBeGreaterThanOrEqual(2);
  });

  it("half-day style uses a smaller reachable radius than day trips", () => {
    const dayTrip = radiusFromConstraint({ ...baseRequest, tripStyle: "day_trip" });
    const halfDay = radiusFromConstraint({ ...baseRequest, tripStyle: "half_day" });
    expect(halfDay).toBeLessThan(dayTrip);
  });

  it("penalizes far spots when highways are disabled", () => {
    const candidates = filterCandidates({
      ...baseRequest,
      constraint: { type: "duration", value: 600, unit: "min" }
    });
    const farSpot = candidates.find((spot) => {
      return haversineKm([baseRequest.origin.lat, baseRequest.origin.lng], [spot.lat, spot.lng]) > 95;
    });
    expect(farSpot).toBeDefined();
    if (!farSpot) return;
    const noHighwayScore = scoreSpot(farSpot, baseRequest);
    const highwayScore = scoreSpot(farSpot, { ...baseRequest, routeOptions: { highwayMode: "full" } });
    expect(highwayScore).toBeGreaterThan(noHighwayScore);
  });
});

function maxBearingSpreadFromOrigin(origin: [number, number], plan: Plan): number {
  const bearings = plan.stops.map((stop) => bearingDeg(origin, [stop.lat, stop.lng]));
  let maxSpread = 0;
  for (const a of bearings) {
    for (const b of bearings) {
      maxSpread = Math.max(maxSpread, angularDistanceDeg(a, b));
    }
  }
  return maxSpread;
}

function bearingDeg(from: [number, number], to: [number, number]): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const toDeg = (value: number) => (value * 180) / Math.PI;
  const lat1 = toRad(from[0]);
  const lat2 = toRad(to[0]);
  const dLng = toRad(to[1] - from[1]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function angularDistanceDeg(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return Math.min(diff, 360 - diff);
}

describe("route animation", () => {
  it("returns interpolated route points by playback progress", () => {
    const route: [number, number][] = [
      [32, 130],
      [32, 131],
      [33, 131]
    ];
    expect(routeAtProgress(route, 0)).toEqual([[32, 130]]);
    expect(routeAtProgress(route, 1)).toEqual(route);
    const half = routeAtProgress(route, 0.5);
    expect(half.length).toBeGreaterThanOrEqual(2);
    expect(half.at(-1)).not.toEqual(route.at(-1));
  });
});
