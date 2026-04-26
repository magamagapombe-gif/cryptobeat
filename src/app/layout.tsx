import type { Metadata, Viewport } from 'next'

export const metadata: Metadata = {
  title: 'CryptoBeat',
  description: 'Predict Bitcoin. Win real UGX every 90 seconds.',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'CryptoBeat' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#050709',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
