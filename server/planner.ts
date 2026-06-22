import rawSpots from "../data/kyushu-spots.json";
import { circlePolygon, destinationPoint, haversineKm, type LatLngTuple } from "../src/lib/geo";
import {
  type HighwayMode,
  type Plan,
  type PlanRequest,
  type PlanResponse,
  type PreferenceLevel,
  type Spot,
  SpotSchema
} from "../src/shared/types";
import { approximateRoute, resolveRoute, speedForMode, type RouteResult } from "./routing";

const spots = rawSpots.map((spot) => SpotSchema.parse(spot));

const highwayLabels: Record<HighwayMode, string> = {
  none: "高速道路なし",
  full: "高速道路あり"
};

const categoryWeightKey: Record<Spot["category"], keyof PlanRequest["preferences"]> = {
  gourmet: "gourmet",
  scenic: "scenic",
  road: "road",
  rest: "relaxed"
};

const preferenceScores: Record<PreferenceLevel, number> = {
  low: 1,
  medium: 3,
  high: 5
};

const preferenceLabels: Record<keyof PlanRequest["preferences"], string> = {
  gourmet: "グルメ",
  scenic: "景色",
  road: "走り",
  relaxed: "ゆったり"
};

const rideFriendlyTags = new Set(["mountain", "volcano", "viewpoint", "waterfall", "beach", "island", "plateau"]);
const ROUTE_CORRIDOR_MAX_BEARING_DEG = 35;
const ROUTE_CORRIDOR_MAX_DETOUR_RATIO = 1.35;
const RETURN_LOOP_MAX_DETOUR_RATIO = 1.3;
const RETURN_LOOP_MAX_WAYPOINT_SNAP_M = 2000;
const RETURN_LOOP_MAX_OVERLAP_RATIO = 0.5;
const RETURN_LOOP_OVERLAP_TOLERANCE_KM = 0.25;
export type PlanFocus = "scenic" | "gourmet" | "road";
const weakDestinationNamePatterns = [
  /スターバックス/i,
  /starbucks/i,
  /マクドナルド/i,
  /mcdonald/i,
  /コンビニ/i,
  /ローソン/i,
  /セブン-?イレブン/i,
  /ファミリーマート/i
];
const weakDestinationTags = new Set(["fast_food", "convenience"]);

export function getSpots(): Spot[] {
  return spots;
}

export function preferenceValue(level: PreferenceLevel): number {
  return preferenceScores[level];
}

export function radiusFromConstraint(request: PlanRequest): number {
  return budgetDistanceKm(request) / 2.4;
}

export function budgetDistanceKm(request: PlanRequest): number {
  const tripStyleBuffer = request.tripStyle === "half_day" ? 0.72 : 1;
  if (request.constraint.type === "distance") return request.constraint.value * tripStyleBuffer;
  const averageSpeed = speedForMode(request.routeOptions.highwayMode);
  const relaxedBuffer = request.preferences.relaxed === "high" ? 0.82 : 0.9;
  return averageSpeed * (request.constraint.value / 60) * relaxedBuffer * tripStyleBuffer;
}

export function scoreSpot(spot: Spot, request: PlanRequest): number {
  const origin: LatLngTuple = [request.origin.lat, request.origin.lng];
  const distance = haversineKm(origin, [spot.lat, spot.lng]);
  const radius = radiusFromConstraint(request);
  const preference = preferenceValue(request.preferences[categoryWeightKey[spot.category]]);
  const distanceFit = Math.max(0, 1 - Math.abs(distance - radius * 0.65) / Math.max(radius, 1));
  const highwayBoost =
    request.routeOptions.highwayMode === "none" && distance > 95
      ? -1.8
      : request.routeOptions.highwayMode !== "none" && distance > 70
        ? 0.6
        : 0;
  const roadLikeBoost =
    spot.category === "road"
      ? preferenceValue(request.preferences.road) * 0.8
      : spot.category === "scenic" && spot.tags.some((tag) => rideFriendlyTags.has(tag))
        ? preferenceValue(request.preferences.road) * 0.38
        : 0;
  const relaxedBoost = spot.category === "rest" ? preferenceValue(request.preferences.relaxed) * 0.32 : 0;
  const famousGourmetBoost = spot.category === "gourmet" && spot.tags.includes("famous") ? 4 : 0;
  const weakDestinationPenalty = isWeakDestinationSpot(spot) ? -4.5 : 0;
  return (
    preference * 1.5 +
    distanceFit * 3 +
    highwayBoost +
    roadLikeBoost +
    relaxedBoost +
    famousGourmetBoost +
    weakDestinationPenalty
  );
}

