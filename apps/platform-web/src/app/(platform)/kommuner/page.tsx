/** Masterplan 176: discovery only. Choosing a municipality in the UI grants no data access. */
export default function MunicipalityDiscovery() {
  return (
    <main>
      <h1>Kommuner i Tryggsignal</h1>
      <p>
        Här listas anslutna kommuner, pilotstatus och kontaktvägar. Valet av kommun i det här
        gränssnittet ger ingen åtkomst till ärendedata — åtkomsten avgörs i kommunens eget data
        plane.
      </p>
    </main>
  );
}
