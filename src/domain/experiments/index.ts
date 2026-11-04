import { createHash } from 'node:crypto';

/**
 * S-20 experiments: users are bucketed once by hash(userId + key) into weighted variants.
 * The assignment is stored on the user so later weight changes never move existing users.
 */
export interface ExperimentDef {
  active: boolean;
  variants: { id: string; weight: number }[];
  /** Share of users in the experiment (0–100); others get no variant. Default 100. */
  allocationPct?: number;
}

/** Stable bucket 0–9999 for a user and experiment key. */
export function bucketOf(userId: string, key: string): number {
  const hex = createHash('sha256').update(`${userId}:${key}`).digest('hex').slice(0, 8);
  return parseInt(hex, 16) % 10_000;
}

export function pickVariant(userId: string, key: string, def: ExperimentDef): string | null {
  const total = def.variants.reduce((s, v) => s + Math.max(0, v.weight), 0);
  if (!def.active || total <= 0) return null;
  const bucket = bucketOf(userId, key);
  if (def.allocationPct !== undefined && bucket >= def.allocationPct * 100) return null;
  // Re-use the bucket inside the allocation so allocation and variant stay independent of weights.
  const point = ((bucket % 10_000) / 10_000) * total;
  let acc = 0;
  for (const v of def.variants) {
    acc += Math.max(0, v.weight);
    if (point < acc) return v.id;
  }
  return def.variants.at(-1)?.id ?? null;
}

/**
 * Returns the variants of active experiments only: existing assignments are kept, new ones added.
 * A stopped (inactive) experiment is left out, so the app falls back to its default; the stored
 * assignment is untouched and comes back if the experiment is restarted (QA B22).
 */
export function assignExperiments(
  userId: string,
  existing: Record<string, string>,
  defs: Record<string, ExperimentDef>,
): { assignments: Record<string, string>; added: Record<string, string> } {
  const assignments: Record<string, string> = {};
  const added: Record<string, string> = {};
  for (const [key, def] of Object.entries(defs)) {
    if (!def.active) continue;
    const known = existing[key];
    if (known !== undefined && def.variants.some((v) => v.id === known)) {
      assignments[key] = known;
      continue;
    }
    const v = pickVariant(userId, key, def);
    if (v !== null) assignments[key] = added[key] = v;
  }
  return { assignments, added };
}
