/**
 * Builds the dashboard detail path for an order.
 *
 * Always use the canonical order UUID for links generated from loaded order
 * data. Display and external order numbers are useful labels, but they are not
 * the database identity: externally-ingested orders only have an
 * external_order_id, manual orders have a display_order_number, and either
 * value can change independently of the row id. Using the UUID gives every
 * list row the same unambiguous loading path.
 *
 * The API still accepts display/external order numbers so pasted or bookmarked
 * human-readable URLs continue to work.
 */
export function orderDetailPath(order: {
  id: string;
}): string {
  return `/orders/${encodeURIComponent(order.id)}`;
}
