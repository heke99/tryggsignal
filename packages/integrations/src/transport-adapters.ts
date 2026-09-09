import { posix as path } from 'node:path';
import type { Connector, ConnectorCapability, ExternalCase, HealthStatus, Page } from './contract';
import { assertCapability, ExternalBlockedError } from './contract';
import { asString, mapExternalCaseItems, readPath, sourceHash, type CaseMapping } from './mapping';
import { idempotencyKey } from './idempotency';

export interface FileEntry {
  readonly path: string;
  readonly sizeBytes?: number;
  readonly modifiedAt?: string;
}

export interface FilePage {
  readonly items: readonly FileEntry[];
  readonly nextCursor: string | null;
}

export interface FileSource {
  healthCheck(): Promise<HealthStatus>;
  list(cursor: string | null): Promise<FilePage>;
  read(path: string): Promise<string | Uint8Array>;
}

export type GenericFileFormat = 'JSON_ARRAY' | 'JSONL' | 'CSV';

export interface GenericFileConnectorConfig {
  readonly key: string;
  readonly format: GenericFileFormat;
  readonly caseMapping: CaseMapping;
  readonly capabilities: readonly ConnectorCapability[];
  readonly csvDelimiter?: string;
}

function decode(input: string | Uint8Array): string {
  return typeof input === 'string'
    ? input
    : new TextDecoder('utf-8', { fatal: true }).decode(input);
}

function parseCsvLine(line: string, delimiter: string): readonly string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === delimiter && !quoted) {
      values.push(value);
      value = '';
      continue;
    }
    value += character;
  }

  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  values.push(value);
  return values;
}

function parseCsv(text: string, delimiter: string): readonly Record<string, string>[] {
  if (delimiter.length !== 1) throw new Error('CSV delimiter must be exactly one character');
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0] ?? '', delimiter).map((header) => header.trim());
  if (headers.some((header) => header.length === 0))
    throw new Error('CSV contains an empty header');
  if (new Set(headers).size !== headers.length) throw new Error('CSV contains duplicate headers');

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line, delimiter);
    if (values.length !== headers.length) {
      throw new Error('CSV row column count does not match the header');
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

function parseFilePayload(
  input: string | Uint8Array,
  format: GenericFileFormat,
  delimiter: string,
): unknown {
  const text = decode(input);
  switch (format) {
    case 'JSON_ARRAY': {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('JSON_ARRAY source must contain a JSON array');
      return parsed;
    }
    case 'JSONL':
      return text
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as unknown);
    case 'CSV':
      return parseCsv(text, delimiter);
  }
}

export class GenericFileConnector implements Connector {
  readonly key: string;
  readonly capabilities: ReadonlySet<ConnectorCapability>;

  constructor(
    private readonly config: GenericFileConnectorConfig,
    private readonly source: FileSource,
  ) {
    if (config.capabilities.some((capability) => capability !== 'listCases')) {
      throw new Error('Generic file connector currently implements only listCases');
    }
    this.key = config.key;
    this.capabilities = new Set(config.capabilities);
  }

  healthCheck(): Promise<HealthStatus> {
    return this.source.healthCheck();
  }

  async listCases(cursor: string | null): Promise<Page<ExternalCase>> {
    assertCapability(this, 'listCases');
    const page = await this.source.list(cursor);
    const items: ExternalCase[] = [];

    for (const entry of page.items) {
      const raw = await this.source.read(entry.path);
      const payload = parseFilePayload(raw, this.config.format, this.config.csvDelimiter ?? ',');
      items.push(...mapExternalCaseItems(payload, this.config.caseMapping));
    }

    return { items, nextCursor: page.nextCursor };
  }
}

export interface SftpClient {
  healthCheck(): Promise<HealthStatus>;
  list(remoteDirectory: string, cursor: string | null): Promise<FilePage>;
  read(remotePath: string): Promise<string | Uint8Array>;
}

export interface GenericSftpConnectorConfig extends Omit<GenericFileConnectorConfig, 'key'> {
  readonly key: string;
  readonly remoteDirectory: string;
}

