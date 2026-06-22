import { afterEach, describe, expect, it, vi } from "vitest";
import { requestPlans } from "../src/lib/planClient";
import type { PlanRequest } from "../src/shared/types";

const request: PlanRequest = {
  origin: { label: "福岡・天神", lat: 33.5902, lng: 130.4017, source: "preset" },
  constraint: { type: "duration", value: 240, unit: "min" },
  routeOptions: { highwayMode: "none" },
  preferences: { gourmet: "medium", scenic: "high", road: "medium", relaxed: "low" },
  tripStyle: "day_trip",
  count: 3,
  generationMode: "auto"
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("requestPlans", () => {
  it("falls back to the bundled spot data when the API is unavailable", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const remoteFetch = vi.fn();
    vi.stubGlobal("fetch", remoteFetch);

    const response = await requestPlans(request, fetcher as unknown as typeof fetch);

    expect(response.mode).toBe("local");
    expect(response.plans.length).toBeGreaterThan(0);
    expect(response.fallbackReason).toContain("端末の登録スポット");
    expect(response.providerStatus?.codexAvailable).toBe(false);
    expect(remoteFetch).not.toHaveBeenCalled();
  });
});
