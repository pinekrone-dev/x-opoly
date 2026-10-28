/*
 * Land Quotient's service worker: what makes the site an app on a phone's
 * home screen, and nothing more.
 *
 * Pages always come from the network first, so a deploy is seen on the next
 * open and never shadowed by an old copy; the last page fetched is kept only
 * to open something when the phone has no signal. The built bundles are
 * named by their hash and never change, so they are kept once fetched. The
 * API, the catalogue and the map tiles are never touched here: they carry
 * their own caching and their own limits, and a stale parcel is worse than
 * none.
 */
const SHELL = 'lq-shell-v1'
const ASSETS = 'lq-assets-v1'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, ASSETS].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(SHELL).then((cache) => cache.put('/shell', copy))
          }
          return response
        })
        .catch(() => caches.match('/shell').then((held) => held || Response.error())),
    )
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(ASSETS).then((cache) =>
        cache.match(request).then(
          (held) =>
            held ||
            fetch(request).then((response) => {
              if (response.ok) cache.put(request, response.clone())
              return response
            }),
        ),
      ),
    )
  }
})
