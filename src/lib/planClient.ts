import { buildLocalPlans } from "../../server/planner";
import { beginRoutingBudget } from "../../server/routing";
import { PlanResponseSchema, type PlanRequest, type PlanResponse } from "../shared/types";

const OFFLINE_FALLBACK_REASON = "高精度提案サーバーへ接続できないため、この端末の登録スポットから提案しました。";

export async function requestPlans(request: PlanRequest, fetcher: typeof fetch = fetch): Promise<PlanResponse> {
  try {
    const response = await fetcher("/api/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request)
    });
    if (!response.ok) throw new Error(`Plan API returned ${response.status}`);
    return PlanResponseSchema.parse(await response.json());
  } catch (error) {
    console.warn("Plan API unavailable; using bundled spot data", error);
    const finishRoutingBudget = beginRoutingBudget(12, 18_000);
    const response = await buildLocalPlans({ ...request, generationMode: "local" }).finally(finishRoutingBudget);
    return {
      ...response,
      fallbackReason: OFFLINE_FALLBACK_REASON,
      providerStatus: {
        codexAvailable: false,
        authMode: null,
        planType: null
      }
    };
  }
}
