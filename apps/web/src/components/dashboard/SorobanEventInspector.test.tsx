import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SorobanEventInspector,
  SAMPLE_SOROBAN_EVENTS,
} from "./SorobanEventInspector";

// Mock the SSE client hook
vi.mock("@/lib/sse-client", () => ({
  useSorobanEventStream: vi.fn(() => ({ connected: false })),
  SorobanEvent: {},
}));

describe("SorobanEventInspector Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders correctly with default sample events", () => {
    render(<SorobanEventInspector />);

    expect(screen.getByTestId("soroban-event-inspector")).toBeInTheDocument();
    expect(
      screen.getByText("Soroban Contract Event Explorer"),
    ).toBeInTheDocument();
    expect(screen.getByText(/3 Events Found/i)).toBeInTheDocument();
    expect(screen.getAllByText("evt_sac_transfer_001")[0]).toBeInTheDocument();
  });

  it("renders decoded XDR topic structure and JSON data payload", () => {
    render(<SorobanEventInspector events={SAMPLE_SOROBAN_EVENTS} />);

    expect(screen.getByText(/Topic\[0\]: transfer/i)).toBeInTheDocument();
    expect(screen.getByText(/AAAAEAAAAAh0cmFuc2Zlcg==/i)).toBeInTheDocument();

    const payloadTree = screen.getByTestId("json-payload-tree");
    expect(payloadTree.textContent).toContain("500.0000000");
    expect(payloadTree.textContent).toContain("USDC");
  });

  it("filters events dynamically by contract ID", () => {
    render(<SorobanEventInspector events={SAMPLE_SOROBAN_EVENTS} />);

    const contractInput = screen.getByTestId("contract-id-input");
    fireEvent.change(contractInput, {
      target: {
        value: "CCONTRACTAMMDEX33333333333333333333333333333333333333",
      },
    });

    expect(screen.getAllByText("evt_swap_003")[0]).toBeInTheDocument();
    expect(screen.queryByText("evt_sac_transfer_001")).not.toBeInTheDocument();
    expect(screen.getByText(/1 Event Found/i)).toBeInTheDocument();
  });

  it("filters events dynamically by topic symbol keyword", () => {
    render(<SorobanEventInspector events={SAMPLE_SOROBAN_EVENTS} />);

    const topicInput = screen.getByTestId("topic-symbol-input");
    fireEvent.change(topicInput, { target: { value: "mint" } });

    expect(screen.getAllByText("evt_mint_002")[0]).toBeInTheDocument();
    expect(screen.queryByText("evt_sac_transfer_001")).not.toBeInTheDocument();
    expect(screen.getByText(/1 Event Found/i)).toBeInTheDocument();
  });

  it("allows switching selected events to view detailed decoded XDR topics", () => {
    render(<SorobanEventInspector events={SAMPLE_SOROBAN_EVENTS} />);

    const swapButton = screen.getAllByTestId("event-item-evt_swap_003")[0];
    fireEvent.click(swapButton);

    expect(screen.getAllByText("evt_swap_003")[0]).toBeInTheDocument();
    expect(screen.getByText(/Topic\[0\]: swap/i)).toBeInTheDocument();
    expect(screen.getByTestId("json-payload-tree").textContent).toContain(
      "100.0000000",
    );
  });

  it("shows SSE connection status indicator", () => {
    render(<SorobanEventInspector />);

    // Should show buffered status when not connected
    expect(screen.getByText("⊘ Buffered")).toBeInTheDocument();
  });

  it("copies event JSON to clipboard when copy button is clicked", () => {
    const clipboardSpy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);

    render(<SorobanEventInspector events={SAMPLE_SOROBAN_EVENTS} />);

    const copyBtn = screen.getByRole("button", { name: /Copy JSON/i });
    fireEvent.click(copyBtn);

    expect(clipboardSpy).toHaveBeenCalled();
    expect(screen.getByText("Copied JSON")).toBeInTheDocument();

    clipboardSpy.mockRestore();
  });

  it("displays transaction hash when available", () => {
    render(<SorobanEventInspector events={SAMPLE_SOROBAN_EVENTS} />);

    const firstEventItem = screen.getAllByTestId(
      "event-item-evt_sac_transfer_001",
    )[0];
    fireEvent.click(firstEventItem);

    expect(screen.getByText(/Transaction Hash/i)).toBeInTheDocument();
    expect(screen.getByText("abc123def456")).toBeInTheDocument();
  });
});
