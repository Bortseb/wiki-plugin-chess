/**
 * PWA bridge — HTTP routes for the installed chess app when it has no wiki iframe parent.
 * Loaded lazily on the first /plugin/chess/pwa/* request.
 *
 * Site reads use `createPwaBridgeSiteClient` (exported for tests) — Node counterpart to
 * `createBrowserWikiSiteClient` in src/federation.js (browser shell only).
 *
 * Uses a tiny path router instead of express.Router so the plugin does not
 * depend on express (wiki-server provides the app; express is not resolvable
 * from the plugin package root).
 */

import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'

import {
  buildJoinChallengePage,
  buildNewGamePage,
  chessItemStateFromPage,
  runNeighborhoodJob,
  orchestrateSiteSurveyDeferredWork,
  materializeJoinChallengePage,
  slugsFromSitemap,
  probeWikiSite,
  fetchWikiResourceWithProtocolFallback,
  farmSiteDirFromSite,
  isLoopbackWikiHost,
  loopbackPortForHost,
  syncOpenChallengeSurveyOnPage,
  SURVEY_PAGE_SLUG,
  SURVEY_PAGE_TITLE,
  SURVEY_PAGE_STORY,
  normalizeChallengeState,
} from '../src/federation.js'
import { proposeUniquePageTitle, pageSlug, sitesMatch, coerceBlockListMeta } from '../src/federation.js'
import {
  applyChessSaveToPage,
  applyPageAction,
  rebuildStoryFromJournal,
  MSG,
  shouldPersistChessItemText,
} from '../src/chess-core.js'

// # Request Helpers and IndexedDB Payload

// IndexedDB neighborhood meta from `federationIndexedDbPayload()` — forward into fetch jobs like the shell.
export function federationIndexedDbOptsFromPayload(data = {}) {
  const blockList = coerceBlockListMeta(data)
  return {
    blockList: blockList || data?.blockList,
    deletionMetrics: data?.deletionMetrics,
    island: data?.island,
    knownOpponents: Array.isArray(data?.knownOpponents) ? data.knownOpponents : undefined,
    knownFederationSites: data?.knownFederationSites,
    siteCrawlCache: data?.siteCrawlCache,
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') {
      resolve(req.body)
      return
    }
    let raw = ''
    req.on('data', chunk => {
      raw += chunk
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function promisifyGet(pagehandler, slug) {
  return new Promise(resolve => {
    pagehandler.get(String(slug), (err, page, status) => {
      resolve({ err, page, status: status || (page ? 200 : 404) })
    })
  })
}

function promisifyPut(pagehandler, slug, page) {
  return new Promise((resolve, reject) => {
    pagehandler.put(String(slug), page, err => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function normalizeLocalPage(page) {
  if (!page) return page
  // Prefer the persisted story when present — rebuilding a long journal can reorder
  // captioned code blocks (leaderboard checkpoint / top tiers) and break parsing.
  if (Array.isArray(page.story) && page.story.length) return page
  if (Array.isArray(page.journal)) page.story = rebuildStoryFromJournal(page)
  return page
}

async function readLocalSitemap(argv, localSite) {
  const dirs = []
  const dataDir = String(argv?.data || '').trim()
  if (dataDir) dirs.push(path.join(dataDir, 'status'))
  const statusDir = String(argv?.status || '').trim()
  if (statusDir && !dirs.includes(statusDir)) dirs.push(statusDir)

  for (const dir of dirs) {
    try {
      const raw = await fsPromises.readFile(path.join(dir, 'sitemap.json'), 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) return parsed
    } catch {
      /* try next location */
    }
  }

  return fetchSitemapViaLoopback(localSite)
}

async function fetchSitemapViaLoopback(localSite) {
  const host = String(localSite || '')
    .trim()
    .toLowerCase()
  if (!host) return null
  const parsed = await fetchWikiJsonLoopback(host, 'system/sitemap.json', { requestHost: host })
  return Array.isArray(parsed) && parsed.length ? parsed : null
}

// Loopback HTTP with Host header — Node fetch cannot override Host on *.localhost farms.
async function fetchWikiJsonLoopback(host, slug, { requestHost = '', timeoutMs = 8000 } = {}) {
  const h = String(host || '')
    .trim()
    .toLowerCase()
  if (!h) return null
  const slugKey = String(slug || '')
    .replace(/^\//, '')
    .replace(/\.json$/i, '')
  const pathStr = `/${slugKey}.json`
  const port = Number(loopbackPortForHost(h, loopbackPortForHost(requestHost, '80'))) || 80
  const http = await import('node:http')
  return new Promise(resolve => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathStr,
        method: 'GET',
        headers: { Host: h },
      },
      res => {
        if (res.statusCode !== 200) {
          res.resume()
          resolve(null)
          return
        }
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', chunk => {
          raw += chunk
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw))
          } catch {
            resolve(null)
          }
        })
      },
    )
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve(null)
    })
    req.end()
  })
}

