import { expect, test } from '@playwright/test';

const PORT = process.env.E2E_PORT ?? '3410';
const at = (host: string, path = '/') => `http://${host}:${PORT}${path}`;

/**
 * Masterplan 157–159, 177, 201–205. These assertions are the reason the suite
 * exists: the proxy is the only thing standing between a hostname and a
 * municipality's data, and it is invisible to unit tests.
 */
test.describe('hostname routing', () => {
  test('the apex and www serve the public site', async ({ page }) => {
    for (const host of ['tryggsignal.se', 'www.tryggsignal.se']) {
      await page.goto(at(host));
      await expect(page.locator('h1').first()).toContainText('Bygglov, tillsyn och OVK');
    }
  });

  test('app and kommuner serve their own platform surfaces', async ({ page }) => {
    await page.goto(at('app.tryggsignal.se'));
    await expect(page.locator('h1')).toContainText('Välj kommun');

    await page.goto(at('kommuner.tryggsignal.se'));
    await expect(page.locator('h1')).toBeVisible();
  });

  test('platform and admin both reach the platform surface', async ({ page }) => {
    for (const host of ['platform.tryggsignal.se', 'admin.tryggsignal.se']) {
      await page.goto(at(host));
      await expect(page.locator('h1')).toBeVisible();
    }
  });

  test('a preview host serves the gateway, never a tenant', async ({ page }) => {
    await page.goto(at('preview.vercel.app'));
    await expect(page.locator('h1')).toContainText('Välj kommun');
  });

  test('an unknown subdomain is refused, not guessed', async ({ page }) => {
    await page.goto(at('mjolby.tryggsignal.se'));
    await expect(page.locator('h1')).toContainText('Domänen är inte aktiverad');
  });

  test('a tenant path is not reachable from a platform host', async ({ page }) => {
    const response = await page.goto(at('app.tryggsignal.se', '/t/demokommun/handlaggning'));
    // The gateway surface has no such route; what must never happen is a
    // municipality workspace rendering here.
    expect(await page.locator('body').innerText()).not.toContain('Handläggning');
    expect(response?.status()).toBeLessThan(500);
  });
});

test.describe('platform isolation (masterplan 177)', () => {
  test('/platform is not reachable from a tenant host', async ({ page }) => {
    await page.goto(at('demokommun.tryggsignal.se', '/platform'));
    await expect(page.locator('h1')).toContainText('Domänen är inte aktiverad');
  });
});

/**
 * These go through the API request context rather than the browser, because the
 * browser refuses to let a page set `Host` — and setting `Host` by hand is
 * exactly how an attacker would try to pick a tenant. The API context reaches
 * the server directly, so the URL is the loopback address and the hostname
 * travels in the header, the way it arrives from a real edge.
 */
const direct = (path = '/') => `http://127.0.0.1:${PORT}${path}`;

test.describe('header spoofing (masterplan 160)', () => {
  test('an inbound x-ts-* header cannot choose a tenant', async ({ request }) => {
    const response = await request.get(direct(), {
      headers: {
        host: 'mjolby.tryggsignal.se',
        'x-ts-tenant-slug': 'demokommun',
        'x-ts-tenant-id': '00000000-0000-4000-8000-000000000000',
        'x-ts-hostname': 'demokommun.tryggsignal.se',
      },
    });
    expect(await response.text()).toContain('Domänen är inte aktiverad');
  });

  test('x-forwarded-host is ignored unless the deployment opts in', async ({ request }) => {
    const response = await request.get(direct(), {
      headers: { host: 'mjolby.tryggsignal.se', 'x-forwarded-host': 'www.tryggsignal.se' },
    });
    expect(await response.text()).toContain('Domänen är inte aktiverad');
  });
});

test.describe('security headers (masterplan 200)', () => {
  test('every response carries the domain security headers', async ({ request }) => {
    const response = await request.get(direct(), {
      headers: { host: 'www.tryggsignal.se' },
    });
    const headers = response.headers();
    expect(headers['strict-transport-security']).toContain('max-age=63072000');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(headers['permissions-policy']).toContain('camera=()');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['x-powered-by']).toBeUndefined();
  });
});
