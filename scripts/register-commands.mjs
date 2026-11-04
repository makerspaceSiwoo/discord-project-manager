import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function registerCommands(
  env,
  fetcher = fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  for (const key of ['GUILD_ID', 'DISCORD_APPLICATION_ID'])
    if (!/^\d{17,20}$/.test(env[key] || '')) throw new Error('Invalid ' + key);
  if (!env.DISCORD_BOT_TOKEN) throw new Error('Missing bot token');
  const commands = JSON.parse(
    await readFile(new URL('../config/discord-commands.json', import.meta.url), 'utf8'),
  );
  const api = async (path, method = 'GET', body) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await fetcher('https://discord.com/api/v10' + path, {
        method,
        headers: {
          Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
      });
      if (r.status === 429 && attempt < 4) {
        const info = await r.json().catch(() => ({}));
        const seconds = Number(info.retry_after ?? r.headers.get('retry-after') ?? 1);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60)
          throw new Error('Discord rate limit exceeds automatic retry window');
        await wait(Math.ceil(seconds * 1000) + 250);
        continue;
      }
      if (!r.ok) throw new Error('Discord HTTP ' + r.status);
      return r.status === 204 ? null : r.json();
    }
  };
  const bot = await api('/users/@me');
  if (bot.id !== env.DISCORD_APPLICATION_ID) throw new Error('Discord application mismatch');
  const path = `/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.GUILD_ID}/commands`;
  for (const command of commands) await api(path, 'POST', command);
  let registered = await api(path);
  for (const expected of commands)
    if (
      !registered.some(
        (c) =>
          c.name === expected.name &&
          c.type === expected.type &&
          (expected.options || []).every((option) =>
            c.options?.some((actual) => actual.name === option.name && actual.type === option.type),
          ),
      )
    )
      throw new Error('Command registration incomplete');
  // Remove only this application's replaced flat slash commands after validating their replacements.
  const obsolete = (c) =>
    c.type === 1 && !c.options?.length && ['주간보고', '일정투표', '투표결과'].includes(c.name);
  for (const command of registered.filter(obsolete)) await api(path + '/' + command.id, 'DELETE');
  registered = await api(path);
  if (registered.some(obsolete)) throw new Error('Obsolete commands remain');
  return registered
    .filter((c) => commands.some((wanted) => wanted.name === c.name))
    .map(({ id, name, options }) => ({
      id,
      name,
      subcommands: (options || []).filter((o) => o.type === 1).map((o) => o.name),
    }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await registerCommands(process.env)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
