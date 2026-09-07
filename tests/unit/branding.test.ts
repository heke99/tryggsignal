import { describe, expect, it } from 'vitest';
import { brandingCssVariables, contrastRatio, validateBranding } from '@tryggsignal/tenancy';

const base = {
  displayName: 'Mjölby kommun',
  primaryColor: '#14532d',
  locale: 'sv-SE',
  showTryggsignalBranding: true,
};

describe('branding validation (masterplan 152–154)', () => {
  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBe(21);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
  });

  it('accepts a theme that passes AA on both surfaces', () => {
    const result = validateBranding(base);
    expect(result.valid).toBe(true);
    expect(result.contrast['whiteOnPrimary']).toBeGreaterThanOrEqual(4.5);
  });

  it('rejects a primary colour that fails contrast', () => {
    const result = validateBranding({ ...base, primaryColor: '#ffe066' });
    expect(result.valid).toBe(false);
    expect(result.problems.some((p) => p.kind === 'INSUFFICIENT_CONTRAST')).toBe(true);
  });

  it('rejects a colour that is not a hex token', () => {
    const result = validateBranding({ ...base, accentColor: 'red; }</style><script>' });
    expect(result.problems).toContainEqual(
      expect.objectContaining({ kind: 'INVALID_COLOR', token: 'accentColor' }),
    );
  });

  it('rejects a javascript: link', () => {
    const result = validateBranding({ ...base, privacyUrl: 'javascript:alert(1)' });
    expect(result.problems).toContainEqual(
      expect.objectContaining({ kind: 'UNSAFE_URL', token: 'privacyUrl' }),
    );
  });

  it('requires a display name and locale', () => {
    const result = validateBranding({ primaryColor: '#14532d' });
    expect(result.problems.filter((p) => p.kind === 'MISSING')).toHaveLength(2);
  });

  it('emits only validated hex values as CSS variables', () => {
    const css = brandingCssVariables({
      ...base,
      accentColor: 'not-a-color' as unknown as string,
      secondaryColor: '#1f2937',
    });
    expect(css).toContain('--ts-primary: #14532d;');
    expect(css).toContain('--ts-secondary: #1f2937;');
    expect(css).not.toContain('not-a-color');
  });
});
