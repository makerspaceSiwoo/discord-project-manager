import { safeText } from '../adapters/discord';
import { AppError, type Draft, type Issue, type Project } from '../core/types';
export function normalizeDueDate(value: unknown): string {
  if (typeof value !== 'string')
    throw new AppError(400, '마감일은 YYYY-MM-DD 또는 YYYYMMDD로 입력하세요.');
  const raw = value.trim();
  const due = /^[0-9]{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : raw;
  if (
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(due) ||
    due.startsWith('0000-') ||
    !Number.isFinite(Date.parse(due)) ||
    new Date(due).toISOString().slice(0, 10) !== due
  )
    throw new AppError(
      400,
      '존재하는 날짜를 YYYY-MM-DD 또는 YYYYMMDD로 입력하세요. 예: 2026-11-06 / 20261106',
    );
  return due;
}
export function validateDraft(input: any, p: Project): Draft {
  if (typeof input?.title !== 'string' || !input.title.trim() || input.title.length > 150)
    throw new AppError(400, '제목은 1~150자입니다.');
  const due = normalizeDueDate(input.due);
  if (typeof input.assignee !== 'string' || !/^\d{5,25}$/.test(input.assignee))
    throw new AppError(400, '연결된 담당자 한 명을 선택하세요.');
  if (!p.notion.types.includes(input.type) || !p.notion.priorities.includes(input.priority))
    throw new AppError(400, '설정에 있는 작업 유형과 우선순위를 선택하세요.');
  if (
    input.description !== undefined &&
    (typeof input.description !== 'string' || input.description.length > 1800)
  )
    throw new AppError(400, '상세 설명은 1,800자까지 입력할 수 있습니다.');
  return { ...input, due, title: input.title.trim(), description: input.description || '' };
}
export function issueStatus(i: Issue) {
  const state = i.archived ? '보관/휴지통' : i.status;
  const key = state.replace(/\s/g, '').toLowerCase();
  const emoji = i.archived
    ? '📦'
    : /^(완료|done|complete|completed)$/.test(key)
      ? '✅'
      : /^(진행중|inprogress|doing)$/.test(key)
        ? '🟦'
        : /^(보류|대기|onhold|blocked)$/.test(key)
          ? '⏸️'
          : /^(중단|취소|cancelled|canceled)$/.test(key)
            ? '⛔'
            : '⬜';
  return `${emoji} ${safeText(state)}`;
}
export function issueThreadName(i: Issue) {
  return `${safeText(i.taskId)} · ${issueStatus(i)} · ${safeText(i.title)}`.slice(0, 100);
}
export function issueSummary(i: Issue, discordUsers: string[]) {
  const assignees = discordUsers.length
    ? discordUsers.map((id) => `<@${id}>`).join(', ')
    : i.assignees.length
      ? 'Notion 담당자 (Discord 연결 없음)'
      : '미지정';
  return `**${safeText(i.taskId)} · ${safeText(i.title).slice(0, 150)}**\n\n> **상태 : ${issueStatus(i)}**\n유형 : ${safeText(i.type)}\n마감일 : ${i.due || '없음'}\n우선순위 : ${safeText(i.priority)}\n담당자 : ${assignees}\n\n${safeText(i.description).slice(0, 700)}\n\n<${i.url}>`;
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
        label('마감일 (YYYY-MM-DD / YYYYMMDD)', {
          ...text('due', 10, '예: 2026-11-06 또는 20261106'),
          min_length: 8,
        }),
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
