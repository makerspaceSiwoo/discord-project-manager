import { createCipheriv, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function seal(value, publicKey) {
  const key = randomBytes(32),
    iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    version: 1,
    key: publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      key,
    ).toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export async function inspect(env, fetcher = fetch) {
  if (!/^\d{17,20}$/.test(env.GUILD_ID || '')) throw new Error('Invalid GUILD_ID');
  if (!/^[a-f\d]{32}$/i.test((env.NOTION_PAGE_ID || '').replaceAll('-', '')))
    throw new Error('Invalid NOTION_PAGE_ID');
  if (!env.DISCORD_BOT_TOKEN || !env.NOTION_TOKEN) throw new Error('Missing API credentials');
  const report = { discord: {}, notion: { pages: [], databases: [], sources: [] }, errors: [] };
  const api = async (service, path, method = 'GET', body) => {
    const discord = service === 'discord';
    const r = await fetcher(
      (discord ? 'https://discord.com/api/v10' : 'https://api.notion.com/v1') + path,
      {
        method,
        headers: {
          Authorization:
            (discord ? 'Bot ' : 'Bearer ') + (discord ? env.DISCORD_BOT_TOKEN : env.NOTION_TOKEN),
          'Content-Type': 'application/json',
          ...(!discord ? { 'Notion-Version': '2026-03-11' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!r.ok) throw new Error(service + ' HTTP ' + r.status + ' at ' + path.split('?')[0]);
    return r.json();
  };
  const attempt = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      report.errors.push({ label, error: e.message });
    }
  };
  await attempt('discord', async () => {
    const guild = await api('discord', '/guilds/' + env.GUILD_ID);
    report.discord.guild = {
      id: guild.id,
      name: guild.name,
      owner_id: guild.owner_id,
      features: guild.features,
    };
    report.discord.roles = (await api('discord', '/guilds/' + env.GUILD_ID + '/roles')).map(
      ({ id, name, permissions, position, managed }) => ({
        id,
        name,
        permissions,
        position,
        managed,
      }),
    );
    report.discord.channels = (await api('discord', '/guilds/' + env.GUILD_ID + '/channels')).map(
      ({ id, name, type, parent_id, permission_overwrites, available_tags, flags }) => ({
        id,
        name,
        type,
        parent_id,
        permission_overwrites,
        available_tags,
        flags,
      }),
    );
    report.discord.members = [];
    let after = '0';
    for (let page = 0; page < 10; page++) {
      const rows = await api(
        'discord',
        '/guilds/' + env.GUILD_ID + '/members?limit=100&after=' + after,
      );
      report.discord.members.push(
        ...rows.map((m) => ({
          id: m.user.id,
          name: m.nick || m.user.global_name || m.user.username,
          bot: !!m.user.bot,
          roles: m.roles,
        })),
      );
      if (rows.length < 100) break;
      after = rows.at(-1).user.id;
      if (page === 9)
        report.errors.push({ label: 'members', error: 'Member list truncated at 1000' });
    }
  });
  await attempt('notion identity', async () => {
    const me = await api('notion', '/users/me');
    report.notion.identity = {
      id: me.id,
      name: me.name,
      type: me.type,
      workspace_id: me.bot?.workspace_id,
      workspace_name: me.bot?.workspace_name,
    };
  });
  const text = (rows = []) => rows.map((x) => x.plain_text || x.text?.content || '').join('');
  const queue = [env.NOTION_PAGE_ID],
    seen = new Set(),
    dbSeen = new Set();
  for (let count = 0; queue.length && count < 50; count++) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    await attempt('notion page ' + id, async () => {
      const page = await api('notion', '/pages/' + id);
      report.notion.pages.push({
        id: page.id,
        url: page.url,
        parent: page.parent,
        title: text(Object.values(page.properties || {}).find((x) => x.type === 'title')?.title),
      });
      let cursor;
      for (let batch = 0; batch < 10; batch++) {
        const blocks = await api(
          'notion',
          '/blocks/' + id + '/children?page_size=100' + (cursor ? '&start_cursor=' + cursor : ''),
        );
        for (const block of blocks.results) {
          if (block.type === 'child_page') queue.push(block.id);
          if (block.type === 'child_database' && !dbSeen.has(block.id)) {
            dbSeen.add(block.id);
            await attempt('notion database ' + block.id, async () => {
              const db = await api('notion', '/databases/' + block.id);
              report.notion.databases.push({
                id: db.id,
                title: text(db.title),
                parent: db.parent,
                data_sources: db.data_sources,
              });
              for (const source of db.data_sources || []) {
                const s = await api('notion', '/data_sources/' + source.id);
                report.notion.sources.push({
                  id: s.id,
                  title: text(s.title),
                  parent: s.parent,
                  properties: s.properties,
                });
              }
            });
          }
          // Layout containers can hold embedded databases; avoid reading task bodies.
          if (
            block.has_children &&
            ['column_list', 'column', 'toggle', 'synced_block'].includes(block.type)
          ) {
            const children = await api('notion', '/blocks/' + block.id + '/children?page_size=100');
            for (const child of children.results) {
              if (child.type === 'child_page') queue.push(child.id);
              if (child.type === 'child_database')
                report.notion.databases.push({
                  id: child.id,
                  title: child.child_database.title,
                  needsInspection: true,
                });
            }
          }
        }
        if (!blocks.has_more) break;
        cursor = blocks.next_cursor;
        if (batch === 9)
          report.errors.push({ label: 'notion blocks', error: 'Block list truncated' });
      }
    });
  }
  if (queue.length)
    report.errors.push({ label: 'notion pages', error: 'Page traversal truncated at 50' });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Validate encryption before fetching any private metadata.
    seal({}, process.env.INSPECTION_PUBLIC_KEY);
    const report = await inspect(process.env);
    await mkdir('work/inspection', { recursive: true });
    await writeFile(
      'work/inspection/report.encrypted.json',
      JSON.stringify(seal(report, process.env.INSPECTION_PUBLIC_KEY)),
    );
    console.log(
      'Inspection complete; encrypted metadata only. API errors: ' + report.errors.length,
    );
  } catch {
    console.error(
      'Inspection failed. Check credentials, IDs and encryption key; no private values logged.',
    );
    process.exitCode = 1;
  }
}
