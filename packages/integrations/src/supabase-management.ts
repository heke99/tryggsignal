export interface SupabaseManagementOptions {
  readonly accessToken: string;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface SupabaseProjectRequest {
  readonly name: string;
  readonly organizationSlug: string;
  readonly databasePassword: string;
  readonly region: 'americas' | 'emea' | 'apac';
}

export interface SupabaseProjectResult {
  readonly ref: string;
  readonly name: string;
  readonly organizationId?: string | undefined;
  readonly region?: string | undefined;
  readonly status?: string | undefined;
}

export interface SupabaseApiKey {
  readonly id?: string | undefined;
  readonly type?: string | undefined;
  readonly name?: string | undefined;
  readonly api_key?: string | undefined;
  readonly disabled?: boolean | undefined;
}

export interface SupabaseServiceHealth {
  readonly name?: string | undefined;
  readonly status?: string | undefined;
}

export class SupabaseManagementError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SupabaseManagementError';
  }
}

/**
 * P39 provider boundary for Supabase-for-Platforms provisioning. The control
 * plane never depends on raw Management API response shapes.
 */
export class SupabaseManagementProvider {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: SupabaseManagementOptions) {
    this.fetcher = options.fetchImpl ?? fetch;
  }

  async createProject(request: SupabaseProjectRequest): Promise<SupabaseProjectResult> {
    if (request.databasePassword.length < 32) {
      throw new Error('Each tenant database requires a unique high-entropy password.');
    }

    return this.request<SupabaseProjectResult>('/v1/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: request.name,
        organization_slug: request.organizationSlug,
        db_pass: request.databasePassword,
        region_selection: { type: 'smartGroup', code: request.region },
      }),
    });
  }

  async projectHealth(projectRef: string): Promise<readonly SupabaseServiceHealth[]> {
    const data = await this.request<unknown>(
      `/v1/projects/${encodeURIComponent(projectRef)}/health`,
    );
    if (Array.isArray(data)) return data as SupabaseServiceHealth[];
    if (data && typeof data === 'object' && 'services' in data) {
      const services = (data as { services?: unknown }).services;
      if (Array.isArray(services)) return services as SupabaseServiceHealth[];
    }
    return [];
  }

  async isHealthy(projectRef: string): Promise<boolean> {
    const services = await this.projectHealth(projectRef);
    return services.length > 0 && services.every((service) => service.status === 'ACTIVE_HEALTHY');
  }

  async apiKeys(projectRef: string): Promise<readonly SupabaseApiKey[]> {
    const data = await this.request<unknown>(
      `/v1/projects/${encodeURIComponent(projectRef)}/api-keys?reveal=true`,
    );
    if (Array.isArray(data)) return data as SupabaseApiKey[];
    return [];
  }

  async publishableKey(projectRef: string): Promise<string> {
    const keys = await this.apiKeys(projectRef);
    const key = keys.find(
      (candidate) =>
        candidate.disabled !== true &&
        (candidate.type === 'publishable' || candidate.name === 'publishable') &&
        typeof candidate.api_key === 'string',
    );
    if (key?.api_key === undefined) {
      throw new SupabaseManagementError(
        'api-keys',
        404,
        'No active publishable key is available.',
      );
    }
    return key.api_key;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`https://api.supabase.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      let message = `Supabase Management API request failed with HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { message?: string; error?: string };
        message = body.message ?? body.error ?? message;
      } catch {
        // Keep the status-only message. Never echo arbitrary response bodies.
      }
      throw new SupabaseManagementError(path, response.status, message);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
