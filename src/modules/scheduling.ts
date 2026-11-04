import { AppError, type Member, type Project } from '../core/types';
import { all, one, run } from '../core/db';
export const SLOT_COUNT = 196;
export function localDate(at: number, zone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
export function addDays(date: string, days: number) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400_000).toISOString().slice(0, 10);
}
export function localInstant(date: string, time: string, zone: string) {
  const wall = Date.parse(`${date}T${time}:00Z`);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(guess);
    const x = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const shown = Date.parse(`${x.year}-${x.month}-${x.day}T${x.hour}:${x.minute}:${x.second}Z`);
    guess += wall - shown;
  }
  return guess;
}
// On Sunday selects tomorrow; during Mon–Sat selects the current week.
export function currentWeek(at: number, zone = 'Asia/Seoul') {
  const d = localDate(at, zone),
    day = new Date(d + 'T00:00:00Z').getUTCDay();
  return addDays(d, day === 0 ? 1 : 1 - day);
}
export function timing(week: string, p: Project) {
  const sun = addDays(week, -1);
  return {
    opens: localInstant(sun, p.schedule.open, p.timezone),
    reminder: localInstant(sun, p.schedule.reminder, p.timezone),
    closes: localInstant(week, '00:00', p.timezone),
    report: localInstant(week, p.schedule.report, p.timezone),
  };
}
export function slots(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length > SLOT_COUNT ||
    value.some((s) => !Number.isInteger(s) || s < 0 || s >= SLOT_COUNT)
  )
    throw new AppError(400, '시간 칸은 0~195 정수 배열이어야 합니다.');
  return [...new Set(value)].sort((a, b) => a - b);
}
export function aggregate(
  members: Member[],
  votes: { user_id: string; slots: string }[],
  slot: number,
) {
  const byId = new Map(votes.map((v) => [v.user_id, new Set(JSON.parse(v.slots))]));
  return {
    available: members.filter((m) => byId.get(m.id)?.has(slot)),
    unavailable: members.filter((m) => byId.has(m.id) && !byId.get(m.id)!.has(slot)),
    unanswered: members.filter((m) => !byId.has(m.id)),
  };
}
export async function pollView(db: D1Database, p: Project, id: string, userId: string) {
  const poll = await one(db, 'SELECT * FROM polls WHERE id=? AND project_id=?', id, p.id);
  if (!poll) throw new AppError(404, '투표가 없습니다.');
  const votes = await all(db, 'SELECT user_id,slots FROM votes WHERE poll_id=?', id);
  const members: Member[] = JSON.parse(poll.members);
  return {
    ...poll,
    members,
    votes: votes.map((v) => ({ userId: v.user_id, slots: JSON.parse(v.slots) })),
    editable:
      Date.now() >= poll.opens && Date.now() < poll.closes && members.some((m) => m.id === userId),
    serverNow: Date.now(),
  };
}
export async function saveVote(
  db: D1Database,
  p: Project,
  id: string,
  userId: string,
  values: unknown,
  at = Date.now(),
) {
  const selected = slots(values);
  const result = await run(
    db,
    `INSERT INTO votes(poll_id,user_id,slots,updated_at)
    SELECT id,?,?,? FROM polls WHERE id=? AND project_id=? AND opens<=? AND closes>?
    AND EXISTS(SELECT 1 FROM json_each(polls.members) WHERE json_extract(value,'$.id')=?)
    ON CONFLICT(poll_id,user_id) DO UPDATE SET slots=excluded.slots,updated_at=excluded.updated_at`,
    userId,
    JSON.stringify(selected),
    at,
    id,
    p.id,
    at,
    at,
    userId,
  );
  if (!result.meta.changes)
    throw new AppError(403, '마감되었거나 이번 주차의 투표 대상자가 아닙니다.');
  return { ok: true, slots: selected, updatedAt: at };
}
