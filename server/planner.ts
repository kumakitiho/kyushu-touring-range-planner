import rawSpots from "../data/kyushu-spots.json";
import { circlePolygon, haversineKm, type LatLngTuple } from "../src/lib/geo";
import {
  type HighwayMode,
  type Plan,
  type PlanRequest,
  type PlanResponse,
  type PreferenceLevel,
  type Spot,
  SpotSchema
} from "../src/shared/types";
import { approximateRoute, resolveRoute, speedForMode } from "./routing";

const spots = rawSpots.map((spot) => SpotSchema.parse(spot));

const highwayLabels: Record<HighwayMode, string> = {
  none: "高速道路なし",
  full: "高速道路利用あり",
  outbound_only: "行きだけ高速",
  return_only: "帰りだけ高速",
  local_only_after_highway: "目的エリアまで高速、現地は下道中心"
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
    spot.category === "scenic" && spot.tags.some((tag) => rideFriendlyTags.has(tag))
      ? preferenceValue(request.preferences.road) * 0.38
      : 0;
  const relaxedBoost = spot.category === "rest" ? preferenceValue(request.preferences.relaxed) * 0.32 : 0;
  return preference * 1.5 + distanceFit * 3 + highwayBoost + roadLikeBoost + relaxedBoost;
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

  for (let attempt = 0; plans.length < count && attempt < candidates.length; attempt += 1) {
    const plan = await buildPlan(request, candidates, attempt);
    if (plan && !sameStopSignature(plans, plan)) plans.push(plan);
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
  allowedSpotIds?: Set<string>
): Promise<Plan | null> {
  const uniqueIds = Array.from(new Set(spotIds)).slice(0, 5);
  if (uniqueIds.length !== spotIds.length) return null;
  if (allowedSpotIds && uniqueIds.some((id) => !allowedSpotIds.has(id))) return null;
  const selected = uniqueIds
    .map((id) => spots.find((spot) => spot.id === id))
    .filter((spot): spot is Spot => Boolean(spot));
  if (selected.length !== uniqueIds.length) return null;
  return planFromStops(request, selected, copy, source);
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

async function buildPlan(request: PlanRequest, candidates: Spot[], planIndex: number): Promise<Plan | null> {
  const origin: LatLngTuple = [request.origin.lat, request.origin.lng];
  const ranked = rotate(candidates, planIndex * 5);
  const anchor = ranked[0];
  if (!anchor) return null;

  const targetStops = request.tripStyle === "half_day" ? (planIndex === 2 ? 2 : 1) : planIndex === 1 ? 2 : 3;
  const anchorBearing = bearingDeg(origin, [anchor.lat, anchor.lng]);
  const sameDirection = ranked.filter((spot) => {
    if (spot.id === anchor.id) return true;
    const bearing = bearingDeg(origin, [spot.lat, spot.lng]);
    return angularDistanceDeg(anchorBearing, bearing) <= 55;
  });
  const selected = orderStopsForOutAndBack(origin, pickBalancedStops(origin, anchor, sameDirection, request, targetStops));
  return planFromStops(request, selected, {}, "local");
}

async function planFromStops(
  request: PlanRequest,
  selected: Spot[],
  copy: PlanCopy = {},
  source: Plan["source"] = "local"
): Promise<Plan | null> {
  if (selected.length === 0) return null;
  const origin: LatLngTuple = [request.origin.lat, request.origin.lng];
  let stops = [...selected];
  const budget = request.constraint.type === "distance" ? budgetDistanceKm(request) * 1.15 : request.constraint.value * 1.2;

  while (stops.length > 0) {
    const routePoints = [origin, ...stops.map((spot) => [spot.lat, spot.lng] as LatLngTuple), origin];
    const route = await resolveRoute(routePoints, request.routeOptions.highwayMode);
    const value = request.constraint.type === "distance" ? route.distanceKm : route.durationMin;
    if (value <= budget) {
      return {
        title: copy.title?.trim() || titleForPlan(request, stops),
        summary: copy.summary?.trim() || summaryForPlan(request, stops),
        appeal: copy.appeal?.trim() || appealForPlan(request, stops),
        bestFor: copy.bestFor?.length ? copy.bestFor : bestForPlan(request, stops),
        routeStory: copy.routeStory?.trim() || routeStoryForPlan(request, stops),
        preferenceFit: copy.preferenceFit?.length ? copy.preferenceFit : preferenceFitForPlan(request, stops),
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
        highlights: copy.highlights?.length ? copy.highlights : highlightsFor(stops),
        cautions: [
          ...(copy.cautions ?? []),
          route.source === "osrm"
            ? "道路形状はOSM/OSRM由来です。規制、営業時間、二輪通行可否は出発前に確認してください。"
            : "ルート線は外部ルート取得失敗時の簡易目安です。実際の道路形状や規制は出発前に確認してください。",
          "スポット情報は収集済みデータ由来です。最新の営業状況や駐車場は未検証です。"
        ],
        source
      };
    }
    stops = stops.slice(0, -1);
  }

  return null;
}

function pickBalancedStops(
  origin: LatLngTuple,
  anchor: Spot,
  candidates: Spot[],
  request: PlanRequest,
  targetStops: number
): Spot[] {
  const selected = [anchor];
  const preferredCategories = preferredCategoryOrder(request);
  const byScore = [...candidates].sort((a, b) => scoreSpot(b, request) - scoreSpot(a, request));

  for (const category of preferredCategories) {
    if (selected.length >= targetStops) break;
    if (selected.some((spot) => spot.category === category)) continue;
    const next = byScore.find(
      (spot) =>
        spot.category === category &&
        !selected.some((picked) => picked.id === spot.id) &&
        isDirectionCompatible(origin, selected, spot)
    );
    if (next && approximateWithinBudget(origin, [...selected, next], request)) selected.push(next);
  }

  for (const candidate of byScore) {
    if (selected.length >= targetStops) break;
    if (selected.some((spot) => spot.id === candidate.id)) continue;
    if (!isDirectionCompatible(origin, selected, candidate)) continue;
    if (approximateWithinBudget(origin, [...selected, candidate], request)) selected.push(candidate);
  }

  return selected;
}

function preferredCategoryOrder(request: PlanRequest): Spot["category"][] {
  const entries: Array<[Spot["category"], number]> = [
    ["road", preferenceValue(request.preferences.road)],
    ["scenic", preferenceValue(request.preferences.scenic)],
    ["gourmet", preferenceValue(request.preferences.gourmet)],
    ["rest", preferenceValue(request.preferences.relaxed)]
  ];
  return entries.sort((a, b) => b[1] - a[1]).map(([category]) => category);
}

function isDirectionCompatible(origin: LatLngTuple, selected: Spot[], candidate: Spot): boolean {
  const candidateBearing = bearingDeg(origin, [candidate.lat, candidate.lng]);
  return selected.every((spot) => angularDistanceDeg(candidateBearing, bearingDeg(origin, [spot.lat, spot.lng])) <= 55);
}

function approximateWithinBudget(origin: LatLngTuple, selected: Spot[], request: PlanRequest): boolean {
  const route = approximateRoute(
    [origin, ...selected.map((spot) => [spot.lat, spot.lng] as LatLngTuple), origin],
    request.routeOptions.highwayMode
  );
  const budget = request.constraint.type === "distance" ? budgetDistanceKm(request) * 1.12 : request.constraint.value * 1.15;
  const value = request.constraint.type === "distance" ? route.distanceKm : route.durationMin;
  return value <= budget;
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

function titleForPlan(_request: PlanRequest, stops: Spot[]): string {
  const lead = stops.find((spot) => spot.category === "scenic" || spot.category === "road") ?? stops[0];
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

function appealForPlan(request: PlanRequest, stops: Spot[]): string {
  const lead = stops[0];
  const topPreference = topPreferenceLabel(request);
  return `${topPreference}を軸に、${lead.name}周辺の見どころと走りやすさをまとめたルートです。`;
}

function bestForPlan(request: PlanRequest, stops: Spot[]): string[] {
  const best = preferenceFitForPlan(request, stops).slice(0, 2);
  const category = stops[0]?.category ? categoryLabel(stops[0].category) : "日帰り";
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
