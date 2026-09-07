/**
 * Masterplan 85 + 99: environment validation with an explicit allow-list.
 * A secret may never be readable from a `NEXT_PUBLIC_*` variable.
 */

export interface EnvVarSpec {
  readonly name: string;
  readonly required: boolean;
  readonly public: boolean;
  readonly description: string;
  readonly pattern?: RegExp;
}

export const PLATFORM_ENV: readonly EnvVarSpec[] = [
  {
    name: 'NEXT_PUBLIC_ROOT_DOMAIN',
    required: true,
    public: true,
    description: 'Apex platform domain, e.g. tryggsignal.se',
    pattern: /^[a-z0-9.-]+$/,
  },
  {
    name: 'NEXT_PUBLIC_MARKETING_URL',
    required: false,
    public: true,
    description: 'Public marketing site URL',
  },
  {
    name: 'CONTROL_PLANE_SUPABASE_URL',
    required: true,
    public: false,
    description: 'Control-plane Supabase project URL',
    pattern: /^https:\/\//,
  },
  {
    name: 'CONTROL_PLANE_SUPABASE_PUBLISHABLE_KEY',
    required: true,
    public: false,
    description: 'Control-plane publishable (anon) key',
  },
  {
    name: 'CONTROL_PLANE_SECRET_REFERENCE',
    required: false,
    public: false,
    description: 'SecretProvider reference for the privileged control-plane credential',
  },
  {
    name: 'TRUST_FORWARDED_HOST',
    required: false,
    public: false,
    description: 'Set to "true" only when running behind an additional trusted proxy',
    pattern: /^(true|false)$/,
  },
];

/** Names that must never appear as a public variable, even by accident. */
const SECRET_MARKERS = [
  'SERVICE_ROLE',
  'SECRET',
  'PRIVATE_KEY',
  'PASSWORD',
  'TOKEN',
  'CLIENT_SECRET',
];

export class EnvValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid environment configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'EnvValidationError';
  }
}

export type Env = Readonly<Record<string, string>>;

export function validateEnv(
  source: Readonly<Record<string, string | undefined>>,
  specs: readonly EnvVarSpec[] = PLATFORM_ENV,
): Env {
  const problems: string[] = [];
  const result: Record<string, string> = {};

  for (const spec of specs) {
    const value = source[spec.name];
    if (value === undefined || value === '') {
      if (spec.required) problems.push(`${spec.name} is required (${spec.description})`);
      continue;
    }
    if (spec.pattern && !spec.pattern.test(value)) {
      problems.push(`${spec.name} does not match ${String(spec.pattern)}`);
      continue;
    }
    result[spec.name] = value;
  }

  for (const name of Object.keys(source)) {
    if (!name.startsWith('NEXT_PUBLIC_')) continue;
    const marker = SECRET_MARKERS.find((candidate) => name.includes(candidate));
    if (marker !== undefined) {
      problems.push(`${name} exposes a secret marker (${marker}) through a public variable`);
    }
  }

  if (problems.length > 0) throw new EnvValidationError(problems);
  return Object.freeze(result);
}
