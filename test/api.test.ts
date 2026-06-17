import request from "supertest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import { PlanResponseSchema } from "../src/shared/types";

describe("plans api", () => {
  beforeEach(() => {
    vi.stubEnv("OSRM_BASE_URL", "off");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("収集済みスポットだけでローカルプランを返す", async () => {
    const response = await request(createApp())
      .post("/api/plans")
      .send({
        origin: { label: "熊本駅", lat: 32.7907, lng: 130.6889, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "local_only_after_highway" },
        preferences: { gourmet: 4, scenic: 4, road: 5, relaxed: 2 },
        tripStyle: "day_trip",
        count: 3
      })
      .expect(200);

    const parsed = PlanResponseSchema.parse(response.body);
    expect(parsed.mode).toBe("fallback");
    expect(parsed.candidates.length).toBeGreaterThan(0);
    expect(parsed.plans[0].stops.every((stop) => parsed.candidates.some((spot) => spot.id === stop.spotId))).toBe(true);
    expect(parsed.plans[0].highwayUsage).toContain("高速");
  });

  it("OpenAIキーが入っていてもChatGPTへ渡さない", async () => {
    vi.stubEnv("OPENAI_API_KEY", "dummy-key-that-must-not-be-used");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("No external model or route request should be made in this test.");
      })
    );

    const response = await request(createApp({ distPath: false }))
      .post("/api/plans")
      .send({
        origin: { label: "熊本駅", lat: 32.7907, lng: 130.6889, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" },
        preferences: { gourmet: 4, scenic: 4, road: 5, relaxed: 2 },
        tripStyle: "day_trip",
        count: 3
      })
      .expect(200);

    const parsed = PlanResponseSchema.parse(response.body);
    expect(parsed.mode).toBe("fallback");
    expect(parsed.plans.length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("不正な入力は400を返す", async () => {
    await request(createApp()).post("/api/plans").send({}).expect(400);
  });

  it("build済みdistがあれば同一オリジンでフロントを配信する", async () => {
    const distPath = mkdtempSync(path.join(tmpdir(), "touring-dist-"));
    mkdirSync(distPath, { recursive: true });
    writeFileSync(path.join(distPath, "index.html"), "<!doctype html><title>test app</title>", "utf8");
    try {
      const response = await request(createApp({ distPath })).get("/").expect(200);
      expect(response.text).toContain("test app");
    } finally {
      rmSync(distPath, { recursive: true, force: true });
    }
  });
});
