const encoder = new TextEncoder();
export const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
export const hex = (s: string) => Uint8Array.from(s.match(/.{2}/g) || [], (b) => parseInt(b, 16));
export async function hash(s: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(s))), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
}
export async function discordSignature(
  body: string,
  signature: string | null,
  timestamp: string | null,
  key: string,
  at = Date.now(),
) {
  if (
    !signature ||
    !/^[a-f0-9]{128}$/i.test(signature) ||
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(at - Number(timestamp) * 1000) > 300_000 ||
    !/^[a-f0-9]{64}$/i.test(key)
  )
    return false;
  try {
    const publicKey = await crypto.subtle.importKey('raw', hex(key), { name: 'Ed25519' }, false, [
      'verify',
    ]);
    return await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      hex(signature),
      encoder.encode(timestamp + body),
    );
  } catch {
    return false;
  }
}
export async function notionSignature(body: string, signature: string | null, secret: string) {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, hex(signature.slice(7)), encoder.encode(body));
}