function assertRemotePath(remoteDirectory: string, candidate: string): string {
  const base = path.normalize('/' + remoteDirectory.replace(/^\/+/, '')).replace(/\/$/, '') || '/';
  const normalized = path.normalize('/' + candidate.replace(/^\/+/, ''));
  const allowed =
    base === '/'
      ? normalized.startsWith('/')
      : normalized === base || normalized.startsWith(base + '/');
  if (!allowed) {
    throw new Error('SFTP source returned a path outside the configured remote directory');
  }
  return normalized;
}

export class GenericSftpConnector implements Connector {
  readonly key: string;
  readonly capabilities: ReadonlySet<ConnectorCapability>;
  private readonly fileConnector: GenericFileConnector;

  constructor(config: GenericSftpConnectorConfig, client: SftpClient) {
    this.key = config.key;
    this.capabilities = new Set(config.capabilities);
    const source: FileSource = {
      healthCheck: () => client.healthCheck(),
      list: async (cursor) => {
        const page = await client.list(config.remoteDirectory, cursor);
        return {
          ...page,
          items: page.items.map((entry) => ({
            ...entry,
            path: assertRemotePath(config.remoteDirectory, entry.path),
          })),
        };
      },
      read: (remotePath) => client.read(assertRemotePath(config.remoteDirectory, remotePath)),
    };
    this.fileConnector = new GenericFileConnector(
      {
        key: config.key,
        format: config.format,
        caseMapping: config.caseMapping,
        capabilities: config.capabilities,
        ...(config.csvDelimiter === undefined ? {} : { csvDelimiter: config.csvDelimiter }),
      },
      source,
    );
  }

  healthCheck(): Promise<HealthStatus> {
    return this.fileConnector.healthCheck();
  }

  listCases(cursor: string | null): Promise<Page<ExternalCase>> {
    return this.fileConnector.listCases(cursor);
  }
}

export interface SqlReadClient {
  healthCheck(): Promise<HealthStatus>;
  query(
    statement: string,
    parameters: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
}

export interface GenericSqlReadConnectorConfig {
  readonly key: string;
  readonly select: string;
  readonly caseMapping: CaseMapping;
  readonly capabilities: readonly ConnectorCapability[];
  readonly pageSize?: number;
}

function validateReadOnlySelect(statement: string): string {
  const normalized = statement.trim().replace(/;+\s*$/, '');
  if (!/^select\b/i.test(normalized)) {
    throw new Error('Generic SQL adapter accepts only a SELECT statement');
  }
  if (normalized.includes(';')) {
    throw new Error('Generic SQL adapter accepts exactly one SQL statement');
  }
  if (
    /\b(insert|update|delete|merge|drop|alter|truncate|create|grant|revoke|copy|call|do|execute)\b/i.test(
      normalized,
    )
  ) {
    throw new Error('Generic SQL adapter rejected a mutating SQL keyword');
  }
  if (
    /\b(pg_sleep|pg_advisory_lock|pg_advisory_xact_lock|dblink|lo_import|lo_export|nextval|setval|set_config)\s*\(/i.test(
      normalized,
    )
  ) {
    throw new Error('Generic SQL adapter rejected a side-effecting SQL function');
  }
  return normalized;
}

export class GenericSqlReadConnector implements Connector {
  readonly key: string;
  readonly capabilities: ReadonlySet<ConnectorCapability>;
  private readonly select: string;
  private readonly pageSize: number;

  constructor(
    config: GenericSqlReadConnectorConfig,
    private readonly client: SqlReadClient,
  ) {
    if (config.capabilities.some((capability) => capability !== 'listCases')) {
      throw new Error('Generic SQL read connector currently implements only listCases');
    }
    this.key = config.key;
    this.capabilities = new Set(config.capabilities);
    this.select = validateReadOnlySelect(config.select);
    const pageSize = config.pageSize ?? 100;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
      throw new Error('SQL page size must be an integer between 1 and 1000');
    }
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.caseMapping.externalId) ||
      config.caseMapping.itemsPath !== undefined
    ) {
      throw new Error('SQL mapping requires a flat external-ID column alias and flat result rows');
    }
    this.pageSize = pageSize;
    this.mapping = config.caseMapping;
  }

  private readonly mapping: CaseMapping;

  healthCheck(): Promise<HealthStatus> {
    return this.client.healthCheck();
  }

  async listCases(cursor: string | null): Promise<Page<ExternalCase>> {
    assertCapability(this, 'listCases');
    if (cursor !== null && !/^(0|[1-9][0-9]*)$/.test(cursor)) {
      throw new Error('Invalid SQL read cursor');
    }
    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid SQL read cursor');

    const rows = await this.client.query(
      `select * from (${this.select}) as tryggsignal_source order by tryggsignal_source."${this.mapping.externalId}" limit $1 offset $2`,
      [this.pageSize, offset],
    );
    if (rows.length > this.pageSize || !Number.isSafeInteger(offset + rows.length)) {
      throw new Error('SQL source returned an invalid page boundary');
    }
    const items = mapExternalCaseItems(rows, this.mapping);

    return {
      items,
      nextCursor: rows.length === this.pageSize ? String(offset + rows.length) : null,
    };
  }
}

