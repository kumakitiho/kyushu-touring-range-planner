import request from "supertest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import type { CodexPlanProvider } from "../server/codexProvider";
import { PlanResponseSchema, type Spot } from "../src/shared/types";

describe("plans api", () => {
  beforeEach(() => {
    vi.stubEnv("VALHALLA_BASE_URL", "off");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("falls back when Codex returns only a nearby gourmet stop for a longer day trip", async () => {
    const provider = mockProvider({
      getStatus: vi.fn(async () => ({ codexAvailable: true, authMode: "chatgpt", planType: "plus" })),
      generatePlanDrafts: vi.fn(async () => [
        {
          title: "Too short gourmet plan",
          summary: "Only a nearby food stop.",
          appeal: "Not enough ride value.",
          bestFor: ["short food stop"],
          routeStory: "Go nearby and return.",
          preferenceFit: ["gourmet"],
          spotIds: ["restaurant-q139765483"],
          highlights: ["nearby food"],
          cautions: []
        }
      ])
    });

    const response = await request(createApp({ distPath: false, codexProvider: provider }))
      .post("/api/plans")
      .send({
        origin: { label: "Fukuoka", lat: 33.5902, lng: 130.4017, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" },
        preferences: { gourmet: "medium", scenic: "medium", road: "medium", relaxed: "low" },
        tripStyle: "day_trip",
        count: 3,
        generationMode: "auto"
      })
      .expect(200);

    const parsed = PlanResponseSchema.parse(response.body);
    expect(parsed.mode).toBe("local");
    expect(parsed.fallbackReason).toContain("invalid spot selection");
    expect(parsed.plans[0].estimatedDurationMin).toBeGreaterThan(10);
    expect(parsed.plans[0].stops.map((stop) => stop.spotId)).not.toEqual(["restaurant-q139765483"]);
  });

  it("収集済みスポットだけでローカルプランを返す", async () => {
    const provider = mockProvider();
    const response = await request(createApp({ codexProvider: provider }))
      .post("/api/plans")
      .send({
        origin: { label: "熊本駅", lat: 32.7907, lng: 130.6889, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "full" },
        preferences: { gourmet: "medium", scenic: "medium", road: "high", relaxed: "low" },
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
        preferences: { gourmet: "medium", scenic: "medium", road: "high", relaxed: "low" },
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
      generatePlanDrafts: vi.fn(async (_request, candidates) => {
        const supportIds = ["gourmet-aso-akaushi", "volcano-q11536251"];
        const roadIds = ["road-aso-milk-road", "road-aso-panorama-line", "road-tawarayama-pass"];
        expect([...supportIds, ...roadIds].every((id) => candidates.some((candidate: Spot) => candidate.id === id))).toBe(true);
        return roadIds.map((roadId) => ({
          title: "Codex選定プラン",
          summary: "候補スポットから選んだ提案です。",
          appeal: "走り重視の条件に合わせたCodex提案です。",
          bestFor: ["走りを楽しみたい人"],
          routeStory: "同じ方面にまとまるように選びます。",
          preferenceFit: ["走り重視: 候補スポットが条件に合います"],
          spotIds: [roadId, ...supportIds],
          highlights: ["同じ候補IDだけを使う"],
          cautions: []
        }));
      })
    });

    const response = await request(createApp({ distPath: false, codexProvider: provider }))
      .post("/api/plans")
      .send({
        origin: { label: "熊本駅", lat: 32.7907, lng: 130.6889, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" },
        preferences: { gourmet: "medium", scenic: "medium", road: "high", relaxed: "low" },
        tripStyle: "day_trip",
        count: 3,
        generationMode: "auto"
      })
      .expect(200);

    const parsed = PlanResponseSchema.parse(response.body);
    expect(parsed.mode).toBe("codex");
    expect(parsed.plans[0].title).not.toBe("Codex選定プラン");
    expect(parsed.plans[0].title).toContain("阿蘇ミルクロード");
    expect(parsed.plans[0].source).toBe("codex");
    expect(provider.generatePlanDrafts).toHaveBeenCalled();
  });

  it("Codexが同じ主目的地を3件返した場合は重複案としてローカルへフォールバックする", async () => {
    const provider = mockProvider({
      getStatus: vi.fn(async () => ({ codexAvailable: true, authMode: "chatgpt", planType: "plus" })),
      generatePlanDrafts: vi.fn(async () =>
        Array.from({ length: 3 }, () => ({
          title: "重複した走り案",
          summary: "同一案です。",
          appeal: "同一案です。",
          bestFor: ["テスト"],
          routeStory: "同一案です。",
          preferenceFit: ["走り重視"],
          spotIds: ["road-aso-milk-road", "gourmet-aso-akaushi", "volcano-q11536251"],
          highlights: ["重複"],
          cautions: []
        }))
      )
    });

    const response = await request(createApp({ distPath: false, codexProvider: provider }))
      .post("/api/plans")
      .send({
        origin: { label: "熊本駅", lat: 32.7907, lng: 130.6889, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" },
        preferences: { gourmet: "medium", scenic: "medium", road: "high", relaxed: "low" },
        tripStyle: "day_trip",
        count: 3,
        generationMode: "auto"
      })
      .expect(200);

    const parsed = PlanResponseSchema.parse(response.body);
    expect(parsed.mode).toBe("local");
    expect(parsed.fallbackReason).toContain("no valid road plan");
  });

  it("Codexの返却順が異なっても景色・グルメ・走りへ内容で割り当てる", async () => {
    const makeDraft = (title: string, spotIds: string[]) => ({
      title,
      summary: `${title}の要約`,
      appeal: `${title}の魅力`,
      bestFor: [title],
      routeStory: `${title}の流れ`,
      preferenceFit: [`${title}が条件に合います`],
      spotIds,
      highlights: [title],
      cautions: []
    });
    const provider = mockProvider({
      getStatus: vi.fn(async () => ({ codexAvailable: true, authMode: "chatgpt", planType: "plus" })),
      generatePlanDrafts: vi.fn(async (_request, candidates) => {
        const requiredIds = [
          "waterfall-q11630184",
          "gourmet-karatsu-burger",
          "gourmet-dazaifu-umegae-mochi",
          "gourmet-yobuko-squid",
          "tourist_attraction-q11353344",
          "road-itoshima-sunset-road"
        ];
        expect(requiredIds.every((id) => candidates.some((candidate: Spot) => candidate.id === id))).toBe(true);
        return [
          makeDraft("走り案", ["road-itoshima-sunset-road", "gourmet-karatsu-burger", "waterfall-q11630184"]),
          makeDraft("景色案", ["waterfall-q11630184", "gourmet-dazaifu-umegae-mochi"]),
          makeDraft("グルメ案", ["gourmet-yobuko-squid", "tourist_attraction-q11353344"])
        ];
      })
    });

    const response = await request(createApp({ distPath: false, codexProvider: provider }))
      .post("/api/plans")
      .send({
        origin: { label: "福岡・天神", lat: 33.5902, lng: 130.4017, source: "preset" },
        constraint: { type: "duration", value: 240, unit: "min" },
        routeOptions: { highwayMode: "none" },
        preferences: { gourmet: "medium", scenic: "medium", road: "medium", relaxed: "low" },
        tripStyle: "day_trip",
        count: 3,
        generationMode: "auto"
      })
      .expect(200);

    const parsed = PlanResponseSchema.parse(response.body);
    expect(parsed.fallbackReason).toBeUndefined();
    expect(parsed.mode).toBe("codex");
    const mainCategories = parsed.plans.map(
      (plan) => plan.stops.find((stop) => plan.title.includes(stop.name))?.category
    );
    expect(mainCategories).toEqual(["scenic", "gourmet", "road"]);
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
        preferences: { gourmet: "medium", scenic: "medium", road: "high", relaxed: "low" },
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
        preferences: { gourmet: "medium", scenic: "medium", road: "high", relaxed: "low" },
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
          appeal: "候補外IDを混ぜる異常系です。",
          bestFor: ["テスト"],
          routeStory: "候補外IDの拒否を確認します。",
          preferenceFit: ["走り重視: テスト"],
          spotIds: [candidates[0].id, "outside-candidate-id"],
          highlights: ["テスト"],
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
          preferences: { gourmet: "medium", scenic: "medium", road: "high", relaxed: "low" },
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

  it("healthとCodex statusをJSONで返す", async () => {
    const provider = mockProvider({
      getStatus: vi.fn(async () => ({ codexAvailable: true, authMode: "chatgpt", planType: "plus" }))
    });
    const app = createApp({ distPath: false, codexProvider: provider });

    const health = await request(app).get("/api/health").expect(200);
    const status = await request(app).get("/api/codex/status").expect(200);

    expect(health.body).toMatchObject({ ok: true, providers: { codexAppServer: true } });
    expect(status.body).toMatchObject({ codexAvailable: true, authMode: "chatgpt", planType: "plus" });
  });

  it("許可したローカルOriginだけをCORSで通す", async () => {
    const app = createApp({ distPath: false, codexProvider: mockProvider() });

    const allowed = await request(app).get("/api/health").set("Origin", "http://127.0.0.1:5173").expect(200);
    const denied = await request(app).get("/api/health").set("Origin", "https://evil.example").expect(403);

    expect(allowed.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    expect(denied.body.error).toBe("Origin is not allowed");
  });

  it("1MBを超えるJSON本文を拒否する", async () => {
    const oversized = { padding: "x".repeat(1024 * 1024 + 1) };

    await request(createApp({ distPath: false, codexProvider: mockProvider() }))
      .post("/api/plans")
      .send(oversized)
      .expect(413);
  });

  it("設定件数を超えるplan生成要求を429で拒否する", async () => {
    vi.stubEnv("PLAN_RATE_LIMIT_PER_MINUTE", "2");
    const app = createApp({ distPath: false, codexProvider: mockProvider() });

    await request(app).post("/api/plans").send({}).expect(400);
    await request(app).post("/api/plans").send({}).expect(400);
    const limited = await request(app).post("/api/plans").send({}).expect(429);

    expect(limited.body.error).toContain("Too many plan requests");
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
