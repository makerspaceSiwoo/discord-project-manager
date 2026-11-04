import { AppError, type Draft, type Env, type Issue, type Project } from '../core/types';
import { Http } from './http';
export const plain = (items: any[] = []) =>
  items.map((x) => x.plain_text ?? x.text?.content ?? '').join('');
export const rich = (text: string) => [{ type: 'text', text: { content: text } }];
export class Notion {
  constructor(
    private env: Env,
    public http = new Http(),
  ) {}
  api<T = any>(path: string, method = 'GET', body?: unknown, timeoutMs = 8_000): Promise<T> {
    return this.http.request(
      'notion',
      `https://api.notion.com/v1${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.env.NOTION_TOKEN}`,
          'Notion-Version': this.env.NOTION_VERSION || '2026-03-11',
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      timeoutMs,
    );
  }
  query(p: Project, cursor?: string, filter?: unknown) {
    return this.api(`/data_sources/${p.notion.dataSourceId}/query`, 'POST', {
      page_size: 25,
      ...(cursor ? { start_cursor: cursor } : {}),
      ...(filter ? { filter } : {}),
    });
  }
  create(p: Project, d: Draft, notionId: string) {
    const m = p.notion.properties;
    return this.api(
      '/pages',
      'POST',
      {
        parent: { type: 'data_source_id', data_source_id: p.notion.dataSourceId },
        properties: {
          [m.title]: { title: rich(d.title) },
          [m.due]: { date: { start: d.due } },
          [m.assignees]: { people: [{ object: 'user', id: notionId }] },
          [m.type]: { select: { name: d.type } },
          [m.priority]: { select: { name: d.priority } },
          [m.status]: { [p.notion.statusType]: { name: p.notion.initialStatus } },
        },
        children: d.description
          ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(d.description) } }]
          : [],
      },
      5_000,
    );
  }
  normalize(p: Project, page: any): Issue {
    const m = p.notion.properties,
      v = page.properties;
    const unique = v[m.taskId]?.unique_id;
    const text = (key: string) => plain(v[key]?.rich_text);
    return {
      id: page.id,
      taskId: unique
        ? `${unique.prefix ? unique.prefix + '-' : ''}${unique.number}`
        : text(m.taskId) || page.id.slice(0, 8),
      title: plain(v[m.title]?.title) || '(제목 없음)',
      due: v[m.due]?.date?.start?.slice(0, 10) || null,
      assignees: (v[m.assignees]?.people || []).map((u: any) => u.id),
      type: v[m.type]?.select?.name || '',
      priority: v[m.priority]?.select?.name || '',
      status: v[m.status]?.[p.notion.statusType]?.name || '',
      statusColor: v[m.status]?.[p.notion.statusType]?.color || 'default',
      created: v[m.created]?.created_time || page.created_time,
      parentIds: (v[m.parent]?.relation || []).map((r: any) => r.id),
      archived: !!(page.archived || page.is_archived || page.in_trash),
      url: page.url,
      description: '',
      edited: page.last_edited_time,
    };
  }
  async comments(page: string) {
    const found: any[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 5; n++) {
      const r = await this.api(
        `/comments?block_id=${page}&page_size=100${cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''}`,
      );
      found.push(...r.results);
      if (!r.has_more) return found;
      cursor = r.next_cursor;
    }
    throw new AppError(
      409,
      '댓글 조회 범위가 초과되었습니다. 인증 페이지를 정리한 뒤 다시 시도하세요.',
    );
  }
  async schema(p: Project) {
    const source = await this.api(`/data_sources/${p.notion.dataSourceId}`);
    const types: Record<string, string[]> = {
      taskId: ['unique_id', 'rich_text'],
      title: ['title'],
      due: ['date'],
      assignees: ['people'],
      type: ['select'],
      priority: ['select'],
      status: [p.notion.statusType],
      created: ['created_time'],
      parent: ['relation'],
      children: ['relation'],
      discord: ['url'],
    };
    const problems: string[] = [];
    for (const [key, allowed] of Object.entries(types)) {
      const name = p.notion.properties[key as keyof typeof p.notion.properties];
      const v = source.properties[name];
      if (!v || !allowed.includes(v.type))
        problems.push(`${name}: ${allowed.join('/')} 속성이 필요합니다.`);
    }
    for (const [key, expected] of [
      ['type', p.notion.types],
      ['priority', p.notion.priorities],
      ['status', [p.notion.initialStatus, ...p.notion.excludedStatuses]],
    ] as const) {
      const prop = source.properties[p.notion.properties[key]];
      const names = (prop?.[prop.type]?.options || []).map((o: any) => o.name);
      for (const name of expected)
        if (!names.includes(name)) problems.push(`${key}: 선택지 '${name}' 없음`);
    }
    return { ok: problems.length === 0, problems, properties: source.properties };
  }
}