export function filterCandidates(request: PlanRequest): Spot[] {
  const origin: LatLngTuple = [request.origin.lat, request.origin.lng];
  const radius = radiusFromConstraint(request);
  const maxCandidateRadius = radius * (request.routeOptions.highwayMode === "none" ? 1.18 : 1.45);

  return spots
    .map((spot) => ({
      spot,
      distance: haversineKm(origin, [spot.lat, spot.lng]),
      score: scoreSpot(spot, request)
    }))
    .filter(({ distance }) => distance <= maxCandidateRadius)
    .sort((a, b) => b.score - a.score || a.distance - b.distance)
    .slice(0, 42)
    .map(({ spot }) => spot);
}

export async function buildLocalPlans(request: PlanRequest, count = request.count): Promise<PlanResponse> {
  const origin: LatLngTuple = [request.origin.lat, request.origin.lng];
  const radiusKm = radiusFromConstraint(request);
  const candidates = filterCandidates(request);
  const plans: Plan[] = [];

  for (let slot = 0; slot < count; slot += 1) {
    const focus = focusForPlan(request, slot);
    for (let attempt = 0; attempt < candidates.length; attempt += 1) {
      const plan = await buildPlan(request, candidates, attempt, focus);
      if (plan && !sameStopSignature(plans, plan)) {
        plans.push(plan);
        break;
      }
    }
  }

  return buildPlanResponse(request, candidates, plans, "local");
}

export const buildFallbackPlans = buildLocalPlans;

export function buildPlanResponse(
  request: PlanRequest,
  candidates: Spot[],
  plans: Plan[],
  mode: PlanResponse["mode"],
  extra: Pick<PlanResponse, "fallbackReason" | "providerStatus"> = {}
): PlanResponse {
  const origin: LatLngTuple = [request.origin.lat, request.origin.lng];
  const radiusKm = radiusFromConstraint(request);
  return {
    plans,
    reachableArea: {
      type: "approx_circle",
      center: origin,
      radiusKm: Number(radiusKm.toFixed(1)),
      coordinates: circlePolygon(origin, radiusKm)
    },
    candidates,
    mode,
    ...extra
  };
}

export async function buildPlanFromSpotIds(
  request: PlanRequest,
  spotIds: string[],
  copy: PlanCopy = {},
  source: Plan["source"] = "local",
  allowedSpotIds?: Set<string>,
  preferredFocus?: PlanFocus
): Promise<Plan | null> {
  const uniqueIds = Array.from(new Set(spotIds)).slice(0, 5);
  if (uniqueIds.length !== spotIds.length) return null;
  if (allowedSpotIds && uniqueIds.some((id) => !allowedSpotIds.has(id))) return null;
  const selected = uniqueIds
    .map((id) => spots.find((spot) => spot.id === id))
    .filter((spot): spot is Spot => Boolean(spot));
  if (selected.length !== uniqueIds.length) return null;
  const preferredAnchor = preferredFocus ? selected.find((spot) => isFocusSpot(spot, preferredFocus)) : undefined;
  if (preferredFocus && (!preferredAnchor || !hasRequiredSupport(selected, preferredFocus))) return null;
  return planFromStops(request, selected, copy, source, preferredAnchor?.id, preferredFocus);
}

type PlanCopy = {
  title?: string;
  summary?: string;
  appeal?: string;
  bestFor?: string[];
  routeStory?: string;
  preferenceFit?: string[];
  highlights?: string[];
  cautions?: string[];
};

async function buildPlan(
  request: PlanRequest,
  candidates: Spot[],
  planIndex: number,
  focus: PlanFocus
): Promise<Plan | null> {
  const origin: LatLngTuple = [request.origin.lat, request.origin.lng];
  const ranked = rotate(
    candidates.filter((spot) => !isWeakDestinationSpot(spot) && isFocusSpot(spot, focus)),
    planIndex
  );
  const anchor = ranked[0];
  if (!anchor) return null;

  const targetStops = focus === "road" ? 3 : request.tripStyle === "half_day" ? 2 : planIndex % 2 === 0 ? 2 : 3;
  return buildPlanAroundAnchor(request, candidates, anchor.id, focus, {}, "local", targetStops);
}

