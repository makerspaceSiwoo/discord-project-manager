import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function registerCommands(env, fetcher = fetch) {
  for (const key of ['GUILD_ID', 'DISCORD_APPLICATION_ID'])
    if (!/^\d{17,20}$/.test(env[key] || '')) throw new Error('Invalid ' + key);
  if (!env.DISCORD_BOT_TOKEN) throw new Error('Missing bot token');
  const commands = JSON.parse(
    await readFile(new URL('../config/discord-commands.json', import.meta.url), 'utf8'),
  );
  const api = async (path, method = 'GET', body) => {
    const r = await fetcher('https://discord.com/api/v10' + path, {
      method,
      headers: {
        Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error('Discord HTTP ' + r.status);
    return r.json();
  };
  const bot = await api('/users/@me');
  if (bot.id !== env.DISCORD_APPLICATION_ID) throw new Error('Discord application mismatch');
  const path = `/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.GUILD_ID}/commands`;
  for (const command of commands) await api(path, 'POST', command);
  const registered = await api(path);
  for (const expected of commands)
    if (!registered.some((c) => c.name === expected.name && c.type === expected.type))
      throw new Error('Command registration incomplete');
  return registered
    .filter((c) => commands.some((wanted) => wanted.name === c.name))
    .map(({ id, name }) => ({ id, name }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await registerCommands(process.env)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
