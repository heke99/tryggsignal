import { posix as path } from 'node:path';
import type { Connector, ConnectorCapability, ExternalCase, HealthStatus, Page } from './contract';
import { assertCapability, ExternalBlockedError } from './contract';
import { asString, mapExternalCaseItems, readPath, sourceHash, type CaseMapping } from './mapping';
import { inboundEventKey } from './idempotency';

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

/** Validate the whole listing before any reads or cursor advancement. */
function assertFilePage(page: FilePage, cursor: string | null): void {
  if (page === null || typeof page !== 'object' || !Array.isArray(page.items)) {
    throw new Error('File source returned an invalid page');
  }
  if (
    page.nextCursor !== null &&
    (typeof page.nextCursor !== 'string' || !page.nextCursor.trim() || page.nextCursor === cursor)
  ) {
    throw new Error('File source returned an invalid or non-advancing cursor');
  }
  for (let index = 0; index < page.items.length; index += 1) {
    const entry = page.items[index];
    if (
      !Object.prototype.hasOwnProperty.call(page.items, index) ||
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.path !== 'string' ||
      !entry.path.trim() ||
      (entry.sizeBytes !== undefined &&
        (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0))
    ) {
      throw new Error(`File source returned an invalid entry at ${index}`);
    }
  }
}

function decode(input: string | Uint8Array): string {
  return typeof input === 'string'
    ? input
    : new TextDecoder('utf-8', { fatal: true }).decode(input);
}

function parseCsv(text: string, delimiter: string): readonly Record<string, string>[] {
  if (delimiter.length !== 1 || ['"', '\r', '\n'].includes(delimiter)) {
    throw new Error('CSV delimiter must be one non-quote, non-newline character');
  }
  const input = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  let rowStarted = false;
  const finishField = (): void => {
    row.push(field);
    field = '';
    afterQuote = false;
  };
  const finishRow = (): void => {
    if (!rowStarted && row.length === 0 && field.length === 0) return;
    finishField();
    rows.push(row);
    row = [];
    rowStarted = false;
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? '';
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === delimiter) {
      rowStarted = true;
      finishField();
    } else if (character === '\r' || character === '\n') {
      finishRow();
      if (character === '\r' && input[index + 1] === '\n') index += 1;
    } else if (character === '"' && field.length === 0 && !afterQuote) {
      rowStarted = true;
      quoted = true;
    } else {
      if (afterQuote || character === '"') throw new Error('CSV contains invalid quoting');
      rowStarted = true;
      field += character;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  finishRow();
  const headers = rows.shift()?.map((header) => header.trim());
  if (headers === undefined) return [];
  if (headers.some((header) => !header)) throw new Error('CSV contains an empty header');
  if (new Set(headers).size !== headers.length) throw new Error('CSV contains duplicate headers');
  return rows.map((values) => {
    if (values.length !== headers.length)
      throw new Error('CSV row column count does not match the header');
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
    assertFilePage(page, cursor);
    const items: ExternalCase[] = [];

    for (const entry of page.items) {
      const raw = await this.source.read(entry.path);
      const payload = parseFilePayload(raw, this.config.format, this.config.csvDelimiter ?? ',');
      // Do not spread an unbounded file into function arguments (V8 stack limit).
      // This retains the existing buffered contract; it does not claim streaming.
      for (const item of mapExternalCaseItems(payload, this.config.caseMapping)) {
        items.push(item);
      }
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
        assertFilePage(page, cursor);
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
  /** Unmodified HTTP bytes for source-specific signature verification.
   * A byte-signature verifier must reject requests where this is absent.
   */
  readonly rawBody?: Uint8Array;
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

    // The receipt RPC accepts a JSON object, never an array/scalar. Hashing an
    // array is valid elsewhere but must not imply that it is a valid receipt.
    if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) {
      throw new Error('Inbound webhook payload must be a JSON object');
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
      idempotencyKey: inboundEventKey({ connectorInstanceId, externalEventId, eventType }),
      sourceHash: sourceHash(request.body),
      mappingVersion,
      payload: request.body,
    };
  }
}
