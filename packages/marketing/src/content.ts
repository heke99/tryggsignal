/**
 * Masterplan 1–3, 40, 153, 202: the public site describes what the product
 * actually does. Every claim here must be traceable to something that exists in
 * this repository — no customer names, no certifications we do not hold, no
 * numbers we cannot show the source of.
 */

export interface Module {
  readonly title: string;
  readonly body: string;
}

export const HERO = {
  eyebrow: 'Kommunalt Samhällsbyggnad OS',
  heading: 'Bygglov, tillsyn och OVK i ett system som kommunen faktiskt äger.',
  body: 'Tryggsignal samlar hela samhällsbyggnadsprocessen — från ansökan och komplettering till remiss, beslut, tillsyn och arkiv — i en plattform där varje kommun har sin egen databas, sin egen domän och sin egen profil.',
  primaryCta: { label: 'Boka en pilotgenomgång', href: 'mailto:pilot@tryggsignal.se' },
  secondaryCta: { label: 'Så är plattformen byggd', href: '#arkitektur' },
} as const;

export const HERO_FACTS: readonly string[] = [
  'Egen databas per kommun',
  'Radnivåsäkerhet i databasen',
  'Oföränderlig beslutslogg',
  'Egen domän och egen grafisk profil',
];

export const PROBLEMS: readonly Module[] = [
  {
    title: 'Handläggningen ligger i fyra system',
    body: 'Ärendet i ett ärendesystem, ritningarna i en filserver, remissen i e-posten och beslutet i en mall. Ingen kan svara på var ärendet står utan att öppna alla fyra.',
  },
  {
    title: 'Tidsfristerna räknas för hand',
    body: 'PBL:s tidsfrister startar, pausar och startar om beroende på kompletteringar. Räknas de manuellt blir de fel, och felet upptäcks först när reduktionen av avgiften ska motiveras.',
  },
  {
    title: 'Kommunen äger inte sitt data',
    body: 'När avtalet tar slut ska allt gå att få ut — ärenden, handlingar, beslut och logg — i ett format som går att läsa utan leverantörens programvara.',
  },
];

export const ANSWERS: readonly Module[] = [
  {
    title: 'Ett ärende, en sanning',
    body: 'Ansökan, handlingar, kompletteringar, remisser, yttranden, beslut och tillsyn hänger ihop i samma ärende. Handläggaren ser status, nästa steg och tidsfrist på samma sida.',
  },
  {
    title: 'Tidsfrister som kan förklaras',
    body: 'Varje datum beräknas av en regelmotor med daterade regler och svenska helgdagar, och redovisar sin egen uträkning: startpunkt, avbrott, förlängning och slutdatum.',
  },
  {
    title: 'Uttag utan förhandling',
    body: 'Exportplanen och arkivmodellen är en del av produkten, inte en förhandlingsfråga vid avtalets slut.',
  },
];

export const MODULES: readonly Module[] = [
  {
    title: 'Bygglov och anmälan',
    body: 'Ansökan, fullständighetskontroll, komplettering, granskning, startbesked och slutbesked.',
  },
  {
    title: 'Förhandsbesked',
    body: 'Lokaliseringsprövning med grannhörande, remisser och beslut i samma flöde som lovärendet.',
  },
  {
    title: 'Remisser och yttranden',
    body: 'Interna och externa remissinstanser med egna svarstider, påminnelser och spårbara svar.',
  },
  {
    title: 'PBL-tillsyn',
    body: 'Anmälan om olovlig åtgärd, utredning, föreläggande, viten och uppföljning.',
  },
  {
    title: 'OVK',
    body: 'Besiktningsintervall, förfallodatum, påminnelser och åtgärder per byggnad och ventilationssystem.',
  },
  {
    title: 'Beslut och delgivning',
    body: 'Beslutsunderlag, delegationsordning, expediering, kungörelse och överklagandetid.',
  },
  {
    title: 'Dokument och versioner',
    body: 'Handlingar med versionshistorik, proveniens och behörighetsstyrd åtkomst per ärende.',
  },
  {
    title: 'Arkiv och gallring',
    body: 'Bevarande- och gallringsregler som följer handlingen genom hela dess livslängd.',
  },
  {
    title: 'Mina sidor',
    body: 'Sökanden ser sitt ärende, vad som saknas och vad som händer härnäst — utan att ringa växeln.',
  },
  {
    title: 'Uppföljning',
    body: 'Volymer, handläggningstider och tidsfristefterlevnad, beräknat på ärendedata i stället för på uppskattningar.',
  },
];

