- kommunen kan använda egen domän,
- kommunen kan få egen branding,
- kommunen kan migrera utan fork,
- Tryggsignal kan deploya en version till alla kompatibla tenants,
- tenant-specifika skillnader är konfiguration, inte kundspecifik kod.

---

# 218. SLUTLIG DOMÄNMÅLBILD

Målbild:

```text
                         tryggsignal.se
                         Marketing
                              │
                              │
                    app.tryggsignal.se
                   Central app / launcher
                              │
                  kommuner.tryggsignal.se
                   Municipality discovery
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
mjolby.tryggsignal.se  motala.tryggsignal.se   ...
          │                   │
          │                   │
  custom domain        custom domain
samhallsbyggnad...     bygglov...
          │                   │
          ↓                   ↓
    Tenant Resolver      Tenant Resolver
          │                   │
          ↓                   ↓
  Supabase Mjölby       Supabase Motala
     Data Plane            Data Plane
```

Samma applikationskod.

Separata kommunala data planes.

Separata auth-/security-contexts.

White-label från tenantkonfiguration.

---

# 219. SLUTLIG AGENTREGEL

Agenten ska efter den tidigare punkt 148 fortsätta med punkterna 149–219.

Agenten får inte betrakta masterplanen som klar bara för att de ursprungliga P0–P33 är GREEN.

Även P34–P40 och samtliga domain/white-label-gates ska vara GREEN eller dokumenterat EXTERNAL_BLOCKED.

När domän eller Vercel-funktioner implementeras ska aktuell officiell Vercel-dokumentation verifieras före writes.

När Supabase-relaterade förändringar görs ska aktuell Supabase-dokumentation och relevanta Supabase skills användas.

Arbetet fortsätter automatiskt enligt samma exekveringsloop tills hela V3-planen är verifierad.

---

# 220. SLUTLIG SKILL-NAMNGIVNING — LÅST

Punkt 211 behålls som historiskt krav, men de projektspecifika skill-namnen har därefter konsoliderats enligt användarens slutliga skill-stack. Agenten ska **inte** skapa parallella dubblettskills för äldre arbetsnamn.

Följande 10 projektskills är canonical:

```text
tryggsignal-masterplan
tryggsignal-architecture
tryggsignal-security
tryggsignal-database
tryggsignal-integration
tryggsignal-migration
tryggsignal-pbl
tryggsignal-whitelabel
tryggsignal-e2e
tryggsignal-performance
```

Äldre arbetsnamn i punkt 211 mappas så här:

```text
tryggsignal-security-gate       → tryggsignal-security
tryggsignal-database-review     → tryggsignal-database
tryggsignal-integration-adapter → tryggsignal-integration
tryggsignal-pbl-domain          → tryggsignal-pbl
tryggsignal-document-security   → tryggsignal-security + tryggsignal-integration
tryggsignal-e2e-municipality    → tryggsignal-e2e
tryggsignal-masterplan-agent    → tryggsignal-masterplan
```

De 12 officiella router-skillsen plus dessa 10 projektskills utgör den låsta 22-skill-stack som ska användas i Tryggsignal.
