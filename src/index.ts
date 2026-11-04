import { scheduleIssueSync } from './modules/issue-sync';
import {
  emailCapabilities,
  requestEmailLink,
  ownEmailRequest,
  listEmailRequests,
  approveEmailRequest,
  cancelEmailRequest,
} from './modules/email-linking';
import { Notion } from './adapters/notion';
import { linkingEnabled } from './core/access';
import { Discord } from './adapters/discord';
import { authorize, callback, logout, startLogin } from './core/auth';
import { all, one, project, run } from './core/db';
import { hash, notionSignature } from './core/crypto';
import { processOne, schedule } from './core/jobs';
import { AppError, RemoteError, type Env, json } from './core/types';
import { beginLink, confirmLink, inspectLink, unlink } from './modules/linking';
import { pollView, saveVote } from './modules/scheduling';
import { interactions } from './interactions';
async function handle(req: Request, env: Env, ctx: ExecutionContext, responseHeaders: Headers) {
  const url = new URL(req.url),
    path = url.pathname;
  if (path === '/api/health') return json({ ok: true, service: '플젝하는 연수리' });
  if (path === '/interactions' && req.method === 'POST')
    return interactions(req, env, await project(env), ctx);
  if (path.startsWith('/webhooks/notion') && req.method === 'POST') {
    const raw = await req.text();
    if (raw.length > 128_000) throw new AppError(413, '본문이 너무 큽니다.');
    if (
      !env.NOTION_WEBHOOK_SECRET &&
      env.WEBHOOK_SETUP_KEY &&
      path === '/webhooks/notion' &&
      url.searchParams.get('setup') === env.WEBHOOK_SETUP_KEY
    ) {
      const body = JSON.parse(raw);
      if (typeof body.verification_token !== 'string' || body.verification_token.length > 512)
        throw new AppError(400, '검증 토큰 형식 오류');
      await run(
        env.DB,
        'INSERT OR IGNORE INTO setup_secrets VALUES(?,?,?)',
        'notion_verification',
        body.verification_token,
        Date.now(),
      );
      return json({ ok: true });
    }
    if (
      path !== '/webhooks/notion' ||
      !(await notionSignature(
        raw,
        req.headers.get('x-notion-signature'),
        env.NOTION_WEBHOOK_SECRET,
      ))
    )
      throw new AppError(401, 'Invalid signature');
    const body = JSON.parse(raw),
      p = await project(env);
    if (body.workspace_id !== p.notion.workspaceId) return json({ ignored: true });
    if (typeof body.id !== 'string' || body.entity?.type !== 'page' || !body.entity?.id)
      return json({ ignored: true });
    const pageId = body.entity.id;
    if (
      !(await one(
        env.DB,
        'SELECT 1 FROM issue_links WHERE page_id=? AND project_id=?',
        pageId,
        p.id,
      ))
    )
      return json({ ignored: true });
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO webhook_events VALUES(?,?,?)').bind(
        body.id,
        pageId,
        Date.now(),
      ),
      env.DB.prepare(
        'INSERT OR IGNORE INTO jobs(id,kind,payload,next_at,created_at) VALUES(?,?,?,?,?)',
      ).bind(
        `webhook:${body.id}`,
        'issue-sync',
        JSON.stringify({ pageId }),
        Date.now(),
        Date.now(),
      ),
    ]);
    return json({ ok: true });
  }
  if (path === '/auth/login' && req.method === 'GET') {
    if (req.headers.get('cookie')) {
      try {
        const who = await authorize(req, env, await project(env));
        if (who.sessionCookie) responseHeaders.set('Set-Cookie', who.sessionCookie);
        return new Response(null, {
          status: 302,
          headers: { Location: '/', 'Cache-Control': 'no-store' },
        });
      } catch (error) {
        if (!(error instanceof AppError && error.status === 401)) throw error;
      }
    }
    return startLogin(env);
  }
  if (path === '/auth/callback' && req.method === 'GET')
    return callback(req, env, await project(env));
  if (path.startsWith('/api/') || path === '/auth/logout') {
    const p = await project(env),
      who = await authorize(req, env, p);
    if (who.sessionCookie && path !== '/auth/logout')
      responseHeaders.set('Set-Cookie', who.sessionCookie);
    const input = async () => {
      const body = await req.text();
      if (body.length > 16_000) throw new AppError(413, '요청이 너무 큽니다.');
      try {
        return JSON.parse(body);
      } catch {
        throw new AppError(400, 'JSON 형식 오류');
      }
    };
    if (path === '/auth/logout' && req.method === 'POST') return logout(env, who);
    if (path === '/api/me' && req.method === 'GET')
      return json({
        userId: who.userId,
        name: who.name,
        csrf: who.csrf,
        admin: who.admin,
        project: { name: p.name, timezone: p.timezone, enabled: p.enabled },
        link: await one(
          env.DB,
          'SELECT notion_id,valid_until FROM links WHERE project_id=? AND discord_id=?',
          p.id,
          who.userId,
        ),
        linkingEnabled: linkingEnabled(p),
        guestVerificationEnabled: p.notion.guestVerificationEnabled,
      });
    if (path === '/api/polls' && req.method === 'GET')
      return json(
        await all(
          env.DB,
          'SELECT id,week,opens,closes FROM polls WHERE project_id=? ORDER BY week DESC LIMIT 104',
          p.id,
        ),
      );
    const poll = path.match(/^\/api\/polls\/([^/]+)$/);
    if (poll && req.method === 'GET')
      return json(await pollView(env.DB, p, decodeURIComponent(poll[1]), who.userId));
    if (poll && req.method === 'PUT') {
      const body = await input();
      if ('userId' in body || 'user_id' in body)
        throw new AppError(400, '다른 사용자를 지정할 수 없습니다.');
      return json(await saveVote(env.DB, p, decodeURIComponent(poll[1]), who.userId, body.slots));
    }
    if (path === '/api/link/email' && req.method === 'GET')
      return json(await ownEmailRequest(env, p, who));
    if (path === '/api/link/email' && req.method === 'POST')
      return json(await requestEmailLink(env, p, who, (await input()).email));
    if (path === '/api/link/email/cancel' && req.method === 'POST')
      return json(await cancelEmailRequest(env, p, who, (await input()).id));
    if (path === '/api/link/start' && req.method === 'POST')
      return json(await beginLink(env, p, who));
    if (path === '/api/link/inspect' && req.method === 'POST')
      return json(await inspectLink(env, p, who, (await input()).id));
    if (path === '/api/link/confirm' && req.method === 'POST') {
      const b = await input();
      return json(await confirmLink(env, p, who, b.id, b.notionId));
    }
    if (path === '/api/link' && req.method === 'DELETE') {
      await unlink(env, p, who);
      return json({ ok: true });
    }
    if (path === '/api/reports' && req.method === 'GET')
      return json(
        await all(
          env.DB,
          'SELECT id,week,complete FROM report_runs WHERE project_id=? ORDER BY week DESC LIMIT 104',
          p.id,
        ),
      );
    const report = path.match(/^\/api\/reports\/([^/]+)$/);
    if (report && req.method === 'GET') {
      const id = decodeURIComponent(report[1]),
        row = await one(env.DB, 'SELECT * FROM report_runs WHERE id=? AND project_id=?', id, p.id);
      if (!row) throw new AppError(404, '보고서가 없습니다.');
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0));
      const items = await all(
        env.DB,
        `SELECT r.payload,l.thread_id FROM report_items r LEFT JOIN issue_links l ON l.page_id=r.page_id WHERE report_id=? ORDER BY due_sort,priority_rank,created,r.page_id LIMIT 100 OFFSET ?`,
        id,
        offset,
      );
      return json({
        ...row,
        items: items.map((i) => ({
          ...JSON.parse(i.payload),
          discordUrl: i.thread_id
            ? `https://discord.com/channels/${p.guildId}/${i.thread_id}`
            : null,
        })),
        nextOffset: items.length === 100 ? offset + 100 : null,
      });
    }
    const job = path.match(/^\/api\/jobs\/([^/]+)$/);
    if (job && req.method === 'GET') {
      const row = await one(env.DB, 'SELECT * FROM jobs WHERE id=?', decodeURIComponent(job[1]));
      if (!row || (!who.admin && JSON.parse(row.payload).userId !== who.userId))
        throw new AppError(404, '요청을 찾을 수 없습니다.');
      return json({
        id: row.id,
        status: row.status,
        error: row.error,
        updated: JSON.parse(row.state),
        nextAt: row.next_at,
      });
    }
    if (path.startsWith('/api/admin/')) {
      if (!who.admin) throw new AppError(403, '관리자 권한이 필요합니다.');
      if (path === '/api/admin/link-capabilities' && req.method === 'GET')
        return json(await emailCapabilities(env, who));
      if (path === '/api/admin/link-requests' && req.method === 'GET')
        return json(await listEmailRequests(env, p, who));
      if (path === '/api/admin/link-requests/approve' && req.method === 'POST')
        return json(await approveEmailRequest(env, p, who, (await input()).id));
      if (path === '/api/admin/status' && req.method === 'GET')
        return json({
          config: p,
          jobs: await all(
            env.DB,
            "SELECT id,kind,status,error,next_at FROM jobs WHERE status NOT IN ('done') ORDER BY created_at DESC LIMIT 100",
          ),
          effects: await all(
            env.DB,
            "SELECT id,state,updated_at FROM effects WHERE state<>'done' LIMIT 100",
          ),
        });
      if (path === '/api/admin/diagnose' && req.method === 'GET') {
        const n = new Notion(env),
          d = new Discord(env);
        const schema = await n.schema(p),
          roster = await d.rosterPage(p, url.searchParams.get('after') || '0');
        const channels = [];
        for (const id of [p.schedulingChannelId, p.reportChannelId, p.issueChannelId])
          channels.push(await d.api(`/channels/${id}`));
        return json({
          schema,
          roster,
          channels: channels.map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type,
            guildId: c.guild_id,
          })),
          note: '실제 전송 권한과 게스트 댓글·People 지정은 별도 검증해야 합니다.',
        });
      }
      if (path === '/api/admin/run' && req.method === 'POST') {
        await scheduleIssueSync(env, p);
        await schedule(env, p);
        await processOne(env, p);
        return json({ ok: true });
      }
      if (path === '/api/admin/retry' && req.method === 'POST') {
        const b = await input();
        await run(
          env.DB,
          "UPDATE jobs SET status='pending',next_at=?,attempts=0 WHERE id=? AND status IN ('failed','review')",
          Date.now(),
          b.id,
        );
        return json({ ok: true });
      }
      if (path === '/api/admin/revoke' && req.method === 'POST') {
        const b = await input();
        await env.DB.batch([
          env.DB.prepare('DELETE FROM links WHERE project_id=? AND discord_id=?').bind(
            p.id,
            b.userId,
          ),
          env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(b.userId),
          env.DB.prepare('DELETE FROM link_requests WHERE project_id=? AND discord_id=?').bind(
            p.id,
            b.userId,
          ),
          env.DB.prepare('UPDATE challenges SET consumed=1 WHERE project_id=? AND user_id=?').bind(
            p.id,
            b.userId,
          ),
        ]);
        return json({ ok: true });
      }
    }
    throw new AppError(404, '경로를 찾을 수 없습니다.');
  }
  return env.ASSETS.fetch(req);
}
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const responseHeaders = new Headers();
    try {
      return secure(await handle(req, env, ctx, responseHeaders), responseHeaders);
    } catch (e) {
      return secure(
        json(
          {
            error:
              e instanceof AppError
                ? e.message
                : e instanceof RemoteError
                  ? '외부 서비스가 응답하지 않습니다. 잠시 후 다시 시도하세요.'
                  : '일시적인 오류입니다. 관리자에게 알려 주세요.',
          },
          e instanceof AppError ? e.status : e instanceof RemoteError ? 503 : 500,
        ),
      );
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const p = await project(env);
        await scheduleIssueSync(env, p);
        await schedule(env, p);
        await processOne(env, p);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
function secure(res: Response, extraHeaders?: Headers) {
  const r = new Response(res.body, res);
  extraHeaders?.forEach((value, key) => r.headers.append(key, value));
  r.headers.set('X-Content-Type-Options', 'nosniff');
  r.headers.set('Referrer-Policy', 'no-referrer');
  r.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  return r;
}
