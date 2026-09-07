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
        <a className="skip-link" href="#huvudinnehall">
          Hoppa till huvudinnehåll
        </a>
        <div id="huvudinnehall">{children}</div>
      </body>
    </html>
  );
}