function farmSiteRoot(argv, host) {
  const dataRoot = String(argv?.data || '').trim()
  const dirName = farmSiteDirFromSite(host)
  if (!dataRoot || !dirName) return null
  return path.join(dataRoot, dirName)
}

async function readFarmSiteJson(argv, host, ...parts) {
  const siteRoot = farmSiteRoot(argv, host)
  if (!siteRoot) return null
  const filePath = path.join(siteRoot, ...parts)
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    if (parts.length && String(parts[parts.length - 1]).endsWith('.json')) {
      const alt = [...parts]
      alt[alt.length - 1] = alt[alt.length - 1].replace(/\.json$/i, '')
      try {
        const raw = await fsPromises.readFile(path.join(siteRoot, ...alt), 'utf8')
        return JSON.parse(raw)
      } catch {
        return null
      }
    }
    return null
  }
}

async function readFarmWikiPage(argv, host, pageSlugKey) {
  const page = await readFarmSiteJson(argv, host, 'pages', `${pageSlugKey}.json`)
  return page ? normalizeLocalPage(page) : null
}

async function discoverFarmNeighborhoodSites(argv, localSite) {
  const local = String(localSite || '')
    .trim()
    .toLowerCase()
  const port = loopbackPortForHost(local, '3001')
  const fromArgv = String(argv?.neighbors || '')
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(Boolean)
    .filter(h => !sitesMatch(h, local))
  if (fromArgv.length) {
    return fromArgv.map(h => (h.includes(':') ? h : `${h}:${port}`))
  }
  // Match the browser shell: seeds are localSite + wiki.neighborhood, not every farm site.
  // Opponent-graph crawls still discover remote hosts from rated games.
  return []
}

