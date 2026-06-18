import { describe, expect, it } from "vitest";
import { AppServerCodexProvider } from "../server/codexProvider";
import type { PlanRequest, Spot } from "../src/shared/types";

describe("codex provider event buffering", () => {
  it("resolves from turn notifications even when turn/start response is missing", async () => {
    const sent: Array<{ id?: number; method?: string; params?: unknown }> = [];
    const provider = new AppServerCodexProvider() as unknown as {
      handleLine(line: string): void;
      bufferedTurns: Map<string, { text: string; completed?: { status?: string; error?: { message?: string } | null } }>;
      pending: Map<number, unknown>;
      pendingTurnStartsByThreadId: Map<string, unknown>;
      send(message: { id?: number; method?: string; params?: unknown }): void;
      startTurn(threadId: string, request: PlanRequest, candidates: Spot[], model: string): Promise<string>;
    };
    provider.send = (message) => sent.push(message);

    const result = provider.startTurn("thread-1", baseRequest, [baseSpot], "gpt-5.4");

    provider.handleLine(
      JSON.stringify({
        method: "item/completed",
        params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", text: "{\"plans\":[]}" } }
      })
    );
    provider.handleLine(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } }
      })
    );

    await expect(result).resolves.toBe("{\"plans\":[]}");
    expect(provider.bufferedTurns.has("turn-1")).toBe(false);
    expect(provider.pending.size).toBe(0);
    expect(provider.pendingTurnStartsByThreadId.size).toBe(0);
    expect(sent.some((message) => message.method === "turn/start")).toBe(true);
  });

  it("rejects buffered app-server errors instead of waiting for completion timeout", async () => {
    const sent: Array<{ id?: number; method?: string; params?: unknown }> = [];
    const provider = new AppServerCodexProvider() as unknown as {
      handleLine(line: string): void;
      pending: Map<number, unknown>;
      pendingTurnStartsByThreadId: Map<string, unknown>;
      send(message: { id?: number; method?: string; params?: unknown }): void;
      startTurn(threadId: string, request: PlanRequest, candidates: Spot[], model: string): Promise<string>;
    };
    provider.send = (message) => sent.push(message);

    const result = provider.startTurn("thread-1", baseRequest, [baseSpot], "gpt-5.4-mini");
    provider.handleLine(
      JSON.stringify({
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-2",
          willRetry: true,
          error: { message: "You've hit your usage limit for premium. Try again at 11:25 PM." }
        }
      })
    );

    await expect(result).rejects.toThrow("usage limit");
    expect(sent.some((message) => message.method === "turn/start")).toBe(true);
    expect(provider.pending.size).toBe(0);
    expect(provider.pendingTurnStartsByThreadId.size).toBe(0);
    const turnStart = sent.find((message) => message.method === "turn/start");
    provider.handleLine(JSON.stringify({ id: turnStart?.id, result: { turn: { id: "late-turn" } } }));
    provider.handleLine(JSON.stringify({ method: "turn/completed", params: { turn: { id: "late-turn", status: "completed", error: null } } }));
    expect(provider.pending.size).toBe(0);
    expect(provider.pendingTurnStartsByThreadId.size).toBe(0);
  });

  it("cleans up turn/start state when JSON-RPC responds with an error", async () => {
    const sent: Array<{ id?: number; method?: string; params?: unknown }> = [];
    const provider = new AppServerCodexProvider() as unknown as {
      handleLine(line: string): void;
      pending: Map<number, unknown>;
      pendingTurnStartsByThreadId: Map<string, unknown>;
      send(message: { id?: number; method?: string; params?: unknown }): void;
      startTurn(threadId: string, request: PlanRequest, candidates: Spot[], model: string): Promise<string>;
    };
    provider.send = (message) => sent.push(message);

    const result = provider.startTurn("thread-1", baseRequest, [baseSpot], "gpt-5.4-mini");
    const turnStart = sent.find((message) => message.method === "turn/start");
    provider.handleLine(JSON.stringify({ id: turnStart?.id, error: { message: "model unavailable" } }));

    await expect(result).rejects.toThrow("model unavailable");
    expect(provider.pending.size).toBe(0);
    expect(provider.pendingTurnStartsByThreadId.size).toBe(0);
  });

  it("starts turns with read-only no-tool planning guardrails and a bounded candidate prompt", async () => {
    const previousLimit = process.env.CODEX_PLAN_CANDIDATE_LIMIT;
    process.env.CODEX_PLAN_CANDIDATE_LIMIT = "2";
    const sent: Array<{ id?: number; method?: string; params?: { input?: Array<{ text?: string }>; approvalPolicy?: string; effort?: string; summary?: string; personality?: string; sandboxPolicy?: unknown; outputSchema?: unknown } }> = [];
    const provider = new AppServerCodexProvider() as unknown as {
      handleLine(line: string): void;
      send(message: { id?: number; method?: string; params?: unknown }): void;
      startTurn(threadId: string, request: PlanRequest, candidates: Spot[], model: string): Promise<string>;
    };
    provider.send = (message) => sent.push(message as (typeof sent)[number]);

    try {
      const result = provider.startTurn("thread-1", baseRequest, [baseSpot, spotWithId("spot-2"), spotWithId("spot-3")], "gpt-5.4-mini");
      const turnStart = sent.find((message) => message.method === "turn/start");
      expect(turnStart?.params?.approvalPolicy).toBe("untrusted");
      expect(turnStart?.params?.effort).toBe("none");
      expect(turnStart?.params?.summary).toBe("none");
      expect(turnStart?.params?.personality).toBe("none");
      expect(turnStart?.params?.sandboxPolicy).toMatchObject({
        type: "readOnly",
        access: { type: "restricted", readableRoots: [] }
      });
      expect(turnStart?.params?.outputSchema).toBeTruthy();
      const prompt = turnStart?.params?.input?.[0]?.text ?? "";
      expect(prompt).toContain("spot-1");
      expect(prompt).toContain("spot-2");
      expect(prompt).not.toContain("spot-3");
      provider.handleLine(JSON.stringify({ id: turnStart?.id, error: { message: "stop test turn" } }));
      await expect(result).rejects.toThrow("stop test turn");
    } finally {
      if (previousLimit === undefined) {
        delete process.env.CODEX_PLAN_CANDIDATE_LIMIT;
      } else {
        process.env.CODEX_PLAN_CANDIDATE_LIMIT = previousLimit;
      }
    }
  });

  it("declines command and file-change approval requests from app-server", () => {
    const sent: Array<{ id?: number; result?: { decision?: string }; error?: unknown }> = [];
    const provider = new AppServerCodexProvider() as unknown as {
      handleLine(line: string): void;
      send(message: { id?: number; result?: { decision?: string }; error?: unknown }): void;
    };
    provider.send = (message) => sent.push(message);

    provider.handleLine(JSON.stringify({ id: 101, method: "item/commandExecution/requestApproval", params: {} }));
    provider.handleLine(JSON.stringify({ id: 102, method: "item/fileChange/requestApproval", params: {} }));

    expect(sent).toContainEqual({ id: 101, result: { decision: "decline" } });
    expect(sent).toContainEqual({ id: 102, result: { decision: "decline" } });
  });

  it("waits briefly for agent text when turn/completed arrives before item/completed", async () => {
    const previousWait = process.env.CODEX_COMPLETED_TEXT_WAIT_MS;
    process.env.CODEX_COMPLETED_TEXT_WAIT_MS = "100";
    const sent: Array<{ id?: number; method?: string; params?: unknown }> = [];
    const provider = new AppServerCodexProvider() as unknown as {
      handleLine(line: string): void;
      send(message: { id?: number; method?: string; params?: unknown }): void;
      startTurn(threadId: string, request: PlanRequest, candidates: Spot[], model: string): Promise<string>;
    };
    provider.send = (message) => sent.push(message);

    const result = provider.startTurn("thread-1", baseRequest, [baseSpot], "gpt-5.4-mini");
    provider.handleLine(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-3", status: "completed", error: null } }
      })
    );
    setTimeout(() => {
      provider.handleLine(
        JSON.stringify({
          method: "item/completed",
          params: { threadId: "thread-1", turnId: "turn-3", item: { type: "agentMessage", text: "{\"plans\":[{\"spotIds\":[\"spot-1\"]}]}" } }
        })
      );
    }, 10);

    try {
      await expect(result).resolves.toContain("spot-1");
    } finally {
      if (previousWait === undefined) {
        delete process.env.CODEX_COMPLETED_TEXT_WAIT_MS;
      } else {
        process.env.CODEX_COMPLETED_TEXT_WAIT_MS = previousWait;
      }
    }
  });
});

const baseRequest: PlanRequest = {
  origin: { label: "福岡・天神", lat: 33.5902, lng: 130.4017, source: "preset" },
  constraint: { type: "duration", value: 180, unit: "min" },
  routeOptions: { highwayMode: "none" },
  preferences: { gourmet: 4, scenic: 4, road: 4, relaxed: 2 },
  tripStyle: "day_trip",
  count: 1,
  generationMode: "codex"
};

const baseSpot: Spot = {
  id: "spot-1",
  name: "テストスポット",
  category: "scenic",
  lat: 33.6,
  lng: 130.5,
  area: "福岡県",
  tags: ["viewpoint"],
  description: "テスト用スポット",
  images: []
};

function spotWithId(id: string): Spot {
  return {
    ...baseSpot,
    id,
    name: id
  };
}
