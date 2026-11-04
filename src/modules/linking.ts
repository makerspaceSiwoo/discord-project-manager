import { Notion, plain } from '../adapters/notion';
import { linkingEnabled } from '../core/access';
import { hash, random } from '../core/crypto';
import { one, run } from '../core/db';
import { AppError, type Env, type Identity, type Project } from '../core/types';
function enabled(p: Project) {
  if (!linkingEnabled(p) || !p.notion.probePageId || !p.notion.verificationPageId)
    throw new AppError(409, '계정 연결 설정이 아직 준비되지 않았습니다.');
}
export async function beginLink(env: Env, p: Project, who: Identity) {
  enabled(p);
  const recent = await one(
    env.DB,
    'SELECT id FROM challenges WHERE project_id=? AND user_id=? AND created_at>?',
    p.id,
    who.userId,
    Date.now() - 60_000,
  );
  if (recent) throw new AppError(429, '1분 후 새 인증 코드를 발급할 수 있습니다.');
  const id = random(),
    code = 'YEONSURI-' + random(),
    at = Date.now();
  await env.DB.batch([
    env.DB.prepare('UPDATE challenges SET consumed=1 WHERE project_id=? AND user_id=?').bind(
      p.id,
      who.userId,
    ),
    env.DB.prepare(
      'INSERT INTO challenges(id,project_id,user_id,session_hash,code_hash,created_at,expires) VALUES(?,?,?,?,?,?,?)',
    ).bind(id, p.id, who.userId, who.sessionHash, await hash(code), at, at + 600_000),
  ]);
  return {
    id,
    code,
    expires: at + 600_000,
    pageUrl: `https://www.notion.so/${p.notion.verificationPageId.replaceAll('-', '')}`,
  };
}
export async function matchComment(
  comments: any[],
  codeHash: string,
  created: number,
  expires: number,
) {
  const matches = [];
  for (const c of comments)
    if ((await hash(plain(c.rich_text).trim())) === codeHash) matches.push(c);
  if (matches.length !== 1)
    throw new AppError(409, '일치하는 댓글이 없거나 중복되었습니다. 새 코드로 다시 시도하세요.');
  const c = matches[0],
    at = Date.parse(c.created_time);
  if (!c.created_by?.id || at < created || at >= expires || c.last_edited_time !== c.created_time)
    throw new AppError(409, '새 댓글의 실제 작성자를 검증하지 못했습니다.');
  return c;
}
async function challenge(env: Env, p: Project, who: Identity, id: string) {
  enabled(p);
  const c = await one(
    env.DB,
    'SELECT * FROM challenges WHERE id=? AND project_id=? AND user_id=? AND session_hash=? AND consumed=0 AND expires>?',
    id,
    p.id,
    who.userId,
    who.sessionHash,
    Date.now(),
  );
  if (!c) throw new AppError(409, '인증 요청이 만료·사용되었거나 원래 로그인 세션이 아닙니다.');
  return c;
}
export async function inspectLink(env: Env, p: Project, who: Identity, id: string) {
  const c = await challenge(env, p, who, id),
    n = new Notion(env);
  const comment = await matchComment(
    await n.comments(p.notion.verificationPageId),
    c.code_hash,
    c.created_at,
    c.expires,
  );
  const user = await n.api(`/users/${comment.created_by.id}`);
  if (user.type !== 'person') throw new AppError(409, '개인 계정의 댓글만 인증할 수 있습니다.');
  await run(
    env.DB,
    'UPDATE challenges SET candidate=?,comment_id=? WHERE id=? AND consumed=0',
    user.id,
    comment.id,
    id,
  );
  return {
    notionId: user.id,
    name: user.name || '(이름 제공 안 됨)',
    email: typeof user.person?.email === 'string' ? user.person.email : null,
    commentId: comment.id,
    warning: '본인이 작성한 댓글과 Notion 계정 ID인지 확인하세요. 다른 계정이면 취소하세요.',
  };
}
export async function confirmLink(
  env: Env,
  p: Project,
  who: Identity,
  id: string,
  notionId: string,
) {
  const c = await challenge(env, p, who, id);
  if (!c.candidate || c.candidate !== notionId)
    throw new AppError(409, '확인한 계정과 일치하지 않습니다.');
  const n = new Notion(env),
    comment = await matchComment(
      await n.comments(p.notion.verificationPageId),
      c.code_hash,
      c.created_at,
      c.expires,
    );
  if (comment.id !== c.comment_id || comment.created_by.id !== c.candidate)
    throw new AppError(409, '댓글이 변경되었습니다. 새 코드로 다시 인증하세요.');
  const lockId = `probe:${p.id}`,
    owner = random();
  const acquired = await run(
    env.DB,
    'INSERT INTO locks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE locks.expires<?',
    lockId,
    owner,
    Date.now() + 120_000,
    Date.now(),
  );
  if (!acquired.meta.changes)
    throw new AppError(409, '다른 인증을 검증 중입니다. 잠시 후 다시 확인하세요.');
  try {
    const page = await n.api(`/pages/${p.notion.probePageId}`),
      prop = p.notion.properties.assignees;
    if (
      page.parent?.data_source_id?.replaceAll('-', '') !==
        p.notion.dataSourceId.replaceAll('-', '') ||
      page.archived ||
      page.in_trash
    )
      throw new AppError(409, '검증 페이지가 대상 이슈 DB에 속하지 않습니다.');
    await n.api(`/pages/${p.notion.probePageId}`, 'PATCH', {
      properties: { [prop]: { people: [{ object: 'user', id: notionId }] } },
    });
    const check = await n.api(`/pages/${p.notion.probePageId}`);
    const people = check.properties[prop]?.people;
    if (people?.length !== 1 || people[0].id !== notionId)
      throw new AppError(409, 'People 담당자 지정과 재조회를 검증하지 못했습니다.');
    const result = await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO links(project_id,discord_id,notion_id,verified_at,valid_until) SELECT project_id,user_id,candidate,?,? FROM challenges WHERE id=? AND consumed=0 AND expires>? ON CONFLICT(project_id,discord_id) DO UPDATE SET notion_id=excluded.notion_id,verified_at=excluded.verified_at,valid_until=excluded.valid_until',
      ).bind(
        Date.now(),
        p.linkLifetimeDays === 0 ? 0 : Date.now() + p.linkLifetimeDays * 86400_000,
        id,
        Date.now(),
      ),
      env.DB.prepare('UPDATE challenges SET consumed=1 WHERE id=? AND consumed=0').bind(id),
    ]);
    if (!result[0].meta.changes) throw new AppError(409, '이미 사용되었거나 만료된 코드입니다.');
  } catch (e) {
    if (String(e).includes('UNIQUE constraint'))
      throw new AppError(
        409,
        '이미 다른 Discord 계정과 연결된 Notion 계정입니다. 기존 연결을 해제하세요.',
      );
    throw e;
  } finally {
    await run(env.DB, 'DELETE FROM locks WHERE id=? AND owner=?', lockId, owner);
  }
  return { ok: true };
}
export async function unlink(env: Env, p: Project, who: Identity) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM links WHERE project_id=? AND discord_id=?').bind(p.id, who.userId),
    env.DB.prepare('UPDATE challenges SET consumed=1 WHERE project_id=? AND user_id=?').bind(
      p.id,
      who.userId,
    ),
  ]);
}
