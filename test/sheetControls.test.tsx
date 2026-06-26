import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mapFitKey, SheetCollapseButton, shouldSuppressSheetClick } from "../src/App";
import type { Plan } from "../src/shared/types";

describe("SheetCollapseButton", () => {
  it("is always available in full-screen mode and collapses the sheet", () => {
    const onCollapse = vi.fn();
    render(<SheetCollapseButton mode="full" onCollapse={onCollapse} />);

    fireEvent.click(screen.getByRole("button", { name: "シートを縮める" }));
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it("does not add a redundant control outside full-screen mode", () => {
    const { rerender } = render(<SheetCollapseButton mode="mid" onCollapse={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "シートを縮める" })).not.toBeInTheDocument();

    rerender(<SheetCollapseButton mode="peek" onCollapse={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "シートを縮める" })).not.toBeInTheDocument();
  });
});

describe("sheet map coordination", () => {
  it("suppresses the synthetic click only after a meaningful drag", () => {
    expect(shouldSuppressSheetClick(8)).toBe(false);
    expect(shouldSuppressSheetClick(-8)).toBe(false);
    expect(shouldSuppressSheetClick(9)).toBe(true);
    expect(shouldSuppressSheetClick(-9)).toBe(true);
  });

  it("changes the map fit key when the sheet mode changes", () => {
    const plan = {
      title: "test",
      routeLine: [[33.59, 130.4]],
      stops: [{ spotId: "spot-1" }]
    } as Plan;

    expect(mapFitKey(plan, "mid")).not.toBe(mapFitKey(plan, "full"));
  });
});
