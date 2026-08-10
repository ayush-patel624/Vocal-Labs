'use client';
import { AuthProvider } from '@/lib/auth';

/**
 * ClientLayout wraps the app in client-side providers.
 * This component must be separate from the RootLayout so that
 * RootLayout can remain a Server Component (required by Next.js
 * App Router when using <html> and <head> tags with metadata).
 */
export default function ClientLayout({ children }) {
  return (
    <AuthProvider>
      <div className="app-container">
        {children}
      </div>
    </AuthProvider>
  );
}
