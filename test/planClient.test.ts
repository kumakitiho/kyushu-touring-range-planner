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
    vi.stubEnv("OSRM_MIN_INTERVAL_MS", "0");
    vi.stubGlobal("navigator", {
      locks: {
        request: async (_name: string, callback: () => Promise<unknown>) => callback()
      }
    });
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const remoteFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const coordinateText = url.pathname.split("/").at(-1) ?? "";
      const coordinates = coordinateText.split(";").map((pair) => pair.split(",").map(Number) as [number, number]);
      return new Response(
        JSON.stringify({
          code: "Ok",
          waypoints: coordinates.map((location) => ({ distance: 0, location })),
          routes: [{ distance: 80_000, duration: 7_200, geometry: { type: "LineString", coordinates } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", remoteFetch);

    const response = await requestPlans(request, fetcher as unknown as typeof fetch);

    expect(response.mode).toBe("local");
    expect(response.plans.length).toBeGreaterThan(0);
    expect(response.fallbackReason).toContain("端末の登録スポット");
    expect(response.providerStatus?.codexAvailable).toBe(false);
    expect(remoteFetch).toHaveBeenCalled();
    expect(response.plans.some((plan) => plan.routeSource === "osrm")).toBe(true);
  });

  it("uses approximate routes when cross-tab coordination is unavailable", async () => {
    vi.stubEnv("OSRM_MIN_INTERVAL_MS", "0");
    vi.stubGlobal("navigator", {});
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const remoteFetch = vi.fn();
    vi.stubGlobal("fetch", remoteFetch);

    const response = await requestPlans(request, fetcher as unknown as typeof fetch);

    expect(response.plans.every((plan) => plan.routeSource === "fallback")).toBe(true);
    expect(remoteFetch).not.toHaveBeenCalled();
  });

  it("does not call public OSRM when shared storage cannot be written", async () => {
    vi.stubEnv("OSRM_MIN_INTERVAL_MS", "0");
    vi.stubGlobal("navigator", {
      locks: {
        request: async (_name: string, callback: () => Promise<unknown>) => callback()
      }
    });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("Quota exceeded");
      },
      removeItem: () => undefined
    });
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const remoteFetch = vi.fn();
    vi.stubGlobal("fetch", remoteFetch);

    const response = await requestPlans(request, fetcher as unknown as typeof fetch);

    expect(response.plans.every((plan) => plan.routeSource === "fallback")).toBe(true);
    expect(remoteFetch).not.toHaveBeenCalled();
  });
});
