import { safeText, type DiscordEmbed } from '../adapters/discord';
import type { Issue, Project } from '../core/types';
import { issueStatus } from './issues';
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
  reportUrl: string,
  options: { testRun?: boolean; first?: boolean } = {},
) {
  const mentionEveryone = !options.testRun && options.first === true;
  const content = `${mentionEveryone ? '@everyone\n' : ''}${options.testRun ? '[테스트] ' : ''}**주간 미완료 상위 작업**\n${issues.length ? '' : '미완료 상위 작업 없음\n'}[전체 목록 보기](<${reportUrl}>)`;
  const trim = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  // One issue per durable delivery keeps retries and existing report snapshots compatible.
  const embeds: DiscordEmbed[] = issues.slice(0, 1).map((i) => ({
    title: trim(`[${safeText(i.taskId)}] ${safeText(i.title)}`, 256),
    url: i.url,
    color: 0x5865f2,
    ...(i.discordUrl ? { description: `[논의 스레드 열기](${i.discordUrl})` } : {}),
    fields: [
      { name: '상태', value: trim(issueStatus(i), 1024), inline: true },
      { name: '마감일', value: safeText(i.due || '없음'), inline: true },
      { name: '우선순위', value: trim(safeText(i.priority || '없음'), 1024), inline: true },
      { name: '유형', value: trim(safeText(i.type || '없음'), 1024), inline: true },
      { name: '생성일', value: safeText(i.created.slice(0, 10) || '없음'), inline: true },
      {
        name: '담당자',
        value: trim(
          (
            i.names ||
            i.assignees.map((id) => safeText(i.assigneeNames?.[id] || 'Notion 사용자 (미연결)'))
          ).join(', ') || '미지정',
          1024,
        ),
        inline: true,
      },
    ],
  }));
  return { content, embeds, mentionEveryone };
}
