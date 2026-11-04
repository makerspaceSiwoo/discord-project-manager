import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from 'node:crypto';
import { seal, inspect } from '../scripts/inspect-integrations.mjs';
test('inspection artifact requires private key and detects tampering', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const value = { member: 'private member name' };
  const sealed = seal(value, pair.publicKey);
  assert.equal(JSON.stringify(sealed).includes(value.member), false);
  const key = privateDecrypt(
    { key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(sealed.key, 'base64'),
  );
  const decode = (data) => {
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    cipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString());
  };
  const data = Buffer.from(sealed.data, 'base64');
  assert.deepEqual(decode(data), value);
  data[0] ^= 1;
  assert.throws(() => decode(data));
});
test('invalid target IDs cannot make network requests', async () => {
  let called = false;
  await assert.rejects(
    inspect({ GUILD_ID: '../bad' }, async () => {
      called = true;
    }),
    /GUILD_ID/,
  );
  assert.equal(called, false);
});
test('API errors are recorded without response bodies or credentials', async () => {
  const report = await inspect(
    {
      GUILD_ID: '1566617780843843795',
      NOTION_PAGE_ID: '40cd4978f45a80868400fb62dc511101',
      DISCORD_BOT_TOKEN: 'secret-discord',
      NOTION_TOKEN: 'secret-notion',
    },
    async () => ({
      ok: false,
      status: 403,
      json: () => {
        throw new Error('must not read error body');
      },
    }),
  );
  assert.equal(report.errors.length, 3);
  assert.equal(JSON.stringify(report).includes('secret-'), false);
});
