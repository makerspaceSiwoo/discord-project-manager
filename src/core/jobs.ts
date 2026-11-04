import { Discord, safeText } from '../adapters/discord';
import { Http } from '../adapters/http';
import { Notion, plain } from '../adapters/notion';
import { issueSummary, validateDraft } from '../modules/issues';
import { addDays, currentWeek, timing } from '../modules/scheduling';
import { rank, reportable, reportMessage } from '../modules/reporting';
import { all, enqueue, one, run } from './db';
import { random, hash } from './crypto';
import { effect } from './effects';
import { automationEnabled, issuesEnabled } from './access';
import { createIssuePage, NOTION_CREATE_UNCERTAIN } from './issue-creation';
import {
  AppError,
  RemoteError,
  type Env,
  type Job,
  type Project,
  type Member,
  type Issue,
} from './types';
export async function schedule(env: Env, p: Project, at = Date.now()) {
  if (!automationEnabled(p)) return;
  let cursor = await one(env.DB, 'SELECT next_week FROM schedule_cursor WHERE project_id=?', p.id);
  let week = cursor?.next_week || currentWeek(at, p.timezone);
  // One week per invocation; persisted cursor catches up without an unbounded scan.
  const t = timing(week, p);
  if (at < t.opens) return;
  const due: [string, string, number][] = [
    ['poll-open', 'open', t.opens],
    ['poll-remind', 'remind', t.reminder],
    ['poll-close', 'close', t.closes],
    ['report', 'report', t.report],
  ];
  const statements = due
    .filter(([, , when]) => when <= at)
    .map(([kind, label, when]) =>
      env.DB.prepare(
        'INSERT OR IGNORE INTO jobs(id,kind,payload,next_at,created_at) VALUES(?,?,?,?,?)',
      ).bind(`${p.id}:${week}:${label}`, kind, JSON.stringify({ week }), when, at),
    );
  if (at >= t.report)
    statements.push(
      env.DB.prepare(
        'INSERT INTO schedule_cursor VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET next_week=excluded.next_week',
      ).bind(p.id, addDays(week, 7)),
    );
  else
    statements.push(
      env.DB.prepare('INSERT OR IGNORE INTO schedule_cursor VALUES(?,?)').bind(p.id, week),
    );
  if (statements.length) await env.DB.batch(statements);
}
export async function processOne(env: Env, p: Project, preferred?: string) {
  const allowedKinds = [
    ...(issuesEnabled(p) ? ['issue-create', 'issue-sync', 'assignee-notify'] : []),
    ...(automationEnabled(p) ? ['poll-open', 'poll-remind', 'poll-close', 'report', 'dm'] : []),
  ];
  if (!allowedKinds.length) return;
  const owner = random(),
    at = Date.now();
  const lock = await run(
    env.DB,
    'INSERT INTO locks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE locks.expires<?',
    'worker',
    owner,
    at + 180_000,
    at,
  );
  if (!lock.meta.changes) return;
  let job: Job | null = null;
  try {
    job = await one<Job>(
      env.DB,
      `UPDATE jobs SET status='running',lease=?,lease_until=?,attempts=attempts+1 WHERE id=(SELECT id FROM jobs WHERE ((status='pending' AND next_at<=?) OR (status='running' AND lease_until<?)) AND kind IN (${allowedKinds.map(() => '?').join(',')}) ${preferred ? 'AND id=?' : ''} ORDER BY next_at,created_at LIMIT 1) RETURNING *`,
      owner,
      at + 180_000,
      at,
      at,
      ...allowedKinds,
      ...(preferred ? [preferred] : []),
    );
    if (!job) return;
    const state = await execute(env, p, job);
    await run(
      env.DB,
      'UPDATE jobs SET state=?,status=?,next_at=?,lease=NULL,lease_until=NULL,error=NULL,attempts=0 WHERE id=? AND lease=?',
      JSON.stringify(state || {}),
      state && !state.finished ? 'pending' : 'done',
      Date.now(),
      job.id,
      owner,
    );
  } catch (e) {
    if (job) {
      const retry =
        e instanceof RemoteError && (e.status === 0 || e.status === 429 || e.status >= 500);
      const uncertain = e instanceof AppError && e.code === 'uncertain';
      const status =
        e instanceof AppError && e.code === NOTION_CREATE_UNCERTAIN
          ? 'review'
          : (retry && job.attempts < 8) || (uncertain && job.attempts < 3)
            ? 'pending'
            : uncertain
              ? 'review'
              : 'failed';
      const wait =
        e instanceof RemoteError
          ? Math.max(e.retryAfter * 1000, Math.min(3600_000, 30_000 * 2 ** job.attempts))
          : 60_000;
      // Deliberately never log request headers, tokens, raw webhook bodies, or remote error payloads.
      const message =
        e instanceof AppError
          ? e.message
          : e instanceof RemoteError
            ? `${e.service}:${e.status}`
            : 'internal_error';
      await run(
        env.DB,
        'UPDATE jobs SET status=?,next_at=?,error=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=?',
        status,
        Date.now() + wait,
        message.slice(0, 500),
        job.id,
        owner,
      );
    } else throw e;
  } finally {
    await run(env.DB, 'DELETE FROM locks WHERE id=? AND owner=?', 'worker', owner);
  }
}
async function execute(env: Env, p: Project, job: Job): Promise<any | null> {
  const payload = JSON.parse(job.payload),
    s = JSON.parse(job.state),
    http = new Http(),
    d = new Discord(env, http),
    n = new Notion(env, http),
    db = env.DB;
  const sent = async (
    id: string,
    channel: string,
    content: string,
    users: string[] = [],
    thread = false,
  ) => {
    const marker = `[연수리:${(await hash(id)).slice(0, 18)}]`,
      nonce = (await hash(id)).slice(0, 24);
    const send = () =>
      effect(
        db,
        id,
        () => d.message(channel, content + '\n' + marker, users, nonce),
        () => d.findMessage(channel, marker),
      );
    return thread ? d.withOpenThread(channel, send) : send();
  };
  if (job.kind === 'issue-create') {
    const draft = validateDraft(payload.draft, p),
      requestId = job.id;
    if (!s.pageId) {
      await d.member(p, payload.userId);
      await d.member(p, draft.assignee);
      const link = await one(
        db,
        'SELECT notion_id FROM links WHERE project_id=? AND discord_id=? AND valid_until>?',
        p.id,
        draft.assignee,
        Date.now(),
      );
      if (!link)
        throw new AppError(
          409,
          '담당자 계정 연결이 없거나 만료되었습니다. 다시 연결 후 재시도하세요.',
        );
      const page = await createIssuePage(db, n, p, draft, link.notion_id, job.id);
      await run(
        db,
        'INSERT OR IGNORE INTO issue_links(page_id,project_id,request_id) VALUES(?,?,?)',
        page.id,
        p.id,
        requestId,
      );
      return { ...s, pageId: page.id };
    }
    if (!s.threadId) {
      const page = await n.api(`/pages/${s.pageId}`),
        i = n.normalize(p, page);
      i.description = draft.description;
      const marker = `[${(await hash(requestId)).slice(0, 12)}]`;
      const content = issueSummary(i, [draft.assignee], marker);
      let thread: any, messageId: string;
      if (p.issueChannelMode === 'forum') {
        thread = await effect(
          db,
          `${job.id}:thread`,
          () =>
            d.api(`/channels/${p.issueChannelId}/threads`, 'POST', {
              name: `${marker} ${safeText(i.title)}`.slice(0, 100),
              auto_archive_duration: 1440,
              message: { content, allowed_mentions: { parse: [] } },
            }),
          () => d.findForum(p, marker),
        );
        messageId = thread.message?.id || thread.id;
      } else {
        const m = await sent(`${job.id}:starter`, p.issueChannelId, content);
        thread = await effect(
          db,
          `${job.id}:thread`,
          () =>
            d.api(`/channels/${p.issueChannelId}/messages/${m.id}/threads`, 'POST', {
              name: `${marker} ${safeText(i.title)}`.slice(0, 100),
              auto_archive_duration: 1440,
            }),
          async () => {
            try {
              return await d.api(`/channels/${m.id}`);
            } catch (e) {
              if (e instanceof RemoteError && e.status === 404) return null;
              throw e;
            }
          },
        );
        messageId = m.id;
      }
      await run(
        db,
        'UPDATE issue_links SET thread_id=?,message_id=? WHERE page_id=?',
        thread.id,
        messageId,
        s.pageId,
      );
      return { ...s, threadId: thread.id, messageId };
    }
    await n.api(`/pages/${s.pageId}`, 'PATCH', {
      properties: {
        [p.notion.properties.discord]: {
          url: `https://discord.com/channels/${p.guildId}/${s.threadId}`,
        },
      },
    });
    await enqueue(db, `${job.id}:initial-sync`, 'issue-sync', { pageId: s.pageId });
    return null;
  }
  if (job.kind === 'issue-sync') {
    const link = await one(
      db,
      'SELECT * FROM issue_links WHERE page_id=? AND project_id=?',
      payload.pageId,
      p.id,
    );
    if (!link?.thread_id) return null;
    let page: any;
    try {
      page = await n.api(`/pages/${payload.pageId}`);
    } catch (e) {
      if (e instanceof RemoteError && e.status === 404) {
        await d.withOpenThread(link.thread_id, () =>
          d.edit(
            p.issueChannelMode === 'forum' ? link.thread_id : p.issueChannelId,
            link.message_id,
            'Notion 페이지 삭제 또는 접근 불가 · 대화 기록은 보존됩니다.',
          ),
        );
        return null;
      }
      throw e;
    }
    if (link.last_edited && page.last_edited_time < link.last_edited) return null;
    const i = n.normalize(p, page);
    // Discord contains a bounded summary, the Notion link remains the full source.
    const body = i.archived
      ? { results: [] }
      : await n.api(`/blocks/${page.id}/children?page_size=25`);
    i.description = body.results
      .map((b: any) => plain(b[b.type]?.rich_text))
      .filter(Boolean)
      .join('\n');
    const mappings = await all(
      db,
      'SELECT discord_id,notion_id FROM links WHERE project_id=? AND valid_until>?',
      p.id,
      Date.now(),
    );
    const assigned = mappings.filter((m) => i.assignees.includes(m.notion_id));
    const previous: string[] = JSON.parse(link.assignees),
      newOnes = assigned.filter((m) => !previous.includes(m.notion_id));
    const marker = `[${(await hash(link.request_id)).slice(0, 12)}]`;
    await d.withOpenThread(link.thread_id, async () => {
      await d.api(`/channels/${link.thread_id}`, 'PATCH', {
        name: `${marker} ${i.archived ? '[보관] ' : ''}${safeText(i.status)} · ${safeText(i.title)}`.slice(
          0,
          100,
        ),
      });
      await d.edit(
        p.issueChannelMode === 'forum' ? link.thread_id : p.issueChannelId,
        link.message_id,
        issueSummary(
          i,
          assigned.map((m) => m.discord_id),
          marker,
        ),
      );
    });
    await db.batch([
      ...newOnes.map((m) =>
        db
          .prepare(
            'INSERT OR IGNORE INTO jobs(id,kind,payload,next_at,created_at) VALUES(?,?,?,?,?)',
          )
          .bind(
            `assignee:${i.id}:${i.edited}:${m.discord_id}`,
            'assignee-notify',
            JSON.stringify({
              pageId: i.id,
              notionId: m.notion_id,
              userId: m.discord_id,
              threadId: link.thread_id,
            }),
            Date.now(),
            Date.now(),
          ),
      ),
      db
        .prepare('UPDATE issue_links SET last_edited=?,assignees=? WHERE page_id=?')
        .bind(i.edited, JSON.stringify(i.assignees), i.id),
    ]);
    return null;
  }
  if (job.kind === 'assignee-notify') {
    const mapping = await one(
      db,
      'SELECT 1 FROM links WHERE project_id=? AND discord_id=? AND notion_id=? AND valid_until>?',
      p.id,
      payload.userId,
      payload.notionId,
      Date.now(),
    );
    if (!mapping) return null;
    const page = await n.api(`/pages/${payload.pageId}`),
      i = n.normalize(p, page);
    if (i.archived || !i.assignees.includes(payload.notionId)) return null;
    try {
      await d.member(p, payload.userId);
    } catch (e) {
      if (e instanceof AppError && e.status === 403) return null;
      throw e;
    }
    await sent(job.id, payload.threadId, `새 담당자: <@${payload.userId}>`, [payload.userId], true);
    return null;
  }
  const week = payload.week,
    pollId = `${p.id}:${week}`,
    t = week ? timing(week, p) : null;
  if (job.kind === 'poll-open') {
    if (Date.now() >= t!.closes)
      throw new AppError(
        409,
        '투표 개시를 마감 전에 실행하지 못했습니다. 과거 대상 명단을 추정해 생성하지 않습니다.',
      );
    if (!s.rosterDone) {
      const r = await d.rosterPage(p, s.after),
        members: Member[] = [...(s.members || []), ...r.members];
      if (members.length > p.maxMembers)
        throw new AppError(
          409,
          `대상 ${members.length}명이 설정된 한도 ${p.maxMembers}명을 초과합니다.`,
        );
      if (r.after) return { ...s, members, after: r.after };
      await run(
        db,
        'INSERT OR IGNORE INTO polls(id,project_id,week,opens,closes,members) VALUES(?,?,?,?,?,?)',
        pollId,
        p.id,
        week,
        t!.opens,
        t!.closes,
        JSON.stringify(members),
      );
      return { ...s, rosterDone: true };
    }
    const poll = await one(db, 'SELECT * FROM polls WHERE id=?', pollId);
    const message = await sent(
      `${job.id}:notice`,
      p.schedulingChannelId,
      `🗓️ **${week} 주간 일정 투표**\n월~일 09:00~23:00 · 30분 단위\n일요일 자정 전까지 저장하세요.\n${env.APP_ORIGIN}/?poll=${encodeURIComponent(pollId)}\n대상 ${JSON.parse(poll.members).length}명`,
    );
    const thread = await effect(
      db,
      `${job.id}:thread`,
      () =>
        d.api(`/channels/${p.schedulingChannelId}/messages/${message.id}/threads`, 'POST', {
          name: `${week} 일정 이야기`,
          auto_archive_duration: 1440,
        }),
      async () => {
        try {
          return await d.api(`/channels/${message.id}`);
        } catch (e) {
          if (e instanceof RemoteError && e.status === 404) return null;
          throw e;
        }
      },
    );
    await run(
      db,
      'UPDATE polls SET message_id=?,thread_id=? WHERE id=?',
      message.id,
      thread.id,
      pollId,
    );
    return null;
  }
  if (job.kind === 'poll-remind') {
    if (Date.now() >= t!.closes) return null;
    const poll = await one(db, 'SELECT * FROM polls WHERE id=?', pollId);
    if (!poll) throw new RemoteError('poll-not-ready', 503, 60);
    for (const m of JSON.parse(poll.members))
      await enqueue(db, `${job.id}:${m.id}`, 'dm', { pollId, userId: m.id });
    return null;
  }
  if (job.kind === 'dm') {
    const poll = await one(db, 'SELECT * FROM polls WHERE id=?', payload.pollId);
    if (
      !poll ||
      Date.now() >= poll.closes ||
      (await one(db, 'SELECT 1 FROM votes WHERE poll_id=? AND user_id=?', poll.id, payload.userId))
    )
      return null;
    try {
      await d.member(p, payload.userId);
      const dm = await d.api('/users/@me/channels', 'POST', { recipient_id: payload.userId });
      await sent(
        job.id,
        dm.id,
        `아직 일정 투표 응답이 없습니다. 가능한 시간이 없어도 제출해 주세요.\n${env.APP_ORIGIN}/?poll=${encodeURIComponent(poll.id)}`,
      );
    } catch (e) {
      if (
        (e instanceof RemoteError && [403, 404].includes(e.status)) ||
        (e instanceof AppError && e.status === 403)
      )
        return { skipped: true, reason: 'DM 거부 또는 접근 권한 없음', finished: true };
      throw e;
    }
    return null;
  }
  if (job.kind === 'poll-close') {
    const poll = await one(db, 'SELECT * FROM polls WHERE id=?', pollId);
    if (!poll?.thread_id)
      throw new AppError(409, '원래 투표 스레드가 없습니다. 개시 작업을 복구하세요.');
    await sent(
      job.id,
      poll.thread_id,
      `✅ ${week} 투표가 마감되었습니다. 확정 결과: ${env.APP_ORIGIN}/?poll=${encodeURIComponent(pollId)}&tab=team`,
      [],
      true,
    );
    return null;
  }
  if (job.kind === 'report') {
    await run(
      db,
      'INSERT OR IGNORE INTO report_runs(id,project_id,week) VALUES(?,?,?)',
      job.id,
      p.id,
      week,
    );
    if (!s.collected) {
      const page = await n.query(p, s.cursor);
      const items: Issue[] = page.results
        .map((x: any) => n.normalize(p, x))
        .filter((i: Issue) => reportable(i, p));
      if (items.length)
        await db.batch(
          items.map((i) =>
            db
              .prepare('INSERT OR REPLACE INTO report_items VALUES(?,?,?,?,?,?)')
              .bind(job.id, i.id, JSON.stringify(i), i.due || '9999-12-31', rank(i, p), i.created),
          ),
        );
      return page.has_more
        ? { ...s, cursor: page.next_cursor }
        : { ...s, collected: true, offset: 0 };
    }
    const rows = await all(
      db,
      'SELECT payload FROM report_items WHERE report_id=? ORDER BY due_sort,priority_rank,created,page_id LIMIT 1 OFFSET ?',
      job.id,
      s.offset || 0,
    );
    const full = `전체 표: ${env.APP_ORIGIN}/?report=${encodeURIComponent(job.id)}`;
    if (rows.length) {
      const i = JSON.parse(rows[0].payload),
        link = await one(db, 'SELECT thread_id FROM issue_links WHERE page_id=?', i.id);
      if (link?.thread_id)
        i.discordUrl = `https://discord.com/channels/${p.guildId}/${link.thread_id}`;
      const mappings = await all(
        db,
        'SELECT notion_id,discord_id FROM links WHERE project_id=?',
        p.id,
      );
      i.names = i.assignees.map(
        (id: string) => mappings.find((m) => m.notion_id === id)?.discord_id || `Notion:${id}`,
      );
      await sent(`${job.id}:row:${s.offset || 0}`, p.reportChannelId, reportMessage([i], full));
      return { ...s, offset: (s.offset || 0) + 1 };
    }
    if (!s.offset) await sent(`${job.id}:empty`, p.reportChannelId, reportMessage([], full));
    await run(db, 'UPDATE report_runs SET complete=1 WHERE id=?', job.id);
    return null;
  }
  throw new AppError(400, '알 수 없는 작업');
}
