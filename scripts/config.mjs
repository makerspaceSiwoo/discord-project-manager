import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const path = process.argv[2];
if (!path || !process.argv.some((x) => ['--local', '--remote', '--validate'].includes(x)))
  throw new Error(
    '사용법: node scripts/config.mjs config/project.local.json --local|--remote|--validate',
  );
const p = JSON.parse(await readFile(path, 'utf8'));
const fail = (s) => {
  throw new Error(s);
};
if (!/^[a-zA-Z0-9_-]{1,40}$/.test(p.id)) fail('프로젝트 ID 형식 오류');
new Intl.DateTimeFormat('en', { timeZone: p.timezone });
for (const key of ['open', 'reminder', 'report'])
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.schedule?.[key] || '')) fail('예약 시간 형식 오류');
if (p.schedule.open >= p.schedule.reminder) fail('안내 시각은 리마인더 이전이어야 합니다.');
if (!Number.isInteger(p.maxMembers) || p.maxMembers < 1 || p.maxMembers > 25)
  fail('maxMembers는 1~25');
if (!Number.isInteger(p.linkLifetimeDays) || p.linkLifetimeDays < 1 || p.linkLifetimeDays > 30)
  fail('계정 재검증 주기는 1~30일');
for (const list of [p.notion.types, p.notion.priorities])
  if (
    !list?.length ||
    list.length > 25 ||
    new Set(list).size !== list.length ||
    list.some((x) => typeof x !== 'string' || !x || x.length > 100)
  )
    fail('선택지는 중복 없는 1~25개, 각 1~100자');
if (
  !['forum', 'text'].includes(p.issueChannelMode) ||
  !['status', 'select'].includes(p.notion.statusType)
)
  fail('채널/상태 유형 오류');
const props = [
  'taskId',
  'title',
  'due',
  'assignees',
  'type',
  'priority',
  'status',
  'created',
  'parent',
  'children',
  'discord',
];
if (props.some((k) => typeof p.notion.properties[k] !== 'string' || !p.notion.properties[k]))
  fail('Notion 속성 매핑 누락');
if (new Set(props.map((key) => p.notion.properties[key])).size !== props.length)
  fail('서로 다른 속성을 매핑해야 합니다.');
if (p.enabled) {
  for (const key of [
    'guildId',
    'memberRoleId',
    'schedulingChannelId',
    'reportChannelId',
    'issueChannelId',
  ])
    if (!/^\d{5,25}$/.test(p[key])) fail(key + ' ID 필요');
  for (const key of ['workspaceId', 'databaseId', 'dataSourceId'])
    if (!/^[a-f0-9-]{32,36}$/i.test(p.notion[key])) fail('Notion ' + key + ' 필요');
  if (!p.adminRoleIds?.length) fail('관리자 역할을 지정하세요.');
}
if (
  p.notion.guestVerificationEnabled &&
  (!p.notion.guestEvidence ||
    ![p.notion.probePageId, p.notion.verificationPageId].every((x) =>
      /^[a-f0-9-]{32,36}$/i.test(x),
    ))
)
  fail('게스트 인증 검증 기록과 인증/전용 테스트 페이지 ID 필요');
if (process.argv.includes('--validate')) {
  console.log('설정 형식 검증 완료. 실제 API 권한은 별도 확인해야 합니다.');
  process.exit(0);
}
await mkdir('work', { recursive: true });
const escaped = JSON.stringify(p).replaceAll("'", "''"),
  sql = `INSERT INTO projects(id,config) VALUES('${p.id}','${escaped}') ON CONFLICT(id) DO UPDATE SET config=excluded.config;`;
await writeFile('work/config.sql', sql, { mode: 0o600 });
const r = spawnSync(
  process.execPath,
  [
    'node_modules/wrangler/bin/wrangler.js',
    'd1',
    'execute',
    'project-manager',
    process.argv.includes('--remote') ? '--remote' : '--local',
    '--file',
    'work/config.sql',
  ],
  { stdio: 'inherit' },
);
process.exit(r.status || 0);
