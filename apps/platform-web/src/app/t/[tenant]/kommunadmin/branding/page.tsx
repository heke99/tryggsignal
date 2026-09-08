import Image from 'next/image';
import { requireTenantPermission } from '@/lib/auth/guard';
import { currentTenant } from '@/lib/tenant/context';
import { defaultTenantBranding, listTenantBrandingVersions } from '@/lib/tenant/branding';
import { contrastRatio, validateBranding } from '@tryggsignal/tenancy';
import {
  publishBrandingAction,
  rollbackBrandingAction,
  saveBrandingAction,
  uploadBrandingAssetAction,
} from './actions';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function messageFor(params: Record<string, string | string[] | undefined>): string | null {
  if (params['saved'] === '1') return 'Utkastet är sparat och validerat.';
  if (params['published'] === '1') return 'Brandingen är publicerad.';
  if (params['rolledBack'] === '1') return 'Föregående publicerade brandingversion är återställd.';
  if (params['asset'] === '1') return 'Brandingfilen är uppladdad och kopplad till utkastet.';
  switch (params['error']) {
    case 'validation':
      return 'Utkastet kunde inte sparas eftersom valideringen inte passerade.';
    case 'asset':
      return 'Filen kunde inte användas. Endast riktig PNG/WebP upp till 2 MB och 4096×4096 px accepteras.';
    case 'publish':
      return 'Publicering misslyckades. Kontrollera att utkastet finns och har godkänd kontrast.';
    case 'rollback':
      return 'Rollback kunde inte genomföras. Det måste finnas en tidigare publicerad version.';
    case 'save':
      return 'Utkastet kunde inte sparas.';
    default:
      return null;
  }
}

