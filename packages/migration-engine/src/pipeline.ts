/** RAW capture is an immutable value; durable storage is a separate required step. */
import { createHash } from 'node:crypto';
import { readPath, sourceHash as semanticJsonHash } from '@tryggsignal/integrations';

export const MIGRATION_STAGES = [
  'EXTRACT', 'RAW', 'PROFILE', 'MAP', 'VALIDATE', 'TRANSFORM',
  'CANONICAL', 'RECONCILE', 'IMPORT', 'VERIFY',
] as const;
export type MigrationStage = (typeof MIGRATION_STAGES)[number];

/** Format catalog, not a claim that every listed format has an active decoder. */
export const SUPPORTED_FORMATS = [
  'CSV', 'XLSX', 'XML', 'JSON', 'ZIP', 'SQL', 'PDF', 'PDF/A', 'TIFF', 'JPEG',
  'PNG', 'GeoJSON', 'GeoPackage', 'Shapefile', 'FGS', 'SIARD',
] as const;
export type MigrationFormat = (typeof SUPPORTED_FORMATS)[number];
export const RAW_HASH_FORMAT = 'UTF8_JSON_SHA256_V1' as const;

export interface RawObject {
  readonly sourceSystem: string;
  readonly sourceVersion: string | null;
  readonly sourceObject: string;
  readonly sourcePrimaryKey: string;
  readonly rawPayload: unknown;
  /** Exact UTF-8 JSON representation retained before transformation. */
  readonly rawText: string;
  readonly sourceHash: string;
  readonly exportedAt: string | null;
}
export class IrreversibleTransformError extends Error {}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
function freezeJson(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
function validateMetadata(input: Pick<RawObject,
  'sourceSystem' | 'sourceVersion' | 'sourceObject' | 'sourcePrimaryKey' | 'exportedAt'
>): void {
  for (const value of [input.sourceSystem, input.sourceObject, input.sourcePrimaryKey]) {
    if (typeof value !== 'string' || !value.trim() || value.length > 500) {
      throw new IrreversibleTransformError('RAW source identity is missing or invalid');
    }
  }
  if (input.sourceVersion !== null && typeof input.sourceVersion !== 'string') {
    throw new IrreversibleTransformError('RAW source version must be a string or null');
  }
  if (input.exportedAt !== null &&
      (typeof input.exportedAt !== 'string' || !Number.isFinite(Date.parse(input.exportedAt)))) {
    throw new IrreversibleTransformError('RAW export timestamp is invalid');
  }
}

export function captureRawText(
  input: Pick<RawObject, 'sourceSystem' | 'sourceVersion' | 'sourceObject' | 'sourcePrimaryKey' | 'exportedAt'>,
  rawText: string,
): RawObject {
  validateMetadata(input);
  if (typeof rawText !== 'string' || rawText.length === 0 || Buffer.byteLength(rawText) > 16 * 1024 * 1024) {
    throw new IrreversibleTransformError('RAW JSON record must contain 1 byte to 16 MiB');
  }
  const payload: unknown = JSON.parse(rawText);
  // Reuse H's lossless JSON validation. Large numeric identifiers must be strings.
  semanticJsonHash(payload);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new IrreversibleTransformError('A RAW record must be a JSON object');
  }
  return Object.freeze({
    sourceSystem: input.sourceSystem,
    sourceVersion: input.sourceVersion,
    sourceObject: input.sourceObject,
    sourcePrimaryKey: input.sourcePrimaryKey,
    exportedAt: input.exportedAt,
    rawPayload: freezeJson(payload),
    rawText,
    sourceHash: digest(rawText),
  });
}

/** For decoded source records. For original export text use captureRawText. */
export function captureRaw(input: Omit<RawObject, 'sourceHash' | 'rawText'>): RawObject {
  semanticJsonHash(input.rawPayload);
  return captureRawText(input, JSON.stringify(input.rawPayload));
}

export function assertRawCaptured(object: Partial<RawObject> | null): asserts object is RawObject {
  try {
    if (object === null || typeof object.rawText !== 'string' ||
        typeof object.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(object.sourceHash) ||
        digest(object.rawText) !== object.sourceHash ||
        semanticJsonHash(JSON.parse(object.rawText)) !== semanticJsonHash(object.rawPayload)) {
      throw new Error('RAW checksum or payload mismatch');
    }
    validateMetadata(object as RawObject);
  } catch {
    throw new IrreversibleTransformError('Refusing transformation: original RAW evidence is absent or inconsistent.');
  }
}

