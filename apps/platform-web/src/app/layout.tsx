import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tryggsignal',
  description: 'Kommunalt Samhällsbyggnad OS',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv">
      <body>
        {/* Masterplan 97: the skip link has to land past the navigation, so it
            targets the page's own <main>, not a wrapper around everything. The
            id is the same in `apps/marketing-web`, so the two behave alike. */}
        <a className="skip-link" href="#innehall">
          Hoppa till huvudinnehåll
        </a>
        {children}
      </body>
    </html>
  );
}
