import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  detectMimeType,
  processDocument,
  type JobEnvelope,
  type MalwareScanner,
  type MalwareScanResult,
  type SqlExecutor,
  type StorageReader,
} from '@tryggsignal/worker';

const VERSION_ID = '11111111-1111-4111-8111-111111111111';
const DOCUMENT_ID = '22222222-2222-4222-8222-222222222222';
const CASE_ID = '33333333-3333-4333-8333-333333333333';
const AUTHORITY_ID = '44444444-4444-4444-8444-444444444444';

function envelope(): JobEnvelope {
  return {
    jobId: '55555555-5555-4555-8555-555555555555',
    type: 'document_processing',
    tenantContext: CASE_ID,
    authorityContext: AUTHORITY_ID,
    correlationId: '66666666-6666-4666-8666-666666666666',
    causationId: null,
    idempotencyKey: `document-processing:${VERSION_ID}`,
    payload: { document_version_id: VERSION_ID },
    attempt: 1,
    createdAt: '2026-09-08T00:00:00Z',
    queue: 'document_processing',
  };
}

function pdfBytes(): Uint8Array {
  return new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
}

function sql(bytes: Uint8Array, declaredMime = 'application/pdf') {
  const completions: unknown[][] = [];
  const expected = createHash('sha256').update(bytes).digest('hex');

  const executor: SqlExecutor = {
    async query<TRow>(text: string, values: readonly unknown[] = []) {
      if (text.includes('worker_claim_document_processing')) {
        return {
          rows: [
            {
              document_version_id: VERSION_ID,
              document_id: DOCUMENT_ID,
              case_id: CASE_ID,
              authority_id: AUTHORITY_ID,
              storage_bucket: 'quarantine',
              storage_path: `${AUTHORITY_ID}/${DOCUMENT_ID}/1/${VERSION_ID}`,
              expected_sha256: expected,
              declared_mime_type: declaredMime,
              size_bytes: bytes.byteLength,
            } as TRow,
          ],
        };
      }
      if (text.includes('worker_complete_document_processing')) {
        completions.push([...values]);
        return { rows: [] as TRow[] };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
  };

  return { executor, completions };
}

function storage(bytes: Uint8Array): StorageReader {
  return {
    async download() {
      async function* body(): AsyncIterable<Uint8Array> {
        yield bytes.subarray(0, Math.min(bytes.length, 7));
        if (bytes.length > 7) yield bytes.subarray(7);
      }
      return {
        body: body(),
        contentType: 'application/pdf',
        contentLength: bytes.byteLength,
      };
    },
  };
}

function scanner(result: MalwareScanResult): MalwareScanner {
  return {
    async scan(stream) {
      // Consume the stream; the processor performs hash/size/signature inspection
      // while the scanner receives the exact same bytes.
      for await (const _chunk of stream) {
        // no-op
      }
      return result;
    },
  };
}

describe('G4 document processing', () => {
  it('marks an intact PDF CLEAN after the scanner accepts it', async () => {
    const bytes = pdfBytes();
    const { executor, completions } = sql(bytes);

    await processDocument(envelope(), executor, {
      storage: storage(bytes),
      scanner: scanner({
        verdict: 'CLEAN',
        provider: 'CLAMAV',
        engineVersion: '1.4.3',
        signatureVersion: '28123',
        threatName: null,
      }),
    });

    expect(completions).toHaveLength(1);
    expect(completions[0]?.[1]).toBe('CLEAN');
    expect(completions[0]?.[2]).toBe('application/pdf');
    expect(completions[0]?.[3]).toBe('CLAMAV');
  });

  it('rejects malware and stores the threat name', async () => {
    const bytes = pdfBytes();
    const { executor, completions } = sql(bytes);

    await processDocument(envelope(), executor, {
      storage: storage(bytes),
      scanner: scanner({
        verdict: 'INFECTED',
        provider: 'CLAMAV',
        engineVersion: '1.4.3',
        signatureVersion: '28123',
        threatName: 'Win.Test.EICAR_HDB-1',
      }),
    });

    expect(completions[0]?.[1]).toBe('INFECTED');
    expect(completions[0]?.[6]).toBe('Win.Test.EICAR_HDB-1');
  });

  it('rejects a declared MIME that disagrees with the file signature', async () => {
    const bytes = pdfBytes();
    const { executor, completions } = sql(bytes, 'image/png');

    await processDocument(envelope(), executor, {
      storage: storage(bytes),
      scanner: scanner({
        verdict: 'CLEAN',
        provider: 'CLAMAV',
        engineVersion: '1.4.3',
        signatureVersion: '28123',
        threatName: null,
      }),
    });

    expect(completions[0]?.[1]).toBe('REJECTED');
    expect(String(completions[0]?.[7])).toContain('Declared MIME');
  });

  it('rejects a byte stream whose SHA-256 differs from the prepared metadata', async () => {
    const preparedBytes = pdfBytes();
    const deliveredBytes = new TextEncoder().encode('%PDF-1.7\nmodified\n');
    const { executor, completions } = sql(preparedBytes);

    await processDocument(envelope(), executor, {
      storage: storage(deliveredBytes),
      scanner: scanner({
        verdict: 'CLEAN',
        provider: 'CLAMAV',
        engineVersion: '1.4.3',
        signatureVersion: '28123',
        threatName: null,
      }),
    });

    expect(completions[0]?.[1]).toBe('REJECTED');
    expect(String(completions[0]?.[7])).toMatch(/Content-Length|SHA-256/);
  });
});

describe('G4 file signature detection', () => {
  it('recognizes core municipal document containers', () => {
    expect(detectMimeType(pdfBytes())).toBe('application/pdf');
    expect(detectMimeType(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toBe('application/zip');
    expect(detectMimeType(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(
      'application/x-ole-storage',
    );
  });
});
