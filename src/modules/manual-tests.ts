import { AppError, type Env, type Project, type Identity } from '../core/types';
import { currentWeek } from './scheduling';
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
  await env.DB.batch([
    env.DB.prepare('INSERT INTO jobs(id,kind,payload,next_at,created_at) VALUES(?,?,?,?,?)').bind(
      `${pollId}:open`,
      'test-poll-open',
      payload,
      at,
      at,
    ),
    env.DB.prepare('INSERT INTO jobs(id,kind,payload,next_at,created_at) VALUES(?,?,?,?,?)').bind(
      `${pollId}:report`,
      'test-report',
      payload,
      at + 1,
      at,
    ),
  ]);
  return {
    pollId,
    openJob: `${pollId}:open`,
    reportJob: `${pollId}:report`,
    durationMinutes: minutes,
  };
}