export async function buildPlanAroundAnchor(
  request: PlanRequest,
  candidates: Spot[],
  anchorId: string,
  focus: PlanFocus,
  copy: PlanCopy = {},
  source: Plan["source"] = "codex",
  targetStops = focus === "road" ? 3 : request.tripStyle === "half_day" ? 2 : 3
): Promise<Plan | null> {
  const origin: LatLngTuple = [request.origin.lat, request.origin.lng];
  const anchor = candidates.find((spot) => spot.id === anchorId);
  if (!anchor || isWeakDestinationSpot(anchor) || !isFocusSpot(anchor, focus)) return null;
  const sameDirection = candidates.filter((spot) => isRouteCorridorSpot(origin, anchor, spot));
  const selected = orderStopsForOutAndBack(
    origin,
    pickStopsForFocus(origin, anchor, sameDirection, request, targetStops, focus)
  );
  if (!hasRequiredSupport(selected, focus)) return null;
  return planFromStops(request, selected, copy, source, anchor.id, focus);
}

async function planFromStops(
  request: PlanRequest,
  selected: Spot[],
  copy: PlanCopy = {},
  source: Plan["source"] = "local",
  preferredAnchorId?: string,
  focus?: PlanFocus
): Promise<Plan | null> {
  if (selected.length === 0) return null;
  const origin: LatLngTuple = [request.origin.lat, request.origin.lng];
  const mainDestination =
    selected.find((spot) => spot.id === preferredAnchorId && !isWeakDestinationSpot(spot)) ??
    chooseMainDestination(origin, selected, request);
  if (!mainDestination) return null;
  let stops = normalizeRouteStops(origin, selected, request, mainDestination.id);
  const budget = request.constraint.type === "distance" ? budgetDistanceKm(request) : request.constraint.value;

  while (stops.length > 0) {
    if (focus && !hasRequiredSupport(stops, focus)) return null;
    const resolvedRoute = await resolvePlanRoute(origin, stops, request, budget);
    const route = resolvedRoute.route;
    const value = request.constraint.type === "distance" ? route.distanceKm : route.durationMin;
    if (value <= budget && isDetourAcceptable(origin, stops, request)) {
      if (isWeakRoutePlan(request, stops, value, budget)) return null;
      return {
        title: titleForPlan(request, stops, mainDestination),
        summary: summaryForPlan(request, stops),
        appeal: appealForPlan(request, stops, mainDestination, focus),
        bestFor: bestForPlan(request, stops, mainDestination),
        routeStory: routeStoryForPlan(request, stops),
        preferenceFit: preferenceFitForPlan(request, stops),
        stops: stops.map((spot, index) => ({
          spotId: spot.id,
          name: spot.name,
          category: spot.category,
          lat: spot.lat,
          lng: spot.lng,
          area: spot.area,
          description: spot.description,
          images: spot.images,
          legNote: `${index + 1}番目の立ち寄り: ${spot.tags.slice(0, 2).join(" / ") || "休憩ポイント"}`,
          whyStopHere: whyStopHere(spot, request),
          famousFor: famousFor(spot),
          riderNote: riderNote(spot),
          recommendedAction: recommendedAction(spot),
          timeHint: timeHint(spot),
          matchedPreferences: matchedPreferences(spot, request)
        })),
        estimatedDistanceKm: Math.round(route.distanceKm),
        estimatedDurationMin: Math.round(route.durationMin),
        highwayUsage: highwayLabels[request.routeOptions.highwayMode],
        routeSource: route.source,
        routeLine: route.line,
        highlights: highlightsFor(stops),
        cautions: [
          ...(copy.cautions ?? []),
          resolvedRoute.usedAlternateReturn
            ? "帰路は往路と重なりにくい周回ルートを選んでいます。"
            : "帰路の別ルートが成立しなかったため、往路と重なる区間があります。",
          route.source === "osrm"
            ? "道路形状はOSM/OSRM由来です。規制、営業時間、二輪通行可否は出発前に確認してください。"
            : "ルート線は外部ルート取得失敗時の簡易目安です。実際の道路形状や規制は出発前に確認してください。",
          "スポット情報は収集済みデータ由来です。最新の営業状況や駐車場は未検証です。"
        ],
        source
      };
    }
    const removable = [...stops]
      .reverse()
      .find(
        (spot) =>
          spot.id !== mainDestination.id &&
          (!focus || hasRequiredSupport(stops.filter((candidate) => candidate.id !== spot.id), focus))
      );
    if (!removable) break;
    stops = normalizeRouteStops(
      origin,
      stops.filter((spot) => spot.id !== removable.id),
      request,
      mainDestination.id
    );
  }

  return null;
}

