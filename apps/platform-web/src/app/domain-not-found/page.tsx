import { headers } from 'next/headers';

/** Masterplan 159/216: an unknown or unverified host serves nothing tenant-specific. */
export default async function DomainNotFound() {
  const store = await headers();
  const reason = store.get('x-ts-rejection') ?? 'UNKNOWN_DOMAIN';

  return (
    <main>
      <h1>Domänen är inte aktiverad</h1>
      <p>
        Den här adressen är inte kopplad till en verifierad och aktiv kommunportal i Tryggsignal.
      </p>
      <div className="card">
        <p className="meta">Orsak: {reason}</p>
        <p className="meta">
          Kontakta din kommunadministratör eller Tryggsignals support om adressen borde fungera.
        </p>
      </div>
    </main>
  );
}
