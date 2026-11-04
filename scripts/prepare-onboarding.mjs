import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { seal } from './inspect-integrations.mjs';

export async function prepareOnboarding(env, fetcher = fetch) {
  for (const key of ['GUILD_ID', 'DISCORD_APPLICATION_ID'])
    if (!/^\d{17,20}$/.test(env[key] || '')) throw new Error('Invalid ' + key);
  for (const key of ['NOTION_ROOT_PAGE_ID', 'NOTION_SOURCE_ID'])
    if (!/^[a-f\d]{32}$/i.test((env[key] || '').replaceAll('-', '')))
      throw new Error('Invalid ' + key);
  if (!env.DISCORD_BOT_TOKEN || !env.NOTION_TOKEN) throw new Error('Missing credentials');
  const apply = env.APPLY === 'true';
  const api = async (service, path, method = 'GET', body) => {
    const discord = service === 'discord';
    const response = await fetcher(
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
    if (!response.ok) throw new Error(service + ' HTTP ' + response.status);
    return response.status === 204 ? null : response.json();
  };
  const title = 'discord-project-manager · 계정 인증';
  const probeTitle = '[봇 설정] 계정 연결 검증용';
  const rich = (text) => [{ type: 'text', text: { content: text } }];
  const guild = await api('discord', '/guilds/' + env.GUILD_ID);
  const bot = await api('discord', '/users/@me');
  if (bot.id !== env.DISCORD_APPLICATION_ID) throw new Error('Discord application mismatch');
  const root = await api('notion', '/pages/' + env.NOTION_ROOT_PAGE_ID);
  if (root.archived || root.in_trash) throw new Error('Root page is archived');
  const source = await api('notion', '/data_sources/' + env.NOTION_SOURCE_ID);
  const titleProperty = Object.values(source.properties).find((p) => p.type === 'title')?.name;
  const assignee = Object.values(source.properties).find(
    (p) => p.name === '담당자' && p.type === 'people',
  );
  if (!titleProperty || !assignee) throw new Error('Expected title and 담당자 People properties');
  const parentDb = await api('notion', '/databases/' + source.parent.database_id);
  if (
    (parentDb.parent?.page_id || '').replaceAll('-', '') !==
    env.NOTION_ROOT_PAGE_ID.replaceAll('-', '')
  )
    throw new Error('Data source is not under the selected root page');
  // Verify comment-read capability before creating anything.
  await api('notion', '/comments?block_id=' + env.NOTION_ROOT_PAGE_ID + '&page_size=1');
  const matchingPages = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const blocks = await api(
      'notion',
      '/blocks/' +
        env.NOTION_ROOT_PAGE_ID +
        '/children?page_size=100' +
        (cursor ? '&start_cursor=' + cursor : ''),
    );
    matchingPages.push(
      ...blocks.results.filter((b) => b.type === 'child_page' && b.child_page.title === title),
    );
    if (!blocks.has_more) break;
    if (page === 19) throw new Error('Root block list too large to determine existing setup');
    cursor = blocks.next_cursor;
  }
  const probes = await api('notion', '/data_sources/' + env.NOTION_SOURCE_ID + '/query', 'POST', {
    filter: { property: titleProperty, title: { equals: probeTitle } },
    page_size: 2,
  });
  if (matchingPages.length > 1 || probes.results.length > 1 || probes.has_more)
    throw new Error('Duplicate setup resources; inspect manually');
  let verification = matchingPages[0],
    probe = probes.results[0];
  const result = {
    applied: apply,
    guildId: guild.id,
    adminUserIds: [guild.owner_id],
    memberRoleId: '',
    verificationPageId: verification?.id || null,
    probePageId: probe?.id || null,
    plannedPages: [...(!verification ? [title] : []), ...(!probe ? [probeTitle] : [])],
    commands: [],
  };
  if (!apply) return result;
  if (!verification) {
    verification = await api('notion', '/pages', 'POST', {
      parent: { type: 'page_id', page_id: env.NOTION_ROOT_PAGE_ID },
      properties: { title: { title: rich(title) } },
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: rich(
              'Discord 계정 연결 화면에서 발급한 일회용 코드를 이 페이지의 새 댓글로 작성하세요. 작성 후 원래 브라우저로 돌아가 이름·이메일을 확인하고 연결합니다. 다른 사람의 코드는 입력하지 마세요.',
            ),
          },
        },
      ],
    });
    result.verificationPageId = verification.id;
  }
  if (!probe) {
    const properties = { [titleProperty]: { title: rich(probeTitle) } };
    const status = source.properties['상태'];
    if (status?.type === 'status' && status.status.options.some((o) => o.name === '중단'))
      properties['상태'] = { status: { name: '중단' } };
    probe = await api('notion', '/pages', 'POST', {
      parent: { type: 'data_source_id', data_source_id: env.NOTION_SOURCE_ID },
      properties,
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: rich(
              '실제 업무가 아닌 봇 계정 연결 검증용 행입니다. 본인 확인 시 담당자가 변경되며 주간 보고에서는 제외됩니다. 삭제하거나 일반 이슈로 사용하지 마세요.',
            ),
          },
        },
      ],
    });
    result.probePageId = probe.id;
  }
  const commands = JSON.parse(
    await readFile(new URL('../config/discord-commands.json', import.meta.url), 'utf8'),
  );
  const base =
    '/applications/' + env.DISCORD_APPLICATION_ID + '/guilds/' + env.GUILD_ID + '/commands';
  for (const command of commands) {
    const registered = await api('discord', base, 'POST', command);
    result.commands.push({ id: registered.id, name: registered.name });
  }
  // Remove only our superseded command, never bulk-replace other application commands.
  for (const command of await api('discord', base))
    if (
      command.type === 1 &&
      (command.name === '이슈생성' ||
        (command.name === 'create' &&
          command.options?.length === 1 &&
          command.options[0].name === 'issue'))
    )
      await api('discord', base + '/' + command.id, 'DELETE');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    seal({}, process.env.INSPECTION_PUBLIC_KEY);
    const result = await prepareOnboarding(process.env);
    await mkdir('work/onboarding', { recursive: true });
    await writeFile(
      'work/onboarding/result.encrypted.json',
      JSON.stringify(seal(result, process.env.INSPECTION_PUBLIC_KEY)),
    );
    console.log('Onboarding preparation complete. Result encrypted; no team messages sent.');
  } catch {
    console.error(
      'Onboarding stopped. Check API permissions and selected IDs. A failed create may have succeeded; inspect before retrying. No automatic retry was performed.',
    );
    process.exitCode = 1;
  }
}