async function resolvePlanRoute(
  origin: LatLngTuple,
  stops: Spot[],
  request: PlanRequest,
  budget: number
): Promise<{ route: RouteResult; usedAlternateReturn: boolean }> {
  const stopPoints = stops.map((spot) => [spot.lat, spot.lng] as LatLngTuple);
  const baseline = await resolveRoute([origin, ...stopPoints, origin], request.routeOptions.highwayMode);
  if (baseline.source !== "osrm") {
    return { route: baseline, usedAlternateReturn: false };
  }

  const loopCandidates = loopRoutePoints(origin, stopPoints);
  const routedCandidates = await Promise.all(
    loopCandidates.map((routePoints) => resolveRoute(routePoints, request.routeOptions.highwayMode))
  );
  const validCandidates = routedCandidates
    .filter((route) => route.source === "osrm")
    .filter(
      (route) =>
        route.maxWaypointSnapDistanceM !== undefined &&
        route.maxWaypointSnapDistanceM <= RETURN_LOOP_MAX_WAYPOINT_SNAP_M
    )
    .filter((route) => routeValue(route, request) <= budget)
    .filter((route) => route.distanceKm <= baseline.distanceKm * RETURN_LOOP_MAX_DETOUR_RATIO)
    .filter((route) => route.durationMin <= baseline.durationMin * RETURN_LOOP_MAX_DETOUR_RATIO)
    .filter(
      (route) =>
        route.waypointLineIndices !== undefined &&
        returnRouteOverlapRatio(route.line, route.waypointLineIndices[stopPoints.length]) <=
          RETURN_LOOP_MAX_OVERLAP_RATIO
    )
    .sort((a, b) => routeValue(a, request) - routeValue(b, request));

  return validCandidates[0]
    ? { route: validCandidates[0], usedAlternateReturn: true }
    : { route: baseline, usedAlternateReturn: false };
}

function routeValue(route: RouteResult, request: PlanRequest): number {
  return request.constraint.type === "distance" ? route.distanceKm : route.durationMin;
}

function returnRouteOverlapRatio(line: LatLngTuple[], destinationIndex: number): number {
  if (line.length < 3) return 1;
  if (destinationIndex <= 0 || destinationIndex >= line.length - 1) return 1;

  const outbound = sampleRouteLine(line.slice(0, destinationIndex + 1));
  const inbound = sampleRouteLine(line.slice(destinationIndex));
  if (outbound.length === 0 || inbound.length === 0) return 1;

  const outboundGrid = buildRouteGrid(outbound, RETURN_LOOP_OVERLAP_TOLERANCE_KM);
  const overlapping = inbound.filter((point) =>
    hasNearbyRoutePoint(outboundGrid, point, RETURN_LOOP_OVERLAP_TOLERANCE_KM)
  ).length;
  return overlapping / inbound.length;
}

function sampleRouteLine(line: LatLngTuple[], intervalKm = 0.5): LatLngTuple[] {
  if (line.length === 0) return [];
  const samples: LatLngTuple[] = [line[0]];
  let distanceUntilNextSample = intervalKm;
  for (let index = 1; index < line.length; index += 1) {
    let from = line[index - 1];
    const to = line[index];
    let segmentDistance = haversineKm(from, to);
    while (segmentDistance >= distanceUntilNextSample && segmentDistance > 0) {
      const progress = distanceUntilNextSample / segmentDistance;
      const sample: LatLngTuple = [
        from[0] + (to[0] - from[0]) * progress,
        from[1] + (to[1] - from[1]) * progress
      ];
      samples.push(sample);
      from = sample;
      segmentDistance = haversineKm(from, to);
      distanceUntilNextSample = intervalKm;
    }
    distanceUntilNextSample -= segmentDistance;
  }
  if (haversineKm(samples[samples.length - 1], line[line.length - 1]) > intervalKm * 0.25) {
    samples.push(line[line.length - 1]);
  }
  return samples;
}

