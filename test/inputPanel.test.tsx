import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InputPanel } from "../src/App";

const baseProps = {
  origin: { label: "福岡・天神", lat: 33.5902, lng: 130.4017, source: "preset" as const },
  geoState: "idle" as const,
  constraintType: "duration" as const,
  constraintValue: 240,
  highwayMode: "none" as const,
  preferences: { gourmet: "medium", scenic: "medium", road: "medium", relaxed: "low" } as const,
  tripStyle: "day_trip" as const,
  generationMode: "auto" as const,
  codexStatus: null,
  codexLogin: null,
  onUseCurrentLocation: vi.fn(),
  onPickOriginOnMap: vi.fn(),
  onOriginChange: vi.fn(),
  onConstraintTypeChange: vi.fn(),
  onConstraintValueChange: vi.fn(),
  onHighwayModeChange: vi.fn(),
  onPreferencesChange: vi.fn(),
  onTripStyleChange: vi.fn(),
  onGenerationModeChange: vi.fn(),
  onStartCodexLogin: vi.fn(),
  onRefreshCodexStatus: vi.fn(),
  isCodexLoginLoading: false
};

function openDetails() {
  fireEvent.click(screen.getByRole("button", { name: /こだわり条件/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("InputPanel trip controls", () => {
  it("exposes current-location and map-origin actions", () => {
    render(<InputPanel {...baseProps} codexBackendAvailable={false} />);

    fireEvent.click(screen.getByRole("button", { name: "現在地" }));
    fireEvent.click(screen.getByRole("button", { name: "地図" }));

    expect(baseProps.onUseCurrentLocation).toHaveBeenCalledOnce();
    expect(baseProps.onPickOriginOnMap).toHaveBeenCalledOnce();
  });

  it("switches between duration and distance and updates the range value", () => {
    render(<InputPanel {...baseProps} codexBackendAvailable={false} />);

    expect(screen.getByRole("button", { name: "走行時間で指定" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "走行距離で指定" }));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "300" } });

    expect(baseProps.onConstraintTypeChange).toHaveBeenCalledWith("distance");
    expect(baseProps.onConstraintValueChange).toHaveBeenCalledWith(300);
  });

  it("updates preset, highway, preferences, and trip style", () => {
    render(<InputPanel {...baseProps} codexBackendAvailable={true} />);
    openDetails();

    fireEvent.click(screen.getByRole("button", { name: /熊本駅/ }));
    fireEvent.click(screen.getByRole("button", { name: /高速あり/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "景色" })).getByRole("button", { name: "重視" }));
    fireEvent.click(within(screen.getByRole("group", { name: "グルメ" })).getByRole("button", { name: "軽め" }));
    fireEvent.click(within(screen.getByRole("group", { name: "余裕" })).getByRole("button", { name: "ゆったり" }));
    fireEvent.click(screen.getByRole("button", { name: "半日" }));

    expect(baseProps.onOriginChange).toHaveBeenCalledWith(expect.objectContaining({ label: "熊本駅", source: "preset" }));
    expect(baseProps.onHighwayModeChange).toHaveBeenCalledWith("full");
    expect(baseProps.onPreferencesChange).toHaveBeenCalledWith(expect.objectContaining({ scenic: "high" }));
    expect(baseProps.onPreferencesChange).toHaveBeenCalledWith(expect.objectContaining({ gourmet: "low" }));
    expect(baseProps.onPreferencesChange).toHaveBeenCalledWith(expect.objectContaining({ relaxed: "high" }));
    expect(baseProps.onTripStyleChange).toHaveBeenCalledWith("half_day");
  });

  it("passes the selected generation mode when the backend exists", () => {
    render(<InputPanel {...baseProps} codexBackendAvailable={true} />);
    openDetails();

    fireEvent.click(screen.getByRole("button", { name: /登録データ/ }));

    expect(baseProps.onGenerationModeChange).toHaveBeenCalledWith("local");
  });
});

describe("InputPanel proposal provider UI", () => {
  it("hides unusable ChatGPT login on the public build", () => {
    render(<InputPanel {...baseProps} codexBackendAvailable={false} />);
    openDetails();

    expect(screen.getByText("公開版では登録済みスポットから提案します。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ログイン" })).not.toBeInTheDocument();
  });

  it("shows provider controls when the local backend exists", () => {
    render(<InputPanel {...baseProps} codexBackendAvailable={true} />);
    openDetails();

    expect(screen.getByRole("button", { name: "ログイン" })).toBeInTheDocument();
    expect(screen.getByText("高精度提案")).toBeInTheDocument();
  });
});