export const ARCHITECTURE: readonly Module[] = [
  {
    title: 'Ett data plane per kommun',
    body: 'Varje kommun får en egen databas. Det är inte delade tabeller med ett kommun-id i en kolumn — två kommuners data ligger fysiskt åtskilda, vilket gör personuppgiftsansvaret och uttaget av data enkelt att beskriva.',
  },
  {
    title: 'Behörighet i tre lager',
    body: 'Roller (RBAC), attribut som förvaltning, avdelning och team (ABAC), och radnivåsäkerhet (RLS) i databasen. Sista lagret gäller även om ett fel i applikationen skulle släppa igenom en förfrågan.',
  },
  {
    title: 'Oföränderlig revisionskedja',
    body: 'Händelser skrivs till en logg som bara kan läggas till, där varje post är hashlänkad till den föregående. En ändrad eller borttagen post går att upptäcka.',
  },
  {
    title: 'Deterministisk regelmotor',
    body: 'Regler är data med giltighetstid, inte kod. Samma ärende och samma datum ger alltid samma utfall, och utfallet går att spela upp i efterhand.',
  },
  {
    title: 'Proveniens på varje uppgift',
    body: 'Varje uppgift bär med sig varifrån den kommer — myndighetsdata, referensdata, bedömning eller maskinellt härledd. En AI-härledd uppgift kan aldrig tyst passera som beslutsunderlag.',
  },
  {
    title: 'Köer som överlever omstart',
    body: 'Bakgrundsarbete ligger i databasens egna köer med kvittens och återförsök. Ett jobb försvinner inte för att en process startades om.',
  },
];

export const WHITE_LABEL = {
  heading: 'Kommunens egen portal, inte en leverantörsportal',
  body: 'Varje kommun körs på sin egen adress — kommun.tryggsignal.se eller kommunens egen domän, till exempel bygglov.kommun.se. Profilen sätts med designtoken: färger, logotyp och typografi. Kommunen levererar aldrig egen CSS eller egna skript, så en profiländring kan inte påverka säkerheten.',
  points: [
    'Egen domän med eget certifikat',
    'Kontrastkrav enligt WCAG 2.2 AA kontrolleras innan en profil kan publiceras',
    'Publicering och återställning av profilen loggas som en händelse',
    'Sessionen är bunden till kommunens värdnamn och följer inte med till en annan kommun',
  ],
} as const;

export const COMPLIANCE: readonly Module[] = [
  {
    title: 'Dataskydd',
    body: 'Underlag för konsekvensbedömning, registerförteckning och personuppgiftsbiträdesavtal ingår i leveransen.',
  },
  {
    title: 'Offentlighet och arkiv',
    body: 'Handlingar, diarieföring och gallringsregler är modellerade i systemet, inte påklistrade efteråt.',
  },
  {
    title: 'Tillgänglighet',
    body: 'Gränssnittet byggs mot WCAG 2.2 AA med riktiga rubriker, tabeller, formuläretiketter och synlig fokusmarkering.',
  },
  {
    title: 'Avslut',
    body: 'Exportplan, format och tidplan för att lämna plattformen är dokumenterade från dag ett.',
  },
];

export const CTA = {
  heading: 'Vi söker pilotkommuner',
  body: 'Tryggsignal är under uppbyggnad och tar in ett litet antal pilotkommuner. En pilot innebär att vi går igenom er nuvarande process, sätter upp en egen miljö åt er och kör ett verkligt ärendeflöde innan ni binder er till något.',
  email: 'pilot@tryggsignal.se',
} as const;
