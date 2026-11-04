// Read-only by default. --apply creates only missing dedicated resources and upserts named commands.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const file = process.argv.find((x) => x.endsWith('.json')) || 'config/project.local.json';
const p = JSON.parse(await readFile(file, 'utf8')),
  apply = process.argv.includes('--apply');
const token = process.env.DISCORD_BOT_TOKEN,
  app = process.env.DISCORD_APPLICATION_ID;
if (!token || !app || !p.guildId)
  throw new Error('환경변수 DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID 및 guildId가 필요합니다.');
async function api(path, method = 'GET', body) {
  const r = await fetch('https://discord.com/api/v10' + path, {
    method,
    headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok)
    throw new Error(
      `Discord HTTP ${r.status}; 생성 응답이 불명확하면 journal 확인 후 재실행하세요.`,
    );
  return r.json();
}
await mkdir('work', { recursive: true });
const journalFile = 'work/setup-journal.json';
let journal = {};
try {
  journal = JSON.parse(await readFile(journalFile, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
const save = () => writeFile(journalFile, JSON.stringify(journal, null, 2), { mode: 0o600 });
async function once(key, existing, create) {
  if (existing) {
    journal[key] = { id: existing.id };
    await save();
    return existing;
  }
  if (journal[key])
    throw new Error(
      key + ' 이전 생성 결과가 불명확합니다. 실제 리소스 ID를 설정에 입력한 후 재시도하세요.',
    );
  if (!apply) {
    console.log('생성 예정:', key);
    return null;
  }
  journal[key] = { uncertain: true };
  await save();
  const result = await create();
  journal[key] = { id: result.id };
  await save();
  return result;
}
const roles = await api(`/guilds/${p.guildId}/roles`),
  channels = await api(`/guilds/${p.guildId}/channels`),
  guild = await api(`/guilds/${p.guildId}`),
  bot = await api('/users/@me');
const find = (rows, id, name) => {
  const matches = rows.filter((x) => (id ? x.id === id : x.name === name));
  if (matches.length > 1) throw new Error('이름 중복: ' + name);
  if (id && !matches.length) throw new Error('설정된 ID 없음: ' + id);
  return matches[0];
};
const role = await once('member-role', find(roles, p.memberRoleId, '연수리-팀원'), () =>
  api(`/guilds/${p.guildId}/roles`, 'POST', {
    name: '연수리-팀원',
    permissions: '0',
    mentionable: false,
  }),
);
if (role) p.memberRoleId = role.id;
if (p.issueChannelMode === 'forum' && !guild.features.includes('COMMUNITY'))
  throw new Error(
    'Community 서버가 아닙니다. Community를 활성화하거나 issueChannelMode를 text로 설정하세요.',
  );
for (const [key, name, type] of [
  ['schedulingChannelId', '일정-투표', 0],
  ['reportChannelId', '주간-보고', 0],
  ['issueChannelId', '프로젝트-이슈', p.issueChannelMode === 'forum' ? 15 : 0],
]) {
  const existing = find(channels, p[key], name);
  if (existing && existing.type !== type) throw new Error(name + ' 채널 유형 불일치');
  const memberPermissions = (1024n | 2048n | 65536n | 274877906944n).toString();
  const botPermissions = (
    1024n |
    2048n |
    65536n |
    16384n |
    32768n |
    17179869184n |
    34359738368n |
    274877906944n
  ).toString();
  const permissions = [
    { id: p.guildId, type: 0, deny: '1024', allow: '0' },
    ...(role ? [{ id: role.id, type: 0, allow: memberPermissions, deny: '0' }] : []),
    { id: bot.id, type: 1, allow: botPermissions, deny: '0' },
  ];
  const channel = await once(key, existing, () =>
    api(`/guilds/${p.guildId}/channels`, 'POST', {
      name,
      type,
      topic: `플젝하는 연수리 · ${p.id} · ${key}`,
      permission_overwrites: permissions,
    }),
  );
  if (channel) p[key] = channel.id;
}
const commands = [
  { name: '계정연결', description: '본인의 Discord와 Notion 계정 연결' },
  { name: '이슈생성', description: '새 Notion 이슈와 Discord 게시물 생성' },
  { name: '일정', description: '주간 일정 투표와 결과 열기' },
  { name: '연동상태', description: '관리자 연동 진단 및 복구', default_member_permissions: '0' },
];
if (apply) {
  for (const c of commands)
    await api(`/applications/${app}/guilds/${p.guildId}/commands`, 'POST', { ...c, type: 1 });
  await writeFile(file, JSON.stringify(p, null, 2) + '\n');
  console.log(
    '설정 저장 완료. 기존 채널 권한은 변경하지 않았습니다. 역할 구성원을 확인하고 진단을 실행하세요.',
  );
} else console.log('읽기 전용 점검 완료. --apply로 누락된 전용 리소스 생성 및 명령 등록.');
let after = '0',
  members = [];
do {
  const page = await api(`/guilds/${p.guildId}/members?limit=100&after=${after}`);
  members.push(
    ...page
      .filter((m) => !m.user.bot && m.roles.includes(p.memberRoleId))
      .map((m) => ({ id: m.user.id, name: m.nick || m.user.global_name || m.user.username })),
  );
  after = page.length === 100 ? page.at(-1).user.id : null;
} while (after);
console.log(
  JSON.stringify(
    { memberRoleId: p.memberRoleId, members, count: members.length, maxMembers: p.maxMembers },
    null,
    2,
  ),
);
