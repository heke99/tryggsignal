/**
 * Masterplan 160: hostname normalization must happen before any tenant lookup.
 * The normalized form is the only value that may be matched against
 * `platform.tenant_domains.normalized_hostname`.
 */

export type HostnameError =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'INVALID_CHARACTERS'
  | 'INVALID_LABEL'
  | 'INVALID_PORT'
  | 'IP_LITERAL_NOT_ALLOWED';

export type HostnameResult =
  | { readonly ok: true; readonly hostname: string }
  | { readonly ok: false; readonly error: HostnameError };

const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Lowercase, strip port, strip a single trailing dot, reject IP literals and
 * anything that is not a valid DNS hostname. Unicode is converted with the
 * runtime's IDNA implementation via `URL`, so homograph input cannot smuggle a
 * different ASCII host past the lookup.
 */
export function normalizeHostname(rawHost: string | null | undefined): HostnameResult {
  if (rawHost == null) return { ok: false, error: 'EMPTY' };

  let host = rawHost.trim();
  if (host.length === 0) return { ok: false, error: 'EMPTY' };
  if (host.startsWith('[')) return { ok: false, error: 'IP_LITERAL_NOT_ALLOWED' };

  // Strip one explicit port, but reject ambiguous/double-port input. IPv6
  // literals are already refused above, so more than one colon is never valid.
  const colonCount = [...host].filter((character) => character === ':').length;
  if (colonCount > 1) return { ok: false, error: 'INVALID_PORT' };

  const portSeparator = host.lastIndexOf(':');
  if (portSeparator !== -1) {
    const port = host.slice(portSeparator + 1);
    if (!/^\d{1,5}$/.test(port)) return { ok: false, error: 'INVALID_PORT' };
    const numericPort = Number(port);
    if (numericPort < 1 || numericPort > 65535) return { ok: false, error: 'INVALID_PORT' };
    host = host.slice(0, portSeparator);
  }

  host = host.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0) return { ok: false, error: 'EMPTY' };
  if (host.includes('..')) return { ok: false, error: 'INVALID_LABEL' };

  // IDNA / punycode conversion. `URL` rejects hosts the platform cannot resolve.
  let ascii: string;
  try {
    ascii = new URL(`https://${host}`).hostname;
  } catch {
    return { ok: false, error: 'INVALID_CHARACTERS' };
  }
  if (ascii.endsWith('.')) ascii = ascii.slice(0, -1);

  if (ascii.length > MAX_HOSTNAME_LENGTH) return { ok: false, error: 'TOO_LONG' };
  if (IPV4_PATTERN.test(ascii)) return { ok: false, error: 'IP_LITERAL_NOT_ALLOWED' };

  const labels = ascii.split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
      return { ok: false, error: 'INVALID_LABEL' };
    }
    if (!LABEL_PATTERN.test(label)) return { ok: false, error: 'INVALID_CHARACTERS' };
  }

  return { ok: true, hostname: ascii };
}

/**
 * Masterplan 160: only forwarded-host information produced by trusted platform
 * infrastructure may be used. On Vercel the platform rewrites `host`, so `host`
 * is authoritative and `x-forwarded-host` is only consulted when the deployment
 * explicitly runs behind an additional trusted proxy.
 */
export interface RequestHostOptions {
  readonly trustForwardedHost: boolean;
}

export function requestHostname(
  headers: { get(name: string): string | null },
  options: RequestHostOptions,
): HostnameResult {
  const forwarded = options.trustForwardedHost ? headers.get('x-forwarded-host') : null;

  if (forwarded !== null) {
    // A trusted edge must hand us exactly one client-facing hostname. Accepting
    // comma-separated chains makes proxy interpretation ambiguous and enables
    // host-smuggling differences between layers.
    const parts = forwarded.split(',').map((part) => part.trim());
    if (parts.length !== 1 || parts[0] === '') {
      return { ok: false, error: 'INVALID_CHARACTERS' };
    }
    return normalizeHostname(parts[0]);
  }

  return normalizeHostname(headers.get('host'));
}
