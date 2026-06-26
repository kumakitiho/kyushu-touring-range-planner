export type CodexBackendStatus = {
  codexAvailable: boolean;
  authMode: string | null;
  planType: string | null;
  loginState?: string;
  message?: string;
};

export async function probeCodexBackend(fetcher: typeof fetch = fetch, timeoutMs = 3000): Promise<CodexBackendStatus | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher("/api/codex/status", {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) return null;

    const data = (await response.json()) as Partial<CodexBackendStatus>;
    if (typeof data.codexAvailable !== "boolean") return null;

    return {
      codexAvailable: data.codexAvailable,
      authMode: typeof data.authMode === "string" ? data.authMode : null,
      planType: typeof data.planType === "string" ? data.planType : null,
      loginState: typeof data.loginState === "string" ? data.loginState : undefined,
      message: typeof data.message === "string" ? data.message : undefined
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
