import './globals.css';
import ClientLayout from './ClientLayout';

export const metadata = {
  title: 'VocalLab — AI Agent Workflow Builder',
  description: 'Build, chain, and automate AI agent workflows with real-time execution monitoring.',
};

/**
 * RootLayout must be a Server Component (no 'use client').
 * Client-side providers are delegated to ClientLayout.
 */
export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>
        <ClientLayout>
          {children}
        </ClientLayout>
      </body>
    </html>
  );
}