type RouteGrid = Map<string, LatLngTuple[]>;

function buildRouteGrid(points: LatLngTuple[], cellSizeKm: number): RouteGrid {
  const grid: RouteGrid = new Map();
  points.forEach((point) => {
    const key = routeGridKey(point, cellSizeKm);
    const bucket = grid.get(key) ?? [];
    bucket.push(point);
    grid.set(key, bucket);
  });
  return grid;
}

function hasNearbyRoutePoint(grid: RouteGrid, point: LatLngTuple, cellSizeKm: number): boolean {
  const [cellX, cellY] = routeGridCell(point, cellSizeKm);
  for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
    for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
      const bucket = grid.get(`${cellX + xOffset}:${cellY + yOffset}`) ?? [];
      if (bucket.some((candidate) => haversineKm(point, candidate) <= cellSizeKm)) return true;
    }
  }
  return false;
}

function routeGridKey(point: LatLngTuple, cellSizeKm: number): string {
  return routeGridCell(point, cellSizeKm).join(":");
}

function routeGridCell([lat, lng]: LatLngTuple, cellSizeKm: number): [number, number] {
  const longitudeCellDegrees = cellSizeKm / 80;
  const latitudeCellDegrees = cellSizeKm / 110.57;
  return [Math.floor(lng / longitudeCellDegrees), Math.floor(lat / latitudeCellDegrees)];
}

function loopRoutePoints(origin: LatLngTuple, stopPoints: LatLngTuple[]): LatLngTuple[][] {
  if (stopPoints.length === 0) return [];
  const farthest = [...stopPoints].sort((a, b) => haversineKm(origin, b) - haversineKm(origin, a))[0];
  const distanceToFarthest = haversineKm(origin, farthest);
  if (distanceToFarthest < 12) return [];

  const midpoint: LatLngTuple = [(origin[0] + farthest[0]) / 2, (origin[1] + farthest[1]) / 2];
  const outboundBearing = bearingDeg(origin, farthest);
  const offsetKm = Math.min(28, Math.max(8, distanceToFarthest * 0.28));
  return [90, -90].map((side) => [origin, ...stopPoints, destinationPoint(midpoint, outboundBearing + side, offsetKm), origin]);
}

function normalizeRouteStops(
  origin: LatLngTuple,
  selected: Spot[],
  request: PlanRequest,
  preferredAnchorId?: string
): Spot[] {
  const anchor =
    selected.find((spot) => spot.id === preferredAnchorId && !isWeakDestinationSpot(spot)) ??
    chooseMainDestination(origin, selected, request);
  if (!anchor) return [];
  const normalized = selected.filter((spot) => spot.id === anchor.id || isRouteCorridorSpot(origin, anchor, spot));
  return orderStopsForOutAndBack(origin, normalized);
}

function chooseMainDestination(origin: LatLngTuple, selected: Spot[], request: PlanRequest): Spot | null {
  const scored = selected
    .filter((spot) => !isWeakDestinationSpot(spot))
    .map((spot) => ({
      spot,
      score:
        scoreSpot(spot, request) +
        destinationCategoryPriority(spot, request) +
        Math.min(2, haversineKm(origin, [spot.lat, spot.lng]) / 40)
    }))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.spot ?? selected[0] ?? null;
}

function destinationCategoryPriority(spot: Spot, request: PlanRequest): number {
  if (isFocusSpot(spot, focusForPlan(request, 0))) return 5;
  if (spot.category === "road") return 3;
  if (spot.category === "scenic") return 2.4;
  if (spot.category === "gourmet") return 1;
  return 0.4;
}

function isWeakDestinationSpot(spot: Spot): boolean {
  return (
    weakDestinationNamePatterns.some((pattern) => pattern.test(spot.name)) ||
    spot.tags.some((tag) => weakDestinationTags.has(tag.toLowerCase()))
  );
}

