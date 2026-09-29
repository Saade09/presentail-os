import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { WizardContact } from "@workspace/api-client-react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const i18nState = vi.hoisted(() => ({ language: "en" }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: i18nState,
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === "orders.co.duplicateFound") return `Duplicate: ${opts?.name ?? ""}`;
      if (key === "orders.co.ordersCount") return `${opts?.count} orders`;
      if (key === "orders.co.deliveriesCount") return `${opts?.count} deliveries`;
      if (key === "orders.co.lastOrder") return `Last order ${opts?.date}`;
      return key;
    },
  }),
}));

const mockRefetch = vi.fn();
let searchState: { data?: unknown; isLoading: boolean; isError?: boolean; refetch?: () => void } = {
  isLoading: false,
  refetch: mockRefetch,
};
let dupState: { data?: unknown; isLoading: boolean } = { isLoading: false };
const mockSearchHook = vi.fn(() => searchState);
const mockDupHook = vi.fn(() => dupState);
const mockMutate = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useWizardSearchContacts: (...args: unknown[]) => mockSearchHook(...(args as [])),
  useWizardDuplicateCheckContact: (...args: unknown[]) => mockDupHook(...(args as [])),
  useWizardCreateContact: () => ({ mutate: mockMutate, isPending: false }),
  getWizardSearchContactsQueryKey: (p: unknown) => ["/api/contacts/wizard-search", p],
  getWizardDuplicateCheckContactQueryKey: (p: unknown) => [
    "/api/contacts/wizard-duplicate-check",
    p,
  ],
}));

import {
  ContactSearchPicker,
  contactDisplayName,
  CREATE_CONTACT_PHONE_COUNTRIES,
  seedPhoneFromQuery,
} from "./ContactSearchPicker";

const jane: WizardContact = {
  id: "c-1",
  first_name: "Jane",
  last_name: "Doe",
  display_name: "Jane Doe",
  email: "jane@example.com",
  phone: "+96170123456",
  orders_placed: 3,
  last_order_at: "2026-07-01T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  i18nState.language = "en";
  searchState = { isLoading: false, refetch: mockRefetch };
  dupState = { isLoading: false };
});

// ---------------------------------------------------------------------------
// contactDisplayName
// ---------------------------------------------------------------------------

describe("contactDisplayName", () => {
  it("prefers display_name, then first+last, then email, then phone", () => {
    expect(contactDisplayName(jane)).toBe("Jane Doe");
    expect(contactDisplayName({ ...jane, display_name: null })).toBe("Jane Doe");
    expect(
      contactDisplayName({ ...jane, display_name: null, first_name: null, last_name: null }),
    ).toBe("jane@example.com");
    expect(
      contactDisplayName({
        ...jane,
        display_name: null,
        first_name: null,
        last_name: null,
        email: null,
      }),
    ).toBe("+96170123456");
  });
});

// ---------------------------------------------------------------------------
// seedPhoneFromQuery
// ---------------------------------------------------------------------------

