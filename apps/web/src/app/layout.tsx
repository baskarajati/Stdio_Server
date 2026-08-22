import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Stdio',
  description: 'Business management for interior and architecture studios.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/* The Product Designer owns the visual design. These components stay unstyled
          until the design tokens arrive. */}
      <body>{children}</body>
    </html>
  );
}