function isWeakRoutePlan(request: PlanRequest, stops: Spot[], routeValue: number, budget: number): boolean {
  const durationBudget = request.constraint.type === "duration" ? request.constraint.value : 0;
  const distanceBudget = request.constraint.type === "distance" ? request.constraint.value : 0;
  const hasLongEnoughBudget = request.tripStyle === "day_trip" || durationBudget >= 150 || distanceBudget >= 80;
  if (!hasLongEnoughBudget) return false;
  if (stops.length === 1 && isWeakDestinationSpot(stops[0])) return true;
  const hasRideDestination = stops.some((spot) => spot.category === "scenic" || spot.category === "road");
  return !hasRideDestination && routeValue < budget * 0.45;
}

function pickStopsForFocus(
  origin: LatLngTuple,
  anchor: Spot,
  candidates: Spot[],
  request: PlanRequest,
  targetStops: number,
  focus: PlanFocus
): Spot[] {
  const selected = [anchor];
  const preferredCategories = supportCategoriesForFocus(focus);
  const byScore = [...candidates].sort((a, b) => scoreSpot(b, request) - scoreSpot(a, request));

  for (const category of preferredCategories) {
    if (selected.length >= targetStops) break;
    const next = byScore.find(
      (spot) =>
        spot.category === category &&
        (category !== "gourmet" || spot.tags.includes("famous")) &&
        !selected.some((picked) => picked.id === spot.id) &&
        isRouteCorridorSpot(origin, anchor, spot)
    );
    if (next && approximateWithinBudget(origin, [...selected, next], request)) selected.push(next);
  }

  for (const candidate of byScore) {
    if (selected.length >= targetStops) break;
    if (selected.some((spot) => spot.id === candidate.id)) continue;
    if (!isRouteCorridorSpot(origin, anchor, candidate)) continue;
    if (approximateWithinBudget(origin, [...selected, candidate], request)) selected.push(candidate);
  }

  return selected;
}

export function focusForPlan(request: PlanRequest, planIndex: number): PlanFocus {
  const scores: Record<PlanFocus, number> = {
    scenic: preferenceValue(request.preferences.scenic),
    gourmet: preferenceValue(request.preferences.gourmet),
    road: preferenceValue(request.preferences.road)
  };
  const highest = Math.max(...Object.values(scores));
  const tied = (["scenic", "gourmet", "road"] as PlanFocus[]).filter((focus) => scores[focus] === highest);
  return tied[planIndex % tied.length];
}

function isFocusSpot(spot: Spot, focus: PlanFocus): boolean {
  if (focus === "road") return spot.category === "road";
  if (focus === "gourmet") return spot.category === "gourmet" && spot.tags.includes("famous");
  return spot.category === focus;
}

function supportCategoriesForFocus(focus: PlanFocus): Spot["category"][] {
  if (focus === "gourmet") return ["scenic", "scenic"];
  return ["gourmet", "scenic"];
}

function hasRequiredSupport(selected: Spot[], focus: PlanFocus): boolean {
  if (focus === "gourmet") return selected.some((spot) => spot.category === "scenic");
  const hasFamousGourmet = selected.some((spot) => spot.category === "gourmet" && spot.tags.includes("famous"));
  if (focus === "road") {
    return hasFamousGourmet && selected.some((spot) => spot.category === "scenic");
  }
  return hasFamousGourmet;
}

function isRouteCorridorSpot(origin: LatLngTuple, anchor: Spot, candidate: Spot): boolean {
  if (candidate.id === anchor.id) return true;
  const anchorPoint: LatLngTuple = [anchor.lat, anchor.lng];
  const candidatePoint: LatLngTuple = [candidate.lat, candidate.lng];
  const anchorDistance = haversineKm(origin, anchorPoint);
  const candidateDistance = haversineKm(origin, candidatePoint);
  const bearingSpread = angularDistanceDeg(bearingDeg(origin, anchorPoint), bearingDeg(origin, candidatePoint));
  if (bearingSpread > ROUTE_CORRIDOR_MAX_BEARING_DEG) return false;
  const loopDistance = anchorDistance + haversineKm(anchorPoint, candidatePoint) + candidateDistance;
  const directRoundTrip = Math.max(anchorDistance, candidateDistance, 1) * 2;
  return loopDistance / directRoundTrip <= ROUTE_CORRIDOR_MAX_DETOUR_RATIO;
}

