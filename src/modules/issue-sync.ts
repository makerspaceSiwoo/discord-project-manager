import { Discord } from '../adapters/discord';
import { Notion } from '../adapters/notion';
import { issuesEnabled } from '../core/access';
import { all, one, run } from '../core/db';
import { hash } from '../core/crypto';
import { RemoteError, type Env, type Project } from '../core/types';
import { issueSummary } from './issues';

// Reuse one durable polling job per page. Oldest due page first, bounded to one per minute.
export async function scheduleIssueSync(env: Env, p: Project, at = Date.now()) {
  if (!issuesEnabled(p)) return;
  const link = await one(
    env.DB,
    `SELECT page_id FROM issue_links WHERE project_id=?
    AND thread_id IS NOT NULL AND message_id IS NOT NULL AND next_sync_at<=?
    ORDER BY next_sync_at,page_id LIMIT 1`,
    p.id,
    at,
  );
  if (!link) return;
  const id = `issue-poll:${p.id}:${link.page_id}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO jobs(id,kind,payload,next_at,created_at) VALUES(?,'issue-sync',?,?,?)
      ON CONFLICT(id) DO UPDATE SET status='pending',state='{}',next_at=excluded.next_at,
      created_at=excluded.created_at,attempts=0,error=NULL WHERE jobs.status='done'`,
    ).bind(id, JSON.stringify({ pageId: link.page_id }), at, at),
    env.DB.prepare('UPDATE issue_links SET next_sync_at=? WHERE page_id=? AND project_id=?').bind(
      at + 60_000,
      link.page_id,
      p.id,
    ),
  ]);
}

export async function syncIssue(env: Env, p: Project, n: Notion, d: Discord, payload: any) {
  const db = env.DB;
  const link = await one(
    db,
    'SELECT * FROM issue_links WHERE page_id=? AND project_id=?',
    payload.pageId,
    p.id,
  );
  if (!link?.thread_id || !link.message_id) return null;
  const channel = p.issueChannelMode === 'forum' ? link.thread_id : p.issueChannelId;
  const edit = (content: string) =>
    p.issueChannelMode === 'forum'
      ? d.withOpenThread(link.thread_id, () => d.edit(channel, link.message_id, content))
      : d.edit(channel, link.message_id, content);
  let page: any;
  try {
    page = await n.api(`/pages/${payload.pageId}`);
  } catch (error) {
    if (!(error instanceof RemoteError && error.status === 404)) throw error;
    if (link.display_hash !== 'unavailable') {
      await edit('Notion 페이지 삭제 또는 접근 불가 · 대화 기록은 보존됩니다.');
      await run(
        db,
        "UPDATE issue_links SET display_hash='unavailable' WHERE page_id=?",
        link.page_id,
      );
    }
    return { finished: true, changed: link.display_hash !== 'unavailable' };
  }
  if (link.last_edited && page.last_edited_time < link.last_edited) return null;
  const issue = n.normalize(p, page);
  issue.assignees.sort();
  const mappings = await all(
    db,
    'SELECT discord_id,notion_id FROM links WHERE project_id=? AND (valid_until=0 OR valid_until>?)',
    p.id,
    Date.now(),
  );
  const users = mappings
    .filter((m) => issue.assignees.includes(m.notion_id))
    .map((m) => m.discord_id)
    .sort();
  // No body/block reads. Ignore edit timestamps and all unrelated properties.
  const fingerprint = await hash(
    JSON.stringify({
      title: issue.title,
      status: issue.status,
      color: issue.statusColor,
      type: issue.type,
      due: issue.due,
      priority: issue.priority,
      assignees: issue.assignees,
      users,
      archived: issue.archived,
    }),
  );
  const changed = link.display_hash !== fingerprint;
  if (changed || payload.refreshPresentation) await edit(issueSummary(issue, users));
  await run(
    db,
    'UPDATE issue_links SET display_hash=?,last_edited=?,assignees=? WHERE page_id=?',
    fingerprint,
    issue.edited,
    JSON.stringify(issue.assignees),
    issue.id,
  );
  let removedNotices = 0;
  if (payload.removeActivityNotices) {
    const notices = await all(
      db,
      `SELECT e.result FROM effects e JOIN jobs j ON j.id=e.id
      WHERE e.state='done' AND j.kind='assignee-notify' AND json_extract(j.payload,'$.pageId')=?
      AND json_extract(j.payload,'$.threadId')=? ORDER BY j.created_at DESC LIMIT 4`,
      issue.id,
      link.thread_id,
    );
    for (const notice of notices) {
      const id = JSON.parse(notice.result).id;
      try {
        const message = await d.api(`/channels/${link.thread_id}/messages/${id}`);
        if (
          message.author?.id !== env.DISCORD_APPLICATION_ID ||
          (message.type ?? 0) !== 0 ||
          !/^새 담당자: <@\d+>(?:\n\[연수리:[a-f0-9]{18}\])?$/.test(message.content)
        )
          continue;
        await d.api(`/channels/${link.thread_id}/messages/${id}`, 'DELETE');
        removedNotices++;
      } catch (error) {
        if (!(error instanceof RemoteError && error.status === 404)) throw error;
      }
    }
  }
  return { finished: true, changed, removedNotices };
}
