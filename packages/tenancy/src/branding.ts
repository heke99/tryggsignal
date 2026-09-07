/**
 * Masterplan 152–154, 163, 164: white-label branding is a versioned set of design
 * tokens. A tenant supplies values, never CSS or JavaScript, and a theme cannot
 * be published until its contrast has been validated (WCAG 2.2 AA).
 */

export interface BrandingTokens {
  readonly displayName: string;
  readonly shortName?: string;
  readonly primaryColor: string;
  readonly secondaryColor?: string;
  readonly accentColor?: string;
  readonly surfaceVariant?: string;
  readonly locale: string;
  readonly showTryggsignalBranding: boolean;
  readonly supportEmail?: string;
  readonly privacyUrl?: string;
  readonly accessibilityStatementUrl?: string;
  readonly termsUrl?: string;
  readonly loginHeading?: string;
  readonly loginSubheading?: string;
}

const HEX = /^#[0-9a-f]{6}$/;

export type BrandingProblem =
  | { readonly kind: 'INVALID_COLOR'; readonly token: string; readonly value: string }
  | {
      readonly kind: 'INSUFFICIENT_CONTRAST';
      readonly token: string;
      readonly ratio: number;
      readonly required: number;
    }
  | { readonly kind: 'UNSAFE_URL'; readonly token: string; readonly value: string }
  | { readonly kind: 'MISSING'; readonly token: string };

export interface BrandingValidation {
  readonly valid: boolean;
  readonly problems: readonly BrandingProblem[];
  readonly contrast: Readonly<Record<string, number>>;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const channel = (value: number): number => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

/** Only http(s) links are accepted; a javascript: URL is an injection vector. */
function unsafeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol !== 'https:' && url.protocol !== 'http:';
  } catch {
    return true;
  }
}

const WHITE = '#ffffff';
const NEAR_BLACK = '#111827';

/**
 * Masterplan 154: the tenant theme is validated against the surfaces it will
 * actually be painted on — text on the primary colour, and the primary colour
 * used as text on a light surface (links, headings).
 */
export function validateBranding(tokens: Partial<BrandingTokens>): BrandingValidation {
  const problems: BrandingProblem[] = [];
  const contrast: Record<string, number> = {};

  if (!tokens.displayName || tokens.displayName.trim().length === 0) {
    problems.push({ kind: 'MISSING', token: 'displayName' });
  }
  if (!tokens.locale) problems.push({ kind: 'MISSING', token: 'locale' });

  const colorTokens: readonly (keyof BrandingTokens)[] = [
    'primaryColor',
    'secondaryColor',
    'accentColor',
    'surfaceVariant',
  ];

  for (const token of colorTokens) {
    const value = tokens[token];
    if (value === undefined) {
      if (token === 'primaryColor') problems.push({ kind: 'MISSING', token });
      continue;
    }
    if (typeof value !== 'string' || !HEX.test(value)) {
      problems.push({ kind: 'INVALID_COLOR', token, value: String(value) });
    }
  }

  const primary = tokens.primaryColor;
  if (typeof primary === 'string' && HEX.test(primary)) {
    const onPrimary = contrastRatio(WHITE, primary);
    contrast['whiteOnPrimary'] = onPrimary;
    if (onPrimary < 4.5) {
      problems.push({
        kind: 'INSUFFICIENT_CONTRAST',
        token: 'primaryColor',
        ratio: onPrimary,
        required: 4.5,
      });
    }

    const primaryOnSurface = contrastRatio(primary, WHITE);
    contrast['primaryOnWhite'] = primaryOnSurface;
    if (primaryOnSurface < 4.5) {
      problems.push({
        kind: 'INSUFFICIENT_CONTRAST',
        token: 'primaryColor',
        ratio: primaryOnSurface,
        required: 4.5,
      });
    }
  }

  const surface = tokens.surfaceVariant;
  if (typeof surface === 'string' && HEX.test(surface)) {
    const textOnSurface = contrastRatio(NEAR_BLACK, surface);
    contrast['textOnSurface'] = textOnSurface;
    if (textOnSurface < 4.5) {
      problems.push({
        kind: 'INSUFFICIENT_CONTRAST',
        token: 'surfaceVariant',
        ratio: textOnSurface,
        required: 4.5,
      });
    }
  }

  for (const token of ['privacyUrl', 'accessibilityStatementUrl', 'termsUrl'] as const) {
    const value = tokens[token];
    if (typeof value === 'string' && value.length > 0 && unsafeUrl(value)) {
      problems.push({ kind: 'UNSAFE_URL', token, value });
    }
  }

  return { valid: problems.length === 0, problems, contrast };
}

/**
 * Renders the validated tokens as CSS custom properties. Values are re-checked
 * here so a token that never passed validation cannot reach the page.
 */
export function brandingCssVariables(tokens: BrandingTokens): string {
  const declarations: string[] = [];
  const add = (name: string, value: string | undefined): void => {
    if (value !== undefined && HEX.test(value)) declarations.push(`${name}: ${value};`);
  };
  add('--ts-primary', tokens.primaryColor);
  add('--ts-secondary', tokens.secondaryColor);
  add('--ts-accent', tokens.accentColor);
  add('--ts-surface', tokens.surfaceVariant);
  return declarations.join(' ');
}
