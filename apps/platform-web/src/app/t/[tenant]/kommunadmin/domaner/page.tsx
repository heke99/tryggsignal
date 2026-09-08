import { requireTenantPermission } from '@/lib/auth/guard';
import { currentTenant } from '@/lib/tenant/context';
import { listTenantDomains } from '@/lib/tenant/domains';
import {
  activateDomainAction,
  disableDomainAction,
  requestDomainAction,
  verifyDomainAction,
} from './actions';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function messageFor(params: Record<string, string | string[] | undefined>): string | null {
  if (params['requested'] === '1') return 'Domänen är registrerad och providerflödet har startat.';
  if (params['verified'] === '1') return 'Domänens provider-, DNS- och TLS-status har kontrollerats.';
  if (params['activated'] === '1') return 'Domänen är aktiv och används som kanonisk adress.';
  if (params['disabled'] === '1') return 'Domänen är avstängd. Plattformens fallback används.';
  switch (params['error']) {
    case 'invalid':
      return 'Ange ett giltigt domännamn.';
    case 'request':
      return 'Domänen kunde inte registreras. Den kan vara upptagen, historiskt låst eller sakna providerstöd.';
    case 'verify':
      return 'Verifieringen misslyckades. Kontrollera DNS-instruktionerna och försök igen.';
    case 'activate':
      return 'Domänen kan inte aktiveras förrän ägarskap, DNS och TLS är godkända.';
    case 'disable':
      return 'Domänen kunde inte stängas av. En orsak på minst 10 tecken krävs.';
    default:
      return null;
  }
}

export default async function DomainsAdmin({ searchParams }: PageProps) {
  const tenant = await currentTenant();
  await requireTenantPermission(tenant, 'domain.manage', '/kommunadmin/domaner');
  const [domains, params] = await Promise.all([listTenantDomains(tenant), searchParams]);
  const message = messageFor(params);

  return (
    <main id="innehall">
      <h1>Domäner</h1>
      <p>
        En egen domän blir aldrig aktiv automatiskt. Ägarskap, DNS och TLS måste vara godkända,
        därefter aktiverar en kommunadministratör den explicit. Plattformens Tryggsignal-adress
        ligger kvar som fallback.
      </p>

      {message !== null ? (
        <p role="status" className="card">
          {message}
        </p>
      ) : null}

      <form action={requestDomainAction} className="card">
        <h2>Lägg till egen domän</h2>
        <p>
          <label>
            Domän
            <br />
            <input
              name="hostname"
              type="text"
              inputMode="url"
              required
              maxLength={253}
              placeholder="bygglov.kommun.se"
              autoCapitalize="none"
              autoCorrect="off"
            />
          </label>
        </p>
        <p className="meta">
          Tryggsignals egna adresser kan inte registreras som custom domains.
        </p>
        <button type="submit">Registrera domän</button>
      </form>

      <section aria-labelledby="h-domains" className="card">
        <h2 id="h-domains">Domänstatus</h2>
        {domains.length === 0 ? (
          <p>Inga domäner är registrerade.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <caption>Domäner för {tenant.tenantSlug}</caption>
              <thead>
                <tr>
                  <th>Domän</th>
                  <th>Typ</th>
                  <th>Status</th>
                  <th>Ägarskap</th>
                  <th>DNS</th>
                  <th>TLS</th>
                  <th>Roll</th>
                  <th>Åtgärd</th>
                </tr>
              </thead>
              <tbody>
                {domains.map((domain) => (
                  <tr key={domain.id}>
                    <td>{domain.normalizedHostname}</td>
                    <td>{domain.domainType}</td>
                    <td>{domain.status}</td>
                    <td>{domain.ownershipStatus}</td>
                    <td>{domain.dnsStatus}</td>
                    <td>{domain.tlsStatus}</td>
                    <td>
                      {domain.isCanonical ? 'Kanonisk' : domain.isFallback ? 'Fallback' : '—'}
                    </td>
                    <td>
                      {domain.domainType === 'CUSTOM_DOMAIN' &&
                      !['ACTIVE', 'DISABLED', 'REMOVED'].includes(domain.status) ? (
                        <form action={verifyDomainAction}>
                          <input type="hidden" name="domainId" value={domain.id} />
                          <button type="submit">Kontrollera</button>
                        </form>
                      ) : null}
                      {domain.domainType === 'CUSTOM_DOMAIN' && domain.status === 'VERIFIED' ? (
                        <form action={activateDomainAction}>
                          <input type="hidden" name="domainId" value={domain.id} />
                          <button type="submit">Aktivera</button>
                        </form>
                      ) : null}
                      {domain.domainType === 'CUSTOM_DOMAIN' &&
                      !['DISABLED', 'REMOVED'].includes(domain.status) ? (
                        <form action={disableDomainAction} style={{ marginTop: '0.5rem' }}>
                          <input type="hidden" name="domainId" value={domain.id} />
                          <label>
                            <span className="sr-only">Orsak till avstängning</span>
                            <input
                              name="reason"
                              required
                              minLength={10}
                              maxLength={500}
                              placeholder="Orsak till avstängning"
                            />
                          </label>{' '}
                          <button type="submit">Stäng av</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {domains
        .filter((domain) => domain.verificationChallenges.length > 0)
        .map((domain) => (
          <section key={domain.id} className="card" aria-labelledby={`dns-${domain.id}`}>
            <h2 id={`dns-${domain.id}`}>DNS-instruktioner — {domain.normalizedHostname}</h2>
            <p>Lägg in minst en av providerens verifieringsposter och kör sedan Kontrollera.</p>
            <table>
              <thead>
                <tr>
                  <th>Typ</th>
                  <th>Namn</th>
                  <th>Värde</th>
                </tr>
              </thead>
              <tbody>
                {domain.verificationChallenges.map((challenge) => (
                  <tr key={`${challenge.type}:${challenge.domain}:${challenge.value}`}>
                    <td>{challenge.type}</td>
                    <td>
                      <code>{challenge.domain}</code>
                    </td>
                    <td>
                      <code>{challenge.value}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
    </main>
  );
}