async function fetchRemoteWikiPage(host, slug, localSite, argv) {
  const h = String(host || '')
    .trim()
    .toLowerCase()
  const pathStr = String(slug || '').replace(/^\//, '')
  const pageSlugKey = pathStr.replace(/\.json$/i, '')

  const diskPage = await readFarmWikiPage(argv, h, pageSlugKey)
  if (diskPage) return diskPage

  if (isLoopbackWikiHost(h)) {
    const loopbackPage = await fetchWikiJsonLoopback(h, pathStr, { requestHost: localSite })
    return loopbackPage ? normalizeLocalPage(loopbackPage) : null
  }

  try {
    const res = await fetchWikiResourceWithProtocolFallback(h, pathStr, {
      allowHttpFallback: true,
      timeoutMs: 8000,
    })
    if (!res) return null
    return normalizeLocalPage(await res.json())
  } catch {
    return null
  }
}

// # PWA Site Client Factory

export function createPwaBridgeSiteClient(pagehandler, localSite, argv) {
  const hostNorm = String(localSite || '')
    .trim()
    .toLowerCase()
  return {
    async getPage(host, slug) {
      const h = String(host || '')
        .trim()
        .toLowerCase()
      const pathStr = String(slug || '').replace(/^\//, '')
      const pageSlugKey = pathStr.replace(/\.json$/i, '')
      // Sitemap lives in each wiki's status dir (argv.data/status on farm hosts), not pagehandler.
      if (pageSlugKey === 'system/sitemap') {
        const farmSitemap = await readFarmSiteJson(argv, h, 'status', 'sitemap.json')
        if (Array.isArray(farmSitemap) && farmSitemap.length) return farmSitemap
        if (sitesMatch(h, hostNorm)) return readLocalSitemap(argv, hostNorm)
        if (isLoopbackWikiHost(h)) {
          return fetchWikiJsonLoopback(h, 'system/sitemap.json', { requestHost: hostNorm })
        }
        try {
          const res = await fetchWikiResourceWithProtocolFallback(h, 'system/sitemap.json', {
            allowHttpFallback: true,
            timeoutMs: 8000,
          })
          if (!res) return null
          return res.json()
        } catch {
          return null
        }
      }
      if (sitesMatch(h, hostNorm)) {
        const { page, status } = await promisifyGet(pagehandler, pageSlugKey)
        return status === 404 ? null : normalizeLocalPage(page)
      }
      return fetchRemoteWikiPage(h, pathStr, hostNorm, argv)
    },
    async listSlugs(host) {
      const sitemap = await this.getPage(host, 'system/sitemap.json')
      return slugsFromSitemap(sitemap)
    },
  }
}

// # Manifest and Favicon

// mtime-based cache buster for `/favicon.png` (installed PWA icon + document favicon).
export function wikiFaviconRevision(faviconPath) {
  if (!faviconPath) return null
  try {
    return String(Math.trunc(fs.statSync(faviconPath).mtimeMs))
  } catch {
    return null
  }
}

function sessionPayload(req, securityhandler, localSite, argv = {}) {
  const isOwner = Boolean(securityhandler?.isAuthorized?.(req))
  const ownerName = String(securityhandler?.getOwner?.() || '').trim()
  const faviconRev = wikiFaviconRevision(resolveWikiFaviconPath(argv))
  return {
    isOwner,
    isAuthenticated: isOwner,
    ownerName,
    pageOnThisWiki: isOwner,
    ownerCanJournalHere: isOwner,
    guestLocalStoragePersist: false,
    viewerCanClaimWikiSeat: isOwner,
    viewerAuthenticated: isOwner,
    wikiSite: localSite,
    ...(faviconRev ? { faviconRev } : {}),
  }
}

function requireOwner(req, res, securityhandler) {
  if (!securityhandler?.isAuthorized?.(req)) {
    res.status(401).json({ error: 'must be owner' })
    return false
  }
  return true
}

function isBridgeOwner(req, securityhandler) {
  return Boolean(securityhandler?.isAuthorized?.(req))
}

async function loadLocalPage(pagehandler, slug) {
  const clean = String(slug || '')
    .trim()
    .replace(/\.json$/i, '')
  const { page, status } = await promisifyGet(pagehandler, clean)
  if (status === 404 || !page) return null
  page.slug = clean
  return normalizeLocalPage(page)
}

async function saveLocalPage(pagehandler, slug, page, handlers = {}) {
  const clean = String(slug || '')
    .trim()
    .replace(/\.json$/i, '')
  await promisifyPut(pagehandler, clean, page)
  handlers.sitemaphandler?.update?.(clean, page)
  handlers.searchhandler?.update?.(clean, page)
}

function requestHost(req, argv) {
  return String(req.headers?.host || argv?.url || argv?.host || 'localhost')
    .trim()
    .toLowerCase()
}

// Public for tests — prefer X-Forwarded-Proto when TLS terminates at a reverse proxy.
export function requestOrigin(req, argv) {
  const host = requestHost(req, argv)
  const forwarded = String(req.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
  const proto = forwarded || (req.socket?.encrypted || req.connection?.encrypted ? 'https' : 'http') || 'http'
  return `${proto}://${host}`
}

// Read PNG width/height from the IHDR chunk (sync, for manifest icon metadata).
export function readPngDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

// Wiki site favicon on disk (`argv.status/favicon.png`).
export function resolveWikiFaviconPath(argv = {}) {
  const statusDir = argv?.status
  if (!statusDir) return null
  const favLoc = path.join(statusDir, 'favicon.png')
  try {
    return fs.existsSync(favLoc) ? favLoc : null
  } catch {
    return null
  }
}

// Manifest icons: prefer the wiki flag when it is install-sized (≥192); always keep
// bundled 192/512 so Chrome's installability checks still pass for small site favicons.
export function chessInstallManifestIcons(pluginBase = '/plugins/chess/', { faviconPath } = {}) {
  const bundled192 = {
    src: `${pluginBase}icon-192.png`,
    sizes: '192x192',
    type: 'image/png',
    purpose: 'any',
  }
  const bundled512 = {
    src: `${pluginBase}icon-512.png`,
    sizes: '512x512',
    type: 'image/png',
    purpose: 'any',
  }

  let faviconIcon = null
  if (faviconPath) {
    try {
      const dim = readPngDimensions(fs.readFileSync(faviconPath))
      if (dim && dim.width >= 48 && dim.height >= 48) {
        const rev = wikiFaviconRevision(faviconPath)
        faviconIcon = {
          // Query bust so Chrome re-fetches after the wiki flag changes (mtime).
          src: rev ? `/favicon.png?v=${encodeURIComponent(rev)}` : '/favicon.png',
          sizes: `${dim.width}x${dim.height}`,
          type: 'image/png',
          purpose: 'any',
        }
      }
    } catch {
      /* site favicon optional */
    }
  }

  if (!faviconIcon) return [bundled192, bundled512]

  const [w, h] = faviconIcon.sizes.split('x').map(Number)
  // Large enough for the home-screen slot — lead with the wiki flag; keep bundled
  // sizes as installability fallbacks.
  if (w >= 192 && h >= 192) {
    return [faviconIcon, bundled192, bundled512]
  }
  // Small flag still listed so install UIs can show it; 192/512 satisfy install checks.
  return [bundled192, bundled512, faviconIcon]
}

// Host-specific install manifest (path-absolute id/start_url/scope — Chrome install is picky).
export function buildChessInstallManifest({ host, origin, pluginBase = '/plugins/chess/', argv } = {}) {
  const startUrlPath = `${pluginBase}index.html`
  const shortName = host.length > 30 ? `${host.slice(0, 27)}…` : host
  const manifestUrl = origin ? `${origin}${pluginBase}manifest.json` : `${pluginBase}manifest.json`
  return {
    name: `Federated Wiki Chess (${host})`,
    short_name: shortName,
    description: 'Federated Wiki Chess as a Progressive Web App (PWA)',
    id: startUrlPath,
    scope: pluginBase,
    start_url: startUrlPath,
    display: 'standalone',
    icons: chessInstallManifestIcons(pluginBase, {
      faviconPath: resolveWikiFaviconPath(argv),
    }),
    background_color: '#99DAFF',
    theme_color: '#99DAFF',
    prefer_related_applications: false,
    related_applications: [
      {
        platform: 'webapp',
        url: manifestUrl,
        id: startUrlPath,
      },
    ],
  }
}

// Web app manifest for /plugins/chess/manifest.webmanifest (Chrome install criteria).
export function chessPwaManifest(req, argv) {
  return buildChessInstallManifest({
    origin: requestOrigin(req, argv),
    host: requestHost(req, argv),
    argv,
  })
}

function requestPath(req) {
  return String(req.url || '/').split('?')[0]
}

// # Path Router

// Minimal Connect-style router for paths under /plugin/chess/pwa.
function createPathRouter() {
  const routes = []

  const add = (method, path, ...handlers) => {
    routes.push({ method: method.toUpperCase(), path, handlers })
  }

  const handle = (req, res, next) => {
    const path = requestPath(req)
    for (const route of routes) {
      if (route.method !== req.method || route.path !== path) continue
      let i = 0
      const dispatch = err => {
        if (err) return next(err)
        if (i >= route.handlers.length) return
        const fn = route.handlers[i]
        i += 1
        try {
          fn(req, res, dispatch)
        } catch (error) {
          next(error)
        }
      }
      dispatch()
      return
    }
    next()
  }

  return { add, handle }
}

function viewerContextReply(session, itemId) {
  return {
    action: MSG.VIEWER_CONTEXT,
    itemId,
    ownerName: session.ownerName,
    pageOnThisWiki: session.pageOnThisWiki,
    ownerCanJournalHere: session.ownerCanJournalHere,
    guestLocalStoragePersist: session.guestLocalStoragePersist,
    viewerCanClaimWikiSeat: session.viewerCanClaimWikiSeat,
    viewerAuthenticated: session.viewerAuthenticated,
  }
}

function setStateReply(chessObj, itemId) {
  return {
    action: MSG.SET_STATE,
    itemId,
    chessObj,
  }
}

// # Journal Routes

async function saveGameFromBridge(body, req, argv, pagehandler, securityhandler, persistHandlers) {
  let slug = String(body.slug || body.pageKey || '').trim()
  const itemId = String(body.itemId || '').trim()
  const text = String(body.text || '').trim()
  const fen = body.fen
  const forkSite = body.forkSite
  if (!itemId || !text) {
    return { error: 'Missing itemId or text', status: 400 }
  }

  const localSite = requestHost(req, argv)
  let itemText = ''
  if (slug && slug !== 'standalone') {
    const existingPage = await loadLocalPage(pagehandler, slug)
    const item = existingPage?.story?.find(entry => entry?.id === itemId)
    itemText = item?.text || ''
  }
  if (
    !shouldPersistChessItemText({
      itemText,
      nextText: text,
      bareKeywordGuard: body.bareKeywordGuard,
    })
  ) {
    return { ok: true, slug, itemId, changed: false, skipped: true }
  }

  if (!slug || slug === 'standalone') {
    const site = createPwaBridgeSiteClient(pagehandler, localSite, argv)
    const existingSlugs = await site.listSlugs(localSite)
    const created = buildNewGamePage({
      title: body.title,
      text,
      itemId,
      ownerName: securityhandler?.getOwner?.(),
      wikiSite: localSite,
    })
    slug = pageSlug(proposeUniquePageTitle(created.title, existingSlugs))
    created.page.title = proposeUniquePageTitle(created.title, existingSlugs)
    await saveLocalPage(pagehandler, slug, created.page, persistHandlers)
    return {
      ok: true,
      slug,
      itemId,
      created: true,
      title: created.page.title,
      pwaContext: { slug, itemId, title: created.page.title },
    }
  }

  const page = await loadLocalPage(pagehandler, slug)
  if (!page) {
    return { error: 'Page not found', status: 404 }
  }
  const result = applyChessSaveToPage(page, itemId, text, { fen, forkSite, viewingSite: localSite })
  if (result.error) {
    return { error: result.error, status: 404 }
  }
  if (result.changed) {
    await saveLocalPage(pagehandler, slug, page, persistHandlers)
  }
  return { ok: true, slug, itemId, changed: result.changed }
}

async function dispatchPwaBridgeMessage(msg, bridgeCtx, env) {
  const replies = []
  const { req, argv, securityhandler, pagehandler, persistHandlers } = env
  const localSite = requestHost(req, argv)
  const slug = String(bridgeCtx.slug || bridgeCtx.pageKey || '').trim()
  const itemId = String(bridgeCtx.itemId || msg.itemId || '').trim()
  let session = null
  let pwaContext = null

  switch (msg.action) {
    case MSG.REQUEST_VIEWER_CONTEXT: {
      session = sessionPayload(req, securityhandler, localSite, argv)
      replies.push(viewerContextReply(session, msg.itemId || itemId))
      break
    }
    case MSG.GET_STATE: {
      if (slug && itemId && slug !== 'standalone' && itemId !== 'standalone') {
        const page = await loadLocalPage(pagehandler, slug)
        if (page) {
          const chessObj = chessItemStateFromPage(page, itemId)
          if (chessObj) {
            session = sessionPayload(req, securityhandler, localSite, argv)
            replies.push(setStateReply({ ...chessObj, ...session, showStartMenu: false }, itemId))
            break
          }
        }
      }
      session = sessionPayload(req, securityhandler, localSite, argv)
      replies.push(viewerContextReply(session, itemId))
      break
    }
    case MSG.BUILD_CHALLENGES: {
      const site = createPwaBridgeSiteClient(pagehandler, localSite, argv)
      const neighborhoodSites = await discoverFarmNeighborhoodSites(argv, localSite)
      const seedSlug = slug && slug !== 'standalone' ? slug : undefined
      const idbOpts = federationIndexedDbOptsFromPayload(msg)
      const localOpenChallenges = Array.isArray(msg.localOpenChallenges)
        ? msg.localOpenChallenges
        : Array.isArray(msg.localOpenSeeks)
          ? msg.localOpenSeeks
          : []
      const result = await orchestrateSiteSurveyDeferredWork(site, localSite, {
        localOpenChallenges,
        slug: seedSlug,
        neighborhoodSites,
        blockList: idbOpts.blockList,
        knownOpponents: idbOpts.knownOpponents,
        knownFederationSites: idbOpts.knownFederationSites,
        enrichGames: false,
        fetchChallenges: true,
      })
      replies.push({
        action: MSG.SURVEY_OPEN_CHALLENGES_DATA,
        openChallenges: result.openChallenges,
        meta: result.meta,
        seq: msg.seq,
        partial: false,
      })
      break
    }
    case MSG.BUILD_LEADERBOARD: {
      const site = createPwaBridgeSiteClient(pagehandler, localSite, argv)
      const neighborhoodSites = await discoverFarmNeighborhoodSites(argv, localSite)
      const seedSlug = slug && slug !== 'standalone' ? slug : undefined
      if (msg.mode === 'site') {
        const { entries, meta } = await runNeighborhoodJob('siteSurvey', {
          site,
          localSite,
          opts: {
            slug: seedSlug,
            neighborhoodSites,
            includeFederationChallenges: false,
          },
        })
        replies.push({
          action: MSG.LEADERBOARD_DATA,
          entries,
          meta,
          seq: msg.seq,
        })
        break
      }
      const mode = msg.mode === 'mine' ? 'mine' : msg.mode === 'neighborhood' ? 'neighborhood' : 'survey'
      const idbOpts = federationIndexedDbOptsFromPayload(msg)
      const hopGraph = msg.hopGraph && typeof msg.hopGraph === 'object' ? msg.hopGraph : null
      const { entries, meta } = await runNeighborhoodJob('leaderboard', {
        site,
        localSite,
        opts: {
          mode,
          survey: msg.survey,
          slug: seedSlug,
          neighborhoodSites,
          hopGraph,
          deepRecompute: msg.deepRecompute === true,
          localCheckpoint: msg.localCheckpoint || null,
          localPlayers: msg.localPlayers || null,
          ...idbOpts,
        },
      })
      replies.push({
        action: MSG.LEADERBOARD_DATA,
        entries,
        meta,
        seq: msg.seq,
      })
      break
    }
    case MSG.BUILD_SITE_SURVEY_ENRICH: {
      const site = createPwaBridgeSiteClient(pagehandler, localSite, argv)
      const fetchedGames = Array.isArray(msg.fetchedGames) ? msg.fetchedGames : null
      const result = await orchestrateSiteSurveyDeferredWork(site, localSite, {
        fetchedGames,
        enrichGames: true,
        fetchChallenges: false,
      })
      replies.push({
        action: MSG.SURVEY_SITE_GAMES_DATA,
        games: result.games,
        seq: msg.seq,
      })
      break
    }
    case MSG.SURVEY_STATUS: {
      const site = createPwaBridgeSiteClient(pagehandler, localSite, argv)
      const seedSlug = slug && slug !== 'standalone' ? slug : undefined
      const status = await runNeighborhoodJob('surveyStatus', {
        site,
        localSite,
        opts: { slug: seedSlug },
      })
      replies.push({
        action: MSG.SURVEY_STATE,
        hasRatedGame: !!status?.hasRatedGame,
      })
      break
    }
    case MSG.LOOKUP_SITE_DISPLAY: {
      const host = String(msg.host || '').trim()
      const probe = await probeWikiSite(host)
      replies.push({
        action: MSG.SITE_DISPLAY,
        requestId: msg.requestId,
        host,
        site: host,
        displayName: String(probe.displayName || '').trim(),
        valid: probe.valid !== false,
        error: probe.valid === false ? String(probe.error || 'unreachable').trim() : '',
      })
      break
    }
    case MSG.FETCH_PUZZLE_PAGES: {
      const slugs = [...new Set((Array.isArray(msg.slugs) ? msg.slugs : []).map(s => String(s || '').trim().toLowerCase()))]
        .filter(pageSlug => /^[a-z0-9][a-z0-9-]*$/.test(pageSlug))
        .slice(0, 20)
      const pages = (
        await Promise.all(
          slugs.map(async pageSlug => {
            const page = await loadLocalPage(pagehandler, pageSlug)
            if (!page) return null
            return {
              slug: pageSlug,
              title: String(page.title || pageSlug),
              story: (Array.isArray(page.story) ? page.story : [])
                .filter(item => item?.type === 'chess')
                .map(item => ({ type: 'chess', id: item.id, text: String(item.text || '') })),
            }
          }),
        )
      ).filter(Boolean)
      replies.push({
        action: MSG.PUZZLE_PAGES_DATA,
        requestId: msg.requestId,
        pages,
      })
      break
    }
    case MSG.CHALLENGE_CHANGED: {
      if (!isBridgeOwner(req, securityhandler)) {
        return { replies, error: 'must be owner', status: 401 }
      }
      const ghost = msg.ghost && typeof msg.ghost === 'object' ? msg.ghost : null
      const challenge = normalizeChallengeState(msg.challenge)
      const ghostItemId = String(msg.ghostItemId || ghost?.itemId || '').trim()
      // Pending seeks stay on My Chess Games survey metadata until accepted.
      let page = await loadLocalPage(pagehandler, SURVEY_PAGE_SLUG)
      let isNew = false
      if (!page) {
        if (!ghost || !challenge) break
        page = { title: SURVEY_PAGE_TITLE, story: [], journal: [] }
        applyPageAction(page, {
          type: 'create',
          item: {
            title: SURVEY_PAGE_TITLE,
            story: SURVEY_PAGE_STORY.map(entry => ({ ...entry })),
          },
          date: Date.now(),
        })
        isNew = true
      }
      const add =
        ghost && challenge
          ? {
              itemId: ghost.itemId,
              pgn: ghost.pgn,
              title: ghost.title,
              challenge,
            }
          : null
      const removeIds = !challenge && ghostItemId ? [ghostItemId] : []
      if (!add && !removeIds.length) break
      const result = syncOpenChallengeSurveyOnPage(page, { add, removeIds })
      if (result.changed || isNew) {
        await saveLocalPage(pagehandler, SURVEY_PAGE_SLUG, page, persistHandlers)
      }
      break
    }
    case MSG.POSITION_CHANGED:
    case MSG.GAME_READY:
    case MSG.PASTE_APPLY: {
      if (!isBridgeOwner(req, securityhandler)) {
        return { replies, error: 'must be owner', status: 401 }
      }
      const result = await saveGameFromBridge(
        {
          slug,
          pageKey: slug,
          itemId,
          text: msg.text,
          fen: msg.fen,
          forkSite: msg.forkSite,
          title: msg.title,
          bareKeywordGuard: msg.bareKeywordGuard,
        },
        req,
        argv,
        pagehandler,
        securityhandler,
        persistHandlers,
      )
      if (result.error) {
        return { replies, error: result.error, status: result.status || 500 }
      }
      if (result.pwaContext) pwaContext = result.pwaContext
      break
    }
    case MSG.OPEN_GAME_PAGE: {
      const openSlug = String(msg.slug || '').trim()
      const openItemId = String(msg.itemId || '').trim()
      const openSite = String(msg.site || '')
        .trim()
        .toLowerCase()
      // Missing site → treat as this wiki.
      if (openSlug && openItemId && (!openSite || sitesMatch(openSite, localSite))) {
        const page = await loadLocalPage(pagehandler, openSlug)
        if (page) {
          const chessObj = chessItemStateFromPage(page, openItemId)
          if (chessObj) {
            session = sessionPayload(req, securityhandler, localSite, argv)
            replies.push(setStateReply({ ...chessObj, ...session, showStartMenu: false }, openItemId))
            pwaContext = { slug: openSlug, itemId: openItemId, title: chessObj.wikiPageTitle }
          }
        }
      }
      break
    }
    default:
      break
  }

  return { replies, session, pwaContext }
}

// # Bridge Router Mount

// Mount installed-PWA wiki bridge routes on an Express router (/plugin/chess/pwa).
export function createPwaBridgeRouter(params) {
  const { argv, securityhandler, pagehandler, sitemaphandler, searchhandler } = params
  const persistHandlers = { sitemaphandler, searchhandler }
  const router = createPathRouter()

  const cors = (req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*')
    res.header('Access-Control-Allow-Credentials', 'true')
    res.header('Access-Control-Allow-Headers', 'Content-Type')
    next()
  }

  router.add('OPTIONS', '/session', cors)
  router.add('OPTIONS', '/challenges', cors)
  router.add('OPTIONS', '/site-survey', cors)
  router.add('OPTIONS', '/leaderboard', cors)
  router.add('OPTIONS', '/survey-status', cors)
  router.add('OPTIONS', '/game-state', cors)
  router.add('OPTIONS', '/save-game', cors)
  router.add('OPTIONS', '/join-challenge', cors)
  router.add('OPTIONS', '/create-game', cors)
  router.add('OPTIONS', '/dispatch', cors)

  router.add('POST', '/dispatch', cors, async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : await readJsonBody(req)
      const msg = body.msg
      if (!msg?.action) {
        res.status(400).json({ error: 'Missing msg.action' })
        return
      }
      const bridgeCtx = body.ctx && typeof body.ctx === 'object' ? body.ctx : {}
      const env = { req, argv, securityhandler, pagehandler, persistHandlers }
      const result = await dispatchPwaBridgeMessage(msg, bridgeCtx, env)
      if (result.error) {
        res.status(result.status || 500).json({ error: result.error, replies: result.replies || [] })
        return
      }
      res.json({
        replies: result.replies || [],
        session: result.session || null,
        pwaContext: result.pwaContext || null,
      })
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err), replies: [] })
    }
  })

  router.add('GET', '/session', cors, (req, res) => {
    res.json(sessionPayload(req, securityhandler, requestHost(req, argv), argv))
  })

  router.add('GET', '/challenges', cors, async (req, res) => {
    try {
      const localSite = requestHost(req, argv)
      const site = createPwaBridgeSiteClient(pagehandler, localSite, argv)
      const neighborhoodSites = await discoverFarmNeighborhoodSites(argv, localSite)
      const slug = String(req.query?.slug || '').trim() || undefined
      const { entries, meta } = await runNeighborhoodJob('challenges', {
        site,
        localSite,
        opts: { slug, neighborhoodSites },
      })
      res.json({ entries, meta })
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err), entries: [], meta: { unavailable: true } })
    }
  })

  router.add('GET', '/site-survey', cors, async (req, res) => {
    try {
      const localSite = requestHost(req, argv)
      const site = createPwaBridgeSiteClient(pagehandler, localSite, argv)
      const slug = String(req.query?.slug || '').trim() || undefined
      const neighborhoodSites = await discoverFarmNeighborhoodSites(argv, localSite)
      const { entries, meta } = await runNeighborhoodJob('siteSurvey', {
        site,
        localSite,
        opts: { slug, neighborhoodSites },
      })
      res.json({ entries, meta })
    } catch (err) {
      res.status(500).json({
        error: String(err?.message || err),
        entries: [],
        meta: { unavailable: true },
      })
    }
  })

  router.add('GET', '/leaderboard', cors, async (req, res) => {
    await handleLeaderboardRequest(req, res, argv, pagehandler)
  })

  router.add('POST', '/leaderboard', cors, async (req, res) => {
    await handleLeaderboardRequest(req, res, argv, pagehandler)
  })

  router.add('GET', '/survey-status', cors, async (req, res) => {
    try {
      const localSite = requestHost(req, argv)
      const site = createPwaBridgeSiteClient(pagehandler, localSite, argv)
      const slug = String(req.query?.slug || '').trim() || undefined
      const status = await runNeighborhoodJob('surveyStatus', {
        site,
        localSite,
        opts: { slug },
      })
      res.json(status)
    } catch (err) {
      res.status(500).json({
        hasRatedGame: false,
        error: String(err?.message || err),
      })
    }
  })

  router.add('GET', '/game-state', cors, async (req, res) => {
    try {
      const localSite = requestHost(req, argv)
      const slug = String(req.query?.slug || req.query?.pageKey || '').trim()
      const itemId = String(req.query?.itemId || '').trim()
      if (!slug || !itemId || slug === 'standalone' || itemId === 'standalone') {
        res.status(400).json({ error: 'Missing slug or itemId' })
        return
      }
      const page = await loadLocalPage(pagehandler, slug)
      if (!page) {
        res.status(404).json({ error: 'Page not found' })
        return
      }
      const chessObj = chessItemStateFromPage(page, itemId)
      if (!chessObj) {
        res.status(404).json({ error: 'Chess item not found' })
        return
      }
      const session = sessionPayload(req, securityhandler, localSite, argv)
      res.json({
        chessObj: { ...chessObj, ...session, showStartMenu: false },
        itemId,
      })
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) })
    }
  })

  router.add('PUT', '/save-game', cors, async (req, res) => {
    if (!requireOwner(req, res, securityhandler)) return
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : await readJsonBody(req)
      const result = await saveGameFromBridge(body, req, argv, pagehandler, securityhandler, persistHandlers)
      if (result.error) {
        res.status(result.status || 500).json({ error: result.error })
        return
      }
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) })
    }
  })

  router.add('POST', '/create-game', cors, async (req, res) => {
    if (!requireOwner(req, res, securityhandler)) return
    try {
      const localSite = requestHost(req, argv)
      const body = req.body && typeof req.body === 'object' ? req.body : await readJsonBody(req)
      const text = String(body.text || 'GAME').trim()
      const itemId = String(body.itemId || '').trim() || undefined
      const site = createPwaBridgeSiteClient(pagehandler, localSite, argv)
      const existingSlugs = await site.listSlugs(localSite)
      const created = buildNewGamePage({
        title: body.title,
        text,
        itemId,
        ownerName: securityhandler?.getOwner?.(),
        wikiSite: localSite,
      })
      const title = proposeUniquePageTitle(created.title, existingSlugs)
      const slug = pageSlug(title)
      created.page.title = title
      await saveLocalPage(pagehandler, slug, created.page, persistHandlers)
      res.json({
        ok: true,
        slug,
        itemId: created.itemId,
        title,
        chessObj: {
          ...chessItemStateFromPage({ ...created.page, slug }, created.itemId),
          ...sessionPayload(req, securityhandler, localSite, argv),
          showStartMenu: false,
        },
      })
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) })
    }
  })

  router.add('POST', '/join-challenge', cors, async (req, res) => {
    if (!requireOwner(req, res, securityhandler)) return
    try {
      const localSite = requestHost(req, argv)
      const body = req.body && typeof req.body === 'object' ? req.body : await readJsonBody(req)
      const ghostPgn = String(body.pgn || '').trim()
      const challenge = body.challenge
      const creatorSite = String(body.host || '')
        .trim()
        .toLowerCase()
      const ghostItemId = String(body.itemId || '').trim()
      const joinerDisplayName = String(body.joinerDisplayName || '').trim()
      const ownerName = securityhandler?.getOwner?.() || ''

      const payload = buildJoinChallengePage({
        ghostPgn,
        challenge,
        itemId: ghostItemId,
        joinerDisplayName,
        joinerSite: localSite,
        creatorSite,
        ownerName,
        isAuthenticatedOwner: true,
      })

      const site = createPwaBridgeSiteClient(pagehandler, localSite, argv)
      const existingSlugs = await site.listSlugs(localSite)
      const requestedTitle = String(body.title || '').trim()
      const title = proposeUniquePageTitle(requestedTitle || payload.baseTitle, existingSlugs)
      const slug = pageSlug(title)
      const { page } = materializeJoinChallengePage(payload, { slug, title })
      page.slug = slug
      await saveLocalPage(pagehandler, slug, page, persistHandlers)

      const chessObj = {
        ...chessItemStateFromPage(page, payload.itemId),
        ...sessionPayload(req, securityhandler, localSite, argv),
        showStartMenu: false,
        PGN: payload.seatedPgn,
        chessState: payload.seatedPgn,
      }

      res.json({
        ok: true,
        slug,
        itemId: payload.itemId,
        title,
        host: localSite,
        chessObj,
      })
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) })
    }
  })

  router.add('GET', '/lookup-host-display', cors, async (req, res) => {
    try {
      const host = String(req.query?.host || '').trim()
      if (!host) {
        res.status(400).json({ error: 'Missing host' })
        return
      }
      const probe = await probeWikiSite(host, { allowHttpFallback: true })
      res.json({
        valid: probe.valid,
        displayName: probe.displayName || '',
        error: probe.error || '',
      })
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) })
    }
  })

  return router.handle
}

