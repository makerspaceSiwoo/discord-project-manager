import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareDeployment } from '../scripts/prepare-deploy.mjs';

const base = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const env = {
  CLOUDFLARE_API_TOKEN: 'fake-deployment-token',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_DATABASE_ID: '11111111-2222-3333-4444-555555555555',
  APP_ORIGIN: 'https://discord-project-manager.example.workers.dev/',
  DISCORD_APPLICATION_ID: '1567056733254324236',
  DISCORD_PUBLIC_KEY: 'b'.repeat(64),
  DISCORD_BOT_TOKEN: 'fake-bot-token',
  DISCORD_CLIENT_SECRET: 'literal-$token-"quoted"-\\value',
  NOTION_TOKEN: 'fake-notion-token',
};

test('maps deployment target without changing source config or including deployment credentials', () => {
  const before = structuredClone(base);
  const { config, secrets } = prepareDeployment(base, env);
  assert.deepEqual(base, before);
  assert.equal(config.account_id, env.CLOUDFLARE_ACCOUNT_ID);
  assert.equal(config.d1_databases[0].database_id, env.CLOUDFLARE_DATABASE_ID);
  assert.equal(config.d1_databases[0].database_name, 'project-manager');
  assert.equal(config.vars.APP_ORIGIN, env.APP_ORIGIN.slice(0, -1));
  assert.equal(config.vars.DISCORD_APPLICATION_ID, env.DISCORD_APPLICATION_ID);
  assert.equal(JSON.stringify(config).includes(env.DISCORD_BOT_TOKEN), false);
  assert.equal('CLOUDFLARE_API_TOKEN' in secrets, false);
  assert.equal('CLOUDFLARE_ACCOUNT_ID' in secrets, false);
  assert.equal(secrets.DISCORD_CLIENT_SECRET, env.DISCORD_CLIENT_SECRET);
  assert.equal('NOTION_WEBHOOK_SECRET' in secrets, false);
});

test('includes optional webhook secrets only when provided, preserving literal values', () => {
  const { secrets } = prepareDeployment(base, { ...env, NOTION_WEBHOOK_SECRET: 'literal-$key' });
  assert.equal(secrets.NOTION_WEBHOOK_SECRET, 'literal-$key');
  assert.equal('WEBHOOK_SETUP_KEY' in secrets, false);
});

test('fails before deployment when any required input is missing and never prints values', () => {
  for (const name of Object.keys(env)) {
    assert.throws(
      () => prepareDeployment(base, { ...env, [name]: '' }),
      (error) => {
        assert.match(error.message, new RegExp(name));
        assert.equal(error.message.includes(env.DISCORD_BOT_TOKEN), false);
        return true;
      },
    );
  }
});

test('rejects malformed IDs and unsafe origins', () => {
  const invalid = {
    CLOUDFLARE_ACCOUNT_ID: ['not-an-id'],
    CLOUDFLARE_DATABASE_ID: ['00000000-0000-0000-0000-000000000000', 'not-an-id'],
    DISCORD_APPLICATION_ID: ['123'],
    DISCORD_PUBLIC_KEY: ['not-a-public-key'],
    APP_ORIGIN: [
      'not-a-url',
      'http://example.com',
      'https://localhost',
      'https://127.0.0.1',
      'https://example.com/path',
      'https://example.com/?x=1',
      'https://example.com/#hash',
      'https://user:password@example.com',
    ],
  };
  for (const [name, values] of Object.entries(invalid))
    for (const value of values)
      assert.throws(() => prepareDeployment(base, { ...env, [name]: value }), new RegExp(name));
});

test('refuses a misnamed DB binding', () => {
  const wrong = structuredClone(base);
  wrong.d1_databases[0].database_name = 'yeonsuri';
  assert.throws(() => prepareDeployment(wrong, env), /project-manager/);
});
