import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const API_DOCS_PATH = resolve(__dirname, "ApiDocs.tsx");

describe("ApiDocs Catalog API authorization", () => {
  it("keeps the Catalog API content behind the publishing-channels PageGuard", () => {
    const source = readFileSync(API_DOCS_PATH, "utf8");

    expect(source).toMatch(
      /<TabsContent value="catalog-api"[^>]*>[\s\S]*?<PageGuard page="publishing-channels">\s*<CatalogApiDocsContent \/>\s*<\/PageGuard>[\s\S]*?<\/TabsContent>/,
    );
  });
});