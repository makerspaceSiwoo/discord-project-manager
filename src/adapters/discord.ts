import { AppError, type Env, type Member, type Project, RemoteError } from '../core/types';
import { Http } from './http';
import { projectMember } from '../core/access';
export class Discord {
  constructor(
    private env: Env,
    public http = new Http(),
  ) {}
  api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
    return this.http.request('discord', `https://discord.com/api/v10${path}`, {
      method,
      headers: {
        Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async member(p: Project, id: string) {
    try {
      const m = await this.api(`/guilds/${p.guildId}/members/${id}`);
      if (!projectMember(p, m))
        throw new AppError(403, '이 서버의 프로젝트 멤버만 이용할 수 있습니다.');
      return m;
    } catch (e) {
      if (e instanceof RemoteError && e.status === 404)
        throw new AppError(403, '서버 멤버가 아닙니다.');
      throw e;
    }
  }
  async rosterPage(p: Project, after = '0') {
    const members: any[] = await this.api(`/guilds/${p.guildId}/members?limit=100&after=${after}`);
    const selected: Member[] = members
      .filter((m) => projectMember(p, m))
      .map((m) => ({ id: m.user.id, name: m.nick || m.user.global_name || m.user.username }));
    return { members: selected, after: members.length === 100 ? members.at(-1).user.id : null };
  }
  message(channel: string, content: string, users: string[] = [], nonce?: string) {
    return this.api(`/channels/${channel}/messages`, 'POST', {
      content,
      allowed_mentions: { parse: [], users },
      ...(nonce ? { nonce, enforce_nonce: true } : {}),
    });
  }
  edit(channel: string, id: string, content: string) {
    return this.api(`/channels/${channel}/messages/${id}`, 'PATCH', {
      content,
      allowed_mentions: { parse: [] },
    });
  }
  async findMessage(channel: string, marker: string) {
    const rows: any[] = await this.api(`/channels/${channel}/messages?limit=100`);
    const matches = rows.filter(
      (m) => m.author?.id === this.env.DISCORD_APPLICATION_ID && m.content?.includes(marker),
    );
    if (matches.length > 1) throw new AppError(409, '중복 메시지 발견: 관리자 복구가 필요합니다.');
    return matches[0] || null;
  }
  async findForum(p: Project, marker: string) {
    const active = await this.api(`/guilds/${p.guildId}/threads/active`);
    const archived = await this.api(
      `/channels/${p.issueChannelId}/threads/archived/public?limit=100`,
    );
    const matches = [...active.threads, ...archived.threads].filter(
      (t) => t.parent_id === p.issueChannelId && t.name.includes(marker),
    );
    if (matches.length > 1) throw new AppError(409, '중복 포럼 게시물: 관리자 확인 필요');
    if (!matches.length) return null;
    return { ...matches[0], message: { id: matches[0].id } };
  }
  async withOpenThread<T>(channel: string, action: () => Promise<T>): Promise<T> {
    const thread = await this.api(`/channels/${channel}`),
      archived = thread.thread_metadata?.archived;
    if (archived) await this.api(`/channels/${channel}`, 'PATCH', { archived: false });
    try {
      return await action();
    } finally {
      if (archived) await this.api(`/channels/${channel}`, 'PATCH', { archived: true });
    }
  }
  async followup(token: string, data: unknown) {
    return this.http.request(
      'discord',
      `https://discord.com/api/v10/webhooks/${this.env.DISCORD_APPLICATION_ID}/${token}/messages/@original`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      },
    );
  }
}
export const safeText = (s: string) =>
  s
    .replace(/[`*_~|>\\]/g, ' ')
    .replace(/@/g, '＠')
    .replace(/[\r\n]+/g, ' ');
