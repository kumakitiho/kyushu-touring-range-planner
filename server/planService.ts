import type { PlanRequest, PlanResponse } from "../src/shared/types";
import { selectCodexCandidates, type CodexPlanProvider, type CodexProviderStatus } from "./codexProvider";
import { buildLocalPlans, buildPlanFromSpotIds, buildPlanResponse, filterCandidates } from "./planner";

export async function buildPlansWithMode(
  request: PlanRequest,
  codexProvider: CodexPlanProvider
): Promise<PlanResponse> {
  if (request.generationMode === "local") {
    return buildLocalPlans(request);
  }

  const providerStatus = await safeStatus(codexProvider);
  if (!providerStatus.codexAvailable) return localFallback(request, providerStatus.message || "Codex app-serverを利用できません。", providerStatus);
  if (providerStatus.authMode !== "chatgpt") return localFallback(request, "CodexにChatGPTログインしていません。", providerStatus);

  if (providerStatus.rateLimitReason) return localFallback(request, providerStatus.rateLimitReason, providerStatus);

  try {
    const candidates = filterCandidates(request);
    const codexCandidates = selectCodexCandidates(candidates);
    const allowedSpotIds = new Set(codexCandidates.map((spot) => spot.id));
    const drafts = await codexProvider.generatePlanDrafts(request, codexCandidates);
    const selectedDrafts = drafts.slice(0, request.count);
    if (selectedDrafts.length === 0) throw new Error("Codex did not return valid spot candidates.");

    const plans = await Promise.all(
      selectedDrafts.map((draft) =>
        buildPlanFromSpotIds(
          request,
          draft.spotIds,
          {
            title: draft.title,
            summary: draft.summary,
            highlights: draft.highlights,
            cautions: draft.cautions
          },
          "codex",
          allowedSpotIds
        )
      )
    );

    if (plans.some((plan) => !plan)) throw new Error("Codex returned an invalid spot selection.");
    const validPlans = plans.filter((plan): plan is NonNullable<typeof plan> => Boolean(plan));
    return buildPlanResponse(request, candidates, validPlans, "codex", { providerStatus });
  } catch (error) {
    return localFallback(request, error instanceof Error ? error.message : String(error), providerStatus);
  }
}

async function localFallback(
  request: PlanRequest,
  fallbackReason: string,
  providerStatus?: CodexProviderStatus
): Promise<PlanResponse> {
  return withProviderStatus(await buildLocalPlans(request), providerStatus, fallbackReason);
}

function withProviderStatus(
  response: PlanResponse,
  providerStatus?: CodexProviderStatus,
  fallbackReason?: string
): PlanResponse {
  return {
    ...response,
    providerStatus: providerStatus
      ? {
          codexAvailable: providerStatus.codexAvailable,
          authMode: providerStatus.authMode,
          planType: providerStatus.planType
        }
      : undefined,
    fallbackReason
  };
}

async function safeStatus(codexProvider: CodexPlanProvider): Promise<CodexProviderStatus> {
  try {
    return await codexProvider.getStatus();
  } catch (error) {
    return {
      codexAvailable: false,
      authMode: null,
      planType: null,
      loginState: "unavailable",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
