import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCommands } from '../scripts/register-commands.mjs';
const env = {
  GUILD_ID: '1566617780843843795',
  DISCORD_APPLICATION_ID: '1567056733254324236',
  DISCORD_BOT_TOKEN: 'test-token',
};
test('registers and verifies named guild commands without replacing unrelated commands', async () => {
  const stored = [{ id: 'other', name: 'unrelated', type: 1 }];
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, method: init.method });
    if (url.endsWith('/users/@me')) return Response.json({ id: env.DISCORD_APPLICATION_ID });
    assert.equal(
      url,
      `https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.GUILD_ID}/commands`,
    );
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      const command = { ...body, id: body.name };
      const index = stored.findIndex((c) => c.name === body.name);
      if (index < 0) stored.push(command);
      else stored[index] = command;
      return Response.json(command);
    }
    assert.equal(init.method, 'GET');
    return Response.json(stored);
  };
  for (let i = 0; i < 2; i++) {
    const result = await registerCommands(env, fetcher);
    for (const name of ['주간보고', '일정투표', '투표결과'])
      assert.ok(result.some((c) => c.name === name));
  }
  assert.equal(stored.filter((c) => c.name === '주간보고').length, 1);
  assert.ok(stored.some((c) => c.name === 'unrelated'));
  assert.ok(calls.every((c) => ['POST', 'GET'].includes(c.method)));
});
test('invalid guild and mismatched bot stop command registration', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return Response.json({ id: 'wrong' });
  };
  await assert.rejects(registerCommands({ ...env, GUILD_ID: 'invalid' }, fetcher), /Invalid/);
  assert.equal(calls, 0);
  await assert.rejects(registerCommands(env, fetcher), /mismatch/);
  assert.equal(calls, 1);
});

test('honors Discord retry_after before retrying a rate-limited upsert', async () => {
  const stored = [];
  const waits = [];
  let limited = false;
  const fetcher = async (url, init) => {
    if (url.endsWith('/users/@me')) return Response.json({ id: env.DISCORD_APPLICATION_ID });
    if (init.method === 'POST') {
      if (!limited) {
        limited = true;
        return Response.json({ retry_after: 0.5 }, { status: 429 });
      }
      const command = { ...JSON.parse(init.body), id: 'registered' };
      stored.push(command);
      return Response.json(command);
    }
    return Response.json(stored);
  };
  const result = await registerCommands(env, fetcher, async (ms) => waits.push(ms));
  assert.deepEqual(waits, [750]);
  assert.ok(result.some((c) => c.name === '투표결과'));
});
