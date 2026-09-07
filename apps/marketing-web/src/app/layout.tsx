import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Tryggsignal — Samhällsbyggnad OS',
  description:
    'Tryggsignal är ett kommunalt operativsystem för bygglov, PBL-tillsyn, OVK och samhällsbyggnadsprocesser.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0 }}>{children}</body>
    </html>
  );
}
