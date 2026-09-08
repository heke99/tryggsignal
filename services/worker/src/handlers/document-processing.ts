import { createHash } from 'node:crypto';
import { PermanentJobError } from '../errors';
import type { JobEnvelope } from '../envelope';
import type { SqlExecutor } from '../pgmq-client';
import { scannerFromEnvironment, type MalwareScanner } from '../scanners';
import {
  storageReaderFromEnvironment,
  type StorageDownload,
  type StorageReader,
} from '../storage-reader';

interface DocumentProcessingPayload {
  readonly document_version_id?: unknown;
}

interface ProcessingTarget {
  readonly document_version_id: string;
  readonly document_id: string;
  readonly case_id: string;
  readonly authority_id: string;
  readonly storage_bucket: string;
  readonly storage_path: string;
  readonly expected_sha256: string;
  readonly declared_mime_type: string;
  readonly size_bytes: string | number;
}

export interface DocumentProcessingDependencies {
  readonly scanner: MalwareScanner;
  readonly storage: StorageReader;
}

interface Inspection {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly detectedMimeType: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let runtimeDependencies: DocumentProcessingDependencies | null = null;

function dependenciesFromEnvironment(): DocumentProcessingDependencies {
  runtimeDependencies ??= {
    scanner: scannerFromEnvironment(),
    storage: storageReaderFromEnvironment(),
  };
  return runtimeDependencies;
}

function documentVersionId(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new PermanentJobError('document_processing payload is not an object');
  }
  const value = (payload as DocumentProcessingPayload).document_version_id;
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new PermanentJobError('document_processing payload has no valid document_version_id');
  }
  return value;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function mostlyText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let printable = 0;
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  for (const byte of sample) {
    if (
      byte === 9 ||
      byte === 10 ||
      byte === 13 ||
      (byte >= 32 && byte <= 126) ||
      byte >= 160
    ) {
      printable += 1;
    }
  }
  return printable / sample.length > 0.95;
}

