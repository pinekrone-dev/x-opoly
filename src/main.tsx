import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

/*
 * The service worker that makes the site installable as an app. Production
 * only: in development it would hold on to bundles the dev server is busy
 * replacing.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // No service worker is no app install, and nothing else changes.
    })
  })
}
