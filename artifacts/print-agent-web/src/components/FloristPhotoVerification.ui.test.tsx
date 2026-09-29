import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import {
  FloristPhotoPublicationControl,
  FloristPhotoVerification,
} from "./FloristPhotoVerification";
import type {
  FloristOrderCard,
  FloristVerificationState,
} from "@workspace/api-client-react";

const {
  mockApiFetch,
  mockSetPhoto,
  mockRemovePhoto,
  mockVerify,
  mockUpdatePublication,
  mockToast,
} = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockSetPhoto: vi.fn(),
  mockRemovePhoto: vi.fn(),
  mockVerify: vi.fn(),
  mockUpdatePublication: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({ apiFetch: mockApiFetch }));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useSetFloristOrderPhoto: () => ({
      mutateAsync: mockSetPhoto,
      isPending: false,
    }),
    useRemoveFloristOrderPhoto: () => ({
      mutate: mockRemovePhoto,
      isPending: false,
    }),
    useVerifyFloristOrder: () => ({
      mutate: mockVerify,
      isPending: false,
    }),
    useUpdateOrderFloristPublication: () => ({
      mutateAsync: mockUpdatePublication,
      isPending: false,
    }),
  };
});

function order(overrides: Partial<FloristOrderCard> = {}): FloristOrderCard {
  return {
    id: 42,
    order_id: "order-42",
    order_number: "M-42",
    location_id: 1,
    location_name: "Main",
    status: "in_progress",
    has_card: false,
    has_cake: false,
    card_message: null,
    items: [],
    photo_items_path: null,
    photo_card_path: null,
    photo_card_on_box_path: null,
    verification_status: "none",
    ...overrides,
  };
}

function state(
  overrides: Partial<FloristVerificationState> = {},
): FloristVerificationState {
  return {
    photo_items_path: null,
    photo_card_path: null,
    photo_card_on_box_path: null,
    verification_status: "none",
    ...overrides,
  };
}

function Harness({ initial }: { initial: FloristOrderCard }) {
  const [current, setCurrent] = useState(initial);
  return (
    <FloristPhotoVerification
      fo={current}
      onChanged={vi.fn()}
      onVerificationChanged={(verification) =>
        setCurrent((value) => ({ ...value, ...verification }))
      }
    />
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
});

describe("FloristPhotoVerification state transitions", () => {
  it("names every missing required photo, including card taped to box for cake orders", () => {
    render(
      <Harness
        initial={order({
          has_card: true,
          has_cake: true,
          card_message: "Happy birthday",
        })}
      />,
    );

    expect(screen.getByTestId("missing-photos-42")).toHaveTextContent("Order items");
    expect(screen.getByTestId("missing-photos-42")).toHaveTextContent("Card message");
    expect(screen.getByTestId("missing-photos-42")).toHaveTextContent(
      "Card taped to box",
    );
    expect(screen.getByTestId("button-verify-42")).toBeDisabled();
  });

  it.each([
    {
      name: "items only",
      order: order({ photo_items_path: "/objects/ws/uploads/items" }),
    },
    {
      name: "items and card",
      order: order({
        has_card: true,
        card_message: "Hello",
        photo_items_path: "/objects/ws/uploads/items",
        photo_card_path: "/objects/ws/uploads/card",
      }),
    },
    {
      name: "items, card, and card on box",
      order: order({
        has_card: true,
        has_cake: true,
        card_message: "Hello",
        photo_items_path: "/objects/ws/uploads/items",
        photo_card_path: "/objects/ws/uploads/card",
        photo_card_on_box_path: "/objects/ws/uploads/box",
      }),
    },
  ])("enables Verify for the $name required-slot combination", ({ order: value }) => {
    render(<Harness initial={value} />);
    expect(screen.getByTestId("button-verify-42")).toBeEnabled();
    expect(screen.queryByTestId("missing-photos-42")).not.toBeInTheDocument();
  });

  it("shows an uploaded photo and enables Verify from the mutation response without a refetch", async () => {
    const user = userEvent.setup();
    const objectPath = "/objects/ws/uploads/new-items";
    mockApiFetch.mockResolvedValue({
      uploadURL: "https://upload.example/new-items",
      objectPath,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    mockSetPhoto.mockResolvedValue({
      success: true,
      verification: state({ photo_items_path: objectPath }),
    });

    render(<Harness initial={order()} />);
    const file = new File(["photo"], "items.jpg", { type: "image/jpeg" });
    await user.upload(screen.getByTestId("input-photo-library-items-42"), file);

    expect(await screen.findByTestId("img-photo-items-42")).toHaveAttribute(
      "src",
      expect.stringContaining(objectPath),
    );
    expect(screen.getByTestId("button-verify-42")).toBeEnabled();
  });

  it("replaces the preview with the returned path immediately", async () => {
    const user = userEvent.setup();
    const replacement = "/objects/ws/uploads/replacement";
    mockApiFetch.mockResolvedValue({
      uploadURL: "https://upload.example/replacement",
      objectPath: replacement,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    mockSetPhoto.mockResolvedValue({
      success: true,
      verification: state({ photo_items_path: replacement }),
    });

    render(
      <Harness
        initial={order({ photo_items_path: "/objects/ws/uploads/original" })}
      />,
    );
    await user.upload(
      screen.getByTestId("input-photo-camera-items-42"),
      new File(["replacement"], "replacement.jpg", { type: "image/jpeg" }),
    );

    expect(await screen.findByTestId("img-photo-items-42")).toHaveAttribute(
      "src",
      expect.stringContaining(replacement),
    );
  });

  it("removes a photo and disables Verify from the mutation response", async () => {
    const user = userEvent.setup();
    mockRemovePhoto.mockImplementation(
      (_variables: unknown, options: { onSuccess: (data: unknown) => void }) =>
        options.onSuccess({
          success: true,
          verification: state(),
        }),
    );

    render(
      <Harness
        initial={order({ photo_items_path: "/objects/ws/uploads/items" })}
      />,
    );
    expect(screen.getByTestId("button-verify-42")).toBeEnabled();
    await user.click(screen.getByTestId("button-remove-photo-items-42"));

    expect(await screen.findByTestId("missing-photos-42")).toHaveTextContent(
      "Order items",
    );
    expect(screen.getByTestId("button-verify-42")).toBeDisabled();
  });

  it("shows a useful unavailable state and retries a failed private preview", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404 }));
    render(
      <Harness
        initial={order({ photo_items_path: "/objects/ws/uploads/items" })}
      />,
    );

    fireEvent.error(screen.getByTestId("img-photo-items-42"));
    expect(
      await screen.findByTestId("photo-preview-failed-items-42"),
    ).toHaveTextContent("This photo preview is unavailable");

    await user.click(screen.getByTestId("button-retry-photo-preview-items-42"));
    await waitFor(() =>
      expect(screen.getByTestId("img-photo-items-42")).toBeInTheDocument(),
    );
  });
});

