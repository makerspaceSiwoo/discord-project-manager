import { AppError, type Env, type Project, type Identity } from '../core/types';
import { currentWeek } from './scheduling';
import { one } from '../core/db';
import { random } from '../core/crypto';

export async function startManualTest(env: Env, p: Project, who: Identity, minutes = 5) {
  if (!who.admin) throw new AppError(403, '관리자 전용입니다.');
  if (!p.enabled) throw new AppError(409, '프로젝트가 비활성 상태입니다.');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 15)
    throw new AppError(400, '테스트 투표는 1~15분으로 설정하세요.');
  const id = random(),
    at = Date.now(),
    week = currentWeek(at, p.timezone);
  const payload = JSON.stringify({
    week,
    testId: id,
    durationMinutes: minutes,
    userId: who.userId,
  });
  const pollId = `test:${p.id}:${id}`;
  const lockId = `manual-test:${p.id}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO locks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE locks.expires<=?`,
    ).bind(lockId, id, at + 60_000, at),
    env.DB.prepare(
      `INSERT INTO jobs(id,kind,payload,next_at,created_at) SELECT ?,'test-poll-open',?,?,? FROM locks WHERE id=? AND owner=?`,
    ).bind(`${pollId}:open`, payload, at, at, lockId, id),
    env.DB.prepare(
      `INSERT INTO jobs(id,kind,payload,next_at,created_at) SELECT ?,'test-report',?,?,? FROM locks WHERE id=? AND owner=?`,
    ).bind(`${pollId}:report`, payload, at + 1, at, lockId, id),
  ]);
  const current = await one(env.DB, 'SELECT owner FROM locks WHERE id=?', lockId);
  const activePollId = `test:${p.id}:${current.owner}`;
  const active = await one(env.DB, 'SELECT payload FROM jobs WHERE id=?', `${activePollId}:open`);
  return {
    pollId: activePollId,
    openJob: `${activePollId}:open`,
    reportJob: `${activePollId}:report`,
    durationMinutes: JSON.parse(active.payload).durationMinutes,
  };
}
