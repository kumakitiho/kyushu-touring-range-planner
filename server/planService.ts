import type { PlanRequest, PlanResponse } from "../src/shared/types";
import { selectCodexCandidates, type CodexPlanProvider, type CodexProviderStatus } from "./codexProvider";
import {
  buildLocalPlans,
  buildPlanAroundAnchor,
  buildPlanFromSpotIds,
  buildPlanResponse,
  filterCandidates,
  focusForPlan
} from "./planner";

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
    if (selectedDrafts.some((draft) => draft.spotIds.some((id) => !allowedSpotIds.has(id)))) {
      throw new Error("Codex returned an invalid spot selection outside the registered candidates.");
    }
    if (selectedDrafts.length !== request.count) {
      throw new Error(
        `Codex returned an invalid spot selection: ${selectedDrafts.length} plans returned; ${request.count} are required.`
      );
    }

    const validPlans: Array<NonNullable<Awaited<ReturnType<typeof buildPlanFromSpotIds>>> | undefined> = Array(
      request.count
    );
    const remainingDrafts = [...selectedDrafts];
    const matchOrder = Array.from({ length: request.count }, (_, index) => index).sort(
      (a, b) => focusMatchPriority(focusForPlan(request, a)) - focusMatchPriority(focusForPlan(request, b))
    );
    for (const index of matchOrder) {
      const focus = focusForPlan(request, index);
      let matchedPlan: Awaited<ReturnType<typeof buildPlanFromSpotIds>> = null;
      for (let draftIndex = 0; draftIndex < remainingDrafts.length; draftIndex += 1) {
        const draft = remainingDrafts[draftIndex];
        const copy = {
          title: draft.title,
          summary: draft.summary,
          appeal: draft.appeal,
          bestFor: draft.bestFor,
          routeStory: draft.routeStory,
          preferenceFit: draft.preferenceFit,
          highlights: draft.highlights,
          cautions: draft.cautions
        };
        let plan = await buildPlanFromSpotIds(
          request,
          draft.spotIds,
          copy,
          "codex",
          allowedSpotIds,
          focus
        );
        if (!plan) {
          for (const anchorId of draft.spotIds) {
            plan = await buildPlanAroundAnchor(request, codexCandidates, anchorId, focus, copy, "codex");
            if (plan) break;
          }
        }
        if (!plan) continue;
        if (isDuplicatePlan(validPlans, plan)) continue;
        matchedPlan = plan;
        remainingDrafts.splice(draftIndex, 1);
        break;
      }
      if (!matchedPlan) {
        console.warn(
          "[codex-plan-validation]",
          JSON.stringify({
            focus,
            drafts: remainingDrafts.map((draft) => ({ spotIds: draft.spotIds }))
          })
        );
        throw new Error(`Codex returned no valid ${focus} plan from the registered candidates.`);
      }
      validPlans[index] = matchedPlan;
    }

    return buildPlanResponse(
      request,
      candidates,
      validPlans.filter((plan): plan is NonNullable<typeof plan> => Boolean(plan)),
      "codex",
      { providerStatus }
    );
  } catch (error) {
    return localFallback(request, error instanceof Error ? error.message : String(error), providerStatus);
  }
}

function focusMatchPriority(focus: ReturnType<typeof focusForPlan>): number {
  if (focus === "road") return 0;
  if (focus === "gourmet") return 1;
  return 2;
}

function isDuplicatePlan(
  plans: Array<NonNullable<Awaited<ReturnType<typeof buildPlanFromSpotIds>>> | undefined>,
  candidate: NonNullable<Awaited<ReturnType<typeof buildPlanFromSpotIds>>>
): boolean {
  const signature = candidate.stops.map((stop) => stop.spotId).join(">");
  const mainId = candidate.stops.find((stop) => candidate.title.includes(stop.name))?.spotId;
  return plans.some((plan) => {
    if (!plan) return false;
    const existingSignature = plan.stops.map((stop) => stop.spotId).join(">");
    const existingMainId = plan.stops.find((stop) => plan.title.includes(stop.name))?.spotId;
    return existingSignature === signature || (mainId !== undefined && existingMainId === mainId);
  });
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
