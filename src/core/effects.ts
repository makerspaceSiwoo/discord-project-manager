import { one, run } from './db';
import { AppError, RemoteError } from './types';
// A crash after a POST leaves 'sending'. Recovery only reconciles; it never blindly repeats POST.
export async function effect<T>(
  db: D1Database,
  id: string,
  create: () => Promise<T>,
  reconcile: () => Promise<T | null>,
): Promise<T> {
  const inserted = await run(
    db,
    'INSERT OR IGNORE INTO effects(id,state,updated_at) VALUES(?,?,?)',
    id,
    'sending',
    Date.now(),
  );
  if (!inserted.meta.changes) {
    const row = await one(db, 'SELECT * FROM effects WHERE id=?', id);
    if (row.state === 'done') return JSON.parse(row.result);
    const existing = await reconcile();
    if (existing) {
      await run(
        db,
        'UPDATE effects SET state=?,result=?,updated_at=? WHERE id=?',
        'done',
        JSON.stringify(existing),
        Date.now(),
        id,
      );
      return existing;
    }
    throw new AppError(
      409,
      `외부 생성 결과 미확인 (${id}). 관리자 확인 후 복구하세요.`,
      'uncertain',
    );
  }
  try {
    const result = await create();
    await run(
      db,
      'UPDATE effects SET state=?,result=?,updated_at=? WHERE id=?',
      'done',
      JSON.stringify(result),
      Date.now(),
      id,
    );
    return result;
  } catch (e) {
    if (e instanceof RemoteError && !e.ambiguous && e.status >= 400 && e.status < 500)
      await run(db, 'DELETE FROM effects WHERE id=?', id);
    throw e;
  }
}
