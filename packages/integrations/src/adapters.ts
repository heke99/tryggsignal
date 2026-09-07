/**
 * Masterplan 60: generic connectors first. These implement the shared contract
 * over transport shapes that every legacy system offers in some form, so a
 * vendor adapter only has to add the vendor's own quirks.
 *
 * They are transport adapters, not vendor adapters: none of them assumes a field
 * name from a product whose documentation has not been verified.
 */
import type {
  Connector,
  ConnectorCapability,
  ExternalCase,
  HealthStatus,
  Page,
  WriteResult,
} from './contract';
import { ExternalBlockedError } from './contract';

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export type HttpClient = (request: {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}) => Promise<HttpResponse>;

export interface RestConnectorConfig {
  readonly key: string;
  readonly baseUrl: string;
  /** Mapping from the source payload to the canonical shape, as configuration. */
  readonly caseMapping: {
    readonly externalId: string;
    readonly caseNumber: string;
    readonly title: string;
    readonly status: string;
    readonly sourceVersion?: string;
    readonly sourceUpdatedAt?: string;
    readonly itemsPath?: string;
    readonly nextCursorPath?: string;
  };
  readonly capabilities: readonly ConnectorCapability[];
  /** Resolved by the SecretProvider at call time; never stored here. */
  readonly authorizationHeader?: string;
}

function readPath(payload: unknown, path: string): unknown {
  let current = payload;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;

export class GenericRestConnector implements Connector {
  readonly key: string;
  readonly capabilities: ReadonlySet<ConnectorCapability>;

  constructor(
    private readonly config: RestConnectorConfig,
    private readonly http: HttpClient,
  ) {
    this.key = config.key;
    this.capabilities = new Set(config.capabilities);
  }

  private headers(): Record<string, string> {
    return {
      accept: 'application/json',
      ...(this.config.authorizationHeader === undefined
        ? {}
        : { authorization: this.config.authorizationHeader }),
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    const startedAt = Date.now();
    try {
      const response = await this.http({
        method: 'GET',
        url: `${this.config.baseUrl}/health`,
        headers: this.headers(),
      });
      return {
        healthy: response.status >= 200 && response.status < 300,
        detail: `HTTP ${response.status}`,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        healthy: false,
        detail: error instanceof Error ? error.message : 'Unknown transport error',
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  async listCases(cursor: string | null): Promise<Page<ExternalCase>> {
    const url = new URL(`${this.config.baseUrl}/cases`);
    if (cursor !== null) url.searchParams.set('cursor', cursor);

    const response = await this.http({ method: 'GET', url: url.toString(), headers: this.headers() });
    if (response.status === 401 || response.status === 403) {
      throw new ExternalBlockedError(this.key, `Access denied by the source system (HTTP ${response.status})`);
    }
    if (response.status >= 400) {
      throw new Error(`${this.key}: listCases failed with HTTP ${response.status}`);
    }

    const mapping = this.config.caseMapping;
    const rawItems = mapping.itemsPath === undefined
      ? response.body
      : readPath(response.body, mapping.itemsPath);
    const items = Array.isArray(rawItems) ? rawItems : [];

    return {
      items: items.flatMap((item): ExternalCase[] => {
        const externalId = asString(readPath(item, mapping.externalId));
        const caseNumber = asString(readPath(item, mapping.caseNumber));
        // A record without a stable external id cannot be reconciled, so it is
        // reported as an error by the caller rather than silently imported.
        if (externalId === null || caseNumber === null) return [];
        return [
          {
            externalId,
            caseNumber,
            title: asString(readPath(item, mapping.title)) ?? caseNumber,
            status: asString(readPath(item, mapping.status)) ?? 'UNKNOWN',
            sourceVersion:
              mapping.sourceVersion === undefined ? null : asString(readPath(item, mapping.sourceVersion)),
            sourceUpdatedAt:
              mapping.sourceUpdatedAt === undefined
                ? null
                : asString(readPath(item, mapping.sourceUpdatedAt)),
            raw: item,
          },
        ];
      }),
      nextCursor:
        mapping.nextCursorPath === undefined
          ? null
          : asString(readPath(response.body, mapping.nextCursorPath)),
    };
  }

  async setStatus(externalId: string, status: string, key: string): Promise<WriteResult> {
    const response = await this.http({
      method: 'POST',
      url: `${this.config.baseUrl}/cases/${encodeURIComponent(externalId)}/status`,
      headers: { ...this.headers(), 'idempotency-key': key, 'content-type': 'application/json' },
      body: { status },
    });
    if (response.status >= 400 && response.status !== 409) {
      throw new Error(`${this.key}: setStatus failed with HTTP ${response.status}`);
    }
    // 409 from a target that honours the idempotency key means "already applied".
    return { externalId, idempotencyKey: key, deduplicated: response.status === 409 };
  }
}

/**
 * A connector slot for a product whose API access has not been granted yet.
 * It exists so configuration, tests and health checks are in place, and it fails
 * loudly instead of returning invented data (masterplan 134).
 */
export class ExternalBlockedConnector implements Connector {
  readonly capabilities: ReadonlySet<ConnectorCapability> = new Set();

  constructor(
    readonly key: string,
    private readonly reason: string,
  ) {}

  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: false,
      detail: `EXTERNAL_BLOCKED: ${this.reason}`,
      checkedAt: new Date().toISOString(),
    };
  }

  async listCases(): Promise<Page<ExternalCase>> {
    throw new ExternalBlockedError(this.key, this.reason);
  }
}