describe("seedPhoneFromQuery", () => {
  it("keeps + prefixed input as international, stripping formatting", () => {
    expect(seedPhoneFromQuery("+961 70 123")).toBe("+96170123");
  });
  it("promotes bare digits to international when a country is derivable", () => {
    expect(seedPhoneFromQuery("96170312345")).toBe("+96170312345");
  });
  it("leaves short/undeterminable digits as-is", () => {
    expect(seedPhoneFromQuery("701")).toBe("701");
  });
  it("returns empty string for non-digit input", () => {
    expect(seedPhoneFromQuery("()- ")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

describe("ContactSearchPicker", () => {
  it("renders a combobox search input and typing shows results", async () => {
    searchState = { isLoading: false, data: { results: [jane] } };
    const onSelect = vi.fn();
    render(
      <ContactSearchPicker
        mode="customer"
        selected={null}
        onSelect={onSelect}
        testIdPrefix="cust"
      />,
    );
    const input = screen.getByTestId("cust-search");
    expect(input).toHaveAttribute("role", "combobox");
    fireEvent.change(input, { target: { value: "jane" } });

    await waitFor(() => expect(screen.getByTestId("cust-result-c-1")).toBeInTheDocument());
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByText("3 orders")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("cust-result-c-1"));
    expect(onSelect).toHaveBeenCalledWith(jane);
  });

  it("supports keyboard navigation: ArrowDown + Enter selects a result", async () => {
    searchState = { isLoading: false, data: { results: [jane] } };
    const onSelect = vi.fn();
    render(
      <ContactSearchPicker
        mode="customer"
        selected={null}
        onSelect={onSelect}
        testIdPrefix="cust"
      />,
    );
    const input = screen.getByTestId("cust-search");
    fireEvent.change(input, { target: { value: "jane" } });
    await waitFor(() => expect(screen.getByTestId("cust-result-c-1")).toBeInTheDocument());

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(jane);
  });

  it("shows the selected contact card with a change button", () => {
    const onSelect = vi.fn();
    render(
      <ContactSearchPicker
        mode="customer"
        selected={jane}
        onSelect={onSelect}
        testIdPrefix="cust"
      />,
    );
    expect(screen.getByTestId("cust-selected")).toHaveTextContent("Jane Doe");
    fireEvent.click(screen.getByTestId("cust-clear"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("shows saved-recipient badge in recipient mode", async () => {
    searchState = {
      isLoading: false,
      data: {
        results: [
          { ...jane, is_saved_recipient: true, deliveries_count: 2, last_delivery_city: "Beirut" },
        ],
      },
    };
    render(
      <ContactSearchPicker
        mode="recipient"
        customerContactId="cust-9"
        selected={null}
        onSelect={vi.fn()}
        testIdPrefix="recip"
      />,
    );
    fireEvent.change(screen.getByTestId("recip-search"), { target: { value: "jane" } });
    await waitFor(() =>
      expect(screen.getByText("orders.co.savedRecipient")).toBeInTheDocument(),
    );
    expect(screen.getByText("2 deliveries")).toBeInTheDocument();
    expect(screen.getByText("Beirut")).toBeInTheDocument();
  });

  it("create form validates that phone or email is required", () => {
    render(
      <ContactSearchPicker mode="customer" selected={null} onSelect={vi.fn()} testIdPrefix="cust" />,
    );
    fireEvent.click(screen.getByTestId("cust-show-create"));
    fireEvent.change(screen.getByTestId("cust-new-name"), { target: { value: "Jane" } });
    fireEvent.click(screen.getByTestId("cust-create-submit"));
    expect(screen.getByText("orders.co.contactNeedsPhoneOrEmail")).toBeInTheDocument();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("seeds the create form from a phone-like search query", () => {
    render(
      <ContactSearchPicker mode="customer" selected={null} onSelect={vi.fn()} testIdPrefix="cust" />,
    );
    fireEvent.change(screen.getByTestId("cust-search"), { target: { value: "+961 70 123" } });
    fireEvent.click(screen.getByTestId("cust-show-create"));
    expect(screen.getByTestId("cust-new-phone")).toHaveValue("+961 70 123");
  });

  it("seeds the create form from a bare-digit international search query", () => {
    render(
      <ContactSearchPicker mode="customer" selected={null} onSelect={vi.fn()} testIdPrefix="cust" />,
    );
    fireEvent.change(screen.getByTestId("cust-search"), { target: { value: "96170312345" } });
    fireEvent.click(screen.getByTestId("cust-show-create"));
    expect(screen.getByTestId("cust-new-phone")).toHaveValue("+961 70 312 345");
  });

  it("submits the create form with an E.164 phone and selects the created contact", () => {
    const onSelect = vi.fn();
    mockMutate.mockImplementation((_vars, opts?: { onSuccess?: (r: unknown) => void }) => {
      opts?.onSuccess?.({ contact: jane, existing: false });
    });
    render(
      <ContactSearchPicker mode="customer" selected={null} onSelect={onSelect} testIdPrefix="cust" />,
    );
    fireEvent.click(screen.getByTestId("cust-show-create"));
    fireEvent.change(screen.getByTestId("cust-new-name"), { target: { value: "Jane Doe" } });
    // Default country is LB, so a national number becomes +961...
    fireEvent.change(screen.getByTestId("cust-new-phone"), { target: { value: "70123456" } });
    fireEvent.click(screen.getByTestId("cust-create-submit"));

    expect(mockMutate).toHaveBeenCalledWith(
      { data: { display_name: "Jane Doe", email: null, phone: "+96170123456" } },
      expect.anything(),
    );
    expect(onSelect).toHaveBeenCalledWith(jane);
  });

  it("selects a resolved existing contact from a normal success response", () => {
    const onSelect = vi.fn();
    mockMutate.mockImplementation((_vars, opts?: { onSuccess?: (r: unknown) => void }) => {
      opts?.onSuccess?.({ contact: jane, existing: true });
    });
    render(
      <ContactSearchPicker mode="customer" selected={null} onSelect={onSelect} testIdPrefix="cust" />,
    );
    fireEvent.click(screen.getByTestId("cust-show-create"));
    fireEvent.change(screen.getByTestId("cust-new-name"), { target: { value: "Jane Doe" } });
    fireEvent.change(screen.getByTestId("cust-new-phone"), { target: { value: "70123456" } });
    fireEvent.click(screen.getByTestId("cust-create-submit"));

    expect(onSelect).toHaveBeenCalledWith(jane);
    expect(screen.queryByText("orders.co.contactDuplicateError")).not.toBeInTheDocument();
  });

  it.each([
    ["customer", "cust", "+971501234567"],
    ["recipient", "recip", "+971501234567"],
  ] as const)(
    "allows selecting a non-default country in the %s create form and submits its E.164 phone",
    (mode, testIdPrefix, expectedPhone) => {
      const onSelect = vi.fn();
      mockMutate.mockImplementation((_vars, opts?: { onSuccess?: (r: unknown) => void }) => {
        opts?.onSuccess?.({ contact: jane, existing: false });
      });
      render(
        <ContactSearchPicker
          mode={mode}
          selected={null}
          onSelect={onSelect}
          testIdPrefix={testIdPrefix}
        />,
      );
      fireEvent.click(screen.getByTestId(`${testIdPrefix}-show-create`));

      const countrySelect = screen.getByTestId(`${testIdPrefix}-new-phone-country`);
      expect(countrySelect).toHaveAccessibleName("orders.co.phoneCountry");
      expect(countrySelect.querySelectorAll("option")).toHaveLength(
        CREATE_CONTACT_PHONE_COUNTRIES.length,
      );
      expect(
        screen.getByRole("option", { name: "United Arab Emirates (+971)" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /Israel/ })).not.toBeInTheDocument();

      fireEvent.change(countrySelect, { target: { value: "AE" } });
      fireEvent.change(screen.getByTestId(`${testIdPrefix}-new-phone`), {
        target: { value: "501234567" },
      });
      fireEvent.change(screen.getByTestId(`${testIdPrefix}-new-name`), {
        target: { value: "Jane Doe" },
      });
      fireEvent.click(screen.getByTestId(`${testIdPrefix}-create-submit`));

      expect(mockMutate).toHaveBeenCalledWith(
        { data: { display_name: "Jane Doe", email: null, phone: expectedPhone } },
        expect.anything(),
      );
      expect(onSelect).toHaveBeenCalledWith(jane);
    },
  );

  it("uses localized country names and calling codes in an Arabic/RTL create form", () => {
    i18nState.language = "ar";
    document.documentElement.dir = "rtl";
    render(
      <ContactSearchPicker mode="customer" selected={null} onSelect={vi.fn()} testIdPrefix="cust" />,
    );
    fireEvent.click(screen.getByTestId("cust-show-create"));

    const countrySelect = screen.getByTestId("cust-new-phone-country");
    expect(countrySelect).toHaveAccessibleName("orders.co.phoneCountry");
    expect(
      screen.getByRole("option", { name: "الإمارات العربية المتحدة (+971)" }),
    ).toBeInTheDocument();
    expect(countrySelect).toBeVisible();
  });

  it("rejects an incomplete phone number with a validation message", () => {
    render(
      <ContactSearchPicker mode="customer" selected={null} onSelect={vi.fn()} testIdPrefix="cust" />,
    );
    fireEvent.click(screen.getByTestId("cust-show-create"));
    fireEvent.change(screen.getByTestId("cust-new-phone"), { target: { value: "701" } });
    fireEvent.click(screen.getByTestId("cust-create-submit"));
    expect(screen.getByText("orders.co.contactPhoneInvalid")).toBeInTheDocument();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("shows a distinct error state with a retry button when the search fails", async () => {
    searchState = { isLoading: false, isError: true, refetch: mockRefetch };
    render(
      <ContactSearchPicker mode="customer" selected={null} onSelect={vi.fn()} testIdPrefix="cust" />,
    );
    fireEvent.change(screen.getByTestId("cust-search"), { target: { value: "jane" } });

    await waitFor(() => expect(screen.getByTestId("cust-search-error")).toBeInTheDocument());
    expect(screen.getAllByText("orders.co.searchError").length).toBeGreaterThan(0);
    // The error state must NOT look like an empty result set.
    expect(screen.queryByText("orders.co.noContactsFound")).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("cust-search-retry"));
    expect(mockRefetch).toHaveBeenCalled();
  });

  it("announces search status via an aria-live region", async () => {
    searchState = { isLoading: false, data: { results: [jane] }, refetch: mockRefetch };
    render(
      <ContactSearchPicker mode="customer" selected={null} onSelect={vi.fn()} testIdPrefix="cust" />,
    );
    fireEvent.change(screen.getByTestId("cust-search"), { target: { value: "jane" } });
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").some((el) => el.textContent === "orders.co.resultsCount"),
      ).toBe(true),
    );
  });

  it("announces the selected contact via an aria-live region", () => {
    render(
      <ContactSearchPicker mode="customer" selected={jane} onSelect={vi.fn()} testIdPrefix="cust" />,
    );
    expect(
      screen.getAllByRole("status").some((el) => el.textContent === "orders.co.contactSelected"),
    ).toBe(true);
  });

  it("shows the duplicate hint and lets the user pick the existing contact", async () => {
    dupState = { isLoading: false, data: { match: jane, matched_field: "phone" } };
    const onSelect = vi.fn();
    render(
      <ContactSearchPicker mode="customer" selected={null} onSelect={onSelect} testIdPrefix="cust" />,
    );
    fireEvent.click(screen.getByTestId("cust-show-create"));
    await waitFor(() => expect(screen.getByTestId("cust-duplicate-hint")).toBeInTheDocument());
    expect(screen.getByTestId("cust-duplicate-hint")).toHaveTextContent("Duplicate: Jane Doe");

    fireEvent.click(screen.getByTestId("cust-use-existing"));
    expect(onSelect).toHaveBeenCalledWith(jane);
  });
});
