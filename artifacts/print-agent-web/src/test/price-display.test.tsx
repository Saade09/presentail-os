import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { formatAED, formatUSD } from "@/lib/utils";
import { PriceText } from "@/components/ui/price-text";

/**
 * These tests exercise the rendering pattern used in product display components:
 *   Products.tsx:      <PriceText value={formatUSD(product.price_usd)} />
 *                      <PriceText value={formatAED(product.price_aed)} />
 *   ProductDetail.tsx: <p><PriceText value={formatUSD(product.price_usd)} /></p>
 *                      <p><PriceText value={formatAED(product.price_aed)} /></p>
 *   BrandDetail.tsx:   <PriceText value={formatUSD(...)} /> · <PriceText value={formatAED(...)} />
 *
 * Instead of mounting those heavyweight page components, we render the same
 * expression in an isolated element to verify the fallback text reaches the DOM.
 */

function renderAED(price_aed: string | number | null | undefined) {
  return render(<span data-testid="price">{formatAED(price_aed)}</span>);
}

function renderUSD(price_usd: string | number | null | undefined) {
  return render(<span data-testid="price">{formatUSD(price_usd)}</span>);
}

describe("product price display — invalid price_aed shows fallback", () => {
  it("renders a valid AED price normally", () => {
    renderAED(150);
    expect(screen.getByTestId("price")).toHaveTextContent("150 AED");
  });

  it("renders '—' when price_aed is null (missing from API)", () => {
    renderAED(null);
    expect(screen.getByTestId("price")).toHaveTextContent("—");
  });

  it("renders '—' when price_aed is undefined", () => {
    renderAED(undefined);
    expect(screen.getByTestId("price")).toHaveTextContent("—");
  });

  it("renders '—' when price_aed is NaN", () => {
    renderAED(NaN);
    expect(screen.getByTestId("price")).toHaveTextContent("—");
  });

  it("renders '—' when price_aed is Infinity", () => {
    renderAED(Infinity);
    expect(screen.getByTestId("price")).toHaveTextContent("—");
  });

  it("renders '—' when price_aed is a non-numeric string", () => {
    renderAED("invalid");
    expect(screen.getByTestId("price")).toHaveTextContent("—");
  });

  it("renders '—' when price_aed is a partial numeric string like '12abc'", () => {
    renderAED("12abc");
    expect(screen.getByTestId("price")).toHaveTextContent("—");
  });

  it("renders '—' when price_aed is an empty string", () => {
    renderAED("");
    expect(screen.getByTestId("price")).toHaveTextContent("—");
  });

  it("never renders 'NaN AED' for any invalid input", () => {
    const cases: Array<string | number | null | undefined> = [
      NaN, "bad", "12abc", null, undefined, Infinity, "",
    ];
    for (const c of cases) {
      const { unmount } = renderAED(c);
      expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe("product price display — invalid price_usd shows fallback", () => {
  it("renders a valid USD price normally", () => {
    renderUSD(75.5);
    expect(screen.getByTestId("price")).toHaveTextContent("$75.50 USD");
  });

  it("renders a string USD price normally", () => {
    renderUSD("12.99");
    expect(screen.getByTestId("price")).toHaveTextContent("$12.99 USD");
  });

  it("renders '—' when price_usd is null (missing from API)", () => {
    renderUSD(null);
    expect(screen.getByTestId("price")).toHaveTextContent("—");
  });

  it("renders '—' when price_usd is undefined", () => {
    renderUSD(undefined);
    expect(screen.getByTestId("price")).toHaveTextContent("—");
  });

  it("renders '—' when price_usd is NaN", () => {
    renderUSD(NaN);
    expect(screen.getByTestId("price")).toHaveTextContent("—");
  });

  it("renders '—' when price_usd is Infinity", () => {
    renderUSD(Infinity);
    expect(screen.getByTestId("price")).toHaveTextContent("—");
  });

  it("renders '—' when price_usd is a non-numeric string", () => {
    renderUSD("invalid");
    expect(screen.getByTestId("price")).toHaveTextContent("—");
  });

  it("renders '—' when price_usd is an empty string", () => {
    renderUSD("");
    expect(screen.getByTestId("price")).toHaveTextContent("—");
  });

  it("never renders 'NaN' for any invalid USD input", () => {
    const cases: Array<string | number | null | undefined> = [
      NaN, "bad", "12abc", null, undefined, Infinity, "",
    ];
    for (const c of cases) {
      const { unmount } = renderUSD(c);
      expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe("PriceText component — muted styling for missing values", () => {
  it("applies text-muted-foreground class when value is '—'", () => {
    render(<PriceText value="—" data-testid="pt" />);
    const span = screen.getByText("—");
    expect(span).toHaveClass("text-muted-foreground");
  });

  it("does not apply text-muted-foreground class for a valid price", () => {
    render(<PriceText value="$75.50 USD" />);
    const span = screen.getByText("$75.50 USD");
    expect(span).not.toHaveClass("text-muted-foreground");
  });

  it("applies text-muted-foreground when formatUSD returns '—' for null", () => {
    render(<PriceText value={formatUSD(null)} />);
    const span = screen.getByText("—");
    expect(span).toHaveClass("text-muted-foreground");
  });

  it("applies text-muted-foreground when formatAED returns '—' for null", () => {
    render(<PriceText value={formatAED(null)} />);
    const span = screen.getByText("—");
    expect(span).toHaveClass("text-muted-foreground");
  });

  it("does not apply text-muted-foreground for a valid AED price", () => {
    render(<PriceText value={formatAED(200)} />);
    const span = screen.getByText("200 AED");
    expect(span).not.toHaveClass("text-muted-foreground");
  });
});