function approximateWithinBudget(origin: LatLngTuple, selected: Spot[], request: PlanRequest): boolean {
  const route = approximateRoute(
    [origin, ...selected.map((spot) => [spot.lat, spot.lng] as LatLngTuple), origin],
    request.routeOptions.highwayMode
  );
  const budget = request.constraint.type === "distance" ? budgetDistanceKm(request) * 1.12 : request.constraint.value * 1.15;
  const value = request.constraint.type === "distance" ? route.distanceKm : route.durationMin;
  return value <= budget && isDetourAcceptable(origin, selected, request);
}

function isDetourAcceptable(origin: LatLngTuple, selected: Spot[], request: PlanRequest): boolean {
  if (selected.length <= 1) return true;
  const farthest = [...selected].sort(
    (a, b) => haversineKm(origin, [b.lat, b.lng]) - haversineKm(origin, [a.lat, a.lng])
  )[0];
  const directRoute = approximateRoute([origin, [farthest.lat, farthest.lng], origin], request.routeOptions.highwayMode);
  const selectedRoute = approximateRoute(
    [origin, ...orderStopsForOutAndBack(origin, selected).map((spot) => [spot.lat, spot.lng] as LatLngTuple), origin],
    request.routeOptions.highwayMode
  );
  return selectedRoute.distanceKm / Math.max(directRoute.distanceKm, 1) <= ROUTE_CORRIDOR_MAX_DETOUR_RATIO;
}

export function orderStopsForOutAndBack(origin: LatLngTuple, selected: Spot[]): Spot[] {
  return [...selected].sort(
    (a, b) => haversineKm(origin, [a.lat, a.lng]) - haversineKm(origin, [b.lat, b.lng])
  );
}

function sameStopSignature(plans: Plan[], plan: Plan): boolean {
  const signature = plan.stops.map((stop) => stop.spotId).join(">");
  return plans.some((existing) => existing.stops.map((stop) => stop.spotId).join(">") === signature);
}

function titleForPlan(_request: PlanRequest, stops: Spot[], mainDestination?: Spot): string {
  const lead = mainDestination ?? stops[0];
  const area = lead?.area ?? "九州";
  const main = lead?.name ?? "立ち寄り";
  return `${area} ${main}方面プラン`;
}

function summaryForPlan(request: PlanRequest, stops: Spot[]): string {
  const categories = new Set(stops.map((spot) => spot.category));
  const taste = [
    categories.has("road") ? "走りやすい道" : undefined,
    categories.has("scenic") ? "景勝地" : undefined,
    categories.has("gourmet") ? "グルメ" : undefined,
    categories.has("rest") ? "休憩地" : undefined
  ]
    .filter(Boolean)
    .join("、");
  const relaxed = request.preferences.relaxed === "high" ? "余白を残して" : "日帰りで";
  return `${request.origin.label}から同じ方面に寄せて、${taste || "立ち寄り先"}を${relaxed}回る提案です。`;
}

function appealForPlan(request: PlanRequest, stops: Spot[], mainDestination?: Spot, focus?: PlanFocus): string {
  const lead = mainDestination ?? stops[0];
  const topPreference = focus ? focusLabel(focus) : topPreferenceLabel(request);
  return `${topPreference}を軸に、${lead.name}周辺の見どころと走りやすさをまとめたルートです。`;
}

function focusLabel(focus: PlanFocus): string {
  if (focus === "gourmet") return "グルメ";
  if (focus === "road") return "走り";
  return "景色";
}

function bestForPlan(request: PlanRequest, stops: Spot[], mainDestination?: Spot): string[] {
  const best = preferenceFitForPlan(request, stops).slice(0, 2);
  const lead = mainDestination ?? stops[0];
  const category = lead?.category ? categoryLabel(lead.category) : "日帰り";
  return [...best, `${category}を目的にした短めの立ち寄り`].slice(0, 3);
}

function routeStoryForPlan(request: PlanRequest, stops: Spot[]): string {
  const names = stops.map((spot) => spot.name).join("、");
  return `${request.origin.label}を出て${names}へ同じ方向に伸ばし、帰路で大きく戻りすぎない日帰りの流れにしています。`;
}

function preferenceFitForPlan(request: PlanRequest, stops: Spot[]): string[] {
  const fits: string[] = [];
  for (const key of highPreferenceKeys(request)) {
    const label = preferenceLabels[key];
    const matched = stops.filter((spot) => matchedPreferences(spot, request).includes(key));
    if (matched.length) fits.push(`${label}重視: ${matched.map((spot) => spot.name).slice(0, 2).join("、")}が条件に合います`);
  }
  if (fits.length === 0) fits.push("バランス型: 条件内で走り、景色、休憩の偏りを抑えています");
  return fits.slice(0, 3);
}

