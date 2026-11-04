import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDiscordLogin } from '../scripts/check-discord-login.mjs';
const env = { DISCORD_APPLICATION_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'secret-value' };
test('OAuth check revokes its token and returns no secrets', async () => {
  const calls = [];
  const result = await checkDiscordLogin(env, async (url, init) => {
    calls.push({ url, body: new URLSearchParams(init.body) });
    return calls.length === 1
      ? Response.json({ access_token: 'private-token' })
      : new Response(null, { status: 200 });
  });
  assert.equal(result.ok, true);
  assert.equal(result.revoked, true);
  assert.equal(calls[1].body.get('token'), 'private-token');
  assert.equal(calls[1].url.endsWith('/token/revoke'), true);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});
test('OAuth check allowlists error codes and excludes raw error descriptions', async () => {
  for (const error of ['invalid_client', 'secret-value']) {
    const result = await checkDiscordLogin(env, async () =>
      Response.json({ error, error_description: 'secret-value' }, { status: 401 }),
    );
    assert.equal(result.reason, error === 'invalid_client' ? error : 'unclassified');
    assert.equal(JSON.stringify(result).includes('secret-value'), false);
  }
});
