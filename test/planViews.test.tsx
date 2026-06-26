import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlanItinerary, PlanList } from "../src/App";
import type { Plan, PlanResponse, PlanStop } from "../src/shared/types";

const scenicStop: PlanStop = {
  spotId: "scenic-1",
  name: "海の展望台",
  category: "scenic",
  lat: 33.6,
  lng: 130.5,
  area: "福岡県",
  description: "海を見渡せる展望台です。",
  images: [],
  legNote: "海沿いを進みます。",
  whyStopHere: "主目的地として景色を楽しみます。",
  famousFor: "玄界灘の眺望",
  riderNote: "海風が強い日は注意。",
  recommendedAction: "展望台を歩く",
  timeHint: "30分",
  matchedPreferences: ["scenic"]
};

const gourmetStop: PlanStop = {
  ...scenicStop,
  spotId: "gourmet-1",
  name: "地元食堂",
  category: "gourmet",
  lat: 33.62,
  lng: 130.55,
  description: "名物を味わえる食堂です。",
  whyStopHere: "昼食に立ち寄ります。",
  famousFor: "地元の海鮮丼",
  riderNote: "昼前の到着が安心。",
  recommendedAction: "海鮮丼を食べる",
  timeHint: "45分",
  matchedPreferences: ["gourmet"]
};

const plan: Plan = {
  title: "海景色と名物ランチ",
  summary: "海沿いを走る日帰りルートです。",
  appeal: "玄界灘の景色と海鮮を一度に楽しめます。",
  bestFor: ["景色", "食事"],
  routeStory: "海の展望台を主目的地に、帰り道で昼食へ寄ります。",
  preferenceFit: ["景色を重視"],
  stops: [scenicStop, gourmetStop],
  estimatedDistanceKm: 120,
  estimatedDurationMin: 240,
  highwayUsage: "下道のみ",
  routeSource: "fallback",
  routeLine: [[33.59, 130.4], [33.6, 130.5], [33.59, 130.4]],
  highlights: ["海景色"],
  cautions: [],
  source: "local"
};

function response(plans: Plan[] = [plan]): PlanResponse {
  return {
    plans,
    reachableArea: { type: "approx_circle", center: [33.59, 130.4], radiusKm: 60, coordinates: [] },
    candidates: [],
    mode: "local",
    fallbackReason: "ローカル生成"
  };
}

describe("PlanList", () => {
  it("shows actionable guidance when no route candidate exists", () => {
    render(<PlanList response={response([])} selectedIndex={0} onSelectPlan={vi.fn()} onSelectSpot={vi.fn()} />);

    expect(screen.getByText(/時間や距離を広げるか、出発地点を変えてください/)).toBeInTheDocument();
  });

  it("shows comparison facts and forwards plan and stop selection", () => {
    const onSelectPlan = vi.fn();
    const onSelectSpot = vi.fn();
    render(<PlanList response={response()} selectedIndex={0} onSelectPlan={onSelectPlan} onSelectSpot={onSelectSpot} />);

    expect(screen.getByText("120km")).toBeInTheDocument();
    expect(screen.getByText("約240分")).toBeInTheDocument();
    expect(screen.getByText("景色向き")).toBeInTheDocument();
    expect(screen.getByText("食事あり")).toBeInTheDocument();
    expect(screen.getByText("簡易ルート")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("heading", { name: plan.title }).closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: /地元食堂/ }));

    expect(onSelectPlan).toHaveBeenCalledWith(plan, 0);
    expect(onSelectSpot).toHaveBeenCalledWith(gourmetStop, plan, 0);
  });

  it("does not claim that high-accuracy generation failed in the static public build", () => {
    render(
      <PlanList
        response={{
          ...response(),
          providerStatus: { codexAvailable: false, authMode: null, planType: null }
        }}
        selectedIndex={0}
        onSelectPlan={vi.fn()}
        onSelectSpot={vi.fn()}
      />
    );

    expect(screen.getByText("登録スポットから候補を整えました")).toBeInTheDocument();
    expect(screen.queryByText(/高精度提案の結果が使えなかった/)).not.toBeInTheDocument();
  });
});

describe("PlanItinerary", () => {
  it("shows the route story and the active stop's rider information", () => {
    const onSelectSpot = vi.fn();
    render(<PlanItinerary plan={plan} selectedSpot={scenicStop} onSelectSpot={onSelectSpot} />);

    expect(screen.getByText(plan.routeStory)).toBeInTheDocument();
    expect(screen.getByText("玄界灘の眺望")).toBeInTheDocument();
    expect(screen.getByText("海風が強い日は注意。")).toBeInTheDocument();
    expect(screen.getByText("30分")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /地元食堂/ }));
    expect(onSelectSpot).toHaveBeenCalledWith(gourmetStop);
  });
});
