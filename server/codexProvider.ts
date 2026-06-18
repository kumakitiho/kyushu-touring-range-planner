import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { z } from "zod";
import type { PlanRequest, Spot } from "../src/shared/types";

export type CodexProviderStatus = {
  codexAvailable: boolean;
  authMode: string | null;
  planType: string | null;
  rateLimits?: unknown;
  rateLimitReason?: string | null;
  loginState?: "idle" | "pending" | "authenticated" | "unavailable";
  message?: string;
};

export type CodexLoginStart = {
  type: "chatgptDeviceCode" | "chatgpt" | "unavailable";
  loginId?: string;
  verificationUrl?: string;
  userCode?: string;
  authUrl?: string;
  message?: string;
};

export type CodexPlanDraft = {
  title?: string;
  summary?: string;
  spotIds: string[];
  highlights?: string[];
  cautions?: string[];
};

export interface CodexPlanProvider {
  getStatus(): Promise<CodexProviderStatus>;
  startLogin(): Promise<CodexLoginStart>;
  generatePlanDrafts(request: PlanRequest, candidates: Spot[]): Promise<CodexPlanDraft[]>;
}

const CodexDraftResponseSchema = z.object({
  plans: z.array(
    z.object({
      title: z.string().min(1).optional(),
      summary: z.string().min(1).optional(),
      spotIds: z.array(z.string()).min(1).max(5),
      highlights: z.array(z.string()).optional(),
      cautions: z.array(z.string()).optional()
    })
  )
});

type RpcMessage = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
  params?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type PendingTurn = {
  turnId: string;
  text: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  completedTextWaitTimeout?: NodeJS.Timeout;
};

