import type { CustomDomainProviderState, DomainVerificationChallenge } from '@tryggsignal/tenancy';

export interface VercelDomainProviderOptions {
  readonly token: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly fetchImpl?: typeof fetch | undefined;
}

interface VercelProjectDomain {
  readonly name: string;
  readonly apexName?: string;
  readonly projectId?: string;
  readonly verified: boolean;
  readonly verification?: readonly DomainVerificationChallenge[];
}

interface VercelDomainConfig {
  readonly misconfigured?: boolean;
}

export interface AddedVercelDomain {
  readonly providerDomainId: string;
  readonly verification: readonly DomainVerificationChallenge[];
  readonly verified: boolean;
}

export class VercelDomainProviderError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'VercelDomainProviderError';
  }
}

/**
 * P37 provider boundary. The rest of Tryggsignal never depends on Vercel's raw
 * response shapes or endpoints.
 */
export class VercelDomainProvider {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: VercelDomainProviderOptions) {
    this.fetcher = options.fetchImpl ?? fetch;
  }

  async add(hostname: string): Promise<AddedVercelDomain> {
    const data = await this.request<VercelProjectDomain>(
      `/v10/projects/${encodeURIComponent(this.options.projectId)}/domains`,
      {
        method: 'POST',
        body: JSON.stringify({ name: hostname }),
      },
    );

    return {
      providerDomainId: data.name,
      verified: data.verified,
      verification: data.verification ?? [],
    };
  }

  async verify(hostname: string): Promise<CustomDomainProviderState> {
    await this.request<VercelProjectDomain>(
      `/v9/projects/${encodeURIComponent(this.options.projectId)}/domains/${encodeURIComponent(hostname)}/verify`,
      { method: 'POST' },
    );
    return this.inspect(hostname);
  }

  async inspect(hostname: string): Promise<CustomDomainProviderState> {
    const [domain, config] = await Promise.all([
      this.request<VercelProjectDomain>(
        `/v9/projects/${encodeURIComponent(this.options.projectId)}/domains/${encodeURIComponent(hostname)}`,
      ),
      this.request<VercelDomainConfig>(`/v6/domains/${encodeURIComponent(hostname)}/config`),
    ]);

    const dnsStatus = config.misconfigured === true ? 'MISCONFIGURED' : 'OK';
    const tlsStatus =
      domain.verified && dnsStatus === 'OK' ? await this.probeTls(hostname) : 'PENDING';

    return {
      verified: domain.verified,
      dnsStatus,
      tlsStatus,
      verification: domain.verification ?? [],
      providerDomainId: domain.name,
    };
  }

  async remove(hostname: string): Promise<void> {
    await this.request<unknown>(
      `/v9/projects/${encodeURIComponent(this.options.projectId)}/domains/${encodeURIComponent(hostname)}`,
      { method: 'DELETE' },
    );
  }

  private async probeTls(hostname: string): Promise<'ISSUED' | 'PENDING'> {
    try {
      await this.fetcher(`https://${hostname}/`, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000),
      });
      return 'ISSUED';
    } catch {
      return 'PENDING';
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const separator = path.includes('?') ? '&' : '?';
    const response = await this.fetcher(
      `https://api.vercel.com${path}${separator}teamId=${encodeURIComponent(this.options.teamId)}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      },
    );

    if (!response.ok) {
      let message = `Vercel domain request failed with HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: { message?: string } };
        message = body.error?.message ?? message;
      } catch {
        // Keep the status-only message; never echo credentials or arbitrary HTML.
      }
      throw new VercelDomainProviderError(path, response.status, message);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
