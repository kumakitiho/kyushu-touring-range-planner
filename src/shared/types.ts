import { z } from "zod";

export const highwayModes = [
  "none",
  "full",
  "outbound_only",
  "return_only",
  "local_only_after_highway"
] as const;

export const SpotImageSchema = z.object({
  url: z.string().min(1),
  alt: z.string(),
  credit: z.string(),
  license: z.string(),
  sourceUrl: z.string().url()
});

export const SpotSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(["gourmet", "scenic", "road", "rest"]),
  lat: z.number(),
  lng: z.number(),
  area: z.string(),
  tags: z.array(z.string()),
  description: z.string(),
  images: z.array(SpotImageSchema).default([])
});

export const PlanRequestSchema = z.object({
  origin: z.object({
    label: z.string().min(1),
    lat: z.number(),
    lng: z.number(),
    source: z.enum(["gps", "manual", "preset"])
  }),
  constraint: z.discriminatedUnion("type", [
    z.object({ type: z.literal("distance"), value: z.number().min(20).max(500), unit: z.literal("km") }),
    z.object({ type: z.literal("duration"), value: z.number().min(30).max(720), unit: z.literal("min") })
  ]),
  routeOptions: z.object({
    highwayMode: z.enum(highwayModes)
  }),
  preferences: z.object({
    gourmet: z.number().min(0).max(5),
    scenic: z.number().min(0).max(5),
    road: z.number().min(0).max(5),
    relaxed: z.number().min(0).max(5)
  }),
  tripStyle: z.enum(["half_day", "day_trip"]),
  count: z.number().int().min(1).max(4)
});

export const PlanStopSchema = z.object({
  spotId: z.string(),
  name: z.string(),
  category: SpotSchema.shape.category,
  lat: z.number(),
  lng: z.number(),
  area: z.string(),
  description: z.string(),
  images: z.array(SpotImageSchema),
  legNote: z.string()
});

export const PlanSchema = z.object({
  title: z.string(),
  summary: z.string(),
  stops: z.array(PlanStopSchema).min(1),
  estimatedDistanceKm: z.number(),
  estimatedDurationMin: z.number(),
  highwayUsage: z.string(),
  routeSource: z.enum(["osrm", "fallback"]),
  routeLine: z.array(z.tuple([z.number(), z.number()])),
  highlights: z.array(z.string()),
  cautions: z.array(z.string()),
  source: z.enum(["ai", "fallback"])
});

export const PlanResponseSchema = z.object({
  plans: z.array(PlanSchema),
  reachableArea: z.object({
    type: z.literal("approx_circle"),
    center: z.tuple([z.number(), z.number()]),
    radiusKm: z.number(),
    coordinates: z.array(z.tuple([z.number(), z.number()]))
  }),
  candidates: z.array(SpotSchema),
  mode: z.enum(["ai", "fallback"])
});

export type HighwayMode = (typeof highwayModes)[number];
export type Spot = z.infer<typeof SpotSchema>;
export type PlanRequest = z.infer<typeof PlanRequestSchema>;
export type PlanResponse = z.infer<typeof PlanResponseSchema>;
export type Plan = PlanResponse["plans"][number];
export type PlanStop = Plan["stops"][number];
