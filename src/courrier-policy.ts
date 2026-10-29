/**
 * Pure authorization rules for the Courrier domain.
 *
 * This module deliberately has no database access. Callers must load tenant-scoped
 * records inside withTenant() and pass the tenantId on every record/assignment.
 * Unknown permission or confidentiality values fail closed.
 */

export const COURRIER_PERMISSIONS = [
  'courrier:read',
  'courrier:register',
  'courrier:assign',
  'courrier:manage',
  'clearance:confidentiel',
  'clearance:secret',
] as const;

export type CourrierPermission = (typeof COURRIER_PERMISSIONS)[number];
export type Confidentiality = 'public' | 'interne' | 'confidentiel' | 'secret';
export type MailAction = 'assign' | 'transition' | 'reply' | 'close';

const LEVEL: Record<Confidentiality, number> = {
  public: 0,
  interne: 1,
  confidentiel: 2,
  secret: 3,
};

export interface CourrierAccessContext {
  tenantId: string;
  actorId: string;
  permissions: ReadonlySet<string>;
  clearance: Confidentiality;
  serviceIds?: ReadonlySet<string>;
}

export interface CourrierRecord {
  id: string;
  tenantId: string;
  createdBy: string;
  confidentiality: Confidentiality;
}

export interface CourrierAssignment {
  tenantId: string;
  mailId: string;
  userId?: string | null;
  serviceId?: string | null;
}

function isConfidentiality(value: unknown): value is Confidentiality {
  return typeof value === 'string' && Object.hasOwn(LEVEL, value);
}

export function requireConfidentiality(value: unknown): Confidentiality {
  if (!isConfidentiality(value)) {
    throw new TypeError('Niveau de confidentialité invalide.');
  }
  return value;
}

export function hasPermission(
  context: CourrierAccessContext,
  permission: CourrierPermission,
): boolean {
  return context.permissions.has('*') || context.permissions.has(permission);
}

export function effectiveClearance(
  permissions: ReadonlySet<string>,
  base: unknown = 'interne',
): Confidentiality {
  if (!isConfidentiality(base)) return 'interne';
  if (permissions.has('*') || permissions.has('clearance:secret')) return 'secret';
  if (permissions.has('clearance:confidentiel') && LEVEL[base] < LEVEL.confidentiel) {
    return 'confidentiel';
  }
  return base;
}

/**
 * Access is denied when tenant, record, assignment, or confidentiality metadata
 * is inconsistent. Creator/assignee exceptions are intentional and explicit:
 * the creator and directly assigned user can read a record regardless of
 * clearance, but only within the same tenant and for the exact mail.
 */
export function canReadMail(
  context: CourrierAccessContext,
  mail: CourrierRecord,
  assignments: readonly CourrierAssignment[],
): boolean {
  if (context.tenantId !== mail.tenantId || !hasPermission(context, 'courrier:read')) {
    return false;
  }
  if (!isConfidentiality(mail.confidentiality) || !isConfidentiality(context.clearance)) {
    return false;
  }

  const relevant = assignments.filter(
    (assignment) =>
      assignment.tenantId === mail.tenantId && assignment.mailId === mail.id,
  );

  if (mail.createdBy === context.actorId) return true;
  if (relevant.some((assignment) => assignment.userId === context.actorId)) return true;

  // Service assignment grants access to confidential mail, but never secret mail.
  if (
    mail.confidentiality === 'confidentiel' &&
    relevant.some((assignment) =>
      Boolean(assignment.serviceId && context.serviceIds?.has(assignment.serviceId)),
    )
  ) {
    return true;
  }

  return LEVEL[context.clearance] >= LEVEL[mail.confidentiality];
}

export function canActOnMail(
  context: CourrierAccessContext,
  mail: CourrierRecord,
  assignments: readonly CourrierAssignment[],
  action: MailAction,
): boolean {
  if (!canReadMail(context, mail, assignments)) return false;

  const manager =
    hasPermission(context, 'courrier:manage') ||
    hasPermission(context, 'courrier:assign');
  const handler =
    mail.createdBy === context.actorId ||
    assignments.some(
      (assignment) =>
        assignment.tenantId === mail.tenantId &&
        assignment.mailId === mail.id &&
        (
          assignment.userId === context.actorId ||
          (
            mail.confidentiality === 'confidentiel' &&
            Boolean(assignment.serviceId && context.serviceIds?.has(assignment.serviceId))
          )
        ),
    );

  switch (action) {
    case 'assign':
      return manager;
    case 'transition':
    case 'reply':
      return hasPermission(context, 'courrier:manage') || handler;
    case 'close':
      return hasPermission(context, 'courrier:manage') || mail.createdBy === context.actorId;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/**
 * Keep list visibility aligned with record-level policy. The query layer must
 * still apply tenant filtering in SQL; this helper is not a substitute for RLS.
 */
export function filterVisibleMails<T extends CourrierRecord>(
  context: CourrierAccessContext,
  mails: readonly T[],
  assignments: readonly CourrierAssignment[],
): T[] {
  return mails.filter((mail) => canReadMail(context, mail, assignments));
}
