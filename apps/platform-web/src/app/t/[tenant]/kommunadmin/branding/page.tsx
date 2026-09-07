import { currentTenant } from '@/lib/tenant/context';
import { validateBranding, contrastRatio } from '@tryggsignal/tenancy';

export const dynamic = 'force-dynamic';

/**
 * Masterplan 164: a municipality edits branding as a draft, previews it, runs the
 * accessibility validation and only then publishes. This page shows the current
 * draft and its validation result; publishing requires the contrast check to pass.
 */
export default async function BrandingAdmin() {
  const tenant = await currentTenant();

  // Until the branding editor writes drafts, the platform default is shown and
  // validated, so the rule is visible rather than theoretical.
  const draft = {
    displayName: tenant.tenantSlug,
    primaryColor: '#14532d',
    secondaryColor: '#1f2937',
    locale: 'sv-SE',
    showTryggsignalBranding: true,
  };
  const validation = validateBranding(draft);

  return (
    <main>
      <h1>Branding</h1>
      <p>
        Kommunens profil sätts med designtokens — färger, logotyper, namn och länkar. Egen
        JavaScript eller fri CSS tillåts inte.
      </p>

      <section aria-labelledby="h-tokens" className="card">
        <h2 id="h-tokens">Utkast (version {tenant.brandingVersion})</h2>
        <dl>
          <div>
            <dt>Visningsnamn</dt>
            <dd>{draft.displayName}</dd>
          </div>
          <div>
            <dt>Primärfärg</dt>
            <dd>
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-block',
                  width: '1rem',
                  height: '1rem',
                  background: draft.primaryColor,
                  border: '1px solid var(--ts-border)',
                  verticalAlign: 'middle',
                  marginRight: '0.5rem',
                }}
              />
              {draft.primaryColor}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="h-contrast" className="card">
        <h2 id="h-contrast">Kontrastvalidering (WCAG 2.2 AA)</h2>
        <ul>
          <li>
            Vit text på primärfärg: {contrastRatio('#ffffff', draft.primaryColor)}:1 (krav 4.5:1)
          </li>
          <li>
            Primärfärg som text på vit yta: {contrastRatio(draft.primaryColor, '#ffffff')}:1 (krav
            4.5:1)
          </li>
        </ul>
        <p role="status">
          {validation.valid
            ? 'Godkänd — profilen kan publiceras.'
            : `Underkänd — ${validation.problems.length} problem måste åtgärdas före publicering.`}
        </p>
      </section>
    </main>
  );
}
