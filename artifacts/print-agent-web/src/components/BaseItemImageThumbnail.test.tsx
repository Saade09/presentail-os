import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { BaseItemImageThumbnail } from "./BaseItemImageThumbnail";

const SIZE_EXPECTATIONS: Array<{ size: 6 | 7 | 8 | 10 | 12; dimension: string }> = [
  { size: 6, dimension: "w-6 h-6" },
  { size: 7, dimension: "w-7 h-7" },
  { size: 8, dimension: "w-8 h-8" },
  { size: 10, dimension: "w-10 h-10" },
  { size: 12, dimension: "w-12 h-12" },
];

describe("BaseItemImageThumbnail", () => {
  describe("with an image URL", () => {
    it.each(SIZE_EXPECTATIONS)(
      "renders a square object-cover <img> with the $dimension size class for size $size",
      ({ size, dimension }) => {
        const { getByRole } = render(
          <BaseItemImageThumbnail
            imageUrl="/api/storage/objects/some-image.jpg"
            name="Wooden Box"
            size={size}
          />,
        );

        const img = getByRole("img");
        expect(img).toHaveAttribute("src", "/api/storage/objects/some-image.jpg");
        expect(img).toHaveAttribute("alt", "Wooden Box");
        expect(img.className).toContain("object-cover");
        expect(img.className).toContain("w-full");
        expect(img.className).toContain("h-full");

        const container = img.parentElement as HTMLElement;
        const dims = dimension.split(" ");
        for (const cls of dims) {
          expect(container.className).toContain(cls);
        }
        expect(container.className).toContain("overflow-hidden");
      },
    );

    it("defaults to the size-10 square when no size is provided", () => {
      const { getByRole } = render(
        <BaseItemImageThumbnail imageUrl="/img.png" name="Default" />,
      );
      const container = getByRole("img").parentElement as HTMLElement;
      expect(container.className).toContain("w-10");
      expect(container.className).toContain("h-10");
    });
  });

  describe("without an image URL", () => {
    it("renders the uppercase first-initial fallback instead of an <img>", () => {
      const { queryByRole, getByText } = render(
        <BaseItemImageThumbnail imageUrl={null} name="wooden box" />,
      );

      expect(queryByRole("img")).toBeNull();
      expect(getByText("W")).toBeInTheDocument();
    });

    it("uppercases the first character and trims leading whitespace", () => {
      const { getByText } = render(
        <BaseItemImageThumbnail imageUrl={null} name="  apple crate" />,
      );
      expect(getByText("A")).toBeInTheDocument();
    });
  });
});
