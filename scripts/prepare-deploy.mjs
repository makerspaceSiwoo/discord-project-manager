import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const requiredSecrets = [
  'DISCORD_PUBLIC_KEY',
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_SECRET',
  'NOTION_TOKEN',
];
const optionalSecrets = ['NOTION_WEBHOOK_SECRET', 'WEBHOOK_SETUP_KEY'];
const requiredSettings = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_DATABASE_ID',
  'APP_ORIGIN',
  'DISCORD_APPLICATION_ID',
  ...requiredSecrets,
];

// Keep credentials out of exceptions, generated Wrangler config and console output.
export function prepareDeployment(base, env) {
  const missing = requiredSettings.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error('Missing GitHub settings: ' + missing.join(', '));
  if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID))
    throw new Error('Invalid CLOUDFLARE_ACCOUNT_ID');
  if (
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(env.CLOUDFLARE_DATABASE_ID) ||
    env.CLOUDFLARE_DATABASE_ID === '00000000-0000-0000-0000-000000000000'
  )
    throw new Error('Invalid CLOUDFLARE_DATABASE_ID');
  if (!/^\d{17,20}$/.test(env.DISCORD_APPLICATION_ID))
    throw new Error('Invalid DISCORD_APPLICATION_ID');
  if (!/^[a-f0-9]{64}$/i.test(env.DISCORD_PUBLIC_KEY))
    throw new Error('Invalid DISCORD_PUBLIC_KEY');

  let origin;
  try {
    origin = new URL(env.APP_ORIGIN);
  } catch {
    throw new Error('Invalid APP_ORIGIN: use an HTTPS origin without a path');
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
    !origin.hostname.includes('.')
  )
    throw new Error('Invalid APP_ORIGIN: use a public HTTPS origin without a path');

  const config = structuredClone(base);
  const db = config.d1_databases?.find((item) => item.binding === 'DB');
  if (!db || db.database_name !== 'project-manager')
    throw new Error('Expected D1 binding DB with database_name project-manager');
  config.account_id = env.CLOUDFLARE_ACCOUNT_ID;
  db.database_id = env.CLOUDFLARE_DATABASE_ID;
  config.vars = {
    ...config.vars,
    APP_ORIGIN: origin.origin,
    DISCORD_APPLICATION_ID: env.DISCORD_APPLICATION_ID,
  };

  const secrets = Object.fromEntries(
    [...requiredSecrets, ...optionalSecrets]
      .filter((name) => env[name]?.trim())
      .map((name) => [name, env[name]]),
  );
  return { config, secrets };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // wrangler.jsonc intentionally uses the JSON subset so no parser dependency is needed.
    const base = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
    const { config, secrets } = prepareDeployment(base, process.env);
    await mkdir('work', { recursive: true });
    await writeFile('.wrangler.deploy.json', JSON.stringify(config, null, 2) + '\n');
    await writeFile('work/deploy-secrets.json', JSON.stringify(secrets), { mode: 0o600 });
    console.log('Deployment settings validated; runtime secrets prepared (values hidden).');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
