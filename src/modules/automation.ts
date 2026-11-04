import { AppError, type Env, type Project } from '../core/types';
import { one, run } from '../core/db';
import { addDays, currentWeek, localDate, timing } from './scheduling';

export const automationCommands = ['주간보고', '일정투표', '투표결과'];
export function upcomingWeek(at: number, p: Project) {
  const week = currentWeek(at, p.timezone);
  return at >= timing(week, p).closes ? addDays(week, 7) : week;
}
export function reportWeek(at: number, p: Project) {
  const date = localDate(at, p.timezone);
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  return addDays(date, day === 0 ? -6 : 1 - day);
}

// Cron and commands share the same weekly key and delivery effects.
async function requestJob(
  env: Env,
  p: Project,
  week: string,
  kind: string,
  label: string,
  at: number,
) {
  const jobId = `${p.id}:${week}:${label}`;
  await run(
    env.DB,
    `INSERT INTO jobs(id,kind,payload,next_at,created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,next_at=excluded.next_at
    WHERE jobs.status='pending' AND jobs.error IS NULL`,
    jobId,
    `manual-${kind}`,
    JSON.stringify({ week }),
    at,
    at,
  );
  const job = await one(env.DB, 'SELECT status,error FROM jobs WHERE id=?', jobId);
  return { jobId, status: job.status as string, error: job.error as string | null };
}
export async function requestAutomation(env: Env, p: Project, command: string, at = Date.now()) {
  if (!p.enabled) throw new AppError(409, '프로젝트가 비활성 상태입니다.');
  if (command === '일정투표') {
    const week = upcomingWeek(at, p);
    const job = await requestJob(env, p, week, 'poll-open', 'open', at);
    return {
      ...job,
      content: `${week} ~ ${addDays(week, 6)} 일정 투표\n${env.APP_ORIGIN}/?poll=${encodeURIComponent(`${p.id}:${week}`)}`,
    };
  }
  if (command === '주간보고') {
    const week = reportWeek(at, p);
    const job = await requestJob(env, p, week, 'report', 'report', at);
    return {
      ...job,
      content: `${week} 주간 보고 · <#${p.reportChannelId}>\n${env.APP_ORIGIN}/?report=${encodeURIComponent(job.jobId)}`,
    };
  }
  if (command === '투표결과') {
    const poll = await one(
      env.DB,
      `SELECT id,week,closes,thread_id FROM polls
      WHERE project_id=? AND display_week IS NULL AND thread_id IS NOT NULL ORDER BY week DESC LIMIT 1`,
      p.id,
    );
    if (!poll) return { content: '정식 일정 투표가 없습니다. /일정 투표로 먼저 열어 주세요.' };
    const url = `${env.APP_ORIGIN}/?poll=${encodeURIComponent(poll.id)}&tab=team`;
    if (at < poll.closes)
      return {
        content: `아직 투표 중입니다. 현재 집계를 확인하세요. 투표는 예정된 마감 시각까지 계속됩니다.\n${url}`,
      };
    const job = await requestJob(env, p, poll.week, 'poll-close', 'close', at);
    return { ...job, content: `마감된 투표 결과 · <#${poll.thread_id}>\n${url}` };
  }
  throw new AppError(400, '지원하지 않는 자동화 명령입니다.');
}
