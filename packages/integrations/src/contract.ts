/**
 * Masterplan 62: one internal connector contract, with declared capabilities.
 * A capability that has not been verified against the vendor's documentation is
 * simply absent — it is never assumed (masterplan 61).
 */

export const CONNECTOR_CAPABILITIES = [
  'listCases',
  'getCase',
  'createCase',
  'updateCase',
  'listDocuments',
  'getDocument',
  'addDocument',
  'listParties',
  'listEvents',
  'addMessage',
  'setStatus',
  'exportRecords',
] as const;

export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

export interface HealthStatus {
  readonly healthy: boolean;
  readonly detail: string;
  readonly checkedAt: string;
  readonly latencyMs?: number;
}

export interface ExternalCase {
  readonly externalId: string;
  readonly caseNumber: string;
  readonly title: string;
  readonly status: string;
  readonly sourceVersion: string | null;
  readonly sourceUpdatedAt: string | null;
  readonly raw: unknown;
}

export interface ExternalDocument {
  readonly externalId: string;
  readonly caseExternalId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly raw: unknown;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface WriteResult {
  readonly externalId: string;
  readonly idempotencyKey: string;
  /** True when the target already had this write and it was not applied twice. */
  readonly deduplicated: boolean;
}

export class CapabilityNotSupportedError extends Error {
  constructor(connectorKey: string, capability: ConnectorCapability) {
    super(`Connector "${connectorKey}" does not declare the capability "${capability}"`);
    this.name = 'CapabilityNotSupportedError';
  }
}

export class ExternalBlockedError extends Error {
  constructor(
    readonly connectorKey: string,
    readonly reason: string,
  ) {
    super(`EXTERNAL_BLOCKED: ${connectorKey} — ${reason}`);
    this.name = 'ExternalBlockedError';
  }
}

export interface Connector {
  readonly key: string;
  readonly capabilities: ReadonlySet<ConnectorCapability>;
  healthCheck(): Promise<HealthStatus>;
  listCases?(cursor: string | null): Promise<Page<ExternalCase>>;
  getCase?(externalId: string): Promise<ExternalCase | null>;
  createCase?(input: unknown, idempotencyKey: string): Promise<WriteResult>;
  updateCase?(externalId: string, input: unknown, idempotencyKey: string): Promise<WriteResult>;
  listDocuments?(caseExternalId: string, cursor: string | null): Promise<Page<ExternalDocument>>;
  getDocument?(externalId: string): Promise<ExternalDocument | null>;
  addDocument?(
    caseExternalId: string,
    input: unknown,
    idempotencyKey: string,
  ): Promise<WriteResult>;
  listParties?(caseExternalId: string): Promise<Page<unknown>>;
  listEvents?(cursor: string | null): Promise<Page<unknown>>;
  addMessage?(caseExternalId: string, input: unknown, idempotencyKey: string): Promise<WriteResult>;
  setStatus?(externalId: string, status: string, idempotencyKey: string): Promise<WriteResult>;
  exportRecords?(cursor: string | null): Promise<Page<unknown>>;
}

export function assertCapability(connector: Connector, capability: ConnectorCapability): void {
  if (!connector.capabilities.has(capability)) {
    throw new CapabilityNotSupportedError(connector.key, capability);
  }
}
