/**
 * Masterplan 177/197: the platform surface is reachable only on Tryggsignal's own
 * approved host. The proxy never rewrites a municipality domain here.
 */
export default function PlatformAdmin() {
  return (
    <main id="innehall">
      <h1>Plattformsadministration</h1>
      <p>
        Tenantregister, domänstatus, provisionering och driftsläge. Ingen stående läsåtkomst till
        kommunernas innehåll finns här — supportåtkomst sker via tidsbegränsad break glass med
        godkännande, MFA och revision.
      </p>
    </main>
  );
}
