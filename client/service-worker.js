/**
 * Service worker for the Federated Wiki Chess PWA / popup window.
 *
 * Precaches the app shell so the standalone chess window installs and plays offline.
 * Network-first fetch — prefer live builds, fall back to cache when offline.
 * Manifest is always fetched from the network (never cached) so install metadata stays current.
 * Bump CACHE_NAME whenever the precached asset list or fetch policy changes.
 * Freshness: wiki-server serves /plugins/chess/* with max-age=1h; this worker
 * uses cache:'no-store' so online PWAs pick up new builds (hop dials, etc.).
 */
const CACHE_NAME = 'wiki-chess-pwa-cache-v97'

// Relative to this script URL (/plugins/chess/service-worker.js).
const assetsToCache = [
  './',
  'index.html',
  'chess-app.js',
  'cm-modules-bundle.js',
  'icon-120.png',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
  'assets/js/stockfish-18-lite-single.js',
  'assets/js/stockfish-18-lite-single.wasm',
  'assets/js/bootstrap.bundle.min.js',
  'assets/js/es-module-shims.min.js',
  'assets/js/jquery-3.3.1.slim.min.js',
  'assets/js/bootstrap-auto-dark-mode.js',
  'assets/styles/all.min.css',
  'assets/styles/cm-modules.css',
  'assets/styles/wiki-chess.css',
  'assets/pieces/merida.svg',
  'assets/pieces/celtic.svg',
  'assets/pieces/cburnett.svg',
  'assets/pieces/chessnut.svg',
  'assets/pieces/kiwen-suwi.svg',
  'assets/pieces/kosal.svg',
  'assets/pieces/mpchess.svg',
  'assets/pieces/pixel.svg',
  'assets/pieces/shapes.svg',
  'assets/extensions/markers/markers.svg',
]

function precacheUrl(relativePath) {
  return new URL(relativePath, self.location).href
}

function isManifestRequest(url) {
  return /\/manifest\.(?:json|webmanifest)$/.test(url.pathname)
}

// Auth + journal bridge must hit the wiki origin directly — a SW network blip
// would otherwise surface as a locked padlock / yellow-halo flash on mobile focus.
function isPwaBridgeRequest(url) {
  return /\/plugin\/chess\/pwa(?:\/|$)/.test(url.pathname)
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(
        assetsToCache.map(relativePath =>
          cache.add(precacheUrl(relativePath)).catch(err => {
            console.warn('wiki-chess SW: precache skip', relativePath, err)
          }),
        ),
      ),
    ),
  )
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (isManifestRequest(url) || isPwaBridgeRequest(url)) {
    event.respondWith(fetch(event.request))
    return
  }

  // Bypass the browser HTTP cache (wiki-server sets max-age=1h on /plugins/chess/*).
  // Network-first still falls back to the precache when offline.
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then(response => response)
      .catch(() => caches.match(event.request).then(hit => hit || caches.match(event.request, { ignoreSearch: true }))),
  )
})