export default async function BrandingAdmin({ searchParams }: PageProps) {
  const tenant = await currentTenant();
  await requireTenantPermission(tenant, 'branding.manage', '/kommunadmin/branding');

  const [versions, params] = await Promise.all([listTenantBrandingVersions(tenant), searchParams]);
  const draft = versions.find((version) => version.status === 'DRAFT');
  const published = versions.find((version) => version.status === 'PUBLISHED');
  const editing = draft ?? published ?? defaultTenantBranding(tenant);
  const validation = validateBranding(editing);
  const message = messageFor(params);

  return (
    <main id="innehall">
      <h1>Branding</h1>
      <p>
        Kommunens profil är versionerad. Ett utkast måste passera WCAG-kontrastkontrollen innan
        publicering. Fri CSS, JavaScript och SVG accepteras inte.
      </p>

      {message !== null ? (
        <p role="status" className="card">
          {message}
        </p>
      ) : null}

      <section aria-labelledby="h-current" className="card">
        <h2 id="h-current">Publicerad profil</h2>
        {published === undefined ? (
          <p>Ingen egen branding är publicerad ännu. Plattformens säkra standardprofil används.</p>
        ) : (
          <>
            <p>
              Version {published.version}: <strong>{published.displayName}</strong>
            </p>
            {published.logoUrl !== undefined ? (
              <Image
                src={published.logoUrl}
                alt={`${published.displayName} logotyp`}
                width={240}
                height={80}
                sizes="240px"
                style={{ width: 'auto', maxWidth: '15rem', height: '4rem', objectFit: 'contain' }}
              />
            ) : null}
          </>
        )}
      </section>

      <form action={saveBrandingAction} className="card">
        <h2>Utkast {draft !== undefined ? `— version ${draft.version}` : '— nytt'}</h2>

        <p>
          <label>
            Visningsnamn
            <br />
            <input
              name="displayName"
              required
              maxLength={120}
              defaultValue={editing.displayName}
              autoComplete="organization"
            />
          </label>
        </p>
        <p>
          <label>
            Kort namn
            <br />
            <input name="shortName" maxLength={60} defaultValue={editing.shortName ?? ''} />
          </label>
        </p>
        <p>
          <label>
            Primärfärg
            <br />
            <input name="primaryColor" type="color" required defaultValue={editing.primaryColor} />
          </label>
        </p>
        <p>
          <label>
            Sekundärfärg
            <br />
            <input
              name="secondaryColor"
              inputMode="text"
              pattern="#[0-9a-fA-F]{6}"
              placeholder="#1f2937"
              defaultValue={editing.secondaryColor ?? ''}
            />
          </label>
        </p>
        <p>
          <label>
            Accentfärg
            <br />
            <input
              name="accentColor"
              inputMode="text"
              pattern="#[0-9a-fA-F]{6}"
              placeholder="#b45309"
              defaultValue={editing.accentColor ?? ''}
            />
          </label>
        </p>
        <p>
          <label>
            Ytfärg
            <br />
            <input
              name="surfaceVariant"
              inputMode="text"
              pattern="#[0-9a-fA-F]{6}"
              placeholder="#f8fafc"
              defaultValue={editing.surfaceVariant ?? ''}
            />
          </label>
        </p>
        <p>
          <label>
            Språk
            <br />
            <input
              name="locale"
              required
              maxLength={16}
              pattern="[a-z]{2}(-[A-Z]{2})?"
              defaultValue={editing.locale}
            />
          </label>
        </p>
        <p>
          <label>
            Support-e-post
            <br />
            <input
              name="supportEmail"
              type="email"
              maxLength={254}
              defaultValue={editing.supportEmail ?? ''}
            />
          </label>
        </p>
        <p>
          <label>
            Integritetspolicy
            <br />
            <input
              name="privacyUrl"
              type="url"
              maxLength={500}
              defaultValue={editing.privacyUrl ?? ''}
            />
          </label>
        </p>
        <p>
          <label>
            Tillgänglighetsredogörelse
            <br />
            <input
              name="accessibilityStatementUrl"
              type="url"
              maxLength={500}
              defaultValue={editing.accessibilityStatementUrl ?? ''}
            />
          </label>
        </p>
        <p>
          <label>
            Villkor
            <br />
            <input
              name="termsUrl"
              type="url"
              maxLength={500}
              defaultValue={editing.termsUrl ?? ''}
            />
          </label>
        </p>
        <p>
          <label>
            Rubrik på inloggning
            <br />
            <input name="loginHeading" maxLength={160} defaultValue={editing.loginHeading ?? ''} />
          </label>
        </p>
        <p>
          <label>
            Underrubrik på inloggning
            <br />
            <textarea
              name="loginSubheading"
              maxLength={280}
              defaultValue={editing.loginSubheading ?? ''}
            />
          </label>
        </p>
        <p>
          <label>
            <input
              name="showTryggsignalBranding"
              type="checkbox"
              defaultChecked={editing.showTryggsignalBranding}
            />{' '}
            Visa ”Powered by Tryggsignal”
          </label>
        </p>

        <button type="submit">Spara och validera utkast</button>
      </form>

      <section aria-labelledby="h-contrast" className="card">
        <h2 id="h-contrast">Kontrastvalidering (WCAG 2.2 AA)</h2>
        <ul>
          <li>
            Vit text på primärfärg: {contrastRatio('#ffffff', editing.primaryColor)}:1 (krav 4.5:1)
          </li>
          <li>
            Primärfärg som text på vit yta: {contrastRatio(editing.primaryColor, '#ffffff')}:1 (krav
            4.5:1)
          </li>
        </ul>
        <p role="status">
          {validation.valid
            ? 'Godkänd — utkastet kan publiceras när det är sparat.'
            : `Underkänd — ${validation.problems.length} problem måste åtgärdas.`}
        </p>
      </section>

      <section aria-labelledby="h-assets" className="card">
        <h2 id="h-assets">Logotyp och favicon</h2>
        <p>Endast PNG/WebP, högst 2 MB och högst 4096×4096 px. SVG tillåts inte.</p>
        {draft === undefined || draft.id === null ? (
          <p>Spara först ett utkast innan filer laddas upp.</p>
        ) : (
          <>
            {(['LOGO', 'LOGO_DARK', 'FAVICON'] as const).map((kind) => (
              <form
                action={uploadBrandingAssetAction}
                encType="multipart/form-data"
                key={kind}
                style={{ marginBottom: '1rem' }}
              >
                <input type="hidden" name="brandingId" value={draft.id ?? ''} />
                <input type="hidden" name="kind" value={kind} />
                <label>
                  {kind === 'LOGO'
                    ? 'Logotyp'
                    : kind === 'LOGO_DARK'
                      ? 'Logotyp mörkt läge'
                      : 'Favicon'}
                  <br />
                  <input name="asset" type="file" accept="image/png,image/webp" required />
                </label>{' '}
                <button type="submit">Ladda upp</button>
              </form>
            ))}
          </>
        )}
      </section>

      <section aria-labelledby="h-release" className="card">
        <h2 id="h-release">Publicering och rollback</h2>
        {draft !== undefined && draft.id !== null ? (
          <form action={publishBrandingAction}>
            <input type="hidden" name="brandingId" value={draft.id} />
            <button type="submit" disabled={draft.contrastValidationStatus !== 'PASSED'}>
              Publicera version {draft.version}
            </button>
          </form>
        ) : (
          <p>Det finns inget utkast att publicera.</p>
        )}

        {published?.supersedesId != null ? (
          <form action={rollbackBrandingAction} style={{ marginTop: '1rem' }}>
            <button type="submit">Återställ föregående publicerade version</button>
          </form>
        ) : null}
      </section>

      <section aria-labelledby="h-history" className="card">
        <h2 id="h-history">Versionshistorik</h2>
        {versions.length === 0 ? (
          <p>Ingen versionshistorik ännu.</p>
        ) : (
          <table>
            <caption>Brandingversioner för {tenant.tenantSlug}</caption>
            <thead>
              <tr>
                <th>Version</th>
                <th>Status</th>
                <th>Kontrast</th>
                <th>Namn</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={version.id ?? version.version}>
                  <td>{version.version}</td>
                  <td>{version.status}</td>
                  <td>{version.contrastValidationStatus}</td>
                  <td>{version.displayName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
