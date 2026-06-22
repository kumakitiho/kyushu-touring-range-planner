import { z } from "zod";

export const highwayModes = ["none", "full"] as const;

export const generationModes = ["auto", "codex", "local"] as const;
export const preferenceLevels = ["low", "medium", "high"] as const;

const PreferenceSchema = z.enum(preferenceLevels);

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
    gourmet: PreferenceSchema,
    scenic: PreferenceSchema,
    road: PreferenceSchema,
    relaxed: PreferenceSchema
  }),
  tripStyle: z.enum(["half_day", "day_trip"]),
  count: z.number().int().min(1).max(4),
  generationMode: z.enum(generationModes).default("auto")
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
  legNote: z.string(),
  whyStopHere: z.string(),
  famousFor: z.string(),
  riderNote: z.string(),
  recommendedAction: z.string(),
  timeHint: z.string(),
  matchedPreferences: z.array(z.enum(["gourmet", "scenic", "road", "relaxed"]))
});

export const PlanSchema = z.object({
  title: z.string(),
  summary: z.string(),
  appeal: z.string(),
  bestFor: z.array(z.string()),
  routeStory: z.string(),
  preferenceFit: z.array(z.string()),
  stops: z.array(PlanStopSchema).min(1),
  estimatedDistanceKm: z.number(),
  estimatedDurationMin: z.number(),
  highwayUsage: z.string(),
  routeSource: z.enum(["osrm", "fallback"]),
  routeLine: z.array(z.tuple([z.number(), z.number()])),
  highlights: z.array(z.string()),
  cautions: z.array(z.string()),
  source: z.enum(["codex", "local"])
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
  mode: z.enum(["codex", "local"]),
  fallbackReason: z.string().optional(),
  providerStatus: z
    .object({
      codexAvailable: z.boolean(),
      authMode: z.string().nullable(),
      planType: z.string().nullable()
    })
    .optional()
});

export type HighwayMode = (typeof highwayModes)[number];
export type GenerationMode = (typeof generationModes)[number];
export type PreferenceLevel = (typeof preferenceLevels)[number];
export type Spot = z.infer<typeof SpotSchema>;
export type PlanRequest = z.infer<typeof PlanRequestSchema>;
export type PlanResponse = z.infer<typeof PlanResponseSchema>;
export type Plan = PlanResponse["plans"][number];
export type PlanStop = Plan["stops"][number];