// # Federation Crawl Routes

async function handleLeaderboardRequest(req, res, argv, pagehandler) {
  try {
    const localSite = requestHost(req, argv)
    const site = createPwaBridgeSiteClient(pagehandler, localSite, argv)
    const body = req.method === 'POST' ? await readJsonBody(req) : {}
    const slug = String(body.slug || req.query?.slug || '').trim() || undefined
    const mode =
      (body.mode || req.query?.mode) === 'mine'
        ? 'mine'
        : (body.mode || req.query?.mode) === 'neighborhood'
          ? 'neighborhood'
          : 'survey'
    const survey = String(body.survey || req.query?.survey || 'global')
      .trim()
      .toLowerCase()
    const deepRecompute = body.deepRecompute === true || req.query?.deepRecompute === 'true'
    const neighborhoodSites = await discoverFarmNeighborhoodSites(argv, localSite)
    const { entries, meta } = await runNeighborhoodJob('leaderboard', {
      site,
      localSite,
      opts: {
        mode,
        survey,
        slug,
        neighborhoodSites,
        deepRecompute,
        localCheckpoint: body.localCheckpoint || null,
        localPlayers: body.localPlayers || null,
        ...federationIndexedDbOptsFromPayload(body),
      },
    })
    res.json({ entries, meta })
  } catch (err) {
    res.status(500).json({
      error: String(err?.message || err),
      entries: [],
      meta: { unavailable: true },
    })
  }
}
