import type { Metadata } from 'next';
import '@tryggsignal/marketing/styles.css';

export const metadata: Metadata = {
  title: 'Tryggsignal — Kommunalt Samhällsbyggnad OS',
  description:
    'Tryggsignal samlar bygglov, anmälan, förhandsbesked, PBL-tillsyn, OVK, remisser, beslut och arkiv i en plattform där varje kommun har sin egen databas, sin egen domän och sin egen profil.',
  openGraph: {
    type: 'website',
    locale: 'sv_SE',
    siteName: 'Tryggsignal',
    title: 'Tryggsignal — Kommunalt Samhällsbyggnad OS',
    description:
      'Bygglov, tillsyn och OVK i ett system som kommunen faktiskt äger. Egen databas per kommun, radnivåsäkerhet och en oföränderlig beslutslogg.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv">
      <body style={{ margin: 0 }}>
        <a className="tsm__skip" href="#innehall">
          Hoppa till huvudinnehåll
        </a>
        {children}
      </body>
    </html>
  );
}
