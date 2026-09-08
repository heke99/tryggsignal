'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import {
  confirmDocumentUploadAction,
  markDocumentUploadFailedAction,
  prepareCaseDocumentUploadAction,
  prepareDocumentVersionUploadAction,
} from '@/lib/data/actions';

const MAX_DOCUMENT_BYTES = 200 * 1024 * 1024;

async function sha256(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Uppladdningen misslyckades.';
}

interface CommonProps {
  readonly caseId: string;
}

export function NewDocumentUploadForm({ caseId }: CommonProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'error' | 'success'; text: string }>(
    {
      kind: 'idle',
      text: '',
    },
  );

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      setState({ kind: 'error', text: 'Välj en fil.' });
      return;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      setState({ kind: 'error', text: 'Filen får vara högst 200 MiB.' });
      return;
    }

    setState({ kind: 'busy', text: 'Beräknar kontrollsumma och förbereder säker uppladdning…' });
    let prepared: Awaited<ReturnType<typeof prepareCaseDocumentUploadAction>> | undefined;

    try {
      const digest = await sha256(file);
      prepared = await prepareCaseDocumentUploadAction({
        caseId,
        documentType: String(form.get('documentType') ?? ''),
        title: String(form.get('title') ?? ''),
        description: String(form.get('description') ?? ''),
        informationClass: String(form.get('informationClass') ?? 'INTERNAL'),
        secrecyLevel: Number(form.get('secrecyLevel') ?? 0),
        originalFilename: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        sha256: digest,
      });

      setState({ kind: 'busy', text: 'Laddar upp direkt till privat quarantine…' });
      const storage = createClient(prepared.supabaseUrl, prepared.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });

      const { error } = await storage.storage
        .from(prepared.bucket)
        .uploadToSignedUrl(prepared.path, prepared.token, file, {
          contentType: file.type || 'application/octet-stream',
          cacheControl: '0',
        });

      if (error !== null) throw new Error('Filen kunde inte lagras i quarantine.');

      setState({ kind: 'busy', text: 'Bekräftar filen och köar säkerhetskontroll…' });
      await confirmDocumentUploadAction({
        caseId,
        documentVersionId: prepared.documentVersionId,
      });

      formRef.current?.reset();
      setState({
        kind: 'success',
        text: 'Filen är uppladdad och väntar på säkerhetskontroll.',
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
          // The original failure is the useful message; a failed cleanup must
          // not replace it with a less actionable secondary error.
        }
      }
      setState({ kind: 'error', text: message(error) });
      router.refresh();
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} className="form-grid compact-form">
      <div className="form-field">
        <label htmlFor="documentType">Handlingstyp</label>
        <input
          id="documentType"
          name="documentType"
          type="text"
          pattern="[A-Za-z0-9_-]+"
          minLength={2}
          maxLength={80}
          placeholder="ANSOKAN"
          required
        />
      </div>

      <div className="form-field">
        <label htmlFor="documentTitle">Titel</label>
        <input id="documentTitle" name="title" type="text" minLength={2} maxLength={240} required />
      </div>

      <div className="form-field">
        <label htmlFor="informationClass">Informationsklass</label>
        <select id="informationClass" name="informationClass" defaultValue="INTERNAL">
          <option value="PUBLIC">Publik</option>
          <option value="INTERNAL">Intern</option>
          <option value="RESTRICTED">Begränsad</option>
          <option value="SECRET">Sekretess</option>
        </select>
      </div>

      <div className="form-field">
        <label htmlFor="secrecyLevel">Sekretessnivå</label>
        <select id="secrecyLevel" name="secrecyLevel" defaultValue="0">
          <option value="0">0 — ingen</option>
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
          <option value="4">4 — hög</option>
        </select>
      </div>

      <div className="form-field form-field-wide">
        <label htmlFor="documentDescription">Beskrivning</label>
        <textarea id="documentDescription" name="description" rows={3} maxLength={10000} />
      </div>

      <div className="form-field form-field-wide">
        <label htmlFor="documentFile">Fil</label>
        <input id="documentFile" name="file" type="file" required />
        <p className="field-help">
          Högst 200 MiB. Filen går direkt till privat quarantine och blir inte läsbar innan
          säkerhetskontrollen är godkänd.
        </p>
      </div>

      <div className="form-actions form-field-wide">
        <button type="submit" disabled={state.kind === 'busy'}>
          {state.kind === 'busy' ? 'Arbetar…' : 'Ladda upp handling'}
        </button>
      </div>

      {state.kind !== 'idle' && (
        <p
          className={
            state.kind === 'error' ? 'notice notice-error form-field-wide' : 'meta form-field-wide'
          }
          role={state.kind === 'error' ? 'alert' : 'status'}
        >
          {state.text}
        </p>
      )}
    </form>
  );
}

export function DocumentVersionUploadForm({
  caseId,
  documentId,
}: CommonProps & { readonly documentId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'error' | 'success'; text: string }>(
    {
      kind: 'idle',
      text: '',
    },
  );

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      setState({ kind: 'error', text: 'Välj en fil.' });
      return;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      setState({ kind: 'error', text: 'Filen får vara högst 200 MiB.' });
      return;
    }

    setState({ kind: 'busy', text: 'Förbereder ny immutable version…' });
    let prepared: Awaited<ReturnType<typeof prepareDocumentVersionUploadAction>> | undefined;

    try {
      prepared = await prepareDocumentVersionUploadAction({
        caseId,
        documentId,
        originalFilename: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        sha256: await sha256(file),
      });

      const storage = createClient(prepared.supabaseUrl, prepared.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { error } = await storage.storage
        .from(prepared.bucket)
        .uploadToSignedUrl(prepared.path, prepared.token, file, {
          contentType: file.type || 'application/octet-stream',
          cacheControl: '0',
        });
      if (error !== null) throw new Error('Den nya versionen kunde inte lagras i quarantine.');

      await confirmDocumentUploadAction({
        caseId,
        documentVersionId: prepared.documentVersionId,
      });

      formRef.current?.reset();
      setState({ kind: 'success', text: 'Ny version uppladdad och köad för säkerhetskontroll.' });
      router.refresh();
    } catch (error) {
      if (prepared !== undefined) {
        try {
          await markDocumentUploadFailedAction({
            documentVersionId: prepared.documentVersionId,
            reason: message(error),
          });
        } catch {
          // Keep the primary upload error.
        }
      }
      setState({ kind: 'error', text: message(error) });
      router.refresh();
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} className="inline-action">
      <label htmlFor={`version-file-${documentId}`}>Ladda upp ny version</label>
      <input id={`version-file-${documentId}`} name="file" type="file" required />
      <button type="submit" className="button-secondary" disabled={state.kind === 'busy'}>
        {state.kind === 'busy' ? 'Arbetar…' : 'Ny version'}
      </button>
      {state.kind !== 'idle' && (
        <p className={state.kind === 'error' ? 'notice notice-error' : 'meta'} role="status">
          {state.text}
        </p>
      )}
    </form>
  );
}
