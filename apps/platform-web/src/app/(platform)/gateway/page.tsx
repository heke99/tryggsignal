/**
 * Masterplan 175: `app.tryggsignal.se` never opens a municipality by an arbitrary
 * tenant id. The launcher lists only tenants where the signed-in user has a
 * verified relation, and then hands off to that tenant's own host.
 */
export default function AppGateway() {
  return (
    <main>
      <h1>Välj kommun</h1>
      <p>
        Logga in för att se de kommuner där du har en verifierad behörighet. Ärendedata öppnas
        alltid på kommunens egen domän, aldrig här.
      </p>
      <div className="card">
        <p className="meta">
          Inloggning sker mot respektive kommuns identitetskonfiguration. Sessionen är värdbunden —
          den följer inte med till en annan kommuns domän.
        </p>
      </div>
    </main>
  );
}
