import { scheduleIssueSync } from '../src/modules/issue-sync';
import {
  requestEmailLink,
  approveEmailRequest,
  cancelEmailRequest,
  ownEmailRequest,
  listEmailRequests,
  findPersonByEmail,
  emailCapabilities,
} from '../src/modules/email-linking';
import { Http } from '../src/adapters/http';
import { Discord } from '../src/adapters/discord';
import { Notion } from '../src/adapters/notion';
import { createIssuePage } from '../src/core/issue-creation';
import { env } from 'cloudflare:workers';
import { reset, applyD1Migrations } from 'cloudflare:test';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import config from '../config/project.example.json';
import { aggregate, currentWeek, timing, slots, saveVote } from '../src/modules/scheduling';
import { compareIssues, reportable, reportMessage } from '../src/modules/reporting';
import { matchComment, beginLink, inspectLink, confirmLink, unlink } from '../src/modules/linking';
import {
  validateDraft,
  normalizeDueDate,
  issueSummary,
  issueThreadName,
  fields,
  modal,
} from '../src/modules/issues';
import { hash, discordSignature, notionSignature } from '../src/core/crypto';
import { all, one, run, enqueue } from '../src/core/db';
import { effect } from '../src/core/effects';
import { processOne, schedule } from '../src/core/jobs';
import { authorize, callback, startLogin, linkedMembers } from '../src/core/auth';
import { RemoteError, type Env, type Project, type Issue } from '../src/core/types';
import worker from '../src/index';
const e = env as unknown as Env & { TEST_MIGRATIONS: any };
let p: Project;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;
const id = '11111',
  nid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const who = {
  userId: id,
  name: '테스트',
  sessionHash: 'original-session',
  csrf: 'csrf',
  admin: false,
};
const member = { user: { id, bot: false }, roles: ['team'], permissions: '0' };
const draft = {
  title: '새 작업',
  due: '2026-11-10',
  assignee: id,
  type: '기능',
  priority: '높음',
  description: '상세 설명',
};
function page(overrides: any = {}) {
  const m = p.notion.properties;
  return {
    id: 'page-1',
    url: 'https://www.notion.so/page-1',
    created_time: '2026-11-01T00:00:00Z',
    last_edited_time: '2026-11-02T00:00:00Z',
    parent: { data_source_id: p.notion.dataSourceId },
    properties: {
      [m.title]: { title: [{ plain_text: '업무' }] },
      [m.taskId]: { unique_id: { prefix: 'TASK', number: 1 } },
      [m.due]: { date: { start: '2026-11-09' } },
      [m.assignees]: { people: [{ id: nid }] },
      [m.type]: { select: { name: '기능' } },
      [m.priority]: { select: { name: '높음' } },
      [m.status]: { status: { name: '미시작' } },
      [m.created]: { created_time: '2026-11-01T00:00:00Z' },
      [m.parent]: { relation: [] },
    },
    ...overrides,
  };
}
function fake(routes: (url: URL, init: any) => any) {
  const f = vi.fn(async (input: any, init: any = {}) => {
    const value = await routes(new URL(typeof input === 'string' ? input : input.url), init);
    if (value instanceof Response) return value;
    return Response.json(value);
  });
  vi.stubGlobal('fetch', f);
  return f;
}
async function signed(body: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(e.NOTION_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return (
    'sha256=' +
    Array.from(
      new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('')
  );
}
async function seedPoll(closes = Date.now() + 60_000) {
  await run(
    e.DB,
    'INSERT INTO polls(id,project_id,week,opens,closes,members) VALUES(?,?,?,?,?,?)',
    'poll',
    p.id,
    '2026-11-09',
    0,
    closes,
    JSON.stringify([
      { id, name: '나' },
      { id: '22222', name: '팀원' },
    ]),
  );
}
async function jobStep(jobId: string) {
  await run(e.DB, "UPDATE jobs SET next_at=0 WHERE id=? AND status='pending'", jobId);
  await processOne(e, p, jobId);
  return one(e.DB, 'SELECT * FROM jobs WHERE id=?', jobId);
}
beforeEach(async () => {
  await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  p = structuredClone(config) as Project;
  p.enabled = true;
  p.guildId = 'guild';
  p.memberRoleId = 'team';
  p.adminRoleIds = ['admin'];
  p.issueChannelId = 'forum';
  p.schedulingChannelId = 'schedule';
  p.reportChannelId = 'report';
  p.notion.workspaceId = 'workspace';
  p.notion.dataSourceId = 'source';
  p.notion.probePageId = 'probe';
  p.notion.verificationPageId = 'verify';
  p.notion.guestEvidence = 'test fixture';
  p.notion.guestVerificationEnabled = true;
  await run(e.DB, 'INSERT INTO projects VALUES(?,?)', p.id, JSON.stringify(p));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});
describe('주차와 투표', () => {
  it('KST 일요일은 다음날, 월요일은 그 주를 선택', () => {
    expect(currentWeek(Date.parse('2026-11-08T00:00:00+09:00'))).toBe('2026-11-09');
    expect(currentWeek(Date.parse('2026-11-09T00:00:00+09:00'))).toBe('2026-11-09');
    expect(currentWeek(Date.parse('2026-12-31T00:00:00+09:00'))).toBe('2026-12-28');
  });
  it('일요일 9시, 23시, 월요일 0시와 9시 경계', () => {
    const t = timing('2026-11-09', p);
    expect(new Date(t.opens).toISOString()).toBe('2026-11-08T00:00:00.000Z');
    expect(t.closes - t.reminder).toBe(3600_000);
    expect(t.report - t.closes).toBe(9 * 3600_000);
  });
  it('196개 슬롯과 마지막 일요일 22:30 구간, 범위 검증', () => {
    expect(slots([195, 0, 0])).toEqual([0, 195]);
    expect(() => slots([196])).toThrow();
    expect(() => slots([1.5])).toThrow();
    expect(() => slots(['0'])).toThrow();
    expect(slots([])).toEqual([]);
  });
  it('미응답과 가능한 시간 없음 분리', () => {
    const g = aggregate(
      [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
        { id: 'c', name: 'C' },
      ],
      [
        { user_id: 'a', slots: '[0]' },
        { user_id: 'b', slots: '[]' },
      ],
      0,
    );
    expect(g.available[0].id).toBe('a');
    expect(g.unavailable[0].id).toBe('b');
    expect(g.unanswered[0].id).toBe('c');
  });
  it('마감 1ms 전 저장 가능, 마감 시각에는 SQL에서 차단', async () => {
    await seedPoll(1000);
    await saveVote(e.DB, p, 'poll', id, [195], 999);
    await expect(saveVote(e.DB, p, 'poll', id, [], 1000)).rejects.toThrow('마감');
    expect((await one(e.DB, 'SELECT slots FROM votes')).slots).toBe('[195]');
  });
  it('대상 아닌 사용자 거부하고 빈 응답은 저장', async () => {
    await seedPoll();
    await expect(saveVote(e.DB, p, 'poll', 'outsider', [1])).rejects.toThrow();
    await saveVote(e.DB, p, 'poll', id, []);
    expect((await one(e.DB, 'SELECT slots FROM votes')).slots).toBe('[]');
  });
  it('다른 주차 응답과 격리', async () => {
    await seedPoll();
    await saveVote(e.DB, p, 'poll', id, [1]);
    await run(
      e.DB,
      'INSERT INTO polls(id,project_id,week,opens,closes,members) SELECT ?,project_id,?,opens,closes,members FROM polls',
      'poll2',
      '2026-11-16',
    );
    await saveVote(e.DB, p, 'poll2', id, [2]);
    expect(
      (await all(e.DB, 'SELECT slots FROM votes ORDER BY poll_id')).map((x) => x.slots),
    ).toEqual(['[1]', '[2]']);
  });
});
describe('인증과 권한', () => {
  it('Discord Ed25519 서명, 변조 및 오래된 요청 거부', async () => {
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const hex = (a: ArrayBuffer) =>
      Array.from(new Uint8Array(a), (x) => x.toString(16).padStart(2, '0')).join('');
    const key = hex(await crypto.subtle.exportKey('raw', pair.publicKey));
    const ts = String(Math.floor(Date.now() / 1000)),
      body = '{"type":1}';
    const signature = hex(
      await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(ts + body)),
    );
    expect(await discordSignature(body, signature, ts, key)).toBe(true);
    expect(await discordSignature(body + 'x', signature, ts, key)).toBe(false);
    expect(await discordSignature(body, signature, '1', key)).toBe(false);
  });
  it('Notion 원본 본문 HMAC 검증', async () => {
    const b = '{"id":"a"}';
    expect(await notionSignature(b, await signed(b), e.NOTION_WEBHOOK_SECRET)).toBe(true);
    expect(await notionSignature(b + ' ', await signed(b), e.NOTION_WEBHOOK_SECRET)).toBe(false);
  });
  it('세션 없는 API 거부', async () => {
    const r = await worker.fetch(new Request('http://localhost:8787/api/polls'), e, ctx);
    expect(r.status).toBe(401);
  });
  it('매 요청 역할 확인 및 CSRF 거부', async () => {
    await run(
      e.DB,
      'INSERT INTO sessions VALUES(?,?,?,?,?)',
      await hash('session'),
      id,
      '이름',
      'csrf',
      Date.now() + 60_000,
    );
    const f = fake(() => member);
    const req = new Request('http://localhost:8787/api/polls/poll', {
      method: 'PUT',
      headers: { cookie: 'session=session', origin: e.APP_ORIGIN, 'x-csrf-token': 'bad' },
      body: '{}',
    });
    await expect(authorize(req, e, p)).rejects.toThrow('CSRF');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('역할 상실 시 세션과 연결 삭제', async () => {
    await run(
      e.DB,
      'INSERT INTO sessions VALUES(?,?,?,?,?)',
      await hash('session'),
      id,
      '이름',
      'csrf',
      Date.now() + 60_000,
    );
    await run(e.DB, 'INSERT INTO links VALUES(?,?,?,?,?)', p.id, id, nid, 0, Date.now() + 60_000);
    fake(() => ({ ...member, roles: [] }));
    await expect(
      authorize(
        new Request('http://localhost/api/me', { headers: { cookie: 'session=session' } }),
        e,
        p,
      ),
    ).rejects.toThrow('멤버');
    expect(await one(e.DB, 'SELECT 1 FROM links')).toBeNull();
    expect(await one(e.DB, 'SELECT 1 FROM sessions')).toBeNull();
  });
  it('OAuth state가 원래 브라우저에 바인딩되고 한 번만 소비', async () => {
    const res = await startLogin(e),
      state = new URL(res.headers.get('location')!).searchParams.get('state')!,
      browser = res.headers.get('set-cookie')!.split(';')[0];
    fake((url) =>
      url.pathname.endsWith('/oauth2/token')
        ? { access_token: 'access' }
        : url.pathname.endsWith('/users/@me')
          ? { id, username: 'me' }
          : member,
    );
    await expect(
      callback(
        new Request('http://localhost/auth/callback?state=' + state + '&code=x', {
          headers: { cookie: 'oauth_browser=wrong' },
        }),
        e,
        p,
      ),
    ).rejects.toThrow('만료');
    const ok = await callback(
      new Request('http://localhost/auth/callback?state=' + state + '&code=x', {
        headers: { cookie: browser },
      }),
      e,
      p,
    );
    expect(ok.status).toBe(302);
    await expect(
      callback(
        new Request('http://localhost/auth/callback?state=' + state + '&code=x', {
          headers: { cookie: browser },
        }),
        e,
        p,
      ),
    ).rejects.toThrow('만료');
  });
  it.each([
    ['token', 401],
    ['profile', 403],
    ['membership', 403],
    ['token', 0],
  ])('로그인 %s 실패를 구분하고 세션을 생성하지 않는다 (%s)', async (stage, status) => {
    const start = await startLogin(e);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const browser = start.headers.get('set-cookie')!.split(';')[0];
    fake((url) => {
      const current = url.pathname.endsWith('/oauth2/token')
        ? 'token'
        : url.pathname.endsWith('/users/@me')
          ? 'profile'
          : 'membership';
      if (current === stage) {
        if (!status) throw new Error('sensitive network details');
        return Response.json({ error: 'sensitive response body' }, { status: Number(status) });
      }
      return current === 'token' ? { access_token: 'secret-access' } : { id, username: 'me' };
    });
    await expect(
      callback(
        new Request('http://localhost/auth/callback?state=' + state + '&code=secret-code', {
          headers: { cookie: browser },
        }),
        e,
        p,
      ),
    ).rejects.toMatchObject({ code: `discord_${stage}_${status || 'network'}` });
    expect(await one(e.DB, 'SELECT 1 FROM sessions')).toBeNull();
  });
  it('API에서 userId를 바꿔 다른 투표 수정 불가', async () => {
    await seedPoll();
    await run(
      e.DB,
      'INSERT INTO sessions VALUES(?,?,?,?,?)',
      await hash('s'),
      id,
      '이름',
      'csrf',
      Date.now() + 60_000,
    );
    fake(() => member);
    const r = await worker.fetch(
      new Request(e.APP_ORIGIN + '/api/polls/poll', {
        method: 'PUT',
        headers: { cookie: 'session=s', origin: e.APP_ORIGIN, 'x-csrf-token': 'csrf' },
        body: JSON.stringify({ slots: [1], userId: '22222' }),
      }),
      e,
      ctx,
    );
    expect(r.status).toBe(400);
    expect(await one(e.DB, 'SELECT 1 FROM votes')).toBeNull();
  });
});
describe('게스트 댓글 인증 (모의 API)', () => {
  const comment = (code: string) => ({
    id: 'comment',
    created_by: { id: nid },
    created_time: new Date(Date.now() + 1).toISOString(),
    last_edited_time: new Date(Date.now() + 1).toISOString(),
    rich_text: [{ plain_text: code }],
  });
  it('검증되지 않은 프로젝트는 기본 차단', async () => {
    p.notion.guestVerificationEnabled = false;
    await expect(beginLink(e, p, who)).rejects.toThrow('설정');
  });
  it('복사/중복 댓글과 수정 댓글은 실패', async () => {
    const c = comment('code');
    await expect(matchComment([c, c], await hash('code'), 0, Date.now() + 10000)).rejects.toThrow(
      '중복',
    );
    await expect(
      matchComment(
        [{ ...c, last_edited_time: '2100-01-01' }],
        await hash('code'),
        0,
        Date.now() + 10000,
      ),
    ).rejects.toThrow('작성자');
  });
  it('다른 Discord 세션이 코드를 알고 있어도 검증 불가', async () => {
    const c = await beginLink(e, p, who);
    await expect(inspectLink(e, p, { ...who, sessionHash: 'other' }, c.id)).rejects.toThrow('세션');
  });
  it('실제 created_by, 원래 세션 재확인, People 지정·조회 후 연결하고 재사용 거부', async () => {
    const c = await beginLink(e, p, who),
      co = comment(c.code);
    co.last_edited_time = co.created_time;
    fake((url, init) => {
      if (url.pathname.endsWith('/comments')) return { results: [co], has_more: false };
      if (url.pathname.includes('/users/'))
        return { id: nid, type: 'person', name: '본인', person: { email: 'me@example.com' } };
      return page();
    });
    expect((await inspectLink(e, p, who, c.id)).email).toBe('me@example.com');
    await confirmLink(e, p, who, c.id, nid);
    expect(JSON.stringify(await one(e.DB, 'SELECT * FROM links'))).not.toContain('me@example.com');
    expect((await one(e.DB, 'SELECT * FROM links')).notion_id).toBe(nid);
    expect((await one(e.DB, 'SELECT * FROM links')).valid_until).toBe(0);
    await expect(confirmLink(e, p, who, c.id, nid)).rejects.toThrow('만료');
  });
  it('기존 다른 Discord 연결과 충돌하면 코드 소비도 롤백', async () => {
    await run(
      e.DB,
      'INSERT INTO links VALUES(?,?,?,?,?)',
      p.id,
      '22222',
      nid,
      0,
      Date.now() + 60000,
    );
    const c = await beginLink(e, p, who),
      co = comment(c.code);
    co.last_edited_time = co.created_time;
    fake((url) =>
      url.pathname.endsWith('/comments')
        ? { results: [co], has_more: false }
        : url.pathname.includes('/users/')
          ? { id: nid, type: 'person' }
          : page(),
    );
    await inspectLink(e, p, who, c.id);
    await expect(confirmLink(e, p, who, c.id, nid)).rejects.toThrow('다른 Discord');
    expect((await one(e.DB, 'SELECT consumed FROM challenges WHERE id=?', c.id)).consumed).toBe(0);
  });
  it('People 지정 결과가 다르면 연결하지 않음', async () => {
    const c = await beginLink(e, p, who),
      co = comment(c.code);
    co.last_edited_time = co.created_time;
    fake((url) =>
      url.pathname.endsWith('/comments')
        ? { results: [co], has_more: false }
        : url.pathname.includes('/users/')
          ? { id: nid, type: 'person' }
          : page({ properties: { [p.notion.properties.assignees]: { people: [] } } }),
    );
    await inspectLink(e, p, who, c.id);
    await expect(confirmLink(e, p, who, c.id, nid)).rejects.toThrow('재조회');
    expect(await one(e.DB, 'SELECT 1 FROM links')).toBeNull();
  });
  it('연결 해제 시 진행 중 코드도 무효화', async () => {
    const c = await beginLink(e, p, who);
    await unlink(e, p, who);
    await expect(inspectLink(e, p, who, c.id)).rejects.toThrow('만료');
  });
});
describe('보고와 이슈 입력', () => {
  const issue = (overrides: any = {}): Issue => ({
    id: 'a',
    taskId: 'TASK-1',
    title: '업무',
    due: '2026-11-09',
    assignees: [],
    priority: '보통',
    status: '미시작',
    type: '기능',
    created: '2026-11-01',
    parentIds: [],
    archived: false,
    url: 'https://notion.so/a',
    description: '',
    edited: '2026-11-01',
    ...overrides,
  });
  it('완료/취소/보관/하위/검증 페이지 제외', () => {
    for (const override of [
      { status: '완료' },
      { status: '취소' },
      { archived: true },
      { parentIds: ['p'] },
      { id: 'probe' },
    ])
      expect(reportable(issue(override), p)).toBe(false);
    expect(reportable(issue({ assignees: [] }), p)).toBe(true);
  });
  it('마감일 → 명시 우선순위 → 생성일 → ID 안정 정렬', () => {
    const list = [
      issue({ id: 'z', due: null, priority: '긴급' }),
      issue({ id: 'b' }),
      issue({ id: 'a' }),
      issue({ id: 'c', priority: '긴급' }),
      issue({ id: 'd', created: '2026-10-01' }),
      issue({ id: 'e', due: '2026-11-08' }),
    ];
    expect(list.sort((a, b) => compareIssues(a, b, p)).map((x) => x.id)).toEqual([
      'e',
      'c',
      'd',
      'a',
      'b',
      'z',
    ]);
  });
  it('긴 제목/담당자도 Discord 메시지 제한 내 요약', () => {
    expect(
      reportMessage(
        [issue({ title: '한'.repeat(2000), assignees: Array(30).fill(nid) })],
        '전체 표 링크',
      ).length,
    ).toBeLessThan(2000);
  });
  it('필수값과 실제 달력 날짜 검증, 최신 Modal Label 파싱', () => {
    expect(validateDraft(draft, p)).toEqual(draft);
    expect(() => validateDraft({ ...draft, due: '2026-02-30' }, p)).toThrow();
    expect(() => validateDraft({ ...draft, priority: '없는 값' }, p)).toThrow();
    expect(modal(p, [{ discord_id: id }]).data.components).toHaveLength(5);
    expect(fields([{ type: 18, component: { custom_id: 'type', values: ['기능'] } }])).toEqual({
      type: '기능',
    });
  });
  it('Notion 모든 페이지를 수집한 뒤 정렬하여 누락 없이 게시', async () => {
    let query = 0;
    fake((url, init) => {
      if (url.pathname.endsWith('/query')) {
        query++;
        return query === 1
          ? { results: [page()], has_more: true, next_cursor: 'next' }
          : { results: [page({ id: 'page-2', created_time: '2026-10-01' })], has_more: false };
      }
      if (url.pathname.endsWith('/messages')) return { id: 'message-' + Math.random() };
      throw new Error('unexpected ' + url.pathname);
    });
    await enqueue(e.DB, 'report-job', 'report', { week: '2026-11-09' });
    for (let i = 0; i < 5; i++) await jobStep('report-job');
    expect(query).toBe(2);
    expect((await all(e.DB, 'SELECT * FROM report_items')).length).toBe(2);
    expect((await one(e.DB, 'SELECT complete FROM report_runs')).complete).toBe(1);
  });
});
describe('중복 방지와 복구', () => {
  it('외부 생성 성공 후 응답 유실은 재생성하지 않고 조회 복구', async () => {
    const create = vi.fn(async () => {
      throw new RemoteError('notion', 0, 1, true);
    });
    await expect(effect(e.DB, 'effect', create, async () => null)).rejects.toThrow();
    expect(await effect(e.DB, 'effect', create, async () => ({ id: 'existing' }))).toEqual({
      id: 'existing',
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(await effect(e.DB, 'effect', create, async () => null)).toEqual({ id: 'existing' });
  });
  it('성공 여부 확인 불가하면 검토 상태로 중단', async () => {
    await run(e.DB, 'INSERT INTO effects VALUES(?,?,?,?)', 'uncertain', 'sending', null, 0);
    const create = vi.fn();
    await expect(effect(e.DB, 'uncertain', create, async () => null)).rejects.toThrow('미확인');
    expect(create).not.toHaveBeenCalled();
  });
  it('확정된 429는 다음 실행에서 재시도 가능', async () => {
    await expect(
      effect(
        e.DB,
        'rate',
        async () => {
          throw new RemoteError('discord', 429, 2);
        },
        async () => null,
      ),
    ).rejects.toThrow();
    expect(await one(e.DB, 'SELECT 1 FROM effects')).toBeNull();
  });
  it('동일 스케줄 반복 실행과 지연 실행을 중복 예약하지 않음', async () => {
    const at = Date.parse('2026-11-09T10:00:00+09:00');
    await schedule(e, p, at);
    await schedule(e, p, at);
    expect((await all(e.DB, 'SELECT * FROM jobs')).length).toBe(4);
    expect((await one(e.DB, 'SELECT next_week FROM schedule_cursor')).next_week).toBe('2026-11-16');
  });
  it('DM 거부는 해당 작업만 종료', async () => {
    await seedPoll();
    fake((url) =>
      url.pathname.includes('/members/') ? member : new Response('{}', { status: 403 }),
    );
    await enqueue(e.DB, 'dm-job', 'dm', { pollId: 'poll', userId: id });
    const j = await jobStep('dm-job');
    expect(j.status).toBe('done');
    expect(JSON.parse(j.state).skipped).toBe(true);
  });
  it('가능한 시간 없음 제출자는 리마인더를 보내지 않음', async () => {
    await seedPoll();
    await saveVote(e.DB, p, 'poll', id, []);
    const f = fake(() => {
      throw new Error('no call');
    });
    await enqueue(e.DB, 'dm-job', 'dm', { pollId: 'poll', userId: id });
    expect((await jobStep('dm-job')).status).toBe('done');
    expect(f).not.toHaveBeenCalled();
  });
  it('영구 연결로 이슈를 생성하고 Discord 일시 실패를 복구하며 Notion 중복 생성하지 않음', async () => {
    await run(e.DB, 'INSERT INTO links VALUES(?,?,?,?,?)', p.id, id, nid, 0, 0);
    let notionCreates = 0,
      forumPosts = 0;
    fake((url, init) => {
      if (url.pathname.includes('/members/')) return member;
      if (
        url.hostname === 'api.notion.com' &&
        url.pathname === '/v1/pages' &&
        init.method === 'POST'
      ) {
        notionCreates++;
        return page();
      }
      if (url.pathname.endsWith('/pages/page-1')) return page();
      if (url.pathname.endsWith('/threads') && init.method === 'POST') {
        forumPosts++;
        return new Response('{}', { status: 500 });
      }
      if (url.pathname.endsWith('/threads/active'))
        return { threads: [{ id: 'thread', name: 'marker', parent_id: 'forum' }] };
      if (url.pathname.includes('/threads/archived')) return { threads: [] };
      if (url.pathname.endsWith('/messages')) return { id: 'mention' };
      throw new Error(url.pathname);
    });
    await enqueue(e.DB, 'create-job', 'issue-create', { userId: id, draft });
    expect((await jobStep('create-job')).status).toBe('pending');
    expect((await jobStep('create-job')).status).toBe('pending');
    const marker = '[' + (await hash('create-job')).slice(0, 12) + ']';
    fake((url, init) => {
      if (url.pathname.endsWith('/pages/page-1')) return page();
      if (url.pathname.endsWith('/threads/active'))
        return { threads: [{ id: 'thread', name: marker + ' 업무', parent_id: 'forum' }] };
      if (url.pathname.includes('/threads/archived')) return { threads: [] };
      if (url.pathname.includes('/members/')) return member;
      if (url.pathname.endsWith('/messages')) return { id: 'mention' };
      throw new Error(url.pathname);
    });
    await jobStep('create-job');
    expect((await jobStep('create-job')).status).toBe('done');
    expect(notionCreates).toBe(1);
    expect(forumPosts).toBe(1);
    expect((await one(e.DB, 'SELECT thread_id FROM issue_links')).thread_id).toBe('thread');
  });
  it('만료된 Worker lease를 다시 획득해 복구', async () => {
    await seedPoll();
    await saveVote(e.DB, p, 'poll', id, []);
    await enqueue(e.DB, 'crashed', 'dm', { pollId: 'poll', userId: id });
    await run(
      e.DB,
      "UPDATE jobs SET status='running',lease='old',lease_until=0 WHERE id='crashed'",
    );
    expect((await jobStep('crashed')).status).toBe('done');
  });
  it('Webhook 중복은 작업 하나, 순서가 바뀌어도 최신 Notion을 다시 읽음', async () => {
    await run(
      e.DB,
      'INSERT INTO issue_links(page_id,project_id,request_id,thread_id,message_id,assignees) VALUES(?,?,?,?,?,?)',
      'page-1',
      p.id,
      'request',
      'thread',
      'starter',
      JSON.stringify([nid]),
    );
    const body = JSON.stringify({
      id: 'event',
      workspace_id: 'workspace',
      entity: { type: 'page', id: 'page-1' },
      timestamp: '2000-01-01',
    });
    for (let i = 0; i < 2; i++) {
      const r = await worker.fetch(
        new Request(e.APP_ORIGIN + '/webhooks/notion', {
          method: 'POST',
          headers: { 'x-notion-signature': await signed(body) },
          body,
        }),
        e,
        ctx,
      );
      expect(r.status).toBe(200);
    }
    expect((await all(e.DB, 'SELECT * FROM jobs')).length).toBe(1);
    const requests: any[] = [];
    fake((url, init) => {
      if (url.pathname.endsWith('/pages/page-1'))
        return page({ last_edited_time: '2026-11-10T00:00:00Z' });
      if (url.pathname.includes('/children')) return { results: [] };
      requests.push(JSON.parse(init.body || '{}'));
      return { id: 'ok' };
    });
    expect((await jobStep('webhook:event')).status).toBe('done');
    expect((await one(e.DB, 'SELECT last_edited FROM issue_links')).last_edited).toBe(
      '2026-11-10T00:00:00Z',
    );
    expect(requests.some((r) => r.content?.includes('업무'))).toBe(true);
  });
});
describe('추가 회귀 검증', () => {
  it.each([false, true])(
    '확인 버튼 재전송은 동일 작업을 재사용하고 비공개 결과를 갱신한다 (실패=%s)',
    async (uncertain) => {
      await run(
        e.DB,
        'INSERT INTO drafts VALUES(?,?,?,?,0)',
        'draft-id',
        id,
        JSON.stringify(draft),
        Date.now() + 60000,
      );
      await run(e.DB, 'INSERT INTO links VALUES(?,?,?,?,?)', p.id, id, nid, 0, Date.now() + 600000);
      const notices: any[] = [];
      let creates = 0;
      fake((url, init) => {
        if (url.pathname.includes('/members/')) return member;
        if (url.pathname.endsWith('/messages/@original')) {
          notices.push(JSON.parse(init.body));
          return {};
        }
        creates++;
        return uncertain ? new Response('{}', { status: 500 }) : page();
      });
      const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      const toHex = (a: ArrayBuffer) =>
        Array.from(new Uint8Array(a), (v) => v.toString(16).padStart(2, '0')).join('');
      const customEnv = {
        ...e,
        DISCORD_PUBLIC_KEY: toHex(await crypto.subtle.exportKey('raw', keys.publicKey)),
      };
      const body = JSON.stringify({
          id: 'interaction',
          token: 'private-interaction-token',
          type: 3,
          guild_id: p.guildId,
          member,
          data: { custom_id: 'issue:confirm:draft-id' },
        }),
        ts = String(Math.floor(Date.now() / 1000));
      const signature = toHex(
        await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(ts + body)),
      );
      const tasks: Promise<any>[] = [];
      const context = { ...ctx, waitUntil: (t: Promise<any>) => tasks.push(t) };
      for (let i = 0; i < 2; i++) {
        const r = await worker.fetch(
          new Request(e.APP_ORIGIN + '/interactions', {
            method: 'POST',
            body,
            headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': ts },
          }),
          customEnv,
          context as any,
        );
        expect(r.status).toBe(200);
        const response: any = await r.json();
        expect(response.type).toBe(i === 0 ? 5 : 4);
        expect(response.data.flags).toBe(64);
      }
      await Promise.all(tasks);
      expect(creates).toBe(1);
      expect(notices).toHaveLength(1);
      expect(notices[0].content).toContain(uncertain ? '자동 재생성을 중단' : 'Notion 이슈가 생성');
      expect(notices[0].allowed_mentions).toEqual({ parse: [] });
      expect((await all(e.DB, "SELECT * FROM jobs WHERE kind='issue-create'")).length).toBe(1);
    },
  );
  it('잘못된 Discord 서명은 PING도 거부', async () => {
    const r = await worker.fetch(
      new Request(e.APP_ORIGIN + '/interactions', { method: 'POST', body: '{"type":1}' }),
      e,
      ctx,
    );
    expect(r.status).toBe(401);
  });
  it('Notion Webhook 서명 없는 이벤트는 등록하지 않음', async () => {
    const r = await worker.fetch(
      new Request(e.APP_ORIGIN + '/webhooks/notion', { method: 'POST', body: '{"id":"fake"}' }),
      e,
      ctx,
    );
    expect(r.status).toBe(401);
    expect(await one(e.DB, 'SELECT 1 FROM jobs')).toBeNull();
  });
  it('중복 Webhook이 담당자 알림을 다시 만들지 않음', async () => {
    await run(e.DB, 'INSERT INTO links VALUES(?,?,?,?,?)', p.id, id, nid, 0, Date.now() + 600000);
    await run(
      e.DB,
      'INSERT INTO issue_links(page_id,project_id,request_id,thread_id,message_id) VALUES(?,?,?,?,?)',
      'page-1',
      p.id,
      'request',
      'thread',
      'starter',
    );
    fake((url) =>
      url.pathname.endsWith('/pages/page-1')
        ? page()
        : url.pathname.includes('/children')
          ? { results: [] }
          : { id: 'ok' },
    );
    for (const key of ['event-1', 'event-2']) {
      await enqueue(e.DB, key, 'issue-sync', { pageId: 'page-1' });
      expect((await jobStep(key)).status).toBe('done');
    }
    expect((await all(e.DB, "SELECT * FROM jobs WHERE kind='assignee-notify'")).length).toBe(0);
  });
  it('보관된 Notion 페이지는 본문 재조회 없이 상태를 반영', async () => {
    await run(
      e.DB,
      'INSERT INTO issue_links(page_id,project_id,request_id,thread_id,message_id) VALUES(?,?,?,?,?)',
      'page-1',
      p.id,
      'request',
      'thread',
      'starter',
    );
    const f = fake((url) => {
      if (url.pathname.includes('/children')) throw new Error('archived content inaccessible');
      if (url.pathname.endsWith('/pages/page-1')) return page({ in_trash: true });
      return { id: 'ok' };
    });
    await enqueue(e.DB, 'archived', 'issue-sync', { pageId: 'page-1' });
    expect((await jobStep('archived')).status).toBe('done');
    expect(f.mock.calls.some(([url, init]: any) => init?.body?.includes('보관'))).toBe(true);
  });
  it('동시에 실행해도 작업은 하나의 lease만 획득', async () => {
    await seedPoll();
    await saveVote(e.DB, p, 'poll', id, []);
    await enqueue(e.DB, 'one', 'dm', { pollId: 'poll', userId: id });
    await Promise.all([processOne(e, p, 'one'), processOne(e, p, 'one')]);
    expect((await one(e.DB, 'SELECT status FROM jobs WHERE id=?', 'one')).status).toBe('done');
  });
});

describe('Notion 요청 ID 없는 생성', () => {
  it('Notion 자동 ID를 읽고 요청 ID 속성 없이 생성한다', async () => {
    let sent: any;
    fake((url, init) => {
      expect(url.pathname).toBe('/v1/pages');
      sent = JSON.parse(init.body);
      return page();
    });
    const created = await new Notion(e).create(p, draft, nid);
    expect(Object.keys(sent.properties).sort()).toEqual(
      [
        p.notion.properties.title,
        p.notion.properties.due,
        p.notion.properties.assignees,
        p.notion.properties.type,
        p.notion.properties.priority,
        p.notion.properties.status,
      ].sort(),
    );
    expect(new Notion(e).normalize(p, created).taskId).toBe('TASK-1');
  });

  it('Notion 생성 요청의 5초 제한이 실제 abort로 연결된다', async () => {
    const original = AbortSignal.timeout.bind(AbortSignal);
    const deadline = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => original(ms === 5000 ? 1 : ms));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const fail = () => reject(new DOMException('Timeout', 'AbortError'));
            if (init.signal!.aborted) fail();
            else init.signal!.addEventListener('abort', fail, { once: true });
          }),
      ),
    );
    await expect(
      createIssuePage(e.DB, new Notion(e), p, draft, nid, 'timeout'),
    ).rejects.toMatchObject({ code: 'notion_create_uncertain' });
    expect(deadline).toHaveBeenCalledWith(5000);
    expect((await one(e.DB, "SELECT state FROM effects WHERE id='timeout:notion'")).state).toBe(
      'sending',
    );
  });

  it.each(['network', '500', '408', 'invalid-json', 'missing-id'])(
    '%s 생성 결과는 즉시 review로 중단하고 관리자 재시도도 POST하지 않는다',
    async (failure) => {
      await run(e.DB, 'INSERT INTO links VALUES(?,?,?,?,?)', p.id, id, nid, 0, Date.now() + 600000);
      let creates = 0;
      fake((url, init) => {
        if (url.pathname.includes('/members/')) return member;
        if (url.pathname === '/v1/pages' && init.method === 'POST') {
          creates++;
          if (failure === 'network') throw new Error('response lost after creation');
          if (failure === 'invalid-json') return new Response('invalid JSON', { status: 200 });
          if (failure === 'missing-id') return {};
          return new Response('{}', { status: Number(failure) });
        }
        throw new Error('unexpected call');
      });
      await enqueue(e.DB, 'uncertain-job', 'issue-create', { userId: id, draft });
      const first = await jobStep('uncertain-job');
      expect(first.status).toBe('review');
      expect(first.error).toContain('자동 재생성을 중단');
      expect((await jobStep('uncertain-job')).status).toBe('review');
      await run(
        e.DB,
        "UPDATE jobs SET status='pending',next_at=0,attempts=0 WHERE id='uncertain-job'",
      );
      expect((await jobStep('uncertain-job')).status).toBe('review');
      expect(creates).toBe(1);
      expect(await one(e.DB, 'SELECT * FROM issue_links')).toBeNull();
    },
  );

  it('전송 직후 Worker가 중단된 기존 sending 효과도 재생성하지 않는다', async () => {
    await run(
      e.DB,
      'INSERT INTO effects(id,state,updated_at) VALUES(?,?,?)',
      'crash:notion',
      'sending',
      0,
    );
    const f = fake(() => {
      throw new Error('must not call API');
    });
    await expect(
      createIssuePage(e.DB, new Notion(e), p, draft, nid, 'crash'),
    ).rejects.toMatchObject({ code: 'notion_create_uncertain' });
    expect(f).not.toHaveBeenCalled();
  });

  it('기록된 성공은 다시 만들지 않고 재사용한다', async () => {
    await run(
      e.DB,
      'INSERT INTO effects(id,state,result,updated_at) VALUES(?,?,?,?)',
      'saved:notion',
      'done',
      JSON.stringify({ id: 'page-1' }),
      0,
    );
    const f = fake(() => {
      throw new Error('must not call API');
    });
    expect(await createIssuePage(e.DB, new Notion(e), p, draft, nid, 'saved')).toEqual({
      id: 'page-1',
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('명시적으로 거절된 429는 대기 후 재시도할 수 있다', async () => {
    await run(e.DB, 'INSERT INTO links VALUES(?,?,?,?,?)', p.id, id, nid, 0, Date.now() + 600000);
    let creates = 0;
    fake((url) => {
      if (url.pathname.includes('/members/')) return member;
      creates++;
      return creates === 1
        ? new Response('{}', { status: 429, headers: { 'retry-after': '2' } })
        : page();
    });
    await enqueue(e.DB, 'rate-job', 'issue-create', { userId: id, draft });
    expect((await jobStep('rate-job')).status).toBe('pending');
    expect(await one(e.DB, "SELECT * FROM effects WHERE id='rate-job:notion'")).toBeNull();
    expect(JSON.parse((await jobStep('rate-job')).state).pageId).toBe('page-1');
    expect(creates).toBe(2);
  });

  it('요청 ID가 없는 DB 스키마도 연동 검증을 통과한다', async () => {
    const names = p.notion.properties;
    const types: Record<string, string> = {
      taskId: 'unique_id',
      title: 'title',
      due: 'date',
      assignees: 'people',
      type: 'select',
      priority: 'select',
      status: 'status',
      created: 'created_time',
      parent: 'relation',
      children: 'relation',
      discord: 'url',
    };
    const properties: any = Object.fromEntries(
      Object.entries(types).map(([key, type]) => [
        names[key as keyof typeof names],
        { type, [type]: {} },
      ]),
    );
    properties[names.type].select.options = p.notion.types.map((name) => ({ name }));
    properties[names.priority].select.options = p.notion.priorities.map((name) => ({ name }));
    properties[names.status].status.options = [
      p.notion.initialStatus,
      ...p.notion.excludedStatuses,
    ].map((name) => ({ name }));
    fake(() => ({ properties }));
    expect((await new Notion(e).schema(p)).ok).toBe(true);
  });
});

describe('이슈 전용 활성화와 서버 멤버 접근', () => {
  it('정기 알림이 꺼져 있으면 새 예약과 기존 대기/실행 작업도 처리하지 않는다', async () => {
    p.features = { issues: true, automation: false };
    await schedule(e, p, Date.parse('2026-11-09T10:00:00+09:00'));
    expect(await all(e.DB, 'SELECT * FROM jobs')).toHaveLength(0);
    const f = fake(() => {
      throw new Error('must not send');
    });
    for (const kind of ['poll-open', 'poll-remind', 'poll-close', 'report', 'dm']) {
      await enqueue(e.DB, kind, kind, { week: '2026-11-09' }, 0);
      await run(e.DB, "UPDATE jobs SET status='running',lease_until=0 WHERE id=?", kind);
      await processOne(e, p, kind);
      expect((await one(e.DB, 'SELECT attempts FROM jobs WHERE id=?', kind)).attempts).toBe(0);
    }
    await enqueue(e.DB, 'pending-report', 'report', { week: '2026-11-09' }, 0);
    await processOne(e, p);
    expect((await one(e.DB, "SELECT status FROM jobs WHERE id='pending-report'")).status).toBe(
      'pending',
    );
    expect(f).not.toHaveBeenCalled();
  });

  it('정기 알림 없이 이슈 작업은 처리하고 이슈 기능을 끄면 처리하지 않는다', async () => {
    p.features = { issues: true, automation: false };
    await run(e.DB, 'INSERT INTO links VALUES(?,?,?,?,?)', p.id, id, nid, 0, Date.now() + 600000);
    fake((url) => (url.pathname.includes('/members/') ? member : page()));
    await enqueue(e.DB, 'enabled-issue', 'issue-create', { userId: id, draft });
    expect(JSON.parse((await jobStep('enabled-issue')).state).pageId).toBe('page-1');
    p.features.issues = false;
    await enqueue(e.DB, 'disabled-issue', 'issue-create', { userId: id, draft });
    expect((await jobStep('disabled-issue')).attempts).toBe(0);
  });

  it('역할 제한이 없으면 역할 없는 멤버도 허용하지만 봇과 탈퇴자는 거부한다', async () => {
    p.memberRoleId = '';
    fake(() => ({ ...member, roles: [] }));
    expect((await new Discord(e).member(p, id)).user.id).toBe(id);
    fake(() => ({ ...member, user: { id, bot: true }, roles: [] }));
    await expect(new Discord(e).member(p, id)).rejects.toMatchObject({ status: 403 });
    fake(() => new Response('{}', { status: 404 }));
    await expect(new Discord(e).member(p, id)).rejects.toMatchObject({ status: 403 });
  });

  it('역할 없는 서버 소유자는 명시적 관리자 ID로만 관리자 권한을 얻는다', async () => {
    p.memberRoleId = '';
    p.adminUserIds = [id];
    await run(
      e.DB,
      'INSERT INTO sessions VALUES(?,?,?,?,?)',
      await hash('owner-session'),
      id,
      'owner',
      'csrf',
      Date.now() + 60000,
    );
    fake(() => ({ ...member, roles: [] }));
    const request = new Request(e.APP_ORIGIN + '/api/me', {
      headers: { cookie: 'session=owner-session' },
    });
    expect((await authorize(request, e, p)).admin).toBe(true);
    p.adminUserIds = ['22222'];
    expect((await authorize(request, e, p)).admin).toBe(false);
  });

  it('명시적으로 켠 계정 연결도 인증 페이지와 검증 행이 없으면 차단한다', async () => {
    p.linkingEnabled = true;
    p.notion.guestVerificationEnabled = false;
    p.notion.guestEvidence = '';
    expect((await beginLink(e, p, who)).code).toBeTruthy();
    p.notion.probePageId = '';
    await expect(beginLink(e, p, who)).rejects.toThrow('설정');
  });

  it('/이슈 생성는 연결된 담당자가 있으면 즉시 모달을 열고 다른 서버는 거부한다', async () => {
    p.memberRoleId = '';
    p.features = { issues: true, automation: false };
    await run(e.DB, 'UPDATE projects SET config=? WHERE id=?', JSON.stringify(p), p.id);
    await run(e.DB, 'INSERT INTO links VALUES(?,?,?,?,?)', p.id, id, nid, 0, Date.now() + 600000);
    const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const hex = (a: ArrayBuffer) =>
      Array.from(new Uint8Array(a), (v) => v.toString(16).padStart(2, '0')).join('');
    const customEnv = {
      ...e,
      DISCORD_PUBLIC_KEY: hex(await crypto.subtle.exportKey('raw', keys.publicKey)),
    };
    for (const guildId of [p.guildId, 'other-guild']) {
      const body = JSON.stringify({
        type: 2,
        guild_id: guildId,
        member: { ...member, roles: [] },
        data: { name: '이슈', options: [{ type: 1, name: '생성' }] },
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const signature = hex(
        await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(ts + body)),
      );
      const response = await worker.fetch(
        new Request(e.APP_ORIGIN + '/interactions', {
          method: 'POST',
          body,
          headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': ts },
        }),
        customEnv,
        ctx,
      );
      const value: any = await response.json();
      expect(value.type).toBe(guildId === p.guildId ? 9 : 4);
      if (guildId === p.guildId) expect(value.data.custom_id).toBe('issue:required');
    }
  });
});

describe('Worker native fetch 호환성', () => {
  it('전역 fetch를 mock하지 않아도 Http가 JSON 응답을 읽는다', async () => {
    const http = new Http();
    await expect(
      http.request('fixture', 'https://http-fixture.test/ok', { method: 'POST', body: 'test' }),
    ).resolves.toEqual({ ok: true, method: 'POST' });
  });
});

describe('계정 연결과 로그인 유지', () => {
  it('영구 연결은 오래 지나도 담당자에 포함되고 직접 해제할 수 있다', async () => {
    await run(e.DB, 'INSERT INTO links VALUES(?,?,?,?,?)', p.id, id, nid, 0, 0);
    await run(e.DB, 'INSERT INTO links VALUES(?,?,?,?,?)', p.id, '22222', 'expired-person', 0, 1);
    expect((await linkedMembers(e, p)).map((x) => x.discord_id)).toEqual([id]);
    await unlink(e, p, who);
    expect(await linkedMembers(e, p)).toEqual([]);
  });
  it('기존 단기 세션을 90일로 갱신하고 이후 로그인 경로도 승인을 생략한다', async () => {
    await run(
      e.DB,
      'INSERT INTO sessions VALUES(?,?,?,?,?)',
      await hash('session'),
      id,
      '본인',
      'csrf',
      Date.now() + 60_000,
    );
    fake(() => member);
    const response = await worker.fetch(
      new Request('http://localhost/api/me', { headers: { cookie: 'session=session' } }),
      e,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=7776000');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect((await one(e.DB, 'SELECT expires FROM sessions')).expires).toBeGreaterThan(
      Date.now() + 89 * 86400_000,
    );
    expect(await response.text()).not.toContain('sessionCookie');
    const again = await worker.fetch(
      new Request('http://localhost/auth/login', { headers: { cookie: 'session=session' } }),
      e,
      ctx,
    );
    expect(again.headers.get('location')).toBe('/');
    expect(again.headers.get('set-cookie')).toBeNull();
    expect(await one(e.DB, 'SELECT 1 FROM oauth_states')).toBeNull();
  });
  it('로그아웃은 세션을 지우지만 영구 Notion 연결은 유지한다', async () => {
    await run(
      e.DB,
      'INSERT INTO sessions VALUES(?,?,?,?,?)',
      await hash('session'),
      id,
      '본인',
      'csrf',
      Date.now() + 60_000,
    );
    await run(e.DB, 'INSERT INTO links VALUES(?,?,?,?,?)', p.id, id, nid, 0, 0);
    fake(() => member);
    const response = await worker.fetch(
      new Request(e.APP_ORIGIN + '/auth/logout', {
        method: 'POST',
        headers: { cookie: 'session=session', origin: e.APP_ORIGIN, 'x-csrf-token': 'csrf' },
      }),
      e,
      ctx,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(response.headers.get('set-cookie')).not.toContain('7776000');
    expect(await one(e.DB, 'SELECT 1 FROM sessions')).toBeNull();
    expect((await linkedMembers(e, p)).length).toBe(1);
  });
  it('만료된 세션은 자동 부활시키지 않고 새 Discord 로그인을 시작한다', async () => {
    await run(
      e.DB,
      'INSERT INTO sessions VALUES(?,?,?,?,?)',
      await hash('expired'),
      id,
      '본인',
      'csrf',
      1,
    );
    const response = await worker.fetch(
      new Request('http://localhost/auth/login', { headers: { cookie: 'session=expired' } }),
      e,
      ctx,
    );
    expect(new URL(response.headers.get('location')!).hostname).toBe('discord.com');
    expect((await one(e.DB, 'SELECT expires FROM sessions')).expires).toBe(1);
  });
});

describe('월요일 투표 결과 링크', () => {
  it('결과 안내는 마감 직후가 아닌 월요일 09시에 한 번 예약한다', async () => {
    const week = '2026-11-09';
    await schedule(e, p, Date.parse(week + 'T08:59:59+09:00'));
    expect(await one(e.DB, "SELECT 1 FROM jobs WHERE kind='poll-close'")).toBeNull();
    await schedule(e, p, Date.parse(week + 'T09:00:00+09:00'));
    await schedule(e, p, Date.parse(week + 'T09:00:01+09:00'));
    const jobs = await all(e.DB, "SELECT next_at FROM jobs WHERE kind='poll-close'");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].next_at).toBe(Date.parse(week + 'T09:00:00+09:00'));
  });
  it('원래 투표 스레드에 팀 결과 링크만 게시하고 이미지는 첨부하지 않는다', async () => {
    const week = '2026-01-05',
      pollId = p.id + ':' + week;
    await run(
      e.DB,
      'INSERT INTO polls(id,project_id,week,opens,closes,members,thread_id) VALUES(?,?,?,?,?,?,?)',
      pollId,
      p.id,
      week,
      0,
      1,
      '[]',
      'original-thread',
    );
    let message: any;
    fake((url, init) => {
      if (url.pathname === '/api/v10/channels/original-thread')
        return { thread_metadata: { archived: false } };
      if (url.pathname === '/api/v10/channels/original-thread/messages' && init.method === 'POST') {
        message = JSON.parse(init.body);
        return { id: 'result-message' };
      }
      throw new Error('Unexpected request');
    });
    await enqueue(e.DB, 'result-job', 'poll-close', { week });
    expect((await jobStep('result-job')).status).toBe('done');
    expect(message.content).toContain('/?poll=' + encodeURIComponent(pollId) + '&tab=team');
    expect(message.attachments).toBeUndefined();
  });
});

describe('이메일 계정 연결', () => {
  const person = { id: nid, type: 'person', name: '본인', person: { email: 'me@example.com' } };
  const adminWho = { ...who, admin: true };
  function emailApi(changeEmail = false) {
    return fake((url) => {
      if (url.pathname.includes('/members/')) return member;
      if (url.pathname === '/v1/users') return { results: [person], has_more: false };
      if (url.pathname === '/v1/users/' + nid)
        return changeEmail ? { ...person, person: { email: 'changed@example.com' } } : person;
      if (url.pathname === '/v1/pages/probe') return page();
      throw new Error('Unexpected endpoint');
    });
  }
  it('이메일은 후보 요청만 만들고 관리자 확인·People 검증 후에 영구 연결한다', async () => {
    emailApi();
    const request = await requestEmailLink(e, p, who, ' ME@example.com ');
    expect(request.email).toBe('me@example.com');
    expect(await one(e.DB, 'SELECT 1 FROM links')).toBeNull();
    await expect(approveEmailRequest(e, p, who, request.id)).rejects.toThrow('관리자');
    expect((await listEmailRequests(e, p, adminWho))[0].discord_id).toBe(id);
    await approveEmailRequest(e, p, adminWho, request.id);
    expect((await one(e.DB, 'SELECT * FROM links')).valid_until).toBe(0);
    expect((await one(e.DB, 'SELECT * FROM links')).notion_id).toBe(nid);
    expect(await ownEmailRequest(e, p, who)).toBeNull();
    await expect(approveEmailRequest(e, p, adminWho, request.id)).rejects.toThrow('요청');
  });
  it('본인 요청만 조회·취소할 수 있고 일반 멤버는 관리자 목록을 볼 수 없다', async () => {
    emailApi();
    const request = await requestEmailLink(e, p, who, 'me@example.com');
    const other = { ...who, userId: '22222' };
    expect(await ownEmailRequest(e, p, other)).toBeNull();
    await cancelEmailRequest(e, p, other, request.id);
    expect(await ownEmailRequest(e, p, who)).not.toBeNull();
    await expect(listEmailRequests(e, p, who)).rejects.toThrow('관리자');
    await cancelEmailRequest(e, p, who, request.id);
    expect(await ownEmailRequest(e, p, who)).toBeNull();
  });
  it('이메일 변경, 요청 만료, 연결 해제 후에는 승인할 수 없다', async () => {
    emailApi(true);
    const request = await requestEmailLink(e, p, who, 'me@example.com');
    await expect(approveEmailRequest(e, p, adminWho, request.id)).rejects.toThrow('변경');
    expect(await one(e.DB, 'SELECT 1 FROM links')).toBeNull();
    await run(e.DB, 'UPDATE link_requests SET expires=1');
    await expect(approveEmailRequest(e, p, adminWho, request.id)).rejects.toThrow('만료');
    await unlink(e, p, who);
    expect(await one(e.DB, 'SELECT 1 FROM link_requests')).toBeNull();
  });
  it('이미 다른 Discord 계정에 연결된 Notion 계정은 덮어쓰지 않는다', async () => {
    emailApi();
    const request = await requestEmailLink(e, p, who, 'me@example.com');
    await run(e.DB, 'INSERT INTO links VALUES(?,?,?,?,?)', p.id, '22222', nid, 0, 0);
    await expect(approveEmailRequest(e, p, adminWho, request.id)).rejects.toThrow('다른 Discord');
    expect((await all(e.DB, 'SELECT discord_id FROM links')).map((x) => x.discord_id)).toEqual([
      '22222',
    ]);
    expect(await ownEmailRequest(e, p, who)).not.toBeNull();
  });
  it('게스트는 검증 행의 담당자 ID로 조회하며 전체 이메일 목록은 반환하지 않는다', async () => {
    fake((url) => {
      if (url.pathname === '/v1/users') return { results: [], has_more: false };
      if (url.pathname === '/v1/pages/probe') return page();
      if (url.pathname === '/v1/users/' + nid) return person;
      throw new Error('Unexpected endpoint');
    });
    expect((await findPersonByEmail(new Notion(e), p, 'me@example.com')).id).toBe(nid);
    const capability = await emailCapabilities(e, adminWho);
    expect(capability.usersWithEmail).toBe(0);
    expect(JSON.stringify(capability)).not.toContain('example.com');
  });
  it('요청을 반복하면 제한하고 계정 검색 결과만으로 연결을 만들지 않는다', async () => {
    emailApi();
    await requestEmailLink(e, p, who, 'me@example.com');
    await expect(requestEmailLink(e, p, who, 'me@example.com')).rejects.toThrow('1분');
    expect(await one(e.DB, 'SELECT 1 FROM links')).toBeNull();
  });
});

describe('날짜 입력과 이슈 표시', () => {
  it('숫자 날짜를 정규화하고 윤년과 월말을 엄격히 검증한다', () => {
    for (const [input, expected] of [
      ['20261106', '2026-11-06'],
      ['2026-11-06', '2026-11-06'],
      ['20000229', '2000-02-29'],
      ['20240229', '2024-02-29'],
      [' 20261106 ', '2026-11-06'],
    ]) {
      expect(normalizeDueDate(input)).toBe(expected);
      expect(validateDraft({ ...draft, due: input }, p).due).toBe(expected);
    }
    for (const input of [
      '20260229',
      '19000229',
      '21000229',
      '2026-02-30',
      '20260431',
      '20261301',
      '20260001',
      '20261100',
      '00000101',
      '2026116',
      '202611060',
      '2026/11/06',
      '2026-1-06',
      '2026-11-06T00:00:00Z',
      '２０２６１１０６',
      '2026--11-06',
      '',
      null,
      20261106,
    ]) {
      expect(() => normalizeDueDate(input)).toThrow();
    }
  });
  it('각 필드를 세로로 표시하고 상태를 강조하며 내부 식별자는 표시하지 않는다', () => {
    const i = new Notion(e).normalize(p, page());
    i.status = '진행 중';
    i.statusColor = 'blue';
    const content = issueSummary(i, [id]);
    expect(content).toContain(
      '상태 : **🟦 진행 중**\n유형 : 기능\n마감일 : 2026-11-09\n우선순위 : 높음\n담당자 : <@11111>',
    );
    expect(content).not.toMatch(/\[(?:연수리:)?[a-f0-9]{12,24}\]/);
    expect(issueThreadName(i)).toBe('[TASK-1] 업무');
    expect(issueSummary({ ...i, status: '완료', statusColor: 'green' }, [])).toContain('🟩 완료');
    expect(issueSummary({ ...i, archived: true }, [])).toContain('📦 보관/휴지통');
  });
  it('nonce로 복구하고 이전 메시지의 마커도 읽되 타인의 메시지는 무시한다', async () => {
    fake(() => [
      { id: 'wrong', author: { id: 'someone' }, nonce: 'n' },
      { id: 'right', author: { id: e.DISCORD_APPLICATION_ID }, nonce: 'n', content: '알림' },
    ]);
    expect((await new Discord(e).findMessage('channel', '[old]', 'n')).id).toBe('right');
    fake(() => [{ id: 'old', author: { id: e.DISCORD_APPLICATION_ID }, content: '알림\n[old]' }]);
    expect((await new Discord(e).findMessage('channel', '[old]', 'n')).id).toBe('old');
    fake(() => []);
    expect(await new Discord(e).findMessage('channel', '[old]', 'n')).toBeNull();
  });
  it('포럼은 업무 ID와 원문 URL로 복구하고 다른 페이지는 연결하지 않는다', async () => {
    fake((url) => {
      if (url.pathname.endsWith('/threads/active'))
        return {
          threads: [{ id: 't', parent_id: p.issueChannelId, name: 'TASK-1 · 🟦 진행 중 · 업무' }],
        };
      if (url.pathname.includes('/threads/archived')) return { threads: [] };
      return {
        author: { id: e.DISCORD_APPLICATION_ID },
        content: '<https://www.notion.so/page-1>',
      };
    });
    expect(
      (await new Discord(e).findForum(p, '[old]', 'TASK-1', 'https://www.notion.so/page-1')).id,
    ).toBe('t');
    expect(
      await new Discord(e).findForum(p, '[old]', 'TASK-1', 'https://www.notion.so/page-2'),
    ).toBeNull();
  });
});

it('요약을 수정하고 알려진 봇 알림만 삭제하며 재멘션하지 않는다', async () => {
  const noticeId = 'notice';
  const marker = `[연수리:${(await hash(noticeId)).slice(0, 18)}]`;
  await run(
    e.DB,
    'INSERT INTO issue_links(page_id,project_id,request_id,thread_id,message_id,assignees) VALUES(?,?,?,?,?,?)',
    'page-1',
    p.id,
    'req',
    'thread',
    'starter',
    JSON.stringify([nid]),
  );
  await enqueue(e.DB, noticeId, 'assignee-notify', { pageId: 'page-1', threadId: 'thread' });
  await run(e.DB, "UPDATE jobs SET status='done' WHERE id=?", noticeId);
  await run(
    e.DB,
    'INSERT INTO effects(id,state,result,updated_at) VALUES(?,?,?,?)',
    noticeId,
    'done',
    JSON.stringify({ id: 'notice-message' }),
    0,
  );
  const edits: any[] = [];
  fake((url, init) => {
    if (url.pathname.endsWith('/pages/page-1')) {
      const result = page();
      result.properties[p.notion.properties.status] = {
        status: { name: '진행 중', color: 'blue' },
      };
      return result;
    }
    if (url.pathname.includes('/children')) return { results: [] };
    if (url.pathname.endsWith('/messages/notice-message') && init.method !== 'DELETE')
      return {
        author: { id: e.DISCORD_APPLICATION_ID },
        content: '새 담당자: <@11111>\n' + marker,
      };
    if (['PATCH', 'DELETE'].includes(init.method))
      edits.push({ method: init.method, path: url.pathname, ...JSON.parse(init.body || '{}') });
    return { id: 'ok' };
  });
  await enqueue(e.DB, 'refresh', 'issue-sync', {
    pageId: 'page-1',
    refreshPresentation: true,
    removeActivityNotices: true,
  });
  const result = await jobStep('refresh');
  expect(result.status).toBe('done');
  expect(JSON.parse(result.state).removedNotices).toBe(1);
  expect(edits.find((x) => x.path.endsWith('/messages/notice-message')).method).toBe('DELETE');
  expect(edits.find((x) => x.path.endsWith('/messages/starter')).content).toContain('🟦 진행 중');
  for (const edit of edits.filter((x) => x.content))
    expect(edit.allowed_mentions).toEqual({ parse: [] });
  expect(
    await one(e.DB, "SELECT 1 FROM jobs WHERE status='pending' AND kind='assignee-notify'"),
  ).toBeNull();
});

it('동기화는 여섯 속성과 상태 색상만 감지하고 스레드 제목과 알림을 변경하지 않는다', async () => {
  await run(
    e.DB,
    'INSERT INTO issue_links(page_id,project_id,request_id,thread_id,message_id) VALUES(?,?,?,?,?)',
    'page-1',
    p.id,
    'r',
    'thread',
    'starter',
  );
  let current = page();
  const edits: any[] = [];
  fake((url, init) => {
    if (url.pathname.endsWith('/pages/page-1')) return current;
    if (url.pathname.includes('/children')) throw new Error('unrelated body read');
    if (init.method === 'PATCH') {
      expect(url.pathname).toContain('/messages/starter');
      edits.push(JSON.parse(init.body));
    }
    return { id: 'ok' };
  });
  async function sync(key: string) {
    await enqueue(e.DB, key, 'issue-sync', { pageId: 'page-1' });
    expect((await jobStep(key)).status).toBe('done');
  }
  await sync('first');
  current.last_edited_time = '2026-11-20T00:00:00Z';
  current.properties['기타'] = { rich_text: [{ plain_text: 'changed' }] };
  await sync('unrelated');
  expect(edits).toHaveLength(1);
  current.properties[p.notion.properties.status] = { status: { name: '보류', color: 'yellow' } };
  await sync('status');
  expect(edits).toHaveLength(2);
  expect(edits[1].content).toContain('상태 : **🟨 보류**');
  expect(edits[1].content).toContain('**[TASK-1] 업무**');
  current.properties[p.notion.properties.status].status.color = 'red';
  await sync('color');
  expect(edits[2].content).toContain('🟥 보류');
  expect(await one(e.DB, "SELECT 1 FROM jobs WHERE kind='assignee-notify'")).toBeNull();
});

it('주간 자동화가 꺼져도 연결된 이슈를 순환 조회하고 폴링 작업을 재사용한다', async () => {
  p.features = { issues: true, automation: false };
  for (const page of ['page-a', 'page-b'])
    await run(
      e.DB,
      'INSERT INTO issue_links(page_id,project_id,request_id,thread_id,message_id) VALUES(?,?,?,?,?)',
      page,
      p.id,
      page,
      'thread',
      'starter',
    );
  await scheduleIssueSync(e, p, 1000);
  await scheduleIssueSync(e, p, 1001);
  expect((await all(e.DB, "SELECT * FROM jobs WHERE kind='issue-sync'")).length).toBe(2);
  await run(e.DB, "UPDATE jobs SET status='done'");
  await scheduleIssueSync(e, p, 62000);
  expect((await all(e.DB, 'SELECT * FROM jobs')).length).toBe(2);
  p.features.issues = false;
  await scheduleIssueSync(e, p, 123000);
  expect((await all(e.DB, "SELECT * FROM jobs WHERE status='pending'")).length).toBe(1);
});