export interface GenericSoapSlotConfig {
  readonly key: string;
  readonly wsdlReference?: string;
  readonly blockedReason?: string;
}

export class GenericSoapConnectorSlot implements Connector {
  readonly capabilities: ReadonlySet<ConnectorCapability> = new Set();

  constructor(private readonly config: GenericSoapSlotConfig) {}

  get key(): string {
    return this.config.key;
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: false,
      detail:
        this.config.blockedReason ??
        'SOAP slot configured; verified WSDL operations and authentication are required before capabilities are enabled.',
      checkedAt: new Date().toISOString(),
    };
  }

  async listCases(): Promise<Page<ExternalCase>> {
    throw new ExternalBlockedError(
      this.key,
      this.config.blockedReason ??
        'SOAP capabilities require a verified WSDL/endpoint contract before use',
    );
  }
}

export interface WebhookRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

export interface WebhookEvent {
  readonly externalEventId: string;
  readonly eventType: string;
  readonly idempotencyKey: string;
  readonly sourceHash: string;
  readonly mappingVersion: string;
  readonly payload: unknown;
}

export type WebhookVerifier = (request: WebhookRequest) => Promise<boolean>;

export interface GenericWebhookConfig {
  readonly key: string;
  readonly eventIdPath: string;
  readonly eventTypePath: string;
  readonly mappingVersion?: string;
}

export class GenericInboundWebhookConnector implements Connector {
  readonly capabilities: ReadonlySet<ConnectorCapability> = new Set();

  constructor(
    private readonly config: GenericWebhookConfig,
    private readonly verify: WebhookVerifier,
  ) {}

  get key(): string {
    return this.config.key;
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: 'Webhook adapter is configured; transport availability is push-driven.',
      checkedAt: new Date().toISOString(),
    };
  }

  async receive(connectorInstanceId: string, request: WebhookRequest): Promise<WebhookEvent> {
    if (!(await this.verify(request))) {
      throw new ExternalBlockedError(this.key, 'Inbound webhook signature/authentication failed');
    }

    const externalEventId = asString(readPath(request.body, this.config.eventIdPath));
    const eventType = asString(readPath(request.body, this.config.eventTypePath));
    if (
      externalEventId === null ||
      eventType === null ||
      !externalEventId.trim() ||
      !eventType.trim() ||
      !connectorInstanceId.trim()
    ) {
      throw new Error('Inbound webhook has no stable event id or event type');
    }

    const mappingVersion = this.config.mappingVersion ?? '1';
    if (
      !mappingVersion.trim() ||
      mappingVersion !== mappingVersion.trim() ||
      mappingVersion.length > 100
    ) {
      throw new Error('Webhook mapping version is invalid');
    }
    return {
      externalEventId,
      eventType,
      idempotencyKey: idempotencyKey({
        connectorInstanceId,
        entityType: 'event',
        externalId: externalEventId,
        operation: eventType,
        sourceVersion: null, // Mapping release is not logical event identity.
      }),
      sourceHash: sourceHash(request.body),
      mappingVersion,
      payload: request.body,
    };
  }
}
