/** Shared SQL predicates for card-aware florist evidence requirements. */
export function hasCardMessageSql(orderAlias: string): string {
  return `${orderAlias}.card_message IS NOT NULL AND btrim(${orderAlias}.card_message) <> ''`;
}

/**
 * The card photo is required only for a non-empty card message. Callers must
 * keep the prepared-items photo predicate separate because it is always required.
 */
export function cardPhotoSatisfiedSql(
  assignmentAlias: string,
  orderAlias: string,
): string {
  return `(${assignmentAlias}.photo_card_path IS NOT NULL OR NOT (${hasCardMessageSql(orderAlias)}))`;
}