import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: apiFetchMock,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) =>
    queryKey[0] === "locations"
      ? { data: { locations: [{ id: 1, name: "Beirut Atelier" }] } }
      : { data: undefined },
}));

import CardMessageForm from "./CardMessageForm";

async function selectOption(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

async function selectPrintDetails(user: ReturnType<typeof userEvent.setup>) {
  await selectOption(user, "Location", "Beirut Atelier");
  await selectOption(user, "Shop Name", "Partner Flower Shop");
  await user.type(screen.getByLabelText("Order ID"), "ORD-42");
  await user.type(screen.getByLabelText("Card Message"), "Happy birthday!");
}

function printRequestBody() {
  const call = apiFetchMock.mock.calls.find(([url]) => url === "/api/card-message/print");
  expect(call).toBeDefined();
  return JSON.parse((call![1] as { body: string }).body) as Record<string, unknown>;
}

describe("CardMessageForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockImplementation((url: string) =>
      url === "/api/card-message/config"
        ? Promise.resolve({
            shops: ["Partner Flower Shop"],
            presentailShops: ["Presentail"],
          })
        : Promise.resolve({ ok: true }),
    );
  });

  it("shows To and From for a shop outside the Presentail shop list", async () => {
    const user = userEvent.setup();
    render(<CardMessageForm />);

    await selectOption(user, "Shop Name", "Partner Flower Shop");

    expect(screen.getByLabelText("To")).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Recipient name (optional)")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Sender name (optional)")).toBeInTheDocument();
  });

  it("sends trimmed optional names for any selected shop", async () => {
    const user = userEvent.setup();
    render(<CardMessageForm />);

    await selectPrintDetails(user);
    await user.type(screen.getByLabelText("To"), "  Amina  ");
    await user.type(screen.getByLabelText("From"), "  Omar  ");
    await user.click(screen.getByRole("button", { name: /Print Card/ }));

    await vi.waitFor(() => {
      expect(printRequestBody()).toMatchObject({
        location: "Beirut Atelier",
        shopName: "Partner Flower Shop",
        orderId: "ORD-42",
        cardMessage: "Happy birthday!",
        toName: "Amina",
        fromName: "Omar",
      });
    });
  });

  it("allows printing when optional names are blank and omits them from the request", async () => {
    const user = userEvent.setup();
    render(<CardMessageForm />);

    await selectPrintDetails(user);

    expect(screen.getByRole("button", { name: /Print Card/ })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /Print Card/ }));

    await vi.waitFor(() => {
      expect(printRequestBody()).toEqual({
        location: "Beirut Atelier",
        shopName: "Partner Flower Shop",
        orderId: "ORD-42",
        cardMessage: "Happy birthday!",
      });
    });
  });
  it("switches to cake-only fields and sends only location and message", async () => {
    const user = userEvent.setup();
    render(<CardMessageForm />);
    expect(screen.getByRole("checkbox", { name: "Cake message" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Cake message" }));
    expect(screen.queryByLabelText("Shop Name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Order ID")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("To")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
    await selectOption(user, "Location", "Jdeideh");
    await user.type(screen.getByLabelText("Cake Message"), "  Happy birthday!  ");
    await user.click(screen.getByRole("button", { name: "Print Cake Message" }));
    await vi.waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/api/card-message/print-cake", expect.objectContaining({
        body: JSON.stringify({ location: "Jdeideh", cakeMessage: "Happy birthday!" }),
      }));
    });
    expect(await screen.findByText("Cake message sent to printer.")).toBeInTheDocument();
  });
  it("shows a cake-specific failure and restores the card form", async () => {
    const user = userEvent.setup();
    render(<CardMessageForm />);
    await user.click(screen.getByRole("checkbox", { name: "Cake message" }));
    await selectOption(user, "Location", "Achrafieh");
    await user.type(screen.getByLabelText("Cake Message"), "Hi");
    apiFetchMock.mockRejectedValueOnce(new Error("webhook_error"));
    await user.click(screen.getByRole("button", { name: "Print Cake Message" }));
    expect(await screen.findByText("Failed to send cake message to printer.")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Cake message" }));
    expect(screen.getByLabelText("Shop Name")).toBeInTheDocument();
  });
});