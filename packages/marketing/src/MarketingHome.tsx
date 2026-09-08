import {
  ANSWERS,
  ARCHITECTURE,
  COMPLIANCE,
  CTA,
  HERO,
  HERO_FACTS,
  MODULES,
  PROBLEMS,
  WHITE_LABEL,
} from './content';

/**
 * The public site. Rendered both by `apps/marketing-web` and by the platform's
 * own MARKETING surface (apex and www), so the two can never drift apart.
 */
export function MarketingHome({ rootDomain = 'tryggsignal.se' }: { rootDomain?: string }) {
  return (
    <div className="tsm">
      <header className="tsm__header">
        <div className="tsm__wrap tsm__headerInner">
          <a className="tsm__brand" href="/">
            <Mark />
            Tryggsignal
          </a>
          <nav className="tsm__nav" aria-label="Huvudmeny">
            <a href="#problem">Varför</a>
            <a href="#moduler">Moduler</a>
            <a href="#arkitektur">Arkitektur</a>
            <a href="#kommunen">Er portal</a>
            <a href={`mailto:${CTA.email}`}>Kontakt</a>
          </nav>
        </div>
      </header>

      <main id="innehall">
        <section className="tsm__hero">
          <div className="tsm__wrap">
            <p className="tsm__eyebrow">{HERO.eyebrow}</p>
            <h1>{HERO.heading}</h1>
            <p className="tsm__lead">{HERO.body}</p>
            <div className="tsm__actions">
              <a className="tsm__btn tsm__btn--primary" href={HERO.primaryCta.href}>
                {HERO.primaryCta.label}
              </a>
              <a className="tsm__btn tsm__btn--ghost" href={HERO.secondaryCta.href}>
                {HERO.secondaryCta.label}
              </a>
            </div>
            <ul className="tsm__facts">
              {HERO_FACTS.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="tsm__section tsm__section--alt" id="problem">
          <div className="tsm__wrap">
            <p className="tsm__eyebrow">Utgångsläget</p>
            <h2>Tre saker som kostar mest i en samhällsbyggnadsförvaltning</h2>
            <p className="tsm__sectionLead">
              Det här är problemen Tryggsignal är byggt för att lösa — inte alla problem en kommun
              har.
            </p>
            <ul className="tsm__grid">
              {PROBLEMS.map((item, index) => (
                <li className="tsm__card" key={item.title}>
                  <span className="tsm__num">{String(index + 1).padStart(2, '0')}</span>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="tsm__section">
          <div className="tsm__wrap">
            <p className="tsm__eyebrow">Svaret</p>
            <h2>Ett ärende som håller ihop hela vägen till arkivet</h2>
            <ul className="tsm__grid">
              {ANSWERS.map((item) => (
                <li className="tsm__card" key={item.title}>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="tsm__section tsm__section--alt" id="moduler">
          <div className="tsm__wrap">
            <p className="tsm__eyebrow">Omfattning</p>
            <h2>Moduler</h2>
            <p className="tsm__sectionLead">
              Modulerna delar samma ärendemodell, samma behörighetsmodell och samma revisionslogg.
              En kommun kan börja med lov och anmälan och lägga till resten utan att data behöver
              flyttas.
            </p>
            <ul className="tsm__grid">
              {MODULES.map((item) => (
                <li className="tsm__card" key={item.title}>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="tsm__section" id="arkitektur">
          <div className="tsm__wrap">
            <p className="tsm__eyebrow">Så är det byggt</p>
            <h2>Arkitekturen är en del av upphandlingsunderlaget</h2>
            <p className="tsm__sectionLead">
              En kommun ska kunna granska hur systemet skyddar personuppgifter och beslut, inte bara
              läsa att det gör det.
            </p>
            <ul className="tsm__grid">
              {ARCHITECTURE.map((item) => (
                <li className="tsm__card" key={item.title}>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="tsm__section tsm__section--alt" id="kommunen">
          <div className="tsm__wrap">
            <div className="tsm__split">
              <div>
                <p className="tsm__eyebrow">Er portal</p>
                <h2>{WHITE_LABEL.heading}</h2>
                <p className="tsm__sectionLead">{WHITE_LABEL.body}</p>
                <ul className="tsm__checks">
                  {WHITE_LABEL.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </div>
              <div className="tsm__hosts" aria-label="Exempel på adresser">
                <div className="tsm__host">
                  <code>{rootDomain}</code>
                  <span>Den här sidan</span>
                </div>
                <div className="tsm__host">
                  <code>{`kommun.${rootDomain}`}</code>
                  <span>Kommunens portal</span>
                </div>
                <div className="tsm__host">
                  <code>bygglov.kommun.se</code>
                  <span>Kommunens egen domän</span>
                </div>
                <div className="tsm__host">
                  <code>{`app.${rootDomain}`}</code>
                  <span>Inloggning för handläggare</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="tsm__section">
          <div className="tsm__wrap">
            <p className="tsm__eyebrow">Efterlevnad</p>
            <h2>Det som måste vara på plats innan systemet får användas</h2>
            <ul className="tsm__grid">
              {COMPLIANCE.map((item) => (
                <li className="tsm__card" key={item.title}>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="tsm__section tsm__section--alt">
          <div className="tsm__wrap">
            <div className="tsm__cta">
              <h2>{CTA.heading}</h2>
              <p>{CTA.body}</p>
              <a className="tsm__btn" href={`mailto:${CTA.email}`}>
                Skriv till {CTA.email}
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="tsm__footer">
        <div className="tsm__wrap tsm__footerInner">
          <p style={{ margin: 0 }}>Tryggsignal — Kommunalt Samhällsbyggnad OS. Under uppbyggnad.</p>
          <p style={{ margin: 0 }}>
            <a href={`mailto:${CTA.email}`}>{CTA.email}</a>
          </p>
        </div>
      </footer>
    </div>
  );
}

function Mark() {
  return (
    <svg className="tsm__mark" viewBox="0 0 32 32" role="img" aria-hidden="true" focusable="false">
      <path
        d="M16 2.5 27 7v9.2c0 6.6-4.4 11.7-11 13.3-6.6-1.6-11-6.7-11-13.3V7L16 2.5Z"
        fill="none"
        stroke="var(--tsm-brand)"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path
        d="m11 16.4 3.4 3.4L21.4 13"
        fill="none"
        stroke="var(--tsm-accent)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
