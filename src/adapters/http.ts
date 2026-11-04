import { RemoteError } from '../core/types';
export class Http {
  calls = 0;
  constructor(private fetcher: typeof fetch = fetch) {}
  async request<T = any>(
    service: string,
    url: string,
    init: RequestInit = {},
    timeoutMs = 8_000,
  ): Promise<T> {
    if (++this.calls > 16) throw new RemoteError('budget', 429, 60);
    const method = init.method || 'GET';
    try {
      const res = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        const seconds = Number(res.headers.get('retry-after'));
        let body: any = {};
        try {
          body = await res.json();
        } catch {
          /* no payload logging */
        }
        throw new RemoteError(
          service,
          res.status,
          Math.max(1, seconds || Number(body.retry_after) || 60),
          method === 'POST' && (res.status >= 500 || res.status === 408),
        );
      }
      if (res.status === 204) return undefined as T;
      // Body timeout/parse failures must be treated as an uncertain write as well.
      return (await res.json()) as T;
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError(service, 0, 60, !['GET', 'HEAD'].includes(method));
    }
  }
}
