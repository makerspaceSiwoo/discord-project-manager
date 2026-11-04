import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Keep native Worker fetch in the runtime test while avoiding real network traffic.
        outboundService: (request) => {
          const url = new URL(request.url);
          if (url.hostname !== 'http-fixture.test') return new Response(null, { status: 502 });
          return Response.json({ ok: true, method: request.method });
        },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          DISCORD_APPLICATION_ID: '99999',
          DISCORD_BOT_TOKEN: 'test-token',
          DISCORD_CLIENT_SECRET: 'test-secret',
          NOTION_TOKEN: 'test-notion',
          NOTION_WEBHOOK_SECRET: 'test-webhook',
        },
      },
    }),
  ],
  test: { include: ['tests/**/*.test.ts'], fileParallelism: false, testTimeout: 15000 },
});