describe("FloristPhotoPublicationControl", () => {
  const assignment = {
    photo_items_path: "/objects/ws/uploads/items",
    photo_set_rev: 4,
    verification_status: "approved",
    parent_order_status: "completed",
    publication: {
      enabled: false,
      status: "not_selected" as const,
      photo_set_rev: 4,
      privacy_faces_clear: false,
      privacy_card_message_clear: false,
      privacy_address_clear: false,
      privacy_other_personal_info_clear: false,
      moderated_at: null,
      feed_eligibility: {
        eligible: false,
        eligible_photo_count: 0,
        reasons: ["minimum_three_photos" as const],
      },
    },
  };

  it("requires all privacy checks, saves the current revision, and refreshes to Featured", async () => {
    mockUpdatePublication.mockResolvedValue({
      success: true,
      publication: {
        ...assignment.publication,
        enabled: true,
        status: "pending",
        privacy_faces_clear: true,
        privacy_card_message_clear: true,
        privacy_address_clear: true,
        privacy_other_personal_info_clear: true,
      },
    });
    render(<FloristPhotoPublicationControl orderId="order-42" assignment={assignment} />);

    const featureButton = screen.getByTestId("button-feature-real-deliveries");
    expect(featureButton).toBeDisabled();
    for (const key of ["faces", "card", "address", "other"]) {
      fireEvent.click(screen.getByTestId(`checkbox-real-deliveries-${key}`));
    }
    expect(featureButton).toBeEnabled();
    await userEvent.click(featureButton);

    await waitFor(() => {
      expect(mockUpdatePublication).toHaveBeenCalledWith({
        id: "order-42",
        data: {
          enabled: true,
          photo_set_rev: 4,
          privacy_faces_clear: true,
          privacy_card_message_clear: true,
          privacy_address_clear: true,
          privacy_other_personal_info_clear: true,
        },
      });
      expect(screen.getByText("Featured")).toBeInTheDocument();
      expect(screen.getByTestId("button-feature-real-deliveries")).toHaveTextContent(
        "Remove from Real Deliveries",
      );
    });
  });

  it("explains why an unavailable current photo cannot be featured", () => {
    render(
      <FloristPhotoPublicationControl
        orderId="order-42"
        assignment={{
          ...assignment,
          photo_items_path: null,
          publication: {
            ...assignment.publication,
            status: "unavailable",
            feed_eligibility: {
              eligible: false,
              eligible_photo_count: 0,
              reasons: ["missing_photo"],
            },
          },
        }}
      />,
    );
    expect(screen.getByText("An approved order-items photo is required.")).toBeInTheDocument();
    expect(screen.getByTestId("button-feature-real-deliveries")).toBeDisabled();
  });
});