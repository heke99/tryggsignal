/** Permanent, versioned migration pipeline (masterplan 54–59). */
import { createHash } from 'node:crypto';
import { canonicalJson, readOwnDataPath, SOURCE_JSON_CODEC } from '@tryggsignal/domain';

export const MIGRATION_STAGES = [
  'EXTRACT',
  'RAW',
  'PROFILE',
  'MAP',
  'VALIDATE',
  'TRANSFORM',
  'CANONICAL',
  'RECONCILE',
  'IMPORT',
  'VERIFY',
] as const;
export type MigrationStage = (typeof MIGRATION_STAGES)[number];

export const SUPPORTED_FORMATS = [
  'CSV',
  'XLSX',
  'XML',
  'JSON',
  'ZIP',
  'SQL',
  'PDF',
  'PDF/A',
  'TIFF',
  'JPEG',
  'PNG',
  'GeoJSON',
  'GeoPackage',
  'Shapefile',
  'FGS',
  'SIARD',
] as const;
export type MigrationFormat = (typeof SUPPORTED_FORMATS)[number];
export type SourceHashVersion = 'json-stringify-v1' | typeof SOURCE_JSON_CODEC;

export interface RawObject {
  readonly sourceSystem: string;
  readonly sourceVersion: string | null;
  readonly sourceObject: string;
  readonly sourcePrimaryKey: string;
  readonly rawPayload: unknown;
  readonly sourceHash: string;
  /** Absent on historical captures: never silently reinterpret their hashes. */
  readonly sourceHashVersion?: SourceHashVersion;
  readonly exportedAt: string | null;
}

export class IrreversibleTransformError extends Error {}

function validateIdentity(input: Partial<RawObject>): void {
  for (const value of [input.sourceSystem, input.sourceObject, input.sourcePrimaryKey]) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
      throw new IrreversibleTransformError('Raw source identity is incomplete or ambiguous');
    }
  }
  if (input.sourceVersion !== null && typeof input.sourceVersion !== 'string') {
    throw new IrreversibleTransformError('Raw source version is invalid');
  }
  if (
    input.exportedAt !== null &&
    (typeof input.exportedAt !== 'string' || !Number.isFinite(Date.parse(input.exportedAt)))
  ) {
    throw new IrreversibleTransformError('Raw export timestamp is invalid');
  }
}

function freezeJson(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** Own a detached, immutable JSON snapshot before transformation. The database
 * still has to persist it; this helper alone is not evidence of durable storage.
 */
export function captureRaw(input: Omit<RawObject, 'sourceHash' | 'sourceHashVersion'>): RawObject {
  validateIdentity(input);
  const encoded = canonicalJson(input.rawPayload);
  const rawPayload: unknown = JSON.parse(encoded);
  return Object.freeze({
    ...input,
    rawPayload: freezeJson(rawPayload),
    sourceHash: createHash('sha256').update(encoded).digest('hex'),
    sourceHashVersion: SOURCE_JSON_CODEC,
  });
}

export function assertRawCaptured(object: Partial<RawObject> | null): asserts object is RawObject {
  if (
    object == null ||
    typeof object.sourceHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(object.sourceHash) ||
    object.rawPayload === undefined
  ) {
    throw new IrreversibleTransformError('Refusing to transform: original raw evidence is missing');
  }
  validateIdentity(object);
  let encoded: string;
  try {
    const canonical = canonicalJson(object.rawPayload);
    switch (object.sourceHashVersion ?? 'json-stringify-v1') {
      case 'canonical-json-v1':
        encoded = canonical;
        break;
      case 'json-stringify-v1':
        // Legacy compatibility is verification, never automatic hash repair.
        encoded = JSON.stringify(object.rawPayload);
        break;
      default:
        throw new Error('Unknown raw hash codec');
    }
  } catch {
    throw new IrreversibleTransformError('Raw payload or source hash codec is invalid');
  }
  if (createHash('sha256').update(encoded).digest('hex') !== object.sourceHash) {
    throw new IrreversibleTransformError('Raw payload no longer matches its captured checksum');
  }
}

export type MappingRule =
  | { readonly kind: 'copy'; readonly from: string; readonly to: string }
  | { readonly kind: 'constant'; readonly to: string; readonly value: unknown }
  | {
      readonly kind: 'lookup';
      readonly from: string;
      readonly to: string;
      readonly table: Readonly<Record<string, string>>;
      readonly onMissing: 'ERROR' | 'PASSTHROUGH';
    };
export interface MappingVersion {
  readonly mappingKey: string;
  readonly version: number;
  readonly entityType: string;
  readonly rules: readonly MappingRule[];
}
export interface MappedObject {
  readonly canonical: Record<string, unknown>;
  readonly errors: readonly {
    readonly field: string;
    readonly code: string;
    readonly message: string;
  }[];
  readonly mappingVersion: number;
}

const RESERVED_TARGETS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'source_system',
  'source_record_id',
  'source_version',
  'migration_mapping_version',
]);

export function applyMapping(raw: RawObject, mapping: MappingVersion): MappedObject {
  assertRawCaptured(raw);
  if (
    !Number.isSafeInteger(mapping.version) ||
    mapping.version < 1 ||
    !mapping.mappingKey.trim() ||
    !mapping.entityType.trim()
  ) {
    throw new Error('Mapping requires a stable key, entity type and positive integer version');
  }
  const canonical: Record<string, unknown> = {};
  const errors: { field: string; code: string; message: string }[] = [];
  const targets = new Set<string>();
  const assign = (target: string, value: unknown): void => {
    // Detached values prevent mapped output from mutating source evidence.
    canonical[target] = JSON.parse(canonicalJson(value)) as unknown;
  };
  for (const rule of mapping.rules) {
    if (
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rule.to) ||
      RESERVED_TARGETS.has(rule.to) ||
      targets.has(rule.to)
    ) {
      throw new Error('Mapping contains an unsafe, reserved or duplicate target');
    }
    targets.add(rule.to);
    switch (rule.kind) {
      case 'constant':
        assign(rule.to, rule.value);
        break;
      case 'copy': {
        const value = readOwnDataPath(raw.rawPayload, rule.from);
        if (value === undefined) {
          errors.push({
            field: rule.to,
            code: 'MISSING_SOURCE_VALUE',
            message: 'Source field missing',
          });
        } else {
          assign(rule.to, value);
        }
        break;
      }
      case 'lookup': {
        if (rule.onMissing !== 'ERROR' && rule.onMissing !== 'PASSTHROUGH') {
          throw new Error('Unknown missing-value policy');
        }
        const source = readOwnDataPath(raw.rawPayload, rule.from);
        const key = typeof source === 'string' ? source : String(source ?? '');
        const descriptor = Object.getOwnPropertyDescriptor(rule.table, key);
        const mapped: unknown =
          descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
        if (typeof mapped !== 'string') {
          if (rule.onMissing === 'ERROR' || source === undefined) {
            errors.push({
              field: rule.to,
              code: 'UNMAPPED_VALUE',
              message: `No mapping for "${key}" in ${mapping.mappingKey} v${mapping.version}`,
            });
          } else {
            assign(rule.to, source);
          }
        } else {
          assign(rule.to, mapped);
        }
        break;
      }
      default:
        throw new Error('Unknown mapping rule kind');
    }
  }
  canonical['source_system'] = raw.sourceSystem;
  canonical['source_record_id'] = raw.sourcePrimaryKey;
  canonical['source_version'] = raw.sourceVersion;
  canonical['migration_mapping_version'] = mapping.version;
  return { canonical, errors, mappingVersion: mapping.version };
}
