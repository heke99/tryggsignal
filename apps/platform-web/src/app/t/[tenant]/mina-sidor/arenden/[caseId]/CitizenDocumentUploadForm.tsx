'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import {
  confirmDocumentUploadAction,
  markDocumentUploadFailedAction,
  prepareCaseDocumentUploadAction,
} from '@/lib/data/actions';

const MAX_DOCUMENT_BYTES = 200 * 1024 * 1024;

async function sha256(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Kompletteringen kunde inte laddas upp.';
}

export function CitizenDocumentUploadForm({ caseId }: { readonly caseId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<{
    kind: 'idle' | 'busy' | 'error' | 'success';
    text: string;
  }>({ kind: 'idle', text: '' });

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get('file');
    const title = String(form.get('title') ?? '').trim();
    const description = String(form.get('description') ?? '').trim();

    if (title.length < 2 || title.length > 240) {
      setState({ kind: 'error', text: 'Ange en titel på 2–240 tecken.' });
      return;
    }
    if (!(file instanceof File) || file.size === 0) {
      setState({ kind: 'error', text: 'Välj en fil.' });
      return;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      setState({ kind: 'error', text: 'Filen får vara högst 200 MiB.' });
      return;
    }

    let prepared: Awaited<ReturnType<typeof prepareCaseDocumentUploadAction>> | undefined;
    setState({ kind: 'busy', text: 'Kontrollerar filen och förbereder säker uppladdning…' });

    try {
      prepared = await prepareCaseDocumentUploadAction({
        caseId,
        documentType: 'KOMPLETTERING',
        title,
        description,
        informationClass: 'INTERNAL',
        secrecyLevel: 0,
        originalFilename: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        sha256: await sha256(file),
      });

      const storage = createClient(prepared.supabaseUrl, prepared.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });

      setState({ kind: 'busy', text: 'Laddar upp till privat karantän…' });
      const { error } = await storage.storage
        .from(prepared.bucket)
        .uploadToSignedUrl(prepared.path, prepared.token, file, {
          contentType: file.type || 'application/octet-stream',
          cacheControl: '0',
        });

      if (error !== null) throw new Error('Filen kunde inte lagras i karantän.');

      setState({ kind: 'busy', text: 'Bekräftar filen och köar säkerhetskontroll…' });
      await confirmDocumentUploadAction({
        caseId,
        documentVersionId: prepared.documentVersionId,
      });

      formRef.current?.reset();
      setState({
        kind: 'success',
        text: 'Kompletteringen är mottagen och väntar på säkerhetskontroll.',
      });
      router.refresh();
    } catch (error) {
      if (prepared !== undefined) {
        try {
          await markDocumentUploadFailedAction({
            documentVersionId: prepared.documentVersionId,
            reason: message(error),
          });
        } catch {
          // Preserve the original upload error.
        }
      }
      setState({ kind: 'error', text: message(error) });
      router.refresh();
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} className="form-grid compact-form">
      <div className="form-field">
        <label htmlFor="citizen-document-title">Titel</label>
        <input
          id="citizen-document-title"
          name="title"
          type="text"
          minLength={2}
          maxLength={240}
          required
        />
      </div>
      <div className="form-field form-field-wide">
        <label htmlFor="citizen-document-description">Beskrivning</label>
        <textarea id="citizen-document-description" name="description" rows={3} maxLength={10000} />
      </div>
      <div className="form-field form-field-wide">
        <label htmlFor="citizen-document-file">Fil</label>
        <input id="citizen-document-file" name="file" type="file" required />
        <p className="field-help">
          Högst 200 MiB. Filen blir inte tillgänglig som handling förrän säkerhetskontrollen är
          godkänd.
        </p>
      </div>
      <div className="form-actions form-field-wide">
        <button type="submit" disabled={state.kind === 'busy'}>
          {state.kind === 'busy' ? 'Arbetar…' : 'Skicka komplettering'}
        </button>
      </div>
      {state.kind !== 'idle' ? (
        <p
          className={
            state.kind === 'error' ? 'notice notice-error form-field-wide' : 'meta form-field-wide'
          }
          role={state.kind === 'error' ? 'alert' : 'status'}
        >
          {state.text}
        </p>
      ) : null}
    </form>
  );
}