export type MappingRule =
  | { readonly kind: 'copy'; readonly from: string; readonly to: string; readonly optional?: boolean }
  | { readonly kind: 'constant'; readonly to: string; readonly value: unknown }
  | { readonly kind: 'lookup'; readonly from: string; readonly to: string;
      readonly table: Readonly<Record<string, string>>; readonly onMissing: 'ERROR' | 'PASSTHROUGH' };
export interface MappingVersion {
  readonly mappingKey: string;
  readonly version: number;
  readonly entityType: string;
  readonly rules: readonly MappingRule[];
}
export interface MappedObject {
  /** A staged candidate, never an assertion that canonical tables were imported. */
  readonly canonical: Record<string, unknown>;
  readonly errors: readonly { readonly field: string; readonly code: string; readonly message: string }[];
  readonly mappingVersion: number;
}

const RESERVED = new Set([
  '__proto__', 'constructor', 'prototype', 'id', 'authority_id', 'department_id',
  'system_of_record', 'source_system', 'source_record_id', 'source_version',
  'source_object', 'migration_mapping_key', 'migration_mapping_version',
]);
const CLOSED_VOCABULARY = new Set(['status', 'information_class', 'classification_code']);

export function validateMapping(mapping: MappingVersion): void {
  if (!mapping.mappingKey?.trim() || !mapping.entityType?.trim() ||
      !Number.isSafeInteger(mapping.version) || mapping.version < 1 ||
      !Array.isArray(mapping.rules) || mapping.rules.length === 0 || mapping.rules.length > 200) {
    throw new Error('Mapping identity/version/rules are invalid');
  }
  const destinations = new Set<string>();
  for (const rule of mapping.rules) {
    if (!/^[a-z][a-z0-9_]*$/.test(rule.to) || RESERVED.has(rule.to) || destinations.has(rule.to)) {
      throw new Error('Mapping has a reserved, invalid or duplicate destination');
    }
    destinations.add(rule.to);
    if (!['copy', 'lookup', 'constant'].includes(rule.kind)) throw new Error('Unsupported mapping rule');
    if (rule.kind !== 'constant' &&
        (!rule.from || rule.from.split('.').some((part) => !part || ['__proto__', 'constructor', 'prototype'].includes(part)))) {
      throw new Error('Mapping path is invalid');
    }
    if (rule.kind === 'constant') semanticJsonHash(rule.value);
    if (rule.kind === 'lookup') {
      if (rule.table === null || typeof rule.table !== 'object' || Array.isArray(rule.table) ||
          !['ERROR', 'PASSTHROUGH'].includes(rule.onMissing) ||
          (CLOSED_VOCABULARY.has(rule.to) && rule.onMissing !== 'ERROR')) {
        throw new Error('Lookup configuration is invalid or permits unsafe vocabulary passthrough');
      }
      semanticJsonHash(rule.table);
      if (Object.values(rule.table).some((value) => typeof value !== 'string')) {
        throw new Error('Lookup targets must be strings');
      }
    }
  }
}

export function applyMapping(raw: RawObject, mapping: MappingVersion): MappedObject {
  assertRawCaptured(raw);
  validateMapping(mapping);
  const canonical: Record<string, unknown> = {};
  const errors: { field: string; code: string; message: string }[] = [];
  for (const rule of mapping.rules) {
    if (rule.kind === 'constant') {
      canonical[rule.to] = JSON.parse(JSON.stringify(rule.value)) as unknown;
      continue;
    }
    const value = readPath(raw.rawPayload, rule.from);
    if (rule.kind === 'copy') {
      if (value === undefined) {
        if (!rule.optional) errors.push({ field: rule.to, code: 'MISSING_FIELD', message: 'Required source field is absent' });
      } else {
        canonical[rule.to] = JSON.parse(JSON.stringify(value)) as unknown;
      }
      continue;
    }
    const key = typeof value === 'string' ? value :
      typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
    const mapped = key !== null && Object.prototype.hasOwnProperty.call(rule.table, key)
      ? rule.table[key] : undefined;
    if (mapped !== undefined) canonical[rule.to] = mapped;
    else if (rule.onMissing === 'PASSTHROUGH' && value !== undefined) canonical[rule.to] = value;
    else errors.push({ field: rule.to, code: 'UNMAPPED_VALUE', message: 'Source value has no explicit mapping' });
  }
  canonical['source_system'] = raw.sourceSystem;
  canonical['source_record_id'] = raw.sourcePrimaryKey;
  canonical['source_version'] = raw.sourceVersion;
  canonical['source_object'] = raw.sourceObject;
  canonical['migration_mapping_key'] = mapping.mappingKey;
  canonical['migration_mapping_version'] = mapping.version;
  return { canonical, errors, mappingVersion: mapping.version };
}
