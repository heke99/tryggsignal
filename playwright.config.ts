import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests run against a real production build of `apps/platform-web`,
 * because the behaviour under test is the proxy — and the proxy only exists in a
 * built application (masterplan 201–205).
 *
 * Every host is served by the same server. Chromium is told to resolve the test
 * hostnames to localhost with `--host-resolver-rules`, so the request carries a
 * genuine `Host` header rather than one set by the test, which is exactly what
 * the proxy reads.
 */
const PORT = Number(process.env.E2E_PORT ?? 3410);

const HOSTS = [
  'tryggsignal.se',
  'www.tryggsignal.se',
  'app.tryggsignal.se',
  'kommuner.tryggsignal.se',
  'platform.tryggsignal.se',
  'admin.tryggsignal.se',
  'demokommun.tryggsignal.se',
  'mjolby.tryggsignal.se',
  'preview.vercel.app',
];

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: process.env.CI === 'true',
  retries: 0,
  reporter: process.env.CI === 'true' ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: `http://www.tryggsignal.se:${PORT}`,
    launchOptions: {
      args: [`--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`],
    },
  },
  webServer: {
    command: `pnpm --filter @tryggsignal/platform-web exec next start -p ${PORT}`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: 'production',
      NEXT_PUBLIC_ROOT_DOMAIN: 'tryggsignal.se',
      // Passed through when the runner has them, never stored here. Without a
      // control plane the directory resolves nothing, which is a valid
      // configuration and the one most of these tests exercise; with one, the
      // control-plane suite also runs. Keys belong in the environment, never in
      // the repository (masterplan 85).
      ...(process.env.CONTROL_PLANE_SUPABASE_URL === undefined
        ? {}
        : { CONTROL_PLANE_SUPABASE_URL: process.env.CONTROL_PLANE_SUPABASE_URL }),
      ...(process.env.CONTROL_PLANE_SUPABASE_PUBLISHABLE_KEY === undefined
        ? {}
        : {
            CONTROL_PLANE_SUPABASE_PUBLISHABLE_KEY:
              process.env.CONTROL_PLANE_SUPABASE_PUBLISHABLE_KEY,
          }),
    },
  },
});
