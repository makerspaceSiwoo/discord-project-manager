import type { Project } from './types';
export function projectMember(
  p: Project,
  member: { user?: { id?: string; bot?: boolean }; roles?: string[] },
) {
  return (
    !!member.user?.id &&
    !member.user.bot &&
    (!p.memberRoleId || (member.roles || []).includes(p.memberRoleId))
  );
}
export function projectAdmin(p: Project, userId: string, roles: string[], permissions = '0') {
  return (
    !!p.adminUserIds?.includes(userId) ||
    p.adminRoleIds.some((role) => roles.includes(role)) ||
    (BigInt(permissions) & 8n) !== 0n
  );
}
export const issuesEnabled = (p: Project) => p.enabled && p.features?.issues !== false;
export const automationEnabled = (p: Project) => p.enabled && p.features?.automation !== false;
export const linkingEnabled = (p: Project) =>
  p.linkingEnabled ?? (p.notion.guestVerificationEnabled && !!p.notion.guestEvidence);
