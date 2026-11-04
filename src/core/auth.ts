import { Discord } from '../adapters/discord';
import { projectAdmin } from './access';
import { Http } from '../adapters/http';
import { hash, random } from './crypto';
import { all, one, run } from './db';
import { AppError, RemoteError, type Env, type Identity, type Project } from './types';
const SESSION_SECONDS = 90 * 24 * 3600;
const SESSION_REFRESH_MARGIN = (90 - 1) * 86400_000;
export const cookies = (r: Request) =>
  Object.fromEntries((r.headers.get('cookie') || '').split(';').map((x) => x.trim().split('=')));
async function loginStep<T>(
  stage: 'token' | 'profile' | 'membership',
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof RemoteError)) throw error;
    const label = {
      token: '로그인 토큰 발급',
      profile: 'Discord 사용자 조회',
      membership: '서버 멤버 확인',
    }[stage];
    const hint =
      stage === 'token' && [400, 401].includes(error.status)
        ? '앱의 OAuth 인증 정보 또는 로그인 코드 확인이 필요합니다. 로그인 시작 화면에서 다시 시도해 주세요.'
        : stage === 'membership' && [401, 403].includes(error.status)
          ? '관리자가 봇 토큰과 서버 접근 권한을 확인해야 합니다.'
          : '잠시 후 로그인 시작 화면에서 다시 시도해 주세요.';
    throw new AppError(
      503,
      `${label} 실패 (discord_${stage}_${error.status || 'network'}). ${hint}`,
      `discord_${stage}_${error.status || 'network'}`,
    );
  }
}
const cookie = (env: Env, name: string, value: string, maxAge: number) =>
  `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${env.APP_ORIGIN.startsWith('https:') ? '; Secure' : ''}`;
export async function startLogin(env: Env) {
  const state = random(),
    browser = random();
  await run(
    env.DB,
    'INSERT INTO oauth_states VALUES(?,?,?)',
    await hash(state),
    await hash(browser),
    Date.now() + 600_000,
  );
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({
    client_id: env.DISCORD_APPLICATION_ID,
    redirect_uri: env.APP_ORIGIN + '/auth/callback',
    response_type: 'code',
    scope: 'identify',
    state,
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      'Set-Cookie': cookie(env, 'oauth_browser', browser, 600),
      'Cache-Control': 'no-store',
    },
  });
}
export async function callback(req: Request, env: Env, p: Project) {
  const u = new URL(req.url),
    state = u.searchParams.get('state'),
    code = u.searchParams.get('code'),
    browser = cookies(req).oauth_browser;
  if (!state || !code || !browser) throw new AppError(400, '로그인 요청이 유효하지 않습니다.');
  const row = await one(
    env.DB,
    'DELETE FROM oauth_states WHERE hash=? AND browser_hash=? AND expires>? RETURNING hash',
    await hash(state),
    await hash(browser),
    Date.now(),
  );
  if (!row) throw new AppError(400, '로그인 요청이 만료되었거나 이미 사용되었습니다.');
  const http = new Http();
  const token = await loginStep('token', () =>
    http.request<any>('discord', 'https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.DISCORD_APPLICATION_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: env.APP_ORIGIN + '/auth/callback',
      }).toString(),
    }),
  );
  if (typeof token.access_token !== 'string' || !token.access_token)
    throw new AppError(
      503,
      'Discord 토큰 응답 형식 오류 (discord_token_invalid). 로그인부터 다시 시도해 주세요.',
    );
  const user = await loginStep('profile', () =>
    http.request<any>('discord', 'https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    }),
  );
  if (typeof user.id !== 'string' || !/^\d+$/.test(user.id))
    throw new AppError(
      503,
      'Discord 사용자 응답 형식 오류 (discord_profile_invalid). 로그인부터 다시 시도해 주세요.',
    );
  await loginStep('membership', () => new Discord(env, http).member(p, user.id));
  const session = random();
  await run(
    env.DB,
    'INSERT INTO sessions VALUES(?,?,?,?,?)',
    await hash(session),
    user.id,
    user.global_name || user.username,
    random(),
    Date.now() + SESSION_SECONDS * 1000,
  );
  const headers = new Headers({ Location: '/', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookie(env, 'session', session, SESSION_SECONDS));
  headers.append('Set-Cookie', cookie(env, 'oauth_browser', '', 0));
  return new Response(null, { status: 302, headers });
}
export async function authorize(req: Request, env: Env, p: Project): Promise<Identity> {
  const raw = cookies(req).session;
  if (!raw) throw new AppError(401, 'Discord 로그인이 필요합니다.');
  const sessionHash = await hash(raw),
    s = await one(
      env.DB,
      'SELECT * FROM sessions WHERE hash=? AND expires>?',
      sessionHash,
      Date.now(),
    );
  if (!s) throw new AppError(401, '세션이 만료되었습니다. 다시 로그인하세요.');
  let m;
  try {
    m = await new Discord(env).member(p, s.user_id);
  } catch (e) {
    if (e instanceof AppError && e.status === 403) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM links WHERE project_id=? AND discord_id=?').bind(
          p.id,
          s.user_id,
        ),
        env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(s.user_id),
      ]);
    }
    throw e;
  }
  if (
    !['GET', 'HEAD'].includes(req.method) &&
    (req.headers.get('origin') !== env.APP_ORIGIN || req.headers.get('x-csrf-token') !== s.csrf)
  )
    throw new AppError(403, '요청 출처 또는 CSRF 검증 실패');
  let sessionCookie: string | undefined;
  if (s.expires - Date.now() < SESSION_REFRESH_MARGIN) {
    const extended = await run(
      env.DB,
      'UPDATE sessions SET expires=? WHERE hash=? AND expires>?',
      Date.now() + SESSION_SECONDS * 1000,
      sessionHash,
      Date.now(),
    );
    if (!extended.meta.changes)
      throw new AppError(401, '로그인이 해제되었습니다. 다시 로그인하세요.');
    sessionCookie = cookie(env, 'session', raw, SESSION_SECONDS);
  }
  return {
    sessionCookie,
    userId: s.user_id,
    name: s.name,
    sessionHash,
    csrf: s.csrf,
    admin: projectAdmin(p, s.user_id, m.roles, m.permissions || '0'),
  };
}
export async function logout(env: Env, identity: Identity) {
  await run(env.DB, 'DELETE FROM sessions WHERE hash=?', identity.sessionHash);
  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': cookie(env, 'session', '', 0) },
  });
}
export async function linkedMembers(env: Env, p: Project) {
  return all(
    env.DB,
    'SELECT l.discord_id,l.notion_id,COALESCE(MAX(s.name),l.discord_id) AS name FROM links l LEFT JOIN sessions s ON s.user_id=l.discord_id WHERE l.project_id=? AND (l.valid_until=0 OR l.valid_until>?) GROUP BY l.discord_id,l.notion_id',
    p.id,
    Date.now(),
  );
}
