/**
 * Event catalog serializer — strips all internal-only fields and builds
 * the safe response shape for the /api/catalog/v1/events endpoints.
 *
 * NEVER include: internal cost data, supplier data, or other private fields.
 */

import { buildPublicObjectUrl } from "./objectStorage";

export type CatalogEventResponse = {
  id: number;
  name: string;
  public_title: string | null;
  slug: string | null;
  description: string | null;
  short_description: string | null;
  long_description: string | null;
  starting_price: string | null;
  currency: string;
  status: string;
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
  created_at: string;
  updated_at: string | null;
};

type EventRow = {
  id: number;
  workspace_owner_id: string;
  name: string;
  description: string | null;
  starting_price_usd: string | null;
  starting_price_aed: string | null;
  main_image_url: string | null;
  additional_image_urls: string[];
  image_public_path?: string | null;
  additional_image_public_paths?: string[] | null;
  status: string;
  is_archived: boolean;
  created_at: string | Date;
  updated_at?: string | Date | null;
};

type EventPublicationRow = {
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

type EventRelations = {
  occasions?: string[];
};

function toIso(val: string | Date | null | undefined): string | null {
  if (!val) return null;
  return val instanceof Date ? val.toISOString() : val;
}

export function serializeCatalogEvent(
  event: EventRow,
  publication: EventPublicationRow,
  relations: EventRelations = {},
  defaultCurrency = "USD",
): CatalogEventResponse {
  const currency = publication.currency_override ?? defaultCurrency;

  let startingPrice: string | null;
  if (publication.price_override !== null && publication.price_override !== undefined) {
    startingPrice = publication.price_override;
  } else {
    startingPrice = currency === "AED"
      ? (event.starting_price_aed ?? null)
      : (event.starting_price_usd ?? null);
  }

  const badges = Array.isArray(publication.badges) ? publication.badges : [];
  const extraFields =
    publication.extra_fields &&
    typeof publication.extra_fields === "object" &&
    !Array.isArray(publication.extra_fields)
      ? (publication.extra_fields as Record<string, unknown>)
      : {};

  return {
    id: event.id,
    name: event.name,
    public_title: publication.public_title ?? null,
    slug: publication.public_slug ?? null,
    description: event.description ?? null,
    short_description: publication.short_description ?? null,
    long_description: publication.long_description ?? null,
    starting_price: startingPrice,
    currency,
    status: event.status,
    images: {
      main: event.main_image_url ?? null,
      additional: event.additional_image_urls ?? [],
      main_public_url: buildPublicObjectUrl(event.image_public_path ?? null),
      additional_public_urls: (event.additional_image_public_paths ?? []).map((p) =>
        buildPublicObjectUrl(p),
      ),
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
    created_at: toIso(event.created_at) ?? "",
    updated_at: toIso(event.updated_at ?? null),
  };
}