function highlightsFor(stops: Spot[]): string[] {
  return stops.slice(0, 3).map((spot) => `${spot.name}: ${famousFor(spot)}`);
}

function whyStopHere(spot: Spot, request: PlanRequest): string {
  const matches = matchedPreferences(spot, request).map((key) => preferenceLabels[key]);
  const prefix = matches.length ? `${matches.join("・")}の好みに合うため` : "ルート上で寄りやすいため";
  return `${prefix}、${spot.area}で${categoryLabel(spot.category)}を足せる立ち寄りです。`;
}

function famousFor(spot: Spot): string {
  const tag = spot.tags[0];
  if (spot.category === "gourmet") return `${spot.description} 名物や地元感のある食事目的に向いています。`;
  if (spot.category === "road") return `${spot.description} 走りの目的地として選びやすいポイントです。`;
  if (spot.category === "scenic") return `${spot.description} ${tag ? `${tag}系の眺め` : "景色"}を楽しめます。`;
  return `${spot.description} 休憩や時間調整に使いやすい場所です。`;
}

function riderNote(spot: Spot): string {
  if (spot.category === "road") return "道そのものを楽しむ区間として、交通量と路面状況を見ながら無理なく流すのがおすすめです。";
  if (spot.category === "scenic") return "写真休憩を入れやすいので、到着前後の駐車場所を確認しておくと安心です。";
  if (spot.category === "gourmet") return "食事時間に寄せると満足度が上がります。混雑時は待ち時間を見込んでください。";
  return "長めに休む場所として使うと、帰りの集中力を残しやすいです。";
}

function recommendedAction(spot: Spot): string {
  if (spot.category === "gourmet") return "看板メニューを一つ決めて、食後は近くで短く休憩する";
  if (spot.category === "scenic") return "写真を撮って、眺めの良い時間帯に少し滞在する";
  if (spot.category === "road") return "速度よりもリズム重視で、気持ちよく走れる区間を味わう";
  return "水分補給と装備の調整をして、次の区間に備える";
}

function timeHint(spot: Spot): string {
  if (spot.category === "gourmet") return "45〜70分";
  if (spot.category === "scenic") return "20〜40分";
  if (spot.category === "road") return "通過中心";
  return "15〜30分";
}

function matchedPreferences(spot: Spot, request: PlanRequest): Array<keyof PlanRequest["preferences"]> {
  const matches: Array<keyof PlanRequest["preferences"]> = [];
  if (spot.category === "gourmet" && request.preferences.gourmet !== "low") matches.push("gourmet");
  if (spot.category === "scenic" && request.preferences.scenic !== "low") matches.push("scenic");
  if ((spot.category === "road" || spot.tags.some((tag) => rideFriendlyTags.has(tag))) && request.preferences.road !== "low") matches.push("road");
  if (spot.category === "rest" && request.preferences.relaxed !== "low") matches.push("relaxed");
  return matches;
}

function highPreferenceKeys(request: PlanRequest): Array<keyof PlanRequest["preferences"]> {
  const keys: Array<keyof PlanRequest["preferences"]> = ["road", "scenic", "gourmet", "relaxed"];
  const high = keys.filter((key) => request.preferences[key] === "high");
  return high.length ? high : keys.filter((key) => request.preferences[key] === "medium");
}

function topPreferenceLabel(request: PlanRequest): string {
  const [top] = [...(["road", "scenic", "gourmet", "relaxed"] as Array<keyof PlanRequest["preferences"]>)]
    .sort((a, b) => preferenceValue(request.preferences[b]) - preferenceValue(request.preferences[a]));
  return preferenceLabels[top];
}

function categoryLabel(category: Spot["category"]): string {
  switch (category) {
    case "gourmet":
      return "グルメ";
    case "scenic":
      return "景勝地";
    case "road":
      return "快走ポイント";
    case "rest":
      return "休憩";
  }
}

function rotate<T>(items: T[], offset: number): T[] {
  if (items.length === 0) return items;
  const normalized = offset % items.length;
  return [...items.slice(normalized), ...items.slice(0, normalized)];
}

function bearingDeg(from: LatLngTuple, to: LatLngTuple): number {
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
