/**
 * Sensitive-occasion detection for orders (sympathy / funeral / condolence).
 *
 * An order is auto-flagged `is_sensitive_occasion = true` at creation time when
 * any of its line items resolves to a product that is tagged, categorised, or
 * occasion-linked as a sympathy/funeral/condolence product — or, as a fallback,
 * when the product/line-item name itself contains one of the sensitive terms.
 *
 * The flag only ever auto-sets to TRUE (never auto-clears), and detection runs
 * only on first creation, so a manual toggle from the order page always sticks.
 *
 * Consumers (Trustpilot review invitations, any future promotional sequences)
 * must check `orders.is_sensitive_occasion` before contacting the customer.
 */

// Word list intentionally conservative: terms that unambiguously indicate a
// loss/mourning context. Matched case-insensitively as substrings.
export const SENSITIVE_OCCASION_PATTERN =
  "(sympathy|funeral|condolence|condolences|bereavement|memorial|in loving memory|rest in peace)";

type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

/**
 * Returns true when any line item on the order matches the sensitive-occasion
 * taxonomy (occasion/category slug or name), product tags, product name, or
 * line-item name. Product resolution: product_id first, then SKU within the
 * workspace (same precedence the order detail route uses).
 */
export async function detectSensitiveOccasion(
  client: Queryable,
  orderId: string,
  workspaceOwnerId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
         FROM order_line_items oli
         LEFT JOIN LATERAL (
           SELECT p.*
             FROM products p
            WHERE p.workspace_owner_id = $2
              AND (
                p.id = oli.product_id
                OR (oli.product_id IS NULL AND oli.sku IS NOT NULL AND p.sku = oli.sku)
              )
            ORDER BY (p.id = oli.product_id) DESC
            LIMIT 1
         ) p ON true
        WHERE oli.order_id = $1
          AND (
            oli.name ~* $3
            OR p.name ~* $3
            OR EXISTS (
              SELECT 1 FROM unnest(COALESCE(p.tags, '{}'::text[])) AS tag
               WHERE tag ~* $3
            )
            OR EXISTS (
              SELECT 1
                FROM product_occasions po
                JOIN occasions oc ON oc.id = po.attribute_id
               WHERE po.product_id = p.id AND (oc.name ~* $3 OR oc.slug ~* $3)
            )
            OR EXISTS (
              SELECT 1
                FROM product_catalog_categories pcc
                JOIN catalog_categories cc ON cc.id = pcc.attribute_id
               WHERE pcc.product_id = p.id AND (cc.name ~* $3 OR cc.slug ~* $3)
            )
          )
     ) AS sensitive`,
    [orderId, workspaceOwnerId, SENSITIVE_OCCASION_PATTERN],
  );
  return result.rows[0]?.sensitive === true;
}

/**
 * Runs detection and, when positive, sets `orders.is_sensitive_occasion = true`.
 * Never clears the flag. Returns whether the order is flagged after the call.
 */
export async function applySensitiveOccasionFlag(
  client: Queryable,
  orderId: string,
  workspaceOwnerId: string,
): Promise<boolean> {
  const sensitive = await detectSensitiveOccasion(client, orderId, workspaceOwnerId);
  if (sensitive) {
    await client.query(
      `UPDATE orders SET is_sensitive_occasion = true, updated_at = now()
        WHERE id = $1 AND workspace_owner_id = $2 AND is_sensitive_occasion IS NOT TRUE`,
      [orderId, workspaceOwnerId],
    );
  }
  return sensitive;
}
