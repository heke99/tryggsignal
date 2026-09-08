import { expect, test } from '@playwright/test';

const PORT = process.env.E2E_PORT ?? '3410';
const at = (host: string, path = '/') => `http://${host}:${PORT}${path}`;

/**
 * Masterplan 97: accessible by construction. These are the structural checks a
 * screen-reader user depends on and that regress silently.
 */
test.describe('accessibility structure', () => {
  test('the public site has one h1, a language and a working skip link', async ({ page }) => {
    await page.goto(at('www.tryggsignal.se'));

    await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
    await expect(page.locator('h1')).toHaveCount(1);

    // The skip link is the first thing keyboard focus reaches, it becomes
    // visible when focused, and — the part that regresses silently — its target
    // actually exists and sits past the navigation.
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toHaveAttribute('href', '#innehall');
    await expect(focused).toBeVisible();

    const target = page.locator('#innehall');
    await expect(target).toHaveCount(1);
    await expect(target.locator('nav')).toHaveCount(0);
  });

  test('headings descend without skipping a level', async ({ page }) => {
    await page.goto(at('www.tryggsignal.se'));
    const levels = await page
      .locator('h1, h2, h3, h4, h5, h6')
      .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName.slice(1))));

    expect(levels[0]).toBe(1);
    for (let index = 1; index < levels.length; index += 1) {
      expect(levels[index]! - levels[index - 1]!).toBeLessThanOrEqual(1);
    }
  });

  test('every link has an accessible name', async ({ page }) => {
    await page.goto(at('www.tryggsignal.se'));
    const unnamed = await page.locator('a').evaluateAll((nodes) =>
      nodes
        .filter((node) => {
          const label = (node.textContent ?? '').trim() || node.getAttribute('aria-label') || '';
          return label.length === 0;
        })
        .map((node) => node.getAttribute('href') ?? '(no href)'),
    );
    expect(unnamed).toEqual([]);
  });
});
