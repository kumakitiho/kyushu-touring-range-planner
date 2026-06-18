import request from "supertest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import type { CodexPlanProvider } from "../server/codexProvider";
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
    const provider = mockProvider();
    const response = await request(createApp({ codexProvider: provider }))
      .post("/api/plans")
      .send({
        origin: { label: "熊本駅", lat: 32.7907, lng: 130.6889, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "local_only_after_highway" },
        preferences: { gourmet: 4, scenic: 4, road: 5, relaxed: 2 },
        tripStyle: "day_trip",
        count: 3,
        generationMode: "local"
      })
      .expect(200);

    const parsed = PlanResponseSchema.parse(response.body);
    expect(parsed.mode).toBe("local");
    expect(parsed.candidates.length).toBeGreaterThan(0);
    expect(parsed.plans[0].stops.every((stop) => parsed.candidates.some((spot) => spot.id === stop.spotId))).toBe(true);
    expect(parsed.plans[0].highwayUsage).toContain("高速");
    expect(provider.getStatus).not.toHaveBeenCalled();
  });

  it("OpenAIキーが入っていてもローカル固定なら外部生成へ渡さない", async () => {
    const provider = mockProvider();
    vi.stubEnv("OPENAI_API_KEY", "dummy-key-that-must-not-be-used");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("No external model or route request should be made in this test.");
      })
    );

    const response = await request(createApp({ distPath: false, codexProvider: provider }))
      .post("/api/plans")
      .send({
        origin: { label: "熊本駅", lat: 32.7907, lng: 130.6889, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" },
        preferences: { gourmet: 4, scenic: 4, road: 5, relaxed: 2 },
        tripStyle: "day_trip",
        count: 3,
        generationMode: "local"
      })
      .expect(200);

    const parsed = PlanResponseSchema.parse(response.body);
    expect(parsed.mode).toBe("local");
    expect(parsed.plans.length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(provider.generatePlanDrafts).not.toHaveBeenCalled();
  });

  it("autoでCodex成功時はCodex選定をhydrateして返す", async () => {
    const provider = mockProvider({
      getStatus: vi.fn(async () => ({ codexAvailable: true, authMode: "chatgpt", planType: "plus" })),
      generatePlanDrafts: vi.fn(async (_request, candidates) => [
        {
          title: "Codex選定プラン",
          summary: "候補スポットから選んだ提案です。",
          spotIds: [candidates[0].id],
          highlights: ["同じ候補IDだけを使う"],
          cautions: []
        }
      ])
    });

    const response = await request(createApp({ distPath: false, codexProvider: provider }))
      .post("/api/plans")
      .send({
        origin: { label: "熊本駅", lat: 32.7907, lng: 130.6889, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" },
        preferences: { gourmet: 4, scenic: 4, road: 5, relaxed: 2 },
        tripStyle: "day_trip",
        count: 3,
        generationMode: "auto"
      })
      .expect(200);

    const parsed = PlanResponseSchema.parse(response.body);
    expect(parsed.mode).toBe("codex");
    expect(parsed.plans[0].title).toBe("Codex選定プラン");
    expect(parsed.plans[0].source).toBe("codex");
    expect(provider.generatePlanDrafts).toHaveBeenCalled();
  });

  it("Codex未ログイン時はローカル生成へフォールバックする", async () => {
    const provider = mockProvider({
      getStatus: vi.fn(async () => ({ codexAvailable: true, authMode: null, planType: null }))
    });

    const response = await request(createApp({ distPath: false, codexProvider: provider }))
      .post("/api/plans")
      .send({
        origin: { label: "熊本駅", lat: 32.7907, lng: 130.6889, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" },
        preferences: { gourmet: 4, scenic: 4, road: 5, relaxed: 2 },
        tripStyle: "day_trip",
        count: 3,
        generationMode: "codex"
      })
      .expect(200);

    const parsed = PlanResponseSchema.parse(response.body);
    expect(parsed.mode).toBe("local");
    expect(parsed.fallbackReason).toContain("ChatGPTログイン");
  });

  it("Codex rate limit時はturnを開始せずローカル生成へフォールバックする", async () => {
    const provider = mockProvider({
      getStatus: vi.fn(async () => ({
        codexAvailable: true,
        authMode: "chatgpt",
        planType: "plus",
        rateLimitReason: "Codex rate limitに到達しています。"
      }))
    });

    const response = await request(createApp({ distPath: false, codexProvider: provider }))
      .post("/api/plans")
      .send({
        origin: { label: "熊本駅", lat: 32.7907, lng: 130.6889, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" },
        preferences: { gourmet: 4, scenic: 4, road: 5, relaxed: 2 },
        tripStyle: "day_trip",
        count: 3,
        generationMode: "auto"
      })
      .expect(200);

    const parsed = PlanResponseSchema.parse(response.body);
    expect(parsed.mode).toBe("local");
    expect(parsed.fallbackReason).toContain("rate limit");
    expect(provider.generatePlanDrafts).not.toHaveBeenCalled();
  });

  it("Codexへ渡した候補外IDが返ったらローカル生成へフォールバックする", async () => {
    const previousLimit = process.env.CODEX_PLAN_CANDIDATE_LIMIT;
    process.env.CODEX_PLAN_CANDIDATE_LIMIT = "1";
    const provider = mockProvider({
      getStatus: vi.fn(async () => ({ codexAvailable: true, authMode: "chatgpt", planType: "plus" })),
      generatePlanDrafts: vi.fn(async (_request, candidates) => [
        {
          title: "不正候補プラン",
          summary: "候補外IDを混ぜた提案です。",
          spotIds: [candidates[0].id, "outside-candidate-id"],
          highlights: [],
          cautions: []
        }
      ])
    });

    try {
      const response = await request(createApp({ distPath: false, codexProvider: provider }))
        .post("/api/plans")
        .send({
          origin: { label: "熊本駅", lat: 32.7907, lng: 130.6889, source: "preset" },
          constraint: { type: "duration", value: 240, unit: "min" },
          routeOptions: { highwayMode: "none" },
          preferences: { gourmet: 4, scenic: 4, road: 5, relaxed: 2 },
          tripStyle: "day_trip",
          count: 3,
          generationMode: "codex"
        })
        .expect(200);

      const parsed = PlanResponseSchema.parse(response.body);
      expect(parsed.mode).toBe("local");
      expect(parsed.fallbackReason).toContain("invalid spot selection");
      expect(provider.generatePlanDrafts).toHaveBeenCalled();
      expect(vi.mocked(provider.generatePlanDrafts).mock.calls[0][1]).toHaveLength(1);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.CODEX_PLAN_CANDIDATE_LIMIT;
      } else {
        process.env.CODEX_PLAN_CANDIDATE_LIMIT = previousLimit;
      }
    }
  });

  it("Codexログイン開始APIはproviderの結果を返す", async () => {
    const provider = mockProvider({
      startLogin: vi.fn(async () => ({
        type: "chatgptDeviceCode" as const,
        loginId: "login-1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234"
      }))
    });

    const response = await request(createApp({ distPath: false, codexProvider: provider })).post("/api/codex/login/start").expect(200);
    expect(response.body.userCode).toBe("ABCD-1234");
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

function mockProvider(overrides: Partial<CodexPlanProvider> = {}): CodexPlanProvider {
  return {
    getStatus: vi.fn(async () => ({ codexAvailable: false, authMode: null, planType: null })),
    startLogin: vi.fn(async () => ({ type: "unavailable" as const, message: "mock" })),
    generatePlanDrafts: vi.fn(async () => []),
    ...overrides
  };
}
