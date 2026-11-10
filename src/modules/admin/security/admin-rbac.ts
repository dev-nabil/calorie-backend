import type { AdminRole } from '../schemas/admin.schema';

/**
 * Server-side copy of nouri-frontend/apps/admin/lib/rbac.ts (the UI matrix is cosmetic; this one
 * is enforced). Keep the two in sync; the frontend's proposed role choices are pending an OQ.
 */
const O: AdminRole = 'owner';
const A: AdminRole = 'admin';
const S: AdminRole = 'support';
const E: AdminRole = 'editor';
const N: AdminRole = 'analyst';

export const ADMIN_PERMISSIONS = {
  'overview.view': [O, A, S, E, N],
  'metrics.aggregate': [O, A, N],
  'users.view': [O, A, S],
  'users.healthData.view': [O, A, S],
  'users.disable': [O, A, S],
  'users.grantPromo': [O, A, S],
  'users.addFreeScans': [O, A, S],
  'users.delete': [O, A],
  'subscriptions.view': [O, A, S],
  'billing.replay': [O, A],
  'ai.view': [O, A, N],
  'ai.usage.view': [O, A, N],
  'ai.failedScans.view': [O, A],
  'ai.settings.edit': [O, A],
  'ai.prompts.manage': [O, A],
  'ai.killSwitch': [O, A],
  'content.view': [O, A, E],
  'content.copy.edit': [O, A, E],
  'flags.edit': [O, A],
  'experiments.edit': [O, A],
  'appVersion.edit': [O, A],
  'settings.view': [O, A],
  'settings.edit': [O, A],
  'waitlist.view': [O, A],
  'audit.view': [O, A],
  'adminUsers.manage': [O],
} as const satisfies Record<string, readonly AdminRole[]>;

export type AdminPermission = keyof typeof ADMIN_PERMISSIONS;

export function adminCan(role: AdminRole, permission: AdminPermission): boolean {
  return (ADMIN_PERMISSIONS[permission] as readonly AdminRole[]).includes(role);
}
