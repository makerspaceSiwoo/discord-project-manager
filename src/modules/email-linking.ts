import { Notion } from '../adapters/notion';
import { Discord } from '../adapters/discord';
import { linkingEnabled } from '../core/access';
import { all, one, run } from '../core/db';
import { random } from '../core/crypto';
import { AppError, type Env, type Identity, type Project } from '../core/types';
import { withVerifiedPerson } from './linking';

const normalize = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
function enabled(p: Project) {
  if (!linkingEnabled(p) || !p.notion.probePageId)
    throw new AppError(409, '계정 연결 설정이 준비되지 않았습니다.');
}
export async function findPersonByEmail(n: Notion, p: Project, email: string) {
  const matches = new Map<string, any>();
  const consider = (user: any) => {
    if (user.type === 'person' && normalize(user.person?.email) === email)
      matches.set(user.id, user);
  };
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const users = await n.api(
      '/users?page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''),
    );
    for (const user of users.results) consider(user);
    if (!users.has_more) break;
    if (page === 4)
      throw new AppError(409, '사용자 조회 범위를 초과했습니다. 관리자에게 알려 주세요.');
    cursor = users.next_cursor;
  }
  // Workspace user lists omit guests. A known guest ID can be retrieved from the dedicated row.
  if (!matches.size) {
    const probe = await n.api('/pages/' + p.notion.probePageId);
    if (
      probe.parent?.data_source_id?.replaceAll('-', '') !==
        p.notion.dataSourceId.replaceAll('-', '') ||
      probe.archived ||
      probe.in_trash
    )
      throw new AppError(409, '검증 행 설정을 확인해 주세요.');
    const people = probe.properties[p.notion.properties.assignees]?.people || [];
    if (people.length > 10)
      throw new AppError(409, '검증용 행의 담당자는 최대 10명까지 조회합니다.');
    for (const user of people) {
      consider(user.person?.email ? user : await n.api('/users/' + user.id));
    }
  }
  if (matches.size > 1)
    throw new AppError(409, '같은 이메일의 계정이 여러 개입니다. 관리자 확인이 필요합니다.');
  if (!matches.size)
    throw new AppError(
      404,
      '이메일에 해당하는 Notion 계정을 찾지 못했습니다. 이메일 정보 읽기 권한을 확인하세요. 게스트라면 관리자가 Notion의 [봇 설정] 계정 연결 검증용 행 담당자에 해당 계정을 추가한 뒤 다시 요청하세요.',
    );
  return [...matches.values()][0];
}
export async function requestEmailLink(env: Env, p: Project, who: Identity, input: unknown) {
  enabled(p);
  const email = normalize(input);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new AppError(400, 'Notion 로그인 이메일을 입력해 주세요.');
  if (
    await one(env.DB, 'SELECT 1 FROM links WHERE project_id=? AND discord_id=?', p.id, who.userId)
  )
    throw new AppError(409, '이미 연결된 계정이 있습니다. 변경하려면 먼저 연결을 해제하세요.');
  const at = Date.now();
  const rate = await run(
    env.DB,
    'INSERT INTO locks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE locks.expires<=?',
    `email-link:${p.id}:${who.userId}`,
    random(),
    at + 60_000,
    at,
  );
  if (!rate.meta.changes) throw new AppError(429, '1분 후 다시 이메일로 요청할 수 있습니다.');
  const person = await findPersonByEmail(new Notion(env), p, email);
  const id = random();
  await run(
    env.DB,
    'INSERT INTO link_requests VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,discord_id) DO UPDATE SET id=excluded.id,notion_id=excluded.notion_id,email=excluded.email,name=excluded.name,created_at=excluded.created_at,expires=excluded.expires',
    id,
    p.id,
    who.userId,
    person.id,
    email,
    person.name || '(이름 없음)',
    at,
    at + 7 * 86400_000,
  );
  return { id, name: person.name || '(이름 없음)', email, expires: at + 7 * 86400_000 };
}
export async function ownEmailRequest(env: Env, p: Project, who: Identity) {
  return one(
    env.DB,
    'SELECT id,name,email,expires FROM link_requests WHERE project_id=? AND discord_id=? AND expires>?',
    p.id,
    who.userId,
    Date.now(),
  );
}
export async function listEmailRequests(env: Env, p: Project, who: Identity) {
  if (!who.admin) throw new AppError(403, '관리자만 계정 연결 요청을 확인할 수 있습니다.');
  return all(
    env.DB,
    `SELECT r.id,r.discord_id,r.name,r.email,r.expires,COALESCE(MAX(s.name),r.discord_id) AS discord_name
    FROM link_requests r LEFT JOIN sessions s ON s.user_id=r.discord_id
    WHERE r.project_id=? AND r.expires>? GROUP BY r.id ORDER BY r.created_at LIMIT 100`,
    p.id,
    Date.now(),
  );
}
export async function approveEmailRequest(env: Env, p: Project, who: Identity, id: string) {
  if (!who.admin) throw new AppError(403, '관리자만 계정 연결을 확인할 수 있습니다.');
  enabled(p);
  const row = await one(
    env.DB,
    'SELECT * FROM link_requests WHERE id=? AND project_id=? AND expires>?',
    id,
    p.id,
    Date.now(),
  );
  if (!row) throw new AppError(404, '연결 요청이 없거나 만료되었습니다.');
  await new Discord(env).member(p, row.discord_id);
  const person = await new Notion(env).api('/users/' + row.notion_id);
  if (
    person.id !== row.notion_id ||
    person.type !== 'person' ||
    normalize(person.person?.email) !== row.email
  )
    throw new AppError(409, 'Notion 계정 정보가 변경되었습니다. 이메일로 다시 요청하세요.');
  await withVerifiedPerson(env, p, row.notion_id, async () => {
    const at = Date.now();
    const result = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO links(project_id,discord_id,notion_id,verified_at,valid_until)
        SELECT project_id,discord_id,notion_id,?,? FROM link_requests WHERE id=? AND project_id=? AND expires>?`,
      ).bind(at, p.linkLifetimeDays === 0 ? 0 : at + p.linkLifetimeDays * 86400_000, id, p.id, at),
      env.DB.prepare('DELETE FROM link_requests WHERE id=? AND project_id=? AND expires>?').bind(
        id,
        p.id,
        at,
      ),
      env.DB.prepare('UPDATE challenges SET consumed=1 WHERE project_id=? AND user_id=?').bind(
        p.id,
        row.discord_id,
      ),
    ]);
    if (!result[0].meta.changes)
      throw new AppError(409, '요청이 취소되거나 변경되었습니다. 새로고침해 주세요.');
  });
  return { ok: true };
}
export async function cancelEmailRequest(env: Env, p: Project, who: Identity, id: string) {
  await run(
    env.DB,
    'DELETE FROM link_requests WHERE id=? AND project_id=?' +
      (who.admin ? '' : ' AND discord_id=?'),
    id,
    p.id,
    ...(who.admin ? [] : [who.userId]),
  );
  return { ok: true };
}

export async function emailCapabilities(env: Env, who: Identity) {
  if (!who.admin) throw new AppError(403, '관리자 전용입니다.');
  const page = await new Notion(env).api('/users?page_size=100');
  const people = page.results.filter((user: any) => user.type === 'person');
  return {
    canReadUsers: true,
    checkedPeople: people.length,
    usersWithEmail: people.filter(
      (user: any) => typeof user.person?.email === 'string' && user.person.email.length > 0,
    ).length,
    hasMore: !!page.has_more,
  };
}
