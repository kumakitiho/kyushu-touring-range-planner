import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRouteCache, resolveRoute } from "../server/routing";

describe("routing", () => {
  beforeEach(() => {
    clearRouteCache();
    vi.stubEnv("OSRM_BASE_URL", "http://mock-osrm");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("caches identical OSRM route lookups", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          code: "Ok",
          routes: [
            {
              distance: 12_000,
              duration: 900,
              geometry: {
                type: "LineString",
                coordinates: [
                  [130.4, 33.59],
                  [130.5, 33.6]
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const points: [number, number][] = [
      [33.59, 130.4],
      [33.6, 130.5]
    ];

    await resolveRoute(points, "none");
    await resolveRoute(points, "none");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
