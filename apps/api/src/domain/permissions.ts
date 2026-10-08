/**
 * Staff permissions. Routes ask for a permission, never a role, so a role can be reshaped
 * here without touching handlers. Least privilege: support can look but not move money,
 * finance moves money but can't suspend people, compliance investigates but can't pay out.
 */
export const PERMISSIONS = [
  'orders.view_any', // read any order, its chat and evidence (always audited)
  'disputes.manage',
  'owner_proofs.review',
  'reviews.moderate',
  'risk.review',
  'users.suspend',
  'aml.review',
  'aml.sar',
  'chargebacks.manage',
  'orders.refund_after_release',
  'reconciliation.run',
  'promos.manage',
  'treasury.request',
  'treasury.approve',
  'ledger.view',
  'ledger.adjust',
  'payout_holds.set',
  'fx.manage',
  'tax.manage',
  'invoices.manage',
  'keys.manage',
  'retention.manage',
  'audit.view',
  'staff.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const STAFF_ROLES = ['arbiter', 'support', 'finance', 'compliance', 'admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  arbiter: ['orders.view_any', 'disputes.manage', 'owner_proofs.review', 'reviews.moderate', 'orders.refund_after_release'],
  support: ['orders.view_any', 'reviews.moderate', 'ledger.view'],
  finance: [
    'chargebacks.manage', 'orders.refund_after_release', 'reconciliation.run', 'promos.manage', 'treasury.request', 'treasury.approve', 'ledger.view', 'ledger.adjust',
    'payout_holds.set', 'fx.manage', 'tax.manage', 'invoices.manage',
  ],
  compliance: ['orders.view_any', 'risk.review', 'users.suspend', 'aml.review', 'aml.sar', 'payout_holds.set', 'ledger.view', 'audit.view', 'retention.manage'],
  admin: PERMISSIONS,
};

export interface HasRoles {
  role: string;
  staff_roles?: string[] | null;
}

export function rolesOf(u: HasRoles): StaffRole[] {
  return [u.role, ...(u.staff_roles ?? [])].filter((r): r is StaffRole => (STAFF_ROLES as readonly string[]).includes(r));
}

export function permissionsOf(u: HasRoles): Set<Permission> {
  return new Set(rolesOf(u).flatMap((r) => ROLE_PERMISSIONS[r]));
}

export const hasPermission = (u: HasRoles, p: Permission) => permissionsOf(u).has(p);
export const isStaff = (u: HasRoles) => rolesOf(u).length > 0;
