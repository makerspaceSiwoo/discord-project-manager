import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareOnboarding } from '../scripts/prepare-onboarding.mjs';
const env = {
  GUILD_ID: '123456789012345678',
  DISCORD_APPLICATION_ID: '223456789012345678',
  NOTION_ROOT_PAGE_ID: '1'.repeat(32),
  NOTION_SOURCE_ID: '2'.repeat(32),
  DISCORD_BOT_TOKEN: 'fake',
  NOTION_TOKEN: 'fake',
};
function fixture(duplicate = false) {
  const mutations = [],
    created = { verification: false, probe: false };
  const fetcher = async (url, init) => {
    const u = new URL(url),
      body = init.body ? JSON.parse(init.body) : {};
    let result;
    if (init.method !== 'GET' && !u.pathname.endsWith('/query'))
      mutations.push({ path: u.pathname, method: init.method, body });
    if (u.pathname.includes('/guilds/') && !u.pathname.includes('/commands'))
      result = { id: env.GUILD_ID, owner_id: 'owner' };
    else if (u.pathname.endsWith('/users/@me')) result = { id: env.DISCORD_APPLICATION_ID };
    else if (u.pathname === '/v1/pages/' + env.NOTION_ROOT_PAGE_ID)
      result = { id: env.NOTION_ROOT_PAGE_ID };
    else if (u.pathname.includes('/data_sources/') && !u.pathname.endsWith('/query'))
      result = {
        parent: { database_id: 'database' },
        properties: {
          이름: { name: '이름', type: 'title' },
          담당자: { name: '담당자', type: 'people' },
        },
      };
    else if (u.pathname === '/v1/databases/database')
      result = { parent: { page_id: env.NOTION_ROOT_PAGE_ID } };
    else if (u.pathname === '/v1/comments') result = { results: [] };
    else if (u.pathname.endsWith('/children'))
      result = {
        results: created.verification
          ? [
              {
                id: 'verification',
                type: 'child_page',
                child_page: { title: 'discord-project-manager · 계정 인증' },
              },
            ]
          : [],
        has_more: false,
      };
    else if (u.pathname.endsWith('/query'))
      result = {
        results: duplicate ? [{ id: 'a' }, { id: 'b' }] : created.probe ? [{ id: 'probe' }] : [],
        has_more: false,
      };
    else if (u.pathname === '/v1/pages' && init.method === 'POST') {
      const key = body.parent.type === 'page_id' ? 'verification' : 'probe';
      created[key] = true;
      result = { id: key };
    } else if (u.pathname.endsWith('/commands'))
      result = init.method === 'POST' ? { id: body.name, name: body.name } : [];
    else throw new Error('Unexpected API call');
    return Response.json(result);
  };
  return { fetcher, mutations };
}
test('onboarding dry-run makes no resource writes', async () => {
  const f = fixture();
  const result = await prepareOnboarding(env, f.fetcher);
  assert.equal(result.applied, false);
  assert.equal(result.plannedPages.length, 2);
  assert.equal(f.mutations.length, 0);
});
test('applying twice reuses dedicated pages and only upserts our commands', async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const result = await prepareOnboarding({ ...env, APPLY: 'true' }, f.fetcher);
    assert.equal(result.verificationPageId, 'verification');
    assert.equal(result.probePageId, 'probe');
    assert.equal(
      result.commands.some((c) => c.name === '이슈'),
      true,
    );
  }
  assert.equal(f.mutations.filter((x) => x.path === '/v1/pages').length, 2);
  assert.equal(
    f.mutations.some((x) => x.path.includes('/messages') || x.path.includes('/roles')),
    false,
  );
});
test('ambiguous existing probe rows stop all writes', async () => {
  const f = fixture(true);
  await assert.rejects(prepareOnboarding({ ...env, APPLY: 'true' }, f.fetcher), /Duplicate/);
  assert.equal(f.mutations.length, 0);
});
