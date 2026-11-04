import { readFile } from 'node:fs/promises';
const p = JSON.parse(await readFile(process.argv[2] || 'config/project.local.json', 'utf8'));
if (!process.env.NOTION_TOKEN) throw new Error('NOTION_TOKEN 환경변수 필요');
const r = await fetch(`https://api.notion.com/v1/data_sources/${p.notion.dataSourceId}`, {
  headers: { Authorization: 'Bearer ' + process.env.NOTION_TOKEN, 'Notion-Version': '2026-03-11' },
});
if (!r.ok) throw new Error(`Notion HTTP ${r.status}`);
const source = await r.json();
const expected = {
  taskId: ['unique_id', 'rich_text'],
  title: ['title'],
  due: ['date'],
  assignees: ['people'],
  type: ['select'],
  priority: ['select'],
  status: [p.notion.statusType],
  created: ['created_time'],
  parent: ['relation'],
  children: ['relation'],
  discord: ['url'],
};
let errors = 0;
for (const [key, types] of Object.entries(expected)) {
  const name = p.notion.properties[key],
    prop = source.properties[name],
    ok = prop && types.includes(prop.type);
  if (!ok) errors++;
  console.log(
    `${ok ? 'OK' : 'FAIL'} ${key} → ${name}: ${prop?.type || '없음'} (필요: ${types.join('/')})`,
  );
}
console.log(
  '읽기 전용입니다. 기존 DB를 변경하지 않았습니다. 상세 옵션/관계는 관리자 웹 진단으로 확인하세요.',
);
process.exitCode = errors ? 1 : 0;
