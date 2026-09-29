/**
 * Public catalog serializer — strips all internal-only fields and builds
 * the safe response shape for the /api/catalog/v1 endpoints.
 *
 * NEVER include: COGS, supplier data, margin, internal notes, base item cost,
 * recipe data, completeness score, or warehouse/procurement details.
 */

import { buildPublicObjectUrl } from "./objectStorage";

export type CatalogProductResponse = {
  id: number;
  sku: string | null;
  name: string;
  public_title: string | null;
  slug: string | null;
  brand: string | null;
  brand_id: number | null;
  category: string | null;
  tags: string[];
  description: string | null;
  short_description: string | null;
  long_description: string | null;
  price: string | null;
  sale_price: string | null;
  currency: string;
  status: string;
  availability: "in_stock" | "out_of_stock" | "unavailable";
  images: {
    main: string | null;
    additional: string[];
    main_public_url: string | null;
    additional_public_urls: (string | null)[];
  };
  seo: {
    title: string | null;
    description: string | null;
    og_image_url: string | null;
  };
  publishing: {
    channel_id: number;
    publication_status: string;
    is_visible: boolean;
    featured: boolean;
    sort_order: number | null;
    published_at: string | null;
    last_synced_at: string | null;
    badges: unknown[];
    extra_fields: Record<string, unknown>;
  };
  occasions: string[];
  recipients: string[];
  categories: string[];
  delivery_cities: string[];
  created_at: string;
  updated_at: string | null;
};

type ProductRow = {
  id: number;
  workspace_owner_id: string;
  name: string;
  price_usd: string | null;
  price_aed: string | null;
  main_image_url: string | null;
  additional_image_urls: string[];
  image_public_path?: string | null;
  additional_image_public_paths?: string[] | null;
  description: string | null;
  status: string;
  brand: string | null;
  tags: string[];
  sku: string | null;
  created_at: string | Date;
  is_archived: boolean;
  updated_at?: string | Date | null;
  brand_id?: number | null;
};

type PublicationRow = {
  id: number;
  channel_id: number;
  publication_status: string;
  is_visible: boolean;
  featured: boolean;
  sort_order: number | null;
  published_at: string | Date | null;
  last_synced_at: string | Date | null;
  public_slug: string | null;
  public_title: string | null;
  short_description: string | null;
  long_description: string | null;
  seo_title: string | null;
  seo_description: string | null;
  og_image_url: string | null;
  price_override: string | null;
  sale_price_override: string | null;
  currency_override: string | null;
  badges: unknown;
  extra_fields: unknown;
};

type Relations = {
  occasions?: string[];
  recipients?: string[];
  categories?: string[];
  delivery_cities?: string[];
  brand_id?: number | null;
};

function toIso(val: string | Date | null | undefined): string | null {
  if (!val) return null;
  return val instanceof Date ? val.toISOString() : val;
}

function availability(status: string): "in_stock" | "out_of_stock" | "unavailable" {
  if (status === "available") return "in_stock";
  if (status === "out_of_stock") return "out_of_stock";
  return "unavailable";
}

export function serializeCatalogProduct(
  product: ProductRow,
  publication: PublicationRow,
  relations: Relations = {},
  defaultCurrency = "USD",
): CatalogProductResponse {
  const currency = publication.currency_override ?? defaultCurrency;

  let price: string | null;
  let salePrice: string | null;

  if (publication.price_override !== null && publication.price_override !== undefined) {
    price = publication.price_override;
    salePrice = publication.sale_price_override ?? null;
  } else {
    price = currency === "AED" ? (product.price_aed ?? null) : (product.price_usd ?? null);
    salePrice = publication.sale_price_override ?? null;
  }

  const badges = Array.isArray(publication.badges)
    ? publication.badges
    : [];
  const extraFields =
    publication.extra_fields && typeof publication.extra_fields === "object" && !Array.isArray(publication.extra_fields)
      ? (publication.extra_fields as Record<string, unknown>)
      : {};

  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    public_title: publication.public_title ?? null,
    slug: publication.public_slug ?? null,
    brand: product.brand ?? null,
    brand_id: relations.brand_id ?? null,
    // Derived from the catalog-category join (primary = alphabetically-first);
    // the legacy free-text products.category column has been retired.
    category: relations.categories?.[0] ?? null,
    tags: product.tags ?? [],
    description: product.description ?? null,
    short_description: publication.short_description ?? null,
    long_description: publication.long_description ?? null,
    price,
    sale_price: salePrice,
    currency,
    status: product.status,
    availability: availability(product.status),
    images: {
      main: product.main_image_url ?? null,
      additional: product.additional_image_urls ?? [],
      main_public_url: buildPublicObjectUrl(product.image_public_path ?? null),
      additional_public_urls: (product.additional_image_public_paths ?? []).map((p) => buildPublicObjectUrl(p)),
    },
    seo: {
      title: publication.seo_title ?? null,
      description: publication.seo_description ?? null,
      og_image_url: publication.og_image_url ?? null,
    },
    publishing: {
      channel_id: publication.channel_id,
      publication_status: publication.publication_status,
      is_visible: publication.is_visible,
      featured: publication.featured,
      sort_order: publication.sort_order ?? null,
      published_at: toIso(publication.published_at),
      last_synced_at: toIso(publication.last_synced_at),
      badges,
      extra_fields: extraFields,
    },
    occasions: relations.occasions ?? [],
    recipients: relations.recipients ?? [],
    categories: relations.categories ?? [],
    delivery_cities: relations.delivery_cities ?? [],
    created_at: toIso(product.created_at) ?? "",
    updated_at: toIso(product.updated_at ?? null),
  };
}
