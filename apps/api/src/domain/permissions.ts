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
  'orders.release', // release an unconfirmed delivered order to the seller (24h+ after delivery)
  'orders.lead', // release or decide orders above the Lead threshold ($200): the Support Lead only
  'ranks.manage', // seller ranks, rates and the launch promo (CEO)
  'leagues.manage', // open and close challenge leagues (Support & Arbitration)
  'rules.manage', // the seller rules test and the ID deadline (Support & Arbitration)
  'reconciliation.run',
  'promos.manage',
  'treasury.request',
  'treasury.approve', // Finance: approve withdrawals (always the first signature), treasury withdrawals and crypto refunds
  'withdrawals.second_approve', // the Support Lead: ONLY the second signature on a withdrawal above the four-eyes thresholds
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
  'status.manage', // incidents and maintenance on the public status page
  'support.manage', // help-centre ticket queue
  'moderation.manage', // listing review queue, flagged chats, banned terms
  'analytics.view', // business dashboard: GMV, take rate, dispute and chargeback rates
  'controls.manage', // kill switches and beta limits (Ops → Controls): admin, and finance for the money ones
  'newsletter.export', // newsletter subscriber list (CSV, personal data): admin and marketing only (Round 23b)
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const STAFF_ROLES = ['arbiter', 'support', 'lead', 'finance', 'compliance', 'marketing', 'admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  arbiter: ['orders.view_any', 'disputes.manage', 'owner_proofs.review', 'reviews.moderate', 'orders.refund_after_release', 'orders.release', 'moderation.manage'],
  support: ['orders.view_any', 'reviews.moderate', 'ledger.view', 'status.manage', 'support.manage', 'moderation.manage', 'orders.release', 'leagues.manage', 'rules.manage'],
  // The Support Lead: everything support and arbiters do, plus the orders above $200, bans and appeals.
  lead: ['orders.view_any', 'reviews.moderate', 'ledger.view', 'status.manage', 'support.manage', 'moderation.manage', 'orders.release', 'leagues.manage', 'rules.manage', 'disputes.manage', 'owner_proofs.review', 'orders.refund_after_release', 'orders.lead', 'users.suspend', 'audit.view', 'withdrawals.second_approve'], // never treasury.approve: the Lead only co-signs large withdrawals (Round 22)
  finance: [
    'chargebacks.manage', 'orders.refund_after_release', 'reconciliation.run', 'promos.manage', 'treasury.request', 'treasury.approve', 'ledger.view', 'ledger.adjust',
    'payout_holds.set', 'fx.manage', 'tax.manage', 'invoices.manage', 'analytics.view', 'controls.manage',
  ],
  compliance: ['orders.view_any', 'risk.review', 'users.suspend', 'aml.review', 'aml.sar', 'payout_holds.set', 'ledger.view', 'audit.view', 'retention.manage', 'analytics.view'],
  // Marketing / community: the newsletter list, nothing else.
  marketing: ['newsletter.export'],
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
