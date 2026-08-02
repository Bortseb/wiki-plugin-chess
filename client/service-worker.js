/**
 * Chess PWA / popup SW. Precaches the app shell; cooperates with parent wiki pack:
 * activate only retires wiki-chess-pwa-cache-* (never fedwiki-pwa-* or puzzle DB);
 * miss falls back to fedwiki-pwa-*; warm cache-first (Android often lies about online).
 * Parent wiki-client SW (domain PWA) warms this list into CACHE_NAME + fedwiki-pwa-* and
 * must not cache /plugin/chess/pwa/* (bridge stays network-only here and there).
 * Bump CACHE_NAME when assets/policy change. Keep wiki-chess-pwa-cache- prefix.
 */
const CACHE_NAME = 'wiki-chess-pwa-cache-v1'
const CHESS_CACHE_PREFIX = 'wiki-chess-pwa-cache-'
const PARENT_CACHE_PREFIX = 'fedwiki-pwa-'

// Relative to /plugins/chess/service-worker.js — parent pack parses this list too.
const assetsToCache = [
  './',
  'index.html',
  'chess.js',
  'chess-app.js',
  'cm-modules-bundle.js',
  'glicko-worker.js',
  'icon-120.png',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
  'assets/books/openings.bin',
  'assets/js/stockfish-18-lite-single.js',
  'assets/js/stockfish-18-lite-single.wasm',
  'assets/js/bootstrap.bundle.min.js',
  'assets/js/es-module-shims.min.js',
  'assets/js/jquery-3.3.1.slim.min.js',
  'assets/js/bootstrap-auto-dark-mode.js',
  'assets/styles/all.min.css',
  'assets/styles/cm-modules.css',
  'assets/styles/wiki-chess.css',
  'assets/styles/chessboard.css',
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
  'assets/extensions/markers/markers.css',
  'assets/extensions/arrows/arrows.css',
  'assets/extensions/arrows/arrows.svg',
  'assets/extensions/promotion-dialog/promotion-dialog.css',
  'assets/extensions/select-piece-dialog.css',
  'assets/images/chessboard-sprite.svg',
  'assets/sounds/chess_console_sounds.mp3',
  'assets/chess/webfonts/fa-brands-400.woff2',
  'assets/chess/webfonts/fa-regular-400.woff2',
  'assets/chess/webfonts/fa-solid-900.woff2',
  'assets/chess/webfonts/fa-brands-400.woff',
  'assets/chess/webfonts/fa-regular-400.woff',
  'assets/chess/webfonts/fa-solid-900.woff',
]

const precacheUrl = rel => new URL(rel, self.location).href
const isManifestRequest = url => /\/manifest\.(?:json|webmanifest)$/.test(url.pathname)
const isPwaBridgeRequest = url => /\/plugin\/chess\/pwa(?:\/|$)/.test(url.pathname)
const offline503 = () => new Response('', { status: 503, statusText: 'Offline' })

async function matchInCache(cache, request) {
  const pathname = new URL(request.url).pathname
  return (
    (await cache.match(request, { ignoreSearch: true })) ||
    (await cache.match(pathname, { ignoreSearch: true })) ||
    (await cache.match(request)) ||
    null
  )
}

async function matchChessCache(request) {
  const hit = await matchInCache(await caches.open(CACHE_NAME), request)
  if (hit) return hit
  try {
    for (const key of await caches.keys()) {
      if (!key.startsWith(PARENT_CACHE_PREFIX)) continue
      const parentHit = await matchInCache(await caches.open(key), request)
      if (parentHit) return parentHit
    }
  } catch {
    /* keep */
  }
  return null
}

async function putChessCache(request, response) {
  if (!response?.ok || request.method !== 'GET') return
  try {
    await (await caches.open(CACHE_NAME)).put(request, response.clone())
  } catch {
    /* keep */
  }
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(
        assetsToCache.map(rel =>
          cache.add(precacheUrl(rel)).catch(err => console.warn('wiki-chess SW: precache skip', rel, err)),
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
      .then(keys =>
        Promise.all(keys.filter(k => k.startsWith(CHESS_CACHE_PREFIX) && k !== CACHE_NAME).map(k => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (isManifestRequest(url) || isPwaBridgeRequest(url)) {
    event.respondWith(fetch(event.request))
    return
  }
  if (url.origin !== self.location.origin) return

  event.respondWith(
    (async () => {
      if (navigator.onLine === false) return (await matchChessCache(event.request)) || offline503()

      const warm = await matchChessCache(event.request)
      if (warm) {
        fetch(event.request, { cache: 'no-store' })
          .then(res => {
            if (res?.ok) putChessCache(event.request, res)
          })
          .catch(() => {})
        return warm
      }

      try {
        const signal =
          typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
        const res = await fetch(event.request, { cache: 'no-store', signal })
        if (res?.ok) {
          await putChessCache(event.request, res)
          return res
        }
        return (await matchChessCache(event.request)) || res
      } catch {
        return (await matchChessCache(event.request)) || offline503()
      }
    })(),
  )
})
