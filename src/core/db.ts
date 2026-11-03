import { AppError, type Env, type Project } from './types';
export const one = <T = any>(db: D1Database, sql: string, ...args: any[]) =>
  db
    .prepare(sql)
    .bind(...args)
    .first<T>();
export async function all<T = any>(db: D1Database, sql: string, ...args: any[]): Promise<T[]> {
  return (
    await db
      .prepare(sql)
      .bind(...args)
      .all<T>()
  ).results;
}
export const run = (db: D1Database, sql: string, ...args: any[]) =>
  db
    .prepare(sql)
    .bind(...args)
    .run();
export async function project(env: Env): Promise<Project> {
  const row = await one<{ config: string }>(
    env.DB,
    'SELECT config FROM projects WHERE id=?',
    env.PROJECT_ID,
  );
  if (!row) throw new AppError(503, '프로젝트 설정이 필요합니다. 설치 안내를 확인하세요.');
  return JSON.parse(row.config);
}
export async function enqueue(
  db: D1Database,
  id: string,
  kind: string,
  payload: unknown,
  at = Date.now(),
) {
  await run(
    db,
    'INSERT OR IGNORE INTO jobs(id,kind,payload,next_at,created_at) VALUES(?,?,?,?,?)',
    id,
    kind,
    JSON.stringify(payload),
    at,
    Date.now(),
  );
}
