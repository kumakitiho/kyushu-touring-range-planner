import { describe, expect, it, vi } from "vitest";
import { probeCodexBackend } from "../src/lib/codexCapability";

describe("probeCodexBackend", () => {
  it("returns the backend status when the API is available", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ codexAvailable: true, authMode: "chatgpt", planType: "plus" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );

    await expect(probeCodexBackend(fetcher)).resolves.toEqual({
      codexAvailable: true,
      authMode: "chatgpt",
      planType: "plus",
      loginState: undefined,
      message: undefined
    });
  });

  it.each([
    ["missing API", vi.fn().mockResolvedValue(new Response("Not found", { status: 404 }))],
    ["network failure", vi.fn().mockRejectedValue(new Error("offline"))],
    ["invalid response", vi.fn().mockResolvedValue(new Response(JSON.stringify({ available: true }), { status: 200 }))]
  ])("returns null for %s", async (_label, fetcher) => {
    await expect(probeCodexBackend(fetcher as typeof fetch)).resolves.toBeNull();
  });

  it("stops waiting when the backend probe times out", async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })
    );

    await expect(probeCodexBackend(fetcher, 5)).resolves.toBeNull();
  });
});
