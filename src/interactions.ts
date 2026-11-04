import { automationCommands, requestAutomation } from './modules/automation';
import { Discord } from './adapters/discord';
import { projectMember, projectAdmin, issuesEnabled } from './core/access';
import { linkedMembers } from './core/auth';
import { discordSignature } from './core/crypto';
import { one, run } from './core/db';
import { processOne } from './core/jobs';
import { AppError, type Env, type Project, json } from './core/types';
import { confirmation, fields, modal, validateDraft } from './modules/issues';
const ephemeral = (content: string) =>
  json({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
export async function interactions(req: Request, env: Env, p: Project, ctx: ExecutionContext) {
  const raw = await req.text();
  if (
    raw.length > 32_000 ||
    !(await discordSignature(
      raw,
      req.headers.get('x-signature-ed25519'),
      req.headers.get('x-signature-timestamp'),
      env.DISCORD_PUBLIC_KEY,
    ))
  )
    return new Response('Invalid signature', { status: 401 });
  const i = JSON.parse(raw);
  if (i.type === 1) return json({ type: 1 });
  if (i.guild_id !== p.guildId || !projectMember(p, i.member || {}))
    return ephemeral('이 서버의 프로젝트 멤버만 이용할 수 있습니다.');
  const userId = i.member.user.id,
    command = i.data?.name,
    custom = i.data?.custom_id || '';
  if (command === '계정연결')
    return ephemeral(
      `본인 Discord 계정으로 로그인한 뒤 연결하세요.\n${env.APP_ORIGIN}/?view=account`,
    );
  if (command === '일정') return ephemeral(`이번 주차와 이전 결과: ${env.APP_ORIGIN}/`);
  if (command === '연동상태') {
    if (!projectAdmin(p, userId, i.member.roles || [], i.member.permissions || '0'))
      return ephemeral('관리자 전용 명령입니다.');
    return ephemeral(`설정 및 연동 진단: ${env.APP_ORIGIN}/?view=admin`);
  }
  if (i.type === 2 && automationCommands.includes(command)) {
    ctx.waitUntil(processAutomationCommand(env, p, command, i.token));
    return json({ type: 5, data: { flags: 64 } });
  }
  if (!issuesEnabled(p)) return ephemeral('이슈 생성이 비활성 상태입니다.');
  try {
    if (
      command === '이슈생성' ||
      (command === '이슈' &&
        i.data?.options?.some((option: any) => option.type === 1 && option.name === '생성'))
    ) {
      // The modal needs only a bounded local D1 query before the initial response.
      const members = await linkedMembers(env, p);
      if (!members.length)
        return ephemeral('먼저 /계정연결로 담당자의 Notion 계정을 연결해 주세요.');
      if (members.length > 25) return ephemeral('현재 폼은 최대 25명의 담당자를 지원합니다.');
      return json(modal(p, members));
    }
    if (custom === 'issue:open') {
      const members = await linkedMembers(env, p);
      if (!members.length) return ephemeral('연결된 담당자가 없습니다. /계정연결을 이용하세요.');
      if (members.length > 25) return ephemeral('현재 폼은 최대 25명의 담당자를 지원합니다.');
      return json(modal(p, members));
    }
    if (custom === 'issue:required' && i.type === 5) {
      const draft = validateDraft(fields(i.data.components), p),
        id = i.id;
      if (
        !(await one(
          env.DB,
          'SELECT 1 FROM links WHERE project_id=? AND discord_id=? AND (valid_until=0 OR valid_until>?)',
          p.id,
          draft.assignee,
          Date.now(),
        ))
      )
        return ephemeral('담당자의 계정 연결이 만료되었습니다.');
      await run(
        env.DB,
        'INSERT OR IGNORE INTO drafts VALUES(?,?,?,?,0)',
        id,
        userId,
        JSON.stringify(draft),
        Date.now() + 900_000,
      );
      return json({ type: 4, data: { ...confirmation(id, draft), flags: 64 } });
    }
    if (custom.startsWith('issue:detail:')) {
      const id = custom.split(':')[2];
      await ownedDraft(env, id, userId);
      return json({
        type: 9,
        data: {
          custom_id: `issue:description:${id}`,
          title: '상세 설명 (선택)',
          components: [
            {
              type: 18,
              label: '상세 설명',
              component: {
                type: 4,
                custom_id: 'description',
                style: 2,
                required: false,
                max_length: 1800,
              },
            },
          ],
        },
      });
    }
    if (custom.startsWith('issue:description:') && i.type === 5) {
      const id = custom.split(':')[2],
        row = await ownedDraft(env, id, userId),
        draft = validateDraft(
          { ...JSON.parse(row.payload), description: fields(i.data.components).description },
          p,
        );
      await run(
        env.DB,
        'UPDATE drafts SET payload=? WHERE id=? AND submitted=0',
        JSON.stringify(draft),
        id,
      );
      return json({ type: 4, data: { ...confirmation(id, draft), flags: 64 } });
    }
    if (custom.startsWith('issue:confirm:')) {
      const id = custom.split(':')[2],
        row = await one(env.DB, 'SELECT * FROM drafts WHERE id=? AND user_id=?', id, userId);
      if (!row) throw new AppError(403, '본인의 입력만 생성할 수 있습니다.');
      const jobId = `issue:${p.id}:${id}`;
      if (row.submitted)
        return ephemeral(
          `이미 접수된 요청입니다. 상태 확인: ${env.APP_ORIGIN}/?job=${encodeURIComponent(jobId)}`,
        );
      if (row.expires <= Date.now()) throw new AppError(409, '입력이 만료되었습니다.');
      await env.DB.batch([
        env.DB.prepare(
          'INSERT OR IGNORE INTO jobs(id,kind,payload,next_at,created_at) SELECT ?,?,?,?,? FROM drafts WHERE id=? AND submitted=0 AND expires>?',
        ).bind(
          jobId,
          'issue-create',
          JSON.stringify({ draft: JSON.parse(row.payload), userId }),
          Date.now(),
          Date.now(),
          id,
          Date.now(),
        ),
        env.DB.prepare('UPDATE drafts SET submitted=1 WHERE id=?').bind(id),
      ]);
      ctx.waitUntil(processConfirmedIssue(env, p, jobId, i.token));
      return json({ type: 5, data: { flags: 64 } });
    }
    return ephemeral('지원하지 않는 명령 또는 만료된 입력입니다.');
  } catch (e) {
    return ephemeral(
      e instanceof AppError ? e.message : '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.',
    );
  }
}
async function ownedDraft(env: Env, id: string, user: string) {
  const row = await one(
    env.DB,
    'SELECT * FROM drafts WHERE id=? AND user_id=? AND expires>? AND submitted=0',
    id,
    user,
    Date.now(),
  );
  if (!row) throw new AppError(403, '입력이 만료되었거나 본인의 입력이 아닙니다.');
  return row;
}

async function processConfirmedIssue(env: Env, p: Project, jobId: string, token: string) {
  const statusUrl = env.APP_ORIGIN + '/?job=' + encodeURIComponent(jobId);
  try {
    await processOne(env, p, jobId);
    const job = await one(env.DB, 'SELECT status,state,error FROM jobs WHERE id=?', jobId);
    const state = JSON.parse(job?.state || '{}');
    let content = '생성 요청을 접수했습니다. 처리 상태를 확인해 주세요.';
    if (job?.status === 'review' || job?.status === 'failed')
      content = job.error || '요청을 완료하지 못했습니다. 처리 상태를 확인해 주세요.';
    else if (state.pageId)
      content =
        'Notion 이슈가 생성되었습니다. Discord 스레드 연결을 이어서 처리합니다.\nhttps://www.notion.so/' +
        state.pageId.replaceAll('-', '');
    await new Discord(env).followup(token, {
      content: content + '\n' + statusUrl,
      components: [],
      allowed_mentions: { parse: [] },
    });
  } catch {
    // A notification failure must never enqueue another issue creation.
    try {
      await new Discord(env).followup(token, {
        content:
          '처리 결과를 표시하지 못했습니다. 다시 생성하지 말고 상태를 확인해 주세요.\n' + statusUrl,
        components: [],
        allowed_mentions: { parse: [] },
      });
    } catch {
      /* The persisted job is still available through the authenticated status page. */
    }
  }
}

async function processAutomationCommand(env: Env, p: Project, command: string, token: string) {
  let content: string;
  try {
    const result = await requestAutomation(env, p, command);
    if ('jobId' in result && result.jobId) {
      // Bounded immediate progress; Cron continues paginated work and retries.
      for (let step = 0; step < 3; step++) {
        const before = await one(
          env.DB,
          'SELECT status,state,next_at FROM jobs WHERE id=?',
          result.jobId,
        );
        if (before?.status !== 'pending' || before.next_at > Date.now()) break;
        await processOne(env, p, result.jobId);
        const after = await one(env.DB, 'SELECT status,state FROM jobs WHERE id=?', result.jobId);
        if (after?.status !== 'pending' || after.state === before.state) break;
      }
      const job = await one(env.DB, 'SELECT status,error FROM jobs WHERE id=?', result.jobId);
      const status =
        job?.status === 'done'
          ? '게시된 메시지를 확인해 주세요. 같은 주차는 중복 발송하지 않습니다.'
          : ['failed', 'review'].includes(job?.status)
            ? '처리가 중단되었습니다. 관리자에게 연동 상태 확인을 요청해 주세요.'
            : '요청을 접수했습니다. 예약 작업이 이어서 처리합니다.';
      content = status + '\n' + result.content;
    } else content = result.content;
  } catch (error) {
    content =
      error instanceof AppError
        ? error.message
        : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  }
  try {
    await new Discord(env).followup(token, { content, allowed_mentions: { parse: [] } });
  } catch {
    /* The durable job remains available; never recreate it for a reply failure. */
  }
}
