import { safeText } from '../adapters/discord';
import type { Issue, Project } from '../core/types';
export const rank = (issue: Issue, p: Project) => {
  const i = p.notion.priorities.indexOf(issue.priority);
  return i < 0 ? 999 : i;
};
export function reportable(i: Issue, p: Project) {
  return (
    !i.archived &&
    !i.parentIds.length &&
    !p.notion.excludedStatuses.includes(i.status) &&
    i.id.replaceAll('-', '') !== p.notion.probePageId.replaceAll('-', '')
  );
}
export function compareIssues(a: Issue, b: Issue, p: Project) {
  return (
    (a.due || '9999').localeCompare(b.due || '9999') ||
    rank(a, p) - rank(b, p) ||
    a.created.localeCompare(b.created) ||
    a.id.localeCompare(b.id)
  );
}
export function reportMessage(
  issues: (Issue & { discordUrl?: string; names?: string[] })[],
  marker: string,
) {
  if (!issues.length) return `미완료 상위 작업 없음\n${marker}`;
  // One complete row per message preserves arbitrary title/assignee lengths via authenticated full table.
  const i = issues[0],
    trim = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  return `**주간 미완료 상위 작업**\n\`\`\`text\nID | 이름 | 마감 | 우선순위 | 상태 | 생성일 | 담당자\n${[i.taskId, trim(i.title, 80), i.due || '없음', i.priority || '없음', i.status, i.created.slice(0, 10), trim((i.names || i.assignees).join(', ') || '미지정', 150)].map(safeText).join(' | ')}\n\`\`\`\n<${i.url}>${i.discordUrl ? '\n<' + i.discordUrl + '>' : ''}\n${marker}`;
}
