'use client';

import { useState } from 'react';
import { createDocumentDownloadUrlAction } from '@/lib/data/actions';

export function DocumentDownloadButton({
  caseId,
  documentVersionId,
}: {
  readonly caseId: string;
  readonly documentVersionId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const url = await createDocumentDownloadUrlAction({ caseId, documentVersionId });
      window.location.assign(url);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Dokumentet kunde inte hämtas.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="download-action">
      <button type="button" className="button-secondary" onClick={() => void download()} disabled={busy}>
        {busy ? 'Skapar länk…' : 'Hämta'}
      </button>
      {error !== null && <span className="meta" role="alert">{error}</span>}
    </span>
  );
}
