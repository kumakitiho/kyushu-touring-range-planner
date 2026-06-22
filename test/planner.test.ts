import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFallbackPlans,
  buildPlanFromSpotIds,
  filterCandidates,
  orderStopsForOutAndBack,
  radiusFromConstraint,
  scoreSpot
} from "../server/planner";
import { clearRouteCache } from "../server/routing";
import { routeAtProgress } from "../src/lib/routeAnimation";
import { haversineKm } from "../src/lib/geo";
import { PlanRequestSchema, PlanResponseSchema, type Plan, type Spot } from "../src/shared/types";

const baseRequest = PlanRequestSchema.parse({
  origin: { label: "Kumamoto", lat: 32.7907, lng: 130.6889, source: "preset" },
  constraint: { type: "duration", value: 240, unit: "min" },
  routeOptions: { highwayMode: "none" },
  preferences: { gourmet: "medium", scenic: "medium", road: "high", relaxed: "low" },
  tripStyle: "day_trip",
  count: 3
});
const fukuokaOrigin: [number, number] = [33.5902, 130.4017];
const ogiWaterfall: [number, number] = [33.522222, 130.608056];
const famousGourmetIds = new Set([
  "gourmet-dazaifu-umegae-mochi",
  "gourmet-mojiko-yaki-curry",
  "gourmet-yanagawa-unagi",
  "gourmet-kurume-ramen",
  "gourmet-karatsu-burger",
  "gourmet-yobuko-squid",
  "gourmet-ide-chanpon",
  "gourmet-sasebo-burger",
  "gourmet-nagasaki-chanpon",
  "gourmet-aso-akaushi",
  "gourmet-yamaga-basashi",
  "gourmet-amakusa-seafood",
  "gourmet-hitoyoshi-unagi",
  "gourmet-hita-yakisoba",
  "gourmet-beppu-jigokumushi",
  "gourmet-miyazaki-chicken-nanban",
  "gourmet-nichinan-katsuo",
  "gourmet-kagoshima-shirokuma",
  "gourmet-kagoshima-kurobuta",
  "gourmet-ibusuki-ontamaran"
]);

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
    expect(response.mode).toBe("local");
    expect(response.plans[0].routeSource).toBe("fallback");
    expect(response.plans[0].source).toBe("local");
    expect(response.plans[0].preferenceFit.length).toBeGreaterThan(0);
    expect(response.plans[0].stops[0].whyStopHere).toContain("好み");
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
      routeOptions: { highwayMode: "full" }
    });
    expect(response.plans[0].estimatedDurationMin).toBeLessThanOrEqual(baseRequest.constraint.value * 1.2);
  });

  it("drops excess stops after routed duration is resolved", async () => {
    const response = await buildFallbackPlans({
      ...baseRequest,
      origin: { label: "Fukuoka", lat: 33.5902, lng: 130.4017, source: "preset" },
      constraint: { type: "duration", value: 120, unit: "min" },
      routeOptions: { highwayMode: "full" }
    });
    expect(response.plans[0].estimatedDurationMin).toBeLessThanOrEqual(144);
  });

  it("varies stop composition across multiple plans", async () => {
    const response = await buildFallbackPlans({
      ...baseRequest,
      origin: { label: "Fukuoka", lat: 33.5902, lng: 130.4017, source: "preset" },
      routeOptions: { highwayMode: "full" }
    });
    const signatures = new Set(response.plans.map((plan) => plan.stops.map((stop) => stop.spotId).join(">")));
    expect(signatures.size).toBeGreaterThan(1);
  });

  it("includes a famous-gourmet-led option when scenic, gourmet, and road preferences are tied", async () => {
    const response = await buildFallbackPlans({
      ...baseRequest,
      origin: { label: "Fukuoka", lat: fukuokaOrigin[0], lng: fukuokaOrigin[1], source: "preset" },
      preferences: { gourmet: "medium", scenic: "medium", road: "medium", relaxed: "low" }
    });

    const gourmetLed = response.plans.find((plan) => {
      const famous = plan.stops.find((stop) => famousGourmetIds.has(stop.spotId));
      return famous && plan.title.includes(famous.name);
    });
    expect(gourmetLed).toBeDefined();
    const mainCategories = response.plans.map((plan) => {
      const main = plan.stops.find((stop) => plan.title.includes(stop.name));
      return main?.category;
    });
    expect(new Set(mainCategories)).toEqual(new Set(["scenic", "gourmet", "road"]));
  });

  it("uses a famous Kyushu gourmet as the destination and adds nearby scenery when gourmet is high", async () => {
    const response = await buildFallbackPlans({
      ...baseRequest,
      origin: { label: "Fukuoka", lat: fukuokaOrigin[0], lng: fukuokaOrigin[1], source: "preset" },
      preferences: { gourmet: "high", scenic: "medium", road: "low", relaxed: "low" }
    });

    expect(response.plans.length).toBeGreaterThan(0);
    for (const plan of response.plans) {
      const famous = plan.stops.find((stop) => famousGourmetIds.has(stop.spotId));
      expect(famous).toBeDefined();
      expect(plan.title).toContain(famous?.name);
      expect(plan.stops.some((stop) => stop.category === "scenic")).toBe(true);
    }
  });

  it("uses a registered touring road as the destination with famous food and scenery when road is high", async () => {
    const response = await buildFallbackPlans({
      ...baseRequest,
      origin: { label: "Fukuoka", lat: fukuokaOrigin[0], lng: fukuokaOrigin[1], source: "preset" },
      preferences: { gourmet: "medium", scenic: "medium", road: "high", relaxed: "low" }
    });

    expect(response.plans.length).toBeGreaterThan(0);
    for (const plan of response.plans) {
      const mainRoad = plan.stops.find((stop) => stop.category === "road" && plan.title.includes(stop.name));
      expect(mainRoad).toBeDefined();
      expect(plan.stops.some((stop) => famousGourmetIds.has(stop.spotId))).toBe(true);
      expect(plan.stops.some((stop) => stop.category === "scenic")).toBe(true);
      expect(plan.appeal.startsWith("走りを軸に")).toBe(true);
    }
  });

  it.each([
    ["Miyazaki", 31.9111, 131.4239],
    ["Kagoshima", 31.5966, 130.5571]
  ])("returns a gourmet-led route with scenery from %s", async (label, lat, lng) => {
    const response = await buildFallbackPlans({
      ...baseRequest,
      origin: { label, lat, lng, source: "preset" },
      preferences: { gourmet: "high", scenic: "medium", road: "low", relaxed: "low" }
    });

    expect(response.plans.length).toBeGreaterThan(0);
    expect(
      response.plans.some(
        (plan) =>
          plan.stops.some((stop) => famousGourmetIds.has(stop.spotId)) &&
          plan.stops.some((stop) => stop.category === "scenic" || stop.category === "road")
      )
    ).toBe(true);
  });

  it.each([
    ["Miyazaki", 31.9111, 131.4239],
    ["Kagoshima", 31.5966, 130.5571]
  ])("keeps scenic, gourmet, and road as separate options from %s when preferences are tied", async (label, lat, lng) => {
    const response = await buildFallbackPlans({
      ...baseRequest,
      origin: { label, lat, lng, source: "preset" },
      preferences: { gourmet: "medium", scenic: "medium", road: "medium", relaxed: "low" }
    });
    const mainCategories = response.plans.map(
      (plan) => plan.stops.find((stop) => plan.title.includes(stop.name))?.category
    );
    expect(new Set(mainCategories)).toEqual(new Set(["scenic", "gourmet", "road"]));
  });

  it("rejects a gourmet-led route if budget trimming would remove its required scenic stop", async () => {
    const plan = await buildPlanFromSpotIds(
      {
        ...baseRequest,
        origin: { label: "Fukuoka", lat: fukuokaOrigin[0], lng: fukuokaOrigin[1], source: "preset" },
        constraint: { type: "duration", value: 45, unit: "min" },
        preferences: { gourmet: "high", scenic: "medium", road: "low", relaxed: "low" }
      },
      ["gourmet-dazaifu-umegae-mochi", "waterfall-q34683319"],
      {},
      "local",
      undefined,
      "gourmet"
    );

    expect(plan).toBeNull();
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
      routeOptions: { highwayMode: "full" }
    });

    expect(() => PlanResponseSchema.parse(response)).not.toThrow();
    expect(response.plans).toHaveLength(0);
    expect(response.plans.every((plan) => plan.estimatedDurationMin <= 144)).toBe(true);
  });

  it("rejects a chain cafe as the only destination for a longer day trip", async () => {
    const plan = await buildPlanFromSpotIds(
      {
        ...baseRequest,
        origin: { label: "Fukuoka", lat: 33.5902, lng: 130.4017, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        tripStyle: "day_trip"
      },
      ["cafe-q139985359"]
    );

    expect(plan).toBeNull();
  });

  it("rejects a nearby gourmet-only stop as the whole route for a longer day trip", async () => {
    const plan = await buildPlanFromSpotIds(
      {
        ...baseRequest,
        origin: { label: "Fukuoka", lat: 33.5902, lng: 130.4017, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" },
        tripStyle: "day_trip"
      },
      ["restaurant-q139765483"]
    );

    expect(plan).toBeNull();
  });

  it("rejects a nearby gourmet-only cluster for a longer day trip", async () => {
    const plan = await buildPlanFromSpotIds(
      {
        ...baseRequest,
        origin: { label: "Fukuoka", lat: 33.5902, lng: 130.4017, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" },
        tripStyle: "day_trip"
      },
      ["cafe-q136681960", "cafe-q139985359", "restaurant-q139765483"]
    );

    expect(plan).toBeNull();
  });

  it("keeps a practical scenic route for a longer day trip", async () => {
    const plan = await buildPlanFromSpotIds(
      {
        ...baseRequest,
        origin: { label: "Fukuoka", lat: 33.5902, lng: 130.4017, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" },
        tripStyle: "day_trip"
      },
      ["waterfall-q34683319"]
    );

    expect(plan).not.toBeNull();
    expect(plan?.stops.map((stop) => stop.spotId)).toEqual(["waterfall-q34683319"]);
    expect(plan?.estimatedDurationMin).toBeGreaterThan(60);
  });

  it("does not draw an invented return loop when road routing is unavailable", async () => {
    const origin: [number, number] = [33.5902, 130.4017];
    const plan = await buildPlanFromSpotIds(
      {
        ...baseRequest,
        origin: { label: "Fukuoka", lat: origin[0], lng: origin[1], source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" },
        tripStyle: "day_trip"
      },
      ["waterfall-q34683319"]
    );

    expect(plan).not.toBeNull();
    expect(plan?.routeLine).toHaveLength(3);
    expect(plan?.routeLine[0]).toEqual(origin);
    expect(plan?.routeLine[1]).toEqual([plan?.stops[0].lat, plan?.stops[0].lng]);
    expect(plan?.routeLine[2]).toEqual(origin);
    expect(plan?.cautions.some((caution) => caution.includes("重なる区間"))).toBe(true);
  });

  it("compares both return directions and chooses the shorter practical road loop", async () => {
    vi.stubEnv("OSRM_BASE_URL", "http://mock-osrm");
    let requestIndex = 0;
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requestIndex += 1;
        requestedUrls.push(String(input));
        if (requestIndex === 1) return osrmResponse(80, 80, routeCoordinates(fukuokaOrigin, ogiWaterfall));
        if (requestIndex === 2) {
          return osrmResponse(100, 100, routeCoordinates(fukuokaOrigin, ogiWaterfall, [33.42, 130.62]));
        }
        return osrmResponse(90, 90, routeCoordinates(fukuokaOrigin, ogiWaterfall, [33.48, 130.34]));
      })
    );

    const plan = await buildPlanFromSpotIds(
      {
        ...baseRequest,
        origin: { label: "Fukuoka", lat: 33.5902, lng: 130.4017, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" }
      },
      ["waterfall-q34683319"]
    );

    expect(plan?.routeSource).toBe("osrm");
    expect(plan?.estimatedDurationMin).toBe(90);
    expect(plan?.routeLine).toHaveLength(4);
    expect(plan?.cautions.some((caution) => caution.includes("周回ルート"))).toBe(true);
    expect(requestedUrls).toHaveLength(3);
    expect(requestedUrls[1]).not.toBe(requestedUrls[2]);
  });

  it("rejects alternate return routes that detour more than thirty percent", async () => {
    vi.stubEnv("OSRM_BASE_URL", "http://mock-osrm");
    let requestIndex = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        requestIndex += 1;
        if (requestIndex === 1) return osrmResponse(80, 80, routeCoordinates(fukuokaOrigin, ogiWaterfall));
        return osrmResponse(
          110 + requestIndex,
          110 + requestIndex,
          routeCoordinates(fukuokaOrigin, ogiWaterfall, [33.42, 130.62])
        );
      })
    );

    const plan = await buildPlanFromSpotIds(
      {
        ...baseRequest,
        origin: { label: "Fukuoka", lat: 33.5902, lng: 130.4017, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" }
      },
      ["waterfall-q34683319"]
    );

    expect(plan?.estimatedDurationMin).toBe(80);
    expect(plan?.routeLine).toHaveLength(3);
    expect(plan?.cautions.some((caution) => caution.includes("重なる区間"))).toBe(true);
  });

  it("rejects a nominal loop when its routed return mostly overlaps the outbound road", async () => {
    vi.stubEnv("OSRM_BASE_URL", "http://mock-osrm");
    const denseGeometry = denseOutAndBackCoordinates(fukuokaOrigin, ogiWaterfall);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        osrmResponse(80, 80, denseGeometry, 0, routeCoordinates(fukuokaOrigin, ogiWaterfall))
      )
    );

    const plan = await buildPlanFromSpotIds(
      {
        ...baseRequest,
        origin: { label: "Fukuoka", lat: fukuokaOrigin[0], lng: fukuokaOrigin[1], source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" }
      },
      ["waterfall-q34683319"]
    );

    expect(plan?.routeLine).toHaveLength(denseGeometry.length);
    expect(plan?.cautions.some((caution) => caution.includes("重なる区間"))).toBe(true);
    expect(plan?.cautions.some((caution) => caution.includes("周回ルート"))).toBe(false);
  });

  it("rejects a loop whose waypoint is snapped more than two kilometers", async () => {
    vi.stubEnv("OSRM_BASE_URL", "http://mock-osrm");
    let requestIndex = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        requestIndex += 1;
        if (requestIndex === 1) return osrmResponse(80, 80, routeCoordinates(fukuokaOrigin, ogiWaterfall));
        return osrmResponse(
          90,
          90,
          routeCoordinates(fukuokaOrigin, ogiWaterfall, [33.42, 130.62]),
          2001
        );
      })
    );

    const plan = await buildPlanFromSpotIds(
      {
        ...baseRequest,
        origin: { label: "Fukuoka", lat: fukuokaOrigin[0], lng: fukuokaOrigin[1], source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" }
      },
      ["waterfall-q34683319"]
    );

    expect(plan?.estimatedDurationMin).toBe(80);
    expect(plan?.cautions.some((caution) => caution.includes("重なる区間"))).toBe(true);
  });

  it("removes out-of-corridor stops from Codex-style mixed-direction selections", async () => {
    const plan = await buildPlanFromSpotIds(
      {
        ...baseRequest,
        origin: { label: "Fukuoka", lat: 33.5902, lng: 130.4017, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" }
      },
      ["restaurant-q131863980", "waterfall-q11560719", "roadside_station-q11640652", "waterfall-q114575274"]
    );

    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.stops.map((stop) => stop.spotId)).not.toContain("roadside_station-q11640652");
    expect(maxBearingSpreadFromOrigin([33.5902, 130.4017], plan)).toBeLessThanOrEqual(35);
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
      routeOptions: { highwayMode: "full" }
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

function routeCoordinates(
  origin: [number, number],
  destination: [number, number],
  returnWaypoint?: [number, number]
): Array<[number, number]> {
  return [origin, destination, ...(returnWaypoint ? [returnWaypoint] : []), origin].map(
    ([lat, lng]) => [lng, lat] as [number, number]
  );
}

function denseOutAndBackCoordinates(
  origin: [number, number],
  destination: [number, number]
): Array<[number, number]> {
  const outbound = Array.from({ length: 101 }, (_, index) => {
    const progress = index / 100;
    return [
      origin[1] + (destination[1] - origin[1]) * progress,
      origin[0] + (destination[0] - origin[0]) * progress
    ] as [number, number];
  });
  return [...outbound, [origin[1], origin[0]]];
}

function osrmResponse(
  distanceKm: number,
  durationMin: number,
  coordinates: Array<[number, number]>,
  waypointDistanceM = 0,
  waypointLocations = coordinates
): Response {
  return new Response(
    JSON.stringify({
      code: "Ok",
      waypoints: waypointLocations.map((location) => ({ distance: waypointDistanceM, location })),
      routes: [
        {
          distance: distanceKm * 1000,
          duration: durationMin * 60,
          geometry: { type: "LineString", coordinates }
        }
      ]
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
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
