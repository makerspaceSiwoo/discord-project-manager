import { safeText } from '../adapters/discord';
import { AppError, type Draft, type Issue, type Project } from '../core/types';
export function validateDraft(input: any, p: Project): Draft {
  if (typeof input?.title !== 'string' || !input.title.trim() || input.title.length > 150)
    throw new AppError(400, '제목은 1~150자입니다.');
  if (
    typeof input.due !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.due) ||
    !Number.isFinite(Date.parse(input.due)) ||
    new Date(input.due).toISOString().slice(0, 10) !== input.due
  )
    throw new AppError(400, '마감일은 유효한 YYYY-MM-DD 날짜여야 합니다.');
  if (typeof input.assignee !== 'string' || !/^\d{5,25}$/.test(input.assignee))
    throw new AppError(400, '연결된 담당자 한 명을 선택하세요.');
  if (!p.notion.types.includes(input.type) || !p.notion.priorities.includes(input.priority))
    throw new AppError(400, '설정에 있는 작업 유형과 우선순위를 선택하세요.');
  if (
    input.description !== undefined &&
    (typeof input.description !== 'string' || input.description.length > 1800)
  )
    throw new AppError(400, '상세 설명은 1,800자까지 입력할 수 있습니다.');
  return { ...input, title: input.title.trim(), description: input.description || '' };
}
export function issueSummary(i: Issue, discordUsers: string[], marker: string) {
  const state = i.archived ? '보관/휴지통' : i.status;
  return `**${safeText(i.taskId)} · ${safeText(i.title).slice(0, 150)}**\n상태 ${safeText(state)} · 유형 ${safeText(i.type)}\n마감 ${i.due || '없음'} · 우선순위 ${safeText(i.priority)}\n담당자 ${discordUsers.length ? discordUsers.map((id) => `<@${id}>`).join(', ') : i.assignees.length ? 'Notion 담당자 (Discord 연결 없음)' : '미지정'}\n\n${safeText(i.description).slice(0, 700)}\n\n<${i.url}>\n${marker}`;
}
export function modal(p: Project, members: { discord_id: string; name?: string }[]) {
  const label = (name: string, component: any) => ({ type: 18, label: name, component });
  const text = (custom_id: string, max_length: number, placeholder: string) => ({
    type: 4,
    custom_id,
    style: 1,
    required: true,
    max_length,
    placeholder,
  });
  const select = (custom_id: string, options: { label: string; value: string }[]) => ({
    type: 3,
    custom_id,
    min_values: 1,
    max_values: 1,
    required: true,
    options,
  });
  return {
    type: 9,
    data: {
      custom_id: 'issue:required',
      title: '새 이슈 · 필수 정보',
      components: [
        label('제목', text('title', 150, '무엇을 해야 하나요?')),
        label('마감일', text('due', 10, 'YYYY-MM-DD')),
        label(
          '담당자',
          select(
            'assignee',
            members.map((m) => ({
              label: (m.name || m.discord_id).slice(0, 100),
              value: m.discord_id,
            })),
          ),
        ),
        label(
          '작업 유형',
          select(
            'type',
            p.notion.types.map((v) => ({ label: v, value: v })),
          ),
        ),
        label(
          '우선순위',
          select(
            'priority',
            p.notion.priorities.map((v) => ({ label: v, value: v })),
          ),
        ),
      ],
    },
  };
}
export function fields(components: any[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (items: any[]) => {
    for (const c of items) {
      if (c.custom_id) out[c.custom_id] = c.value ?? c.values?.[0] ?? '';
      if (c.component) walk([c.component]);
      if (c.components) walk(c.components);
    }
  };
  walk(components);
  return out;
}
export function confirmation(id: string, d: Draft) {
  return {
    content: `**이슈 생성 확인**\n${safeText(d.title)}\n마감 ${d.due} · 담당자 <@${d.assignee}>\n${safeText(d.type)} · ${safeText(d.priority)}\n상세: ${safeText(d.description).slice(0, 500) || '없음'}\n생성을 누르면 Notion과 Discord에 게시합니다.`,
    allowed_mentions: { parse: [] },
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: '상세 설명 입력', custom_id: `issue:detail:${id}` },
          { type: 2, style: 3, label: '확인하고 생성', custom_id: `issue:confirm:${id}` },
        ],
      },
    ],
  };
}
