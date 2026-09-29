type MemberForDefault = {
  id: number;
  role: string;
  custom_role_id: number | null;
};

export function computeSmartDefault(
  allMembers: MemberForDefault[],
  deletingId: number,
  affected: MemberForDefault[],
): number | null {
  const affectedIds = new Set(affected.map((m) => m.id));
  const counts = new Map<number, number>();
  for (const m of allMembers) {
    if (affectedIds.has(m.id)) continue;
    if (m.role === "owner") continue;
    if (m.custom_role_id === null || m.custom_role_id === deletingId) continue;
    counts.set(m.custom_role_id, (counts.get(m.custom_role_id) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let bestId: number | null = null;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestId = id;
    }
  }
  return bestId;
}
