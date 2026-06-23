import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginRoutingBudget, clearRouteCache, resolveRoute } from "../server/routing";

describe("routing", () => {
  beforeEach(() => {
    clearRouteCache();
    vi.stubEnv("OSRM_BASE_URL", "http://mock-osrm");
    vi.stubEnv("OSRM_MIN_INTERVAL_MS", "0");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("serializes public OSRM requests with a minimum interval", async () => {
    vi.stubEnv("OSRM_MIN_INTERVAL_MS", "25");
    const startedAt: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        startedAt.push(Date.now());
        return new Response(JSON.stringify({ code: "NoRoute", routes: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      })
    );

    await Promise.all([
      resolveRoute(
        [
          [33.59, 130.4],
          [33.6, 130.5]
        ],
        "none"
      ),
      resolveRoute(
        [
          [33.59, 130.4],
          [33.7, 130.6]
        ],
        "none"
      )
    ]);

    expect(startedAt).toHaveLength(2);
    expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(20);
  });

  it("stops external routing when the generation request budget is exhausted", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ code: "NoRoute", routes: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const finishBudget = beginRoutingBudget(1, 10_000);

    await resolveRoute(
      [
        [33.59, 130.4],
        [33.6, 130.5]
      ],
      "none"
    );
    await resolveRoute(
      [
        [33.59, 130.4],
        [33.7, 130.6]
      ],
      "none"
    );
    finishBudget();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not start a request after the generation deadline", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const finishBudget = beginRoutingBudget(5, 0);

    await resolveRoute(
      [
        [33.59, 130.4],
        [33.6, 130.5]
      ],
      "none"
    );
    finishBudget();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
