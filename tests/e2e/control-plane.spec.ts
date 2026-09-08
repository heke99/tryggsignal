import { expect, test } from '@playwright/test';

const PORT = process.env.E2E_PORT ?? '3410';
const at = (host: string, path = '/') => `http://${host}:${PORT}${path}`;

/**
 * Masterplan 158, 166: a hostname becomes a tenant context only after it matches
 * an ACTIVE domain of an ACTIVE tenant with a healthy deployment. Everything
 * else is refused.
 *
 * These run only when the runner has a control plane configured, because without
 * one the directory resolves nothing and the assertions would pass for the wrong
 * reason.
 */
const configured = process.env.CONTROL_PLANE_SUPABASE_URL !== undefined;

test.describe('control-plane resolution', () => {
  test.skip(!configured, 'CONTROL_PLANE_SUPABASE_URL is not set for this run');

  test('a registered but unverified domain is refused', async ({ page }) => {
    // `demokommun.tryggsignal.se` exists in platform.tenant_domains with
    // status PENDING and unverified ownership. A domain that is merely known
    // must not serve a municipality — that is the whole point of the
    // `domain_active_requires_verification` constraint.
    await page.goto(at('demokommun.tryggsignal.se'));
    await expect(page.locator('h1')).toContainText('Domänen är inte aktiverad');
  });

  test('the refusal names the reason without leaking tenant data', async ({ request }) => {
    const response = await request.get(`http://127.0.0.1:${PORT}/`, {
      headers: { host: 'demokommun.tryggsignal.se' },
    });
    const body = await response.text();
    expect(body).toContain('Domänen är inte aktiverad');
    // A refusal page must not disclose which tenant the hostname belongs to.
    expect(body).not.toContain('tenantId');
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
  });
});