type PendingTurnStart = {
  requestId: number;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type BufferedTurn = {
  text: string;
  completed?: {
    status?: string;
    error?: { message?: string } | null;
  };
};

const PLAN_SELECTOR_INSTRUCTIONS = [
  "You are an embedded JSON planner for a personal Kyushu motorcycle touring app.",
  "Your only job is to select realistic stop IDs from the candidate list supplied in the user message.",
  "Do not inspect files. Do not run commands. Do not browse the web. Do not call tools. Do not modify anything.",
  "Return only JSON that matches the provided output schema.",
  "Use only candidate spot IDs. Never invent spot IDs or places.",
  "Prefer one geographic direction from the origin, not east then west then backtracking."
].join("\n");

export function selectCodexCandidates(candidates: Spot[]): Spot[] {
  return candidates.slice(0, codexPlanCandidateLimit());
}

export class AppServerCodexProvider implements CodexPlanProvider {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private pendingTurns = new Map<string, PendingTurn>();
  private pendingTurnStartsByThreadId = new Map<string, PendingTurnStart>();
  private bufferedTurns = new Map<string, BufferedTurn>();
  private initialized: Promise<void> | null = null;
  private lastLoginState: CodexProviderStatus["loginState"] = "idle";
  private readonly sandboxCwd = createCodexSandboxCwd();

  async getStatus(): Promise<CodexProviderStatus> {
    try {
      await this.ensureStarted();
      const account = await this.request<{ account?: { type?: string; planType?: string }; requiresOpenaiAuth?: boolean }>(
        "account/read",
        { refreshToken: false },
        8000
      );
      const rateLimits = await this.request("account/rateLimits/read", undefined, 8000).catch(() => undefined);
      const authMode = account.account?.type ?? null;
      this.lastLoginState = authMode ? "authenticated" : this.lastLoginState === "pending" ? "pending" : "idle";
      return {
        codexAvailable: true,
        authMode,
        planType: account.account?.planType ?? null,
        rateLimits,
        rateLimitReason: readableRateLimitReason(rateLimits),
        loginState: this.lastLoginState
      };
    } catch (error) {
      return {
        codexAvailable: false,
        authMode: null,
        planType: null,
        loginState: "unavailable",
        message: errorMessage(error)
      };
    }
  }

  async startLogin(): Promise<CodexLoginStart> {
    try {
      await this.ensureStarted();
      const response = await this.startLoginWithDeviceCode().catch(() =>
        this.request<{ type: "chatgpt"; loginId: string; authUrl: string }>("account/login/start", { type: "chatgpt" }, 12000)
      );
      this.lastLoginState = "pending";
      if (response.type === "chatgptDeviceCode") {
        return {
          type: "chatgptDeviceCode",
          loginId: response.loginId,
          verificationUrl: response.verificationUrl,
          userCode: response.userCode
        };
      }
      return {
        type: "chatgpt",
        loginId: response.loginId,
        authUrl: response.authUrl
      };
    } catch (error) {
      return {
        type: "unavailable",
        message: errorMessage(error)
      };
    }
  }

  async generatePlanDrafts(request: PlanRequest, candidates: Spot[]): Promise<CodexPlanDraft[]> {
    if (candidates.length === 0) return [];
    const status = await this.getStatus();
    if (!status.codexAvailable) throw new Error(status.message || "Codex app-serverを起動できませんでした。");
    if (status.authMode !== "chatgpt") throw new Error("CodexにChatGPTログインしていません。");

    const model = codexPlanModel();
    const thread = await this.request<{ thread: { id: string } }>(
      "thread/start",
      {
        model,
        cwd: this.sandboxCwd,
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        personality: "none",
        baseInstructions: PLAN_SELECTOR_INSTRUCTIONS,
        developerInstructions: PLAN_SELECTOR_INSTRUCTIONS,
        config: {
          instructions: PLAN_SELECTOR_INSTRUCTIONS,
          developer_instructions: PLAN_SELECTOR_INSTRUCTIONS,
          model_reasoning_effort: "none",
          model_reasoning_summary: "none",
          web_search: "disabled",
          tools: { web_search: false, view_image: false }
        },
        ephemeral: true,
        experimentalRawEvents: false,
        serviceName: "kyushu_touring_range_planner"
      },
      15000
    );
    const threadId = thread.thread.id;
    const responseText = await this.startTurn(threadId, request, candidates, model);
    const parsed = CodexDraftResponseSchema.parse(JSON.parse(extractJson(responseText)));
    return parsed.plans;
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = this.start();
    return this.initialized;
  }

  private async start(): Promise<void> {
    const codexBin = process.env.CODEX_BIN || "codex";
    this.proc = spawn(codexBin, ["app-server", "--listen", "stdio://"], {
      cwd: this.sandboxCwd,
      env: buildCodexEnv(),
      shell: process.platform === "win32"
    });

    const proc = this.proc;
    proc.once("exit", (code) => {
      const error = new Error(`Codex app-serverが終了しました: ${code ?? "unknown"}`);
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(error);
      }
      for (const turn of this.pendingTurns.values()) {
        clearTimeout(turn.timeout);
        if (turn.completedTextWaitTimeout) clearTimeout(turn.completedTextWaitTimeout);
        turn.reject(error);
      }
      this.pending.clear();
      this.pendingTurns.clear();
      this.pendingTurnStartsByThreadId.clear();
      this.bufferedTurns.clear();
      this.proc = null;
      this.initialized = null;
    });

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => this.handleLine(line));
    proc.stderr.on("data", () => {
      // app-server progress logs are intentionally ignored; JSON-RPC is on stdout.
    });

    await this.request(
      "initialize",
      {
        clientInfo: {
          name: "kyushu_touring_range_planner",
          title: "Kyushu Touring Range Planner",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      },
      12000
    );
    this.notify("initialized", {});
  }

  private async startLoginWithDeviceCode(): Promise<{
    type: "chatgptDeviceCode";
    loginId: string;
    verificationUrl: string;
    userCode: string;
  }> {
    const response = await this.request<{
      type: "chatgptDeviceCode";
      loginId: string;
      verificationUrl: string;
      userCode: string;
    }>("account/login/start", { type: "chatgptDeviceCode" }, 12000);
    if (response.type !== "chatgptDeviceCode") throw new Error("device-codeログインは未対応です。");
    return response;
  }

  private startTurn(threadId: string, request: PlanRequest, candidates: Spot[], model: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.pendingTurnStartsByThreadId.delete(threadId);
        reject(new Error("Codexのプラン生成がタイムアウトしました。"));
      }, Number(process.env.CODEX_PLAN_TIMEOUT_MS || 60000));

      this.pendingTurnStartsByThreadId.set(threadId, { requestId: id, resolve, reject, timeout });

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          this.pendingTurnStartsByThreadId.delete(threadId);
          let turnId: string;
          try {
            turnId = turnIdFromResponse(value);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          const buffered = this.bufferedTurns.get(turnId);
          const turnTimeout = setTimeout(() => {
            this.pendingTurns.delete(turnId);
            this.bufferedTurns.delete(turnId);
            reject(new Error("Codexのプラン生成完了を待てませんでした。"));
          }, Number(process.env.CODEX_PLAN_TIMEOUT_MS || 60000));
          this.pendingTurns.set(turnId, {
            turnId,
            text: buffered?.text ?? "",
            resolve,
            reject,
            timeout: turnTimeout
          });
          if (buffered?.completed) this.finishTurn(turnId, buffered.completed);
        },
        reject,
        timeout
      });

      this.send({
        method: "turn/start",
        id,
        params: {
          threadId,
          input: [{ type: "text", text: buildPrompt(request, candidates), text_elements: [] }],
          cwd: this.sandboxCwd,
          model,
          approvalPolicy: "untrusted",
          effort: "none",
          summary: "none",
          personality: "none",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "restricted", includePlatformDefaults: true, readableRoots: [] }
          },
          outputSchema: codexOutputSchema()
        }
      });
    });
  }

  private request<T>(method: string, params?: unknown, timeoutMs = 10000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} がタイムアウトしました。`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });
      this.send(params === undefined ? { method, id } : { method, id, params });
    });
  }

  private notify(method: string, params: unknown) {
    this.send({ method, params });
  }

  private send(message: unknown) {
    if (!this.proc?.stdin.writable) throw new Error("Codex app-serverが起動していません。");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    this.recordEvent(message);

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        if (message.method) this.handleServerRequest(message.id, message.method);
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
    if (message.error) {
        this.cleanupPendingTurnStartByRequestId(message.id);
        pending.reject(new Error(message.error.message || "Codex app-server request failed."));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "account/login/completed") {
      const params = message.params as { success?: boolean } | undefined;
      this.lastLoginState = params?.success ? "authenticated" : "idle";
      return;
    }

    if (message.method === "error") {
      const params = message.params as { threadId?: string; turnId?: string; error?: { message?: string; additionalDetails?: string | null }; willRetry?: boolean } | undefined;
      const messageText = [params?.error?.message, params?.error?.additionalDetails].filter(Boolean).join(" ");
      const isTerminal = !params?.willRetry || isTerminalCodexError(messageText);
      const failedStart = params?.threadId && isTerminal ? this.failPendingTurnStart(params.threadId, messageText) : false;
      const failedAnyStart = !failedStart && isTerminal ? this.failAnyPendingTurnStart(messageText) : failedStart;
      if (params?.turnId && isTerminal && !failedAnyStart) {
        this.finishTurn(params.turnId, { status: "failed", error: { message: messageText || "Codex app-server error." } });
      } else if (!params?.turnId && isTerminalCodexError(messageText)) {
        this.failAllPendingTurns(messageText);
      }
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const params = message.params as { threadId?: string; turnId?: string; delta?: string } | undefined;
      if (params?.turnId) this.appendTurnText(params.turnId, params.delta ?? "", params.threadId);
      return;
    }

    if (message.method === "item/completed") {
      const params = message.params as { threadId?: string; turnId?: string; item?: { type?: string; text?: string } } | undefined;
      if (params?.turnId && params?.item?.type === "agentMessage" && params.item.text) {
        this.setTurnText(params.turnId, params.item.text, params.threadId);
      }
      return;
    }

    if (message.method === "turn/completed") {
      const params = message.params as { threadId?: string; turn?: { id?: string; status?: string; error?: { message?: string } | null } } | undefined;
      const turnId = params?.turn?.id;
      if (!turnId) return;
      this.finishTurn(turnId, params.turn, params.threadId);
      return;
      /*
      const turn = this.pendingTurns.get(turnId);
      if (!turn) return;
      this.pendingTurns.delete(turnId);
      clearTimeout(turn.timeout);
      if (params?.turn?.status === "failed") {
        turn.reject(new Error(params.turn.error?.message || "Codexの生成が失敗しました。"));
        return;
      }
      turn.resolve(turn.text);
      */
    }
  }

  private appendTurnText(turnId: string, text: string, threadId?: string) {
    this.promotePendingTurnStart(turnId, threadId);
    const turn = this.pendingTurns.get(turnId);
    if (turn) {
      turn.text += text;
      return;
    }
    const buffered = this.bufferedTurns.get(turnId) ?? { text: "" };
    buffered.text += text;
    this.bufferedTurns.set(turnId, buffered);
    this.scheduleBufferedTurnCleanup(turnId);
  }

  private setTurnText(turnId: string, text: string, threadId?: string) {
    this.promotePendingTurnStart(turnId, threadId);
    const turn = this.pendingTurns.get(turnId);
    if (turn) {
      turn.text = text;
      if (turn.completedTextWaitTimeout && turn.text.trim()) this.resolvePendingTurn(turnId, turn);
      return;
    }
    const buffered = this.bufferedTurns.get(turnId) ?? { text: "" };
    buffered.text = text;
    this.bufferedTurns.set(turnId, buffered);
    this.scheduleBufferedTurnCleanup(turnId);
  }

  private finishTurn(turnId: string, completed: BufferedTurn["completed"], threadId?: string) {
    this.promotePendingTurnStart(turnId, threadId);
    const turn = this.pendingTurns.get(turnId);
    if (!turn) {
      const buffered = this.bufferedTurns.get(turnId) ?? { text: "" };
      buffered.completed = completed;
      this.bufferedTurns.set(turnId, buffered);
      this.scheduleBufferedTurnCleanup(turnId);
      return;
    }
    if (completed?.status !== "completed") {
      this.pendingTurns.delete(turnId);
      this.bufferedTurns.delete(turnId);
      clearTimeout(turn.timeout);
      if (turn.completedTextWaitTimeout) clearTimeout(turn.completedTextWaitTimeout);
      turn.reject(new Error(completed?.error?.message || `Codex turn ended with status: ${completed?.status ?? "unknown"}`));
      return;
    }
    if (!turn.text.trim()) {
      this.resolveCompletedTurnAfterText(turnId);
      return;
    }
    this.resolvePendingTurn(turnId, turn);
  }

  private resolveCompletedTurnAfterText(turnId: string) {
    const turn = this.pendingTurns.get(turnId);
    if (!turn || turn.completedTextWaitTimeout) return;
    clearTimeout(turn.timeout);
    turn.completedTextWaitTimeout = setTimeout(() => {
      const turn = this.pendingTurns.get(turnId);
      if (!turn) return;
      this.pendingTurns.delete(turnId);
      this.bufferedTurns.delete(turnId);
      if (turn.completedTextWaitTimeout) clearTimeout(turn.completedTextWaitTimeout);
      if (turn.text.trim()) {
        turn.resolve(turn.text);
      } else {
        turn.reject(new Error("Codex completed without a plan response."));
      }
    }, Number(process.env.CODEX_COMPLETED_TEXT_WAIT_MS || 2000)).unref?.();
  }

  private resolvePendingTurn(turnId: string, turn: PendingTurn) {
    this.pendingTurns.delete(turnId);
    this.bufferedTurns.delete(turnId);
    clearTimeout(turn.timeout);
    if (turn.completedTextWaitTimeout) clearTimeout(turn.completedTextWaitTimeout);
    turn.resolve(turn.text);
  }

  private failAllPendingTurns(message: string) {
    for (const threadId of Array.from(this.pendingTurnStartsByThreadId.keys())) {
      this.failPendingTurnStart(threadId, message);
    }
    for (const [turnId, turn] of this.pendingTurns) {
      this.pendingTurns.delete(turnId);
      this.bufferedTurns.delete(turnId);
      clearTimeout(turn.timeout);
      if (turn.completedTextWaitTimeout) clearTimeout(turn.completedTextWaitTimeout);
      turn.reject(new Error(message || "Codex app-server error."));
    }
  }

  private failPendingTurnStart(threadId: string, message: string): boolean {
    const pendingStart = this.pendingTurnStartsByThreadId.get(threadId);
    if (!pendingStart) return false;
    this.pendingTurnStartsByThreadId.delete(threadId);
    this.pending.delete(pendingStart.requestId);
    clearTimeout(pendingStart.timeout);
    pendingStart.reject(new Error(message || "Codex app-server error."));
    return true;
  }

  private promotePendingTurnStart(turnId: string, threadId?: string): boolean {
    const pendingEntry = this.findPendingTurnStart(threadId, turnId);
    if (!pendingEntry) return false;
    const [pendingThreadId, pendingStart] = pendingEntry;
    this.pendingTurnStartsByThreadId.delete(pendingThreadId);
    this.pending.delete(pendingStart.requestId);
    clearTimeout(pendingStart.timeout);

    const buffered = this.bufferedTurns.get(turnId);
    const turnTimeout = setTimeout(() => {
      this.pendingTurns.delete(turnId);
      this.bufferedTurns.delete(turnId);
      pendingStart.reject(new Error("Codex plan generation completion timed out."));
    }, Number(process.env.CODEX_PLAN_TIMEOUT_MS || 60000));

    this.pendingTurns.set(turnId, {
      turnId,
      text: buffered?.text ?? "",
      resolve: pendingStart.resolve,
      reject: pendingStart.reject,
      timeout: turnTimeout
    });
    if (buffered?.completed) this.finishTurn(turnId, buffered.completed, pendingThreadId);
    return true;
  }

  private findPendingTurnStart(threadId: string | undefined, turnId: string): [string, PendingTurnStart] | null {
    if (threadId) {
      const pendingStart = this.pendingTurnStartsByThreadId.get(threadId);
      if (pendingStart) return [threadId, pendingStart];
    }
    if (!this.bufferedTurns.has(turnId)) return null;
    if (this.pendingTurnStartsByThreadId.size !== 1) return null;
    const first = this.pendingTurnStartsByThreadId.entries().next().value as [string, PendingTurnStart] | undefined;
    return first ?? null;
  }

  private failAnyPendingTurnStart(message: string): boolean {
    if (this.pendingTurnStartsByThreadId.size > 1) {
      for (const threadId of Array.from(this.pendingTurnStartsByThreadId.keys())) {
        this.failPendingTurnStart(threadId, message);
      }
      return true;
    }
    const firstThreadId = this.pendingTurnStartsByThreadId.keys().next().value as string | undefined;
    return firstThreadId ? this.failPendingTurnStart(firstThreadId, message) : false;
  }

  private cleanupPendingTurnStartByRequestId(requestId: number) {
    for (const [threadId, pendingStart] of this.pendingTurnStartsByThreadId) {
      if (pendingStart.requestId === requestId) {
        this.pendingTurnStartsByThreadId.delete(threadId);
        clearTimeout(pendingStart.timeout);
        return;
      }
    }
  }

  private scheduleBufferedTurnCleanup(turnId: string) {
    setTimeout(() => this.bufferedTurns.delete(turnId), Number(process.env.CODEX_PLAN_TIMEOUT_MS || 60000)).unref?.();
  }

  private handleServerRequest(id: number, method: string) {
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      this.send({
        id,
        result: {
          decision: "decline"
        }
      });
      return;
    }
    this.send({
      id,
      error: {
        code: -32601,
        message: `${method} is disabled for touring plan generation.`
      }
    });
  }

  private recordEvent(message: RpcMessage) {
    const method = message.method ?? (typeof message.id === "number" ? "response" : "unknown");
    if (!shouldRecordCodexEvent(method)) return;
    const params = message.params as
      | {
          threadId?: string;
          turnId?: string;
          item?: { type?: string; text?: string };
          turn?: { id?: string; status?: string; error?: { message?: string } | null };
          error?: { message?: string; additionalDetails?: string | null };
          willRetry?: boolean;
        }
      | undefined;
    const entry = {
      at: new Date().toISOString(),
      method,
      id: message.id,
      threadId: params?.threadId,
      turnId: params?.turnId ?? params?.turn?.id,
      status: params?.turn?.status,
      itemType: params?.item?.type,
      textLength: params?.item?.text?.length,
      errorMessage: params?.error?.message ?? params?.turn?.error?.message ?? message.error?.message,
      willRetry: params?.willRetry
    };
    try {
      mkdirSync(".codex-logs", { recursive: true });
      appendFileSync(path.join(".codex-logs", "codex-app-server-events.jsonl"), `${JSON.stringify(entry)}\n`);
    } catch {
      // Diagnostics must never affect plan generation.
    }
  }
}

function buildPrompt(request: PlanRequest, candidates: Spot[]): string {
  const candidateSummaries = selectCodexCandidates(candidates).map((spot) => ({
    id: spot.id,
    name: spot.name,
    category: spot.category,
    area: spot.area,
    lat: spot.lat,
    lng: spot.lng,
    tags: spot.tags,
    description: spot.description
  }));
  return [
    "あなたは九州在住のバイク乗りとして、日帰りツーリングの立ち寄りスポットを選びます。",
    "必ず候補に含まれるspot idだけを使ってください。存在しないスポットを作らないでください。",
    "出発地を中心に東西へ行って戻るような不自然な往復は避け、1プランは1つの方面にまとめてください。",
    "距離・時間・ルート形状はサーバー側で検証するため、あなたはspotIds、タイトル、要約、見どころ、注意点だけをJSONで返してください。",
    JSON.stringify({
      request,
      candidates: candidateSummaries,
      output: {
        plans: [
          {
            title: "string",
            summary: "string",
            spotIds: ["candidate-spot-id"],
            highlights: ["string"],
            cautions: ["string"]
          }
        ]
      }
    })
  ].join("\n");
}

function codexOutputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["plans"],
    properties: {
      plans: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "summary", "spotIds", "highlights", "cautions"],
          properties: {
            title: { type: "string" },
            summary: { type: "string" },
            spotIds: {
              type: "array",
              minItems: 1,
              maxItems: 5,
              items: { type: "string" }
            },
            highlights: { type: "array", items: { type: "string" } },
            cautions: { type: "array", items: { type: "string" } }
          }
        }
      }
    }
  };
}

function turnIdFromResponse(value: unknown): string {
  const parsed = z.object({ turn: z.object({ id: z.string() }) }).parse(value);
  return parsed.turn.id;
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match?.[1]) return match[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTerminalCodexError(message: string): boolean {
  return /usage limit|rate limit|premium|quota|try again/i.test(message);
}

function shouldRecordCodexEvent(method: string): boolean {
  return [
    "error",
    "turn/started",
    "turn/completed",
    "item/completed",
    "item/agentMessage/delta",
    "response"
  ].includes(method);
}

function codexPlanModel(): string {
  return process.env.CODEX_PLAN_MODEL || "gpt-5.4-mini";
}

function codexPlanCandidateLimit(): number {
  const value = Number(process.env.CODEX_PLAN_CANDIDATE_LIMIT || 24);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 24;
}

function createCodexSandboxCwd(): string {
  const sandboxCwd = path.join(tmpdir(), "kyushu-touring-range-planner-codex");
  mkdirSync(sandboxCwd, { recursive: true });
  return sandboxCwd;
}

function buildCodexEnv(): NodeJS.ProcessEnv {
  const allowedKeys = [
    "APPDATA",
    "CODEX_HOME",
    "COMSPEC",
    "HOME",
    "LOCALAPPDATA",
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "windir"
  ];
  return Object.fromEntries(allowedKeys.map((key) => [key, process.env[key]]).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

function rateLimitReason(rateLimits: unknown): string | null {
  const windows = collectRateLimitWindows(rateLimits);
  const exhausted = windows.find((window) => typeof window.usedPercent === "number" && window.usedPercent >= 100);
  if (!exhausted) return null;
  return exhausted.resetsAt
    ? `Codex rate limitに到達しています。${new Date(exhausted.resetsAt).toLocaleString("ja-JP")}以降に再試行できます。`
    : "Codex rate limitに到達しています。";
}

function collectRateLimitWindows(value: unknown): Array<{ usedPercent?: number; resetsAt?: number | null }> {
  if (!value || typeof value !== "object") return [];
  const windows: Array<{ usedPercent?: number; resetsAt?: number | null }> = [];
  const stack = [value as Record<string, unknown>];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    if (typeof current.usedPercent === "number") {
      windows.push({ usedPercent: current.usedPercent, resetsAt: typeof current.resetsAt === "number" ? current.resetsAt : null });
    }
    for (const child of Object.values(current)) {
      if (child && typeof child === "object") stack.push(child as Record<string, unknown>);
    }
  }
  return windows;
}

function readableRateLimitReason(rateLimits: unknown): string | null {
  const windows = collectRateLimitWindows(rateLimits);
  const exhausted = windows.find((window) => typeof window.usedPercent === "number" && window.usedPercent >= 100);
  if (!exhausted) return null;
  const resetTime = exhausted.resetsAt ? new Date(normalizeEpochMs(exhausted.resetsAt)).toLocaleString("ja-JP") : null;
  return resetTime
    ? `Codex rate limitに到達しています。${resetTime}以降に再試行できます。`
    : "Codex rate limitに到達しています。";
}

function normalizeEpochMs(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value;
}
