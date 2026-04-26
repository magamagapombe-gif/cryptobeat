// src/app/page.tsx
// Serves the single-file HTML app.
// In production you can also move the HTML into a proper React component.
// For now this iframe-free approach just reads and inlines the HTML.

import { readFileSync } from 'fs'
import { join } from 'path'

export default function Home() {
  // The HTML file lives in /public/index.html
  // Next.js serves /public/* statically, so we redirect there.
  // OR: return the HTML inline using dangerouslySetInnerHTML.
  return null  // page.tsx not used — app is served from /public/index.html directly
}

// To serve the app at /, add this to next.config.ts instead:
// async rewrites() {
//   return [{ source: '/', destination: '/index.html' }]
// }
