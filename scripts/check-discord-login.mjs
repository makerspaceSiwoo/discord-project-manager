import { pathToFileURL } from 'node:url';

// Never log API response bodies, tokens, credentials, or authorization codes.
export async function checkDiscordLogin(env, fetcher = fetch) {
  if (!/^\d{17,20}$/.test(env.DISCORD_APPLICATION_ID || '') || !env.DISCORD_CLIENT_SECRET)
    throw new Error('Required OAuth settings missing');
  const credentials = {
    client_id: env.DISCORD_APPLICATION_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
  };
  const request = (path, body) =>
    fetcher('https://discord.com/api/v10/oauth2/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(15000),
    });
  const response = await request('token', {
    ...credentials,
    grant_type: 'client_credentials',
    scope: 'applications.commands.update',
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    const known = ['invalid_client', 'invalid_request', 'invalid_scope', 'unauthorized_client'];
    return {
      ok: false,
      phase: 'client_credentials',
      status: response.status,
      reason: known.includes(body.error) ? body.error : 'unclassified',
    };
  }
  if (typeof body.access_token !== 'string' || !body.access_token)
    return {
      ok: false,
      phase: 'client_credentials',
      status: response.status,
      reason: 'invalid_response',
    };
  // This diagnostic token is never used to read user data or change commands.
  const revoked = await request('token/revoke', {
    ...credentials,
    token: body.access_token,
    token_type_hint: 'access_token',
  });
  return { ok: true, phase: 'client_credentials', status: response.status, revoked: revoked.ok };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkDiscordLogin(process.env);
    console.log(JSON.stringify(result));
    if (!result.ok || !result.revoked) process.exitCode = 1;
  } catch {
    console.error('OAuth check could not complete. No credential or response body was logged.');
    process.exitCode = 1;
  }
}