export function detectMimeType(prefix: Uint8Array): string {
  if (startsWith(prefix, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWith(prefix, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    startsWith(prefix, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(prefix, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return 'image/gif';
  }
  if (
    startsWith(prefix, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(prefix, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return 'image/tiff';
  }
  if (startsWith(prefix, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  if (startsWith(prefix, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return 'application/x-ole-storage';
  }
  if (startsWith(prefix, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return 'application/rtf';
  if (mostlyText(prefix)) return 'text/plain';
  return 'application/octet-stream';
}

function mimeCompatible(declared: string, detected: string): boolean {
  const normalized = declared.split(';', 1)[0]?.trim().toLowerCase() ?? declared.toLowerCase();
  if (normalized === detected || normalized === 'application/octet-stream') return true;

  const zipContainers = new Set([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'application/epub+zip',
  ]);
  if (detected === 'application/zip' && zipContainers.has(normalized)) return true;

  const oleContainers = new Set([
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/x-ole-storage',
  ]);
  if (detected === 'application/x-ole-storage' && oleContainers.has(normalized)) return true;

  return false;
}

async function inspectedStream(
  download: StorageDownload,
  onFinished: (inspection: Inspection) => void,
): Promise<AsyncIterable<Uint8Array>> {
  const hash = createHash('sha256');
  const prefixParts: Uint8Array[] = [];
  let prefixBytes = 0;
  let sizeBytes = 0;

  async function* stream(): AsyncIterable<Uint8Array> {
    for await (const chunk of download.body) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      hash.update(bytes);
      sizeBytes += bytes.byteLength;

      if (prefixBytes < 4096) {
        const take = bytes.subarray(0, Math.min(bytes.byteLength, 4096 - prefixBytes));
        prefixParts.push(take);
        prefixBytes += take.byteLength;
      }

      yield bytes;
    }

    const prefix = new Uint8Array(prefixBytes);
    let offset = 0;
    for (const part of prefixParts) {
      prefix.set(part, offset);
      offset += part.byteLength;
    }

    onFinished({
      sha256: hash.digest('hex'),
      sizeBytes,
      detectedMimeType: detectMimeType(prefix),
    });
  }

  return stream();
}

async function complete(
  sql: SqlExecutor,
  target: ProcessingTarget,
  outcome: 'CLEAN' | 'INFECTED' | 'REJECTED' | 'ERROR',
  values: {
    readonly detectedMimeType?: string | null;
    readonly scannerProvider?: string | null;
    readonly scannerVersion?: string | null;
    readonly signatureVersion?: string | null;
    readonly threatName?: string | null;
    readonly reason?: string | null;
  },
): Promise<void> {
  await sql.query(
    `select documents.worker_complete_document_processing(
      $1, $2, $3, $4, $5, $6, $7, $8
    )`,
    [
      target.document_version_id,
      outcome,
      values.detectedMimeType ?? null,
      values.scannerProvider ?? null,
      values.scannerVersion ?? null,
      values.signatureVersion ?? null,
      values.threatName ?? null,
      values.reason ?? null,
    ],
  );
}

export async function processDocument(
  envelope: JobEnvelope,
  sql: SqlExecutor,
  dependencies: DocumentProcessingDependencies,
): Promise<void> {
  const versionId = documentVersionId(envelope.payload);
  const { rows } = await sql.query<ProcessingTarget>(
    'select * from documents.worker_claim_document_processing($1)',
    [versionId],
  );
  const target = rows[0];
  if (target === undefined) return;

  if (
    envelope.authorityContext !== null &&
    envelope.authorityContext !== target.authority_id
  ) {
    await complete(sql, target, 'REJECTED', {
      reason: 'Queue authority context did not match the document authority',
    });
    throw new PermanentJobError('document_processing authority context mismatch');
  }

  let inspection: Inspection | null = null;

  try {
    const download = await dependencies.storage.download(
      target.storage_bucket,
      target.storage_path,
    );

    if (
      download.contentLength !== null &&
      download.contentLength !== Number(target.size_bytes)
    ) {
      await complete(sql, target, 'REJECTED', {
        reason: 'Storage Content-Length did not match prepared document size',
      });
      return;
    }

    const stream = await inspectedStream(download, (result) => {
      inspection = result;
    });
    const scan = await dependencies.scanner.scan(stream);

    if (inspection === null) {
      throw new Error('Document stream ended without integrity inspection');
    }

    const checked: Inspection = inspection;
    if (checked.sizeBytes !== Number(target.size_bytes)) {
      await complete(sql, target, 'REJECTED', {
        detectedMimeType: checked.detectedMimeType,
        scannerProvider: scan.provider,
        scannerVersion: scan.engineVersion,
        signatureVersion: scan.signatureVersion,
        reason: 'Downloaded byte count did not match prepared document size',
      });
      return;
    }

    if (checked.sha256 !== target.expected_sha256) {
      await complete(sql, target, 'REJECTED', {
        detectedMimeType: checked.detectedMimeType,
        scannerProvider: scan.provider,
        scannerVersion: scan.engineVersion,
        signatureVersion: scan.signatureVersion,
        reason: 'SHA-256 did not match the browser-prepared digest',
      });
      return;
    }

    if (!mimeCompatible(target.declared_mime_type, checked.detectedMimeType)) {
      await complete(sql, target, 'REJECTED', {
        detectedMimeType: checked.detectedMimeType,
        scannerProvider: scan.provider,
        scannerVersion: scan.engineVersion,
        signatureVersion: scan.signatureVersion,
        reason: `Declared MIME ${target.declared_mime_type} did not match file signature ${checked.detectedMimeType}`,
      });
      return;
    }

    if (scan.verdict === 'INFECTED') {
      await complete(sql, target, 'INFECTED', {
        detectedMimeType: checked.detectedMimeType,
        scannerProvider: scan.provider,
        scannerVersion: scan.engineVersion,
        signatureVersion: scan.signatureVersion,
        threatName: scan.threatName,
        reason: 'Malware scanner rejected the document',
      });
      return;
    }

    await complete(sql, target, 'CLEAN', {
      detectedMimeType: checked.detectedMimeType,
      scannerProvider: scan.provider,
      scannerVersion: scan.engineVersion,
      signatureVersion: scan.signatureVersion,
    });
  } catch (error) {
    await complete(sql, target, 'ERROR', {
      detectedMimeType: inspection?.detectedMimeType ?? null,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function handleDocumentProcessing(
  envelope: JobEnvelope,
  sql: SqlExecutor,
): Promise<void> {
  await processDocument(envelope, sql, dependenciesFromEnvironment());
}
