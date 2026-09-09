import Link from 'next/link';
import { currentTenant } from '@/lib/tenant/context';
import { submitCitizenApplicationAction } from '@/lib/data/citizen-actions';
import { loadCitizenApplicationProfiles } from '@/lib/data/citizen';

export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Record<string, string> = {
  validation: 'Kontrollera de obligatoriska uppgifterna och försök igen.',
  submit:
    'Ansökan kunde inte skickas. Det kan saknas en aktiv publicerad process för vald ansökningstyp.',
};

export default async function CitizenApplicationPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const tenant = await currentTenant();
  const [profiles, query] = await Promise.all([
    loadCitizenApplicationProfiles(tenant),
    searchParams,
  ]);
  const errorMessage =
    query.error === undefined ? null : (ERROR_MESSAGES[query.error] ?? ERROR_MESSAGES.validation);

  return (
    <main id="innehall">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Mina sidor</p>
          <h1>Ny ansökan</h1>
          <p>
            Ansökan registreras i kommunens data plane och binds atomiskt till den publicerade
            processversion som gäller för den valda tjänsten.
          </p>
        </div>
        <Link className="button-secondary" href="/mina-sidor">
          Till Mina sidor
        </Link>
      </div>

      {errorMessage !== null ? (
        <div className="notice notice-error" role="alert">
          {errorMessage}
        </div>
      ) : null}

      <section className="card" aria-labelledby="application-heading">
        <h2 id="application-heading">Ansökningsuppgifter</h2>
        {profiles.length === 0 ? (
          <p role="status">
            Kommunen har ännu ingen aktiv ansökningstyp konfigurerad för Mina sidor.
          </p>
        ) : (
          <form action={submitCitizenApplicationAction} className="form-grid">
            <div className="form-field form-field-wide">
              <label htmlFor="citizen-profile">Ansökningstyp</label>
              <select id="citizen-profile" name="profileId" defaultValue="" required>
                <option value="" disabled>
                  Välj ansökningstyp
                </option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.displayName} · {profile.processType}
                  </option>
                ))}
              </select>
              <p className="field-help">
                Valet styr vilken versionerad kommunal process som ansökan startar i.
              </p>
            </div>

            <div className="form-field">
              <label htmlFor="citizen-relationship">Din roll</label>
              <select
                id="citizen-relationship"
                name="relationship"
                defaultValue="APPLICANT"
                required
              >
                <option value="APPLICANT">Sökande</option>
                <option value="REPRESENTATIVE">Ombud</option>
              </select>
            </div>

            <div className="form-field">
              <label htmlFor="citizen-phone">Telefon</label>
              <input
                id="citizen-phone"
                name="contactPhone"
                type="tel"
                autoComplete="tel"
                maxLength={80}
              />
            </div>

            <div className="form-field form-field-wide">
              <label htmlFor="citizen-title">Rubrik</label>
              <input
                id="citizen-title"
                name="title"
                type="text"
                minLength={3}
                maxLength={240}
                required
              />
            </div>

            <div className="form-field form-field-wide">
              <label htmlFor="citizen-description">Beskrivning</label>
              <textarea id="citizen-description" name="description" rows={7} maxLength={10000} />
            </div>

            <div className="form-actions form-field-wide">
              <button type="submit">Skicka ansökan</button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
